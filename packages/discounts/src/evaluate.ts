import { dayOfWeek } from '@repo/zoned-time'
import {
	type DiscountChannel,
	type DiscountCodeRecord,
	type DiscountFulfillment,
	type DiscountRecord,
	normalizeDiscountCode,
} from './definition.ts'
import {
	allocateProportionally,
	BASIS_POINTS,
	mulDiv,
	sameCurrency,
	sumMinor,
} from './money.ts'

/**
 * The discount engine. Pure: no I/O, no clock, no randomness. Every channel
 * builds the cart from its own server-priced lines and calls
 * `evaluateDiscounts`; the result says how much each line is discounted and
 * why a typed code was refused. Tax, tip and loyalty are applied by the caller
 * on the remaining line values.
 */

export type DiscountCartLine = {
	lineId: string
	itemId: string
	variantId: string | null
	/** Every category the item is directly in. */
	categoryIds: readonly string[]
	quantity: number
	/** One unit including its modifiers, in minor units. */
	unitMinor: number
	/** Excluded from every discount (item or variant flag). */
	excluded: boolean
}

export type DiscountContext = {
	channel: DiscountChannel
	fulfillment: DiscountFulfillment
	locationId: string | null
	isDrop: boolean
	/** Wall clock at the location, `YYYY-MM-DDTHH:MM`. */
	localNow: string
	/** Delivery fee before any discount, in minor units (0 when not delivery). */
	deliveryFeeMinor: number
	customer: {
		signedIn: boolean
		isNewCustomer: boolean
		isLoyaltyMember: boolean
	}
}

export type DiscountUsage = {
	/** Reserved and consumed uses across all customers. */
	total: number
	customerLifetime: number
	/** This customer's uses on `localNow`'s calendar day. */
	customerDay: number
	/** This customer's uses in `localNow`'s week (Monday start). */
	customerWeek: number
}

export type DiscountEvaluationInput = {
	currency: string
	lines: readonly DiscountCartLine[]
	context: DiscountContext
	discounts: readonly DiscountRecord[]
	codes: readonly DiscountCodeRecord[]
	usage: Readonly<Record<string, DiscountUsage | undefined>>
	/** Reserved and consumed uses per code id. */
	codeUsage: Readonly<Record<string, number | undefined>>
	/** What the customer typed, if anything. */
	code?: string | null
}

export const DISCOUNT_REFUSAL_REASONS = [
	'not_found',
	'not_started',
	'expired',
	'not_available_now',
	'wrong_location',
	'wrong_channel',
	'wrong_fulfillment',
	'wrong_drop',
	'sign_in_required',
	'new_customers_only',
	'members_only',
	'limit_reached',
	'minimum_not_met',
	'requirement_not_met',
	'quantity_not_met',
	'not_applicable',
] as const
export type DiscountRefusalReason = (typeof DISCOUNT_REFUSAL_REASONS)[number]

export type AppliedDiscountLine = {
	lineId: string
	amountMinor: number
	/** Units of the line the discount covers. */
	units: number
}

export type AppliedDiscount = {
	discountId: string
	version: number
	name: string
	codeId: string | null
	normalizedCode: string | null
	amountMinor: number
	deliveryAmountMinor: number
	lines: AppliedDiscountLine[]
}

export type DiscountCodeOutcome =
	| { status: 'applied'; discountId: string }
	| { status: 'refused'; reason: DiscountRefusalReason }
	| {
			status: 'replaced'
			reason: 'replaced_by_better_discount'
			discountId: string
	  }

export type DiscountEvaluation = {
	applied: AppliedDiscount[]
	/** Total discount per line id; lines without one are absent. */
	lineDiscounts: Record<string, number>
	deliveryDiscountMinor: number
	totalDiscountMinor: number
	/** Null when no code was typed. */
	code: DiscountCodeOutcome | null
}

type WorkingLine = DiscountCartLine & { remaining: number }
type State = { lines: WorkingLine[]; deliveryRemaining: number }
type Unit = { lineIndex: number; unitIndex: number; value: number }

function lineTotalMinor(line: DiscountCartLine): number {
	return line.unitMinor * line.quantity
}

function cloneState(state: State): State {
	return {
		lines: state.lines.map((line) => ({ ...line })),
		deliveryRemaining: state.deliveryRemaining,
	}
}

function minutesOf(time: string): number {
	return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
}

function inSchedule(
	windows: NonNullable<DiscountRecord['schedule']>,
	localNow: string,
): boolean {
	const date = localNow.slice(0, 10)
	const minute = minutesOf(localNow.slice(11, 16))
	const today = dayOfWeek(date)
	const yesterday = (today + 6) % 7
	return windows.some((window) => {
		const start = minutesOf(window.start)
		const end = minutesOf(window.end)
		if (start < end) {
			return window.day === today && minute >= start && minute < end
		}
		// Runs past midnight: the evening part belongs to its own day, the
		// morning part to the day after.
		if (window.day === today && minute >= start) return true
		return window.day === yesterday && minute < end
	})
}

/** Why a discount can't apply to this cart and customer right now, or null. */
function refusalFor(
	discount: DiscountRecord,
	input: DiscountEvaluationInput,
	subtotalMinor: number,
): DiscountRefusalReason | null {
	const { context } = input
	if (discount.status !== 'active') return 'not_found'
	if (
		discount.valueType === 'fixed' &&
		(!discount.currency || !sameCurrency(discount.currency, input.currency))
	) {
		return 'not_applicable'
	}
	if (discount.startsAt && context.localNow < discount.startsAt) {
		return 'not_started'
	}
	if (discount.endsAt && context.localNow > discount.endsAt) return 'expired'
	if (discount.schedule && !inSchedule(discount.schedule, context.localNow)) {
		return 'not_available_now'
	}
	if (
		discount.locationIds &&
		(!context.locationId || !discount.locationIds.includes(context.locationId))
	) {
		return 'wrong_location'
	}
	if (!discount.channels.includes(context.channel)) return 'wrong_channel'
	if (!discount.fulfillments.includes(context.fulfillment)) {
		return 'wrong_fulfillment'
	}
	if (context.isDrop && !discount.includeDrops) return 'wrong_drop'
	const { customer } = context
	if (discount.eligibility !== 'everyone' && !customer.signedIn) {
		return 'sign_in_required'
	}
	if (discount.eligibility === 'new_customer' && !customer.isNewCustomer) {
		return 'new_customers_only'
	}
	if (discount.eligibility === 'loyalty_member' && !customer.isLoyaltyMember) {
		return 'members_only'
	}
	const usage = input.usage[discount.id]
	if (
		discount.totalLimit !== null &&
		(usage?.total ?? 0) >= discount.totalLimit
	) {
		return 'limit_reached'
	}
	if (discount.perCustomerLimit) {
		if (!customer.signedIn) return 'sign_in_required'
		const { count, period } = discount.perCustomerLimit
		const used =
			period === 'day'
				? (usage?.customerDay ?? 0)
				: period === 'week'
					? (usage?.customerWeek ?? 0)
					: (usage?.customerLifetime ?? 0)
		if (used >= count) return 'limit_reached'
	}
	if (
		discount.minSubtotalMinor !== null &&
		subtotalMinor < discount.minSubtotalMinor
	) {
		return 'minimum_not_met'
	}
	return null
}

function lineMatchesTarget(
	discount: DiscountRecord,
	line: DiscountCartLine,
): boolean {
	if (line.excluded) return false
	const { target } = discount
	if (target.excludeItemIds.includes(line.itemId)) return false
	if (line.categoryIds.some((id) => target.excludeCategoryIds.includes(id))) {
		return false
	}
	if (target.scope === 'order') return true
	if (target.scope === 'items') return target.itemIds.includes(line.itemId)
	return line.categoryIds.some((id) => target.categoryIds.includes(id))
}

function requirementMet(
	discount: DiscountRecord,
	lines: readonly WorkingLine[],
): boolean {
	const { requirement } = discount
	if (!requirement) return true
	const anyItem =
		requirement.itemIds.length === 0 && requirement.categoryIds.length === 0
	const count = lines
		.filter((line) => {
			if (line.excluded) return false
			if (anyItem) return true
			return (
				requirement.itemIds.includes(line.itemId) ||
				line.categoryIds.some((id) => requirement.categoryIds.includes(id))
			)
		})
		.reduce((sum, line) => sum + line.quantity, 0)
	return count >= requirement.quantity
}

/** One entry per unit, spreading a line's remaining value over its quantity. */
function unitsOf(line: WorkingLine, lineIndex: number): Unit[] {
	const base = Math.floor(line.remaining / line.quantity)
	const extra = line.remaining % line.quantity
	return Array.from({ length: line.quantity }, (_, unitIndex) => ({
		lineIndex,
		unitIndex,
		value: base + (unitIndex < extra ? 1 : 0),
	}))
}

function selectUnits(
	rule: DiscountRecord['quantityRule'],
	units: readonly Unit[],
): Unit[] | null {
	const count = units.length
	switch (rule.kind) {
		case 'none':
			return [...units]
		case 'minimum':
			return count >= rule.quantity ? [...units] : null
		case 'exact': {
			const covered = Math.floor(count / rule.quantity) * rule.quantity
			return covered > 0 ? units.slice(0, covered) : null
		}
		case 'bogo': {
			// Highest value first, so what is free is never worth more than what
			// was bought. A partly filled last group still discounts the units
			// past its bought ones.
			const group = rule.buyQuantity + rule.getQuantity
			const picked = units.filter(
				(_, index) => index % group >= rule.buyQuantity,
			)
			return picked.length > 0 ? picked : null
		}
	}
}

type ApplyResult =
	| {
			ok: true
			amountMinor: number
			deliveryAmountMinor: number
			lines: AppliedDiscountLine[]
	  }
	| { ok: false; reason: DiscountRefusalReason }

/** Compute one discount against `state` and, on success, take it off `state`. */
function applyDiscount(discount: DiscountRecord, state: State): ApplyResult {
	if (discount.valueType === 'free_delivery') {
		if (state.deliveryRemaining <= 0)
			return { ok: false, reason: 'not_applicable' }
		if (!requirementMet(discount, state.lines)) {
			return { ok: false, reason: 'requirement_not_met' }
		}
		const amount = state.deliveryRemaining
		state.deliveryRemaining = 0
		return { ok: true, amountMinor: 0, deliveryAmountMinor: amount, lines: [] }
	}
	if (!requirementMet(discount, state.lines)) {
		return { ok: false, reason: 'requirement_not_met' }
	}
	const eligible: Unit[] = []
	state.lines.forEach((line, lineIndex) => {
		if (!lineMatchesTarget(discount, line) || line.remaining <= 0) return
		for (const unit of unitsOf(line, lineIndex)) {
			if (unit.value > 0) eligible.push(unit)
		}
	})
	if (eligible.length === 0) return { ok: false, reason: 'not_applicable' }
	eligible.sort(
		(a, b) =>
			b.value - a.value ||
			a.lineIndex - b.lineIndex ||
			a.unitIndex - b.unitIndex,
	)
	let selected = selectUnits(discount.quantityRule, eligible)
	if (!selected) return { ok: false, reason: 'quantity_not_met' }
	if (discount.maxDiscountedUnits !== null) {
		selected = selected.slice(0, discount.maxDiscountedUnits)
	}
	const values = selected.map((unit) => unit.value)
	const eligibleMinor = sumMinor(values)
	let shares: number[]
	if (discount.valueType === 'percent') {
		let total = mulDiv(eligibleMinor, discount.percentBp ?? 0, BASIS_POINTS)
		if (discount.maxDiscountMinor !== null) {
			total = Math.min(total, discount.maxDiscountMinor)
		}
		shares = allocateProportionally(Math.min(total, eligibleMinor), values)
	} else if (discount.target.scope === 'order') {
		shares = allocateProportionally(
			Math.min(discount.amountMinor ?? 0, eligibleMinor),
			values,
		)
	} else {
		shares = values.map((value) => Math.min(discount.amountMinor ?? 0, value))
	}
	const amountMinor = sumMinor(shares)
	if (amountMinor <= 0) return { ok: false, reason: 'not_applicable' }
	const perLine = new Map<number, AppliedDiscountLine>()
	selected.forEach((unit, index) => {
		const line = state.lines[unit.lineIndex]!
		let entry = perLine.get(unit.lineIndex)
		if (!entry) {
			entry = { lineId: line.lineId, amountMinor: 0, units: 0 }
			perLine.set(unit.lineIndex, entry)
		}
		entry.amountMinor += shares[index]!
		entry.units += 1
	})
	const lines = [...perLine.entries()]
		.sort(([a], [b]) => a - b)
		.map(([lineIndex, entry]) => {
			state.lines[lineIndex]!.remaining -= entry.amountMinor
			return entry
		})
		.filter((entry) => entry.amountMinor > 0)
	return { ok: true, amountMinor, deliveryAmountMinor: 0, lines }
}

type Candidate = { discount: DiscountRecord; code: DiscountCodeRecord | null }

type Plan = {
	applied: AppliedDiscount[]
	state: State
	totalMinor: number
	/** The first discount that applied, for tie-breaks. */
	lead: DiscountRecord | null
}

function runPlan(candidates: readonly Candidate[], from: State): Plan {
	const state = cloneState(from)
	const applied: AppliedDiscount[] = []
	let lead: DiscountRecord | null = null
	for (const { discount, code } of candidates) {
		const result = applyDiscount(discount, state)
		if (!result.ok) continue
		lead ??= discount
		applied.push(toApplied(discount, code, result))
	}
	return { applied, state, totalMinor: planTotal(applied), lead }
}

function toApplied(
	discount: DiscountRecord,
	code: DiscountCodeRecord | null,
	result: Extract<ApplyResult, { ok: true }>,
): AppliedDiscount {
	return {
		discountId: discount.id,
		version: discount.version,
		name: discount.name,
		codeId: code?.id ?? null,
		normalizedCode: code?.normalizedCode ?? null,
		amountMinor: result.amountMinor,
		deliveryAmountMinor: result.deliveryAmountMinor,
		lines: result.lines,
	}
}

function planTotal(applied: readonly AppliedDiscount[]): number {
	return sumMinor(
		applied.map((entry) => entry.amountMinor + entry.deliveryAmountMinor),
	)
}

function byPriority(a: DiscountRecord, b: DiscountRecord): number {
	return (
		a.priority - b.priority ||
		(a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
		(a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
	)
}

/**
 * Pick what applies. Automatic discounts first: each non-combinable one alone
 * and all combinable ones stacked in priority order compete, and the largest
 * total wins. A typed code then stacks on top when it combines, or competes
 * with the winner when it doesn't. Manual discounts are not evaluated here.
 */
export function evaluateDiscounts(
	input: DiscountEvaluationInput,
): DiscountEvaluation {
	const subtotalMinor = sumMinor(input.lines.map(lineTotalMinor))
	const deliveryFee = Math.max(0, input.context.deliveryFeeMinor)
	const start: State = {
		lines: input.lines.map((line) => ({
			...line,
			remaining: lineTotalMinor(line),
		})),
		deliveryRemaining: deliveryFee,
	}

	const automatic = input.discounts
		.filter((discount) => discount.application === 'automatic')
		.filter((discount) => refusalFor(discount, input, subtotalMinor) === null)
		.sort(byPriority)
		.map((discount): Candidate => ({ discount, code: null }))

	const plans: Plan[] = []
	for (const candidate of automatic.filter((c) => !c.discount.combinable)) {
		plans.push(runPlan([candidate], start))
	}
	plans.push(
		runPlan(
			automatic.filter((c) => c.discount.combinable),
			start,
		),
	)

	let best = plans[0]!
	for (const plan of plans.slice(1)) {
		if (comparePlans(plan, best) < 0) best = plan
	}

	let outcome: DiscountCodeOutcome | null = null
	const typed = input.code ? normalizeDiscountCode(input.code) : ''
	if (input.code !== undefined && input.code !== null && input.code !== '') {
		const record = typed
			? input.codes.find((code) => code.normalizedCode === typed)
			: undefined
		const discount = record
			? input.discounts.find((d) => d.id === record.discountId)
			: undefined
		if (!record || !discount || discount.application !== 'code') {
			outcome = { status: 'refused', reason: 'not_found' }
		} else {
			const refusal =
				refusalFor(discount, input, subtotalMinor) ??
				(record.maxUses !== null &&
				(input.codeUsage[record.id] ?? 0) >= record.maxUses
					? 'limit_reached'
					: null)
			if (refusal) {
				outcome = { status: 'refused', reason: refusal }
			} else if (discount.combinable) {
				const state = cloneState(best.state)
				const result = applyDiscount(discount, state)
				if (!result.ok) {
					outcome = { status: 'refused', reason: result.reason }
				} else {
					const applied = [...best.applied, toApplied(discount, record, result)]
					best = { ...best, applied, state, totalMinor: planTotal(applied) }
					outcome = { status: 'applied', discountId: discount.id }
				}
			} else {
				const alone = runPlan([{ discount, code: record }], start)
				if (alone.applied.length === 0) {
					const why = applyDiscount(discount, cloneState(start))
					outcome = {
						status: 'refused',
						reason: why.ok ? 'not_applicable' : why.reason,
					}
				} else if (alone.totalMinor >= best.totalMinor) {
					best = alone
					outcome = { status: 'applied', discountId: discount.id }
				} else {
					outcome = {
						status: 'replaced',
						reason: 'replaced_by_better_discount',
						discountId: discount.id,
					}
				}
			}
		}
	}

	const lineDiscounts: Record<string, number> = {}
	for (const line of best.state.lines) {
		const discounted = lineTotalMinor(line) - line.remaining
		if (discounted > 0) lineDiscounts[line.lineId] = discounted
	}
	const deliveryDiscountMinor = deliveryFee - best.state.deliveryRemaining
	return {
		applied: best.applied,
		lineDiscounts,
		deliveryDiscountMinor,
		totalDiscountMinor:
			sumMinor(Object.values(lineDiscounts)) + deliveryDiscountMinor,
		code: outcome,
	}
}

/** Negative when `a` beats `b`: bigger total, then lower priority, then older. */
function comparePlans(a: Plan, b: Plan): number {
	if (a.totalMinor !== b.totalMinor) return b.totalMinor - a.totalMinor
	if (a.lead && b.lead) return byPriority(a.lead, b.lead)
	return a.lead ? -1 : b.lead ? 1 : 0
}

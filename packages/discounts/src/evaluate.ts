import { dayOfWeek } from '@repo/zoned-time'
import {
	combinesWithOf,
	type DiscountChannel,
	type DiscountCodeRecord,
	type DiscountFulfillment,
	type DiscountRecord,
	discountClassOf,
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

/** One modifier choice on a cart line (a topping, a sauce, a side upgrade). */
export type DiscountCartOption = {
	groupId: string
	optionId: string
	/** How many of it each unit of the line carries; a quantity group can be 2 or more. */
	quantity: number
	/** What those cost for one unit of the line, in minor units. */
	totalMinor: number
}

export type DiscountCartLine = {
	lineId: string
	itemId: string
	variantId: string | null
	/** Every category the item is directly in. */
	categoryIds: readonly string[]
	quantity: number
	/** One unit including its modifiers, in minor units. */
	unitMinor: number
	/**
	 * One unit without its modifiers. A set price applies to this part only, so
	 * a paid topping is never swallowed by "large pizza $10". Missing means the
	 * line carries no modifier detail and the whole unit is the price basis.
	 */
	baseUnitMinor?: number
	/** The choices on each unit, for discounts that target modifiers. */
	options?: readonly DiscountCartOption[]
	/**
	 * The names of the variant chosen ("Large", "Thin"), for discounts that
	 * target a size. Missing means no variant detail, which matches no size.
	 */
	variantNames?: readonly string[]
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

type WorkingLine = DiscountCartLine & {
	/** What the whole line has left: the sum of `unitRemaining`. */
	remaining: number
	/**
	 * What each unit has left. Tracked per unit, not spread evenly over the
	 * line, so a discount that took one unit ("the first one $2") leaves the
	 * other units whole for the next discount, whatever the line order.
	 */
	unitRemaining: number[]
	/**
	 * Of what has been taken off each unit, the part a set price took from the
	 * item's base alone, and the part a modifier discount took from its choices
	 * alone. Everything else came off proportionally, so these two let the base
	 * and the choices each be valued correctly for the next discount.
	 */
	unitBaseTaken: number[]
	unitOptionsTaken: number[]
}
type State = {
	lines: WorkingLine[]
	deliveryRemaining: number
	/** The fee before any discount, for a delivery discount's fee limit. */
	deliveryFeeMinor: number
	/** Order currency, so a cap stored in another currency is not applied. */
	currency?: string
}
type Unit = {
	lineIndex: number
	/** Breaks ties between equal units, so line order never changes a result. */
	lineId: string
	unitIndex: number
	value: number
}

/** Units on one cart line; the order schemas allow no more. */
export const DISCOUNT_MAX_LINE_QUANTITY = 50
/**
 * Units in one evaluation. Larger than one order's 200 because a tab is
 * evaluated with all its rounds; it only bounds the engine's work.
 */
export const DISCOUNT_MAX_CART_UNITS = 5000

function assertNonNegativeSafeInteger(value: unknown, name: string): void {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative whole number`)
	}
}

/**
 * Refuses a cart the order schemas would never let through, before any work:
 * fractional, negative or huge quantities and prices. The engine allocates per
 * unit, so a quantity of a billion must not reach it.
 */
function assertCart(lines: readonly DiscountCartLine[]): void {
	let units = 0
	for (const line of lines) {
		assertNonNegativeSafeInteger(line.quantity, 'quantity')
		if (line.quantity < 1 || line.quantity > DISCOUNT_MAX_LINE_QUANTITY) {
			throw new RangeError(
				`quantity must be between 1 and ${DISCOUNT_MAX_LINE_QUANTITY}`,
			)
		}
		assertNonNegativeSafeInteger(line.unitMinor, 'unitMinor')
		if (line.baseUnitMinor !== undefined) {
			assertNonNegativeSafeInteger(line.baseUnitMinor, 'baseUnitMinor')
		}
		for (const option of line.options ?? []) {
			assertNonNegativeSafeInteger(option.quantity, 'option quantity')
			assertNonNegativeSafeInteger(option.totalMinor, 'option totalMinor')
		}
		if (!Number.isSafeInteger(line.unitMinor * line.quantity)) {
			throw new RangeError('line total is too large')
		}
		units += line.quantity
	}
	if (units > DISCOUNT_MAX_CART_UNITS) {
		throw new RangeError(`at most ${DISCOUNT_MAX_CART_UNITS} units`)
	}
}

function lineTotalMinor(line: DiscountCartLine): number {
	return line.unitMinor * line.quantity
}

function workingLines(lines: readonly DiscountCartLine[]): WorkingLine[] {
	return lines.map((line) => ({
		...line,
		remaining: lineTotalMinor(line),
		unitRemaining: Array.from({ length: line.quantity }, () => line.unitMinor),
		unitBaseTaken: Array.from({ length: line.quantity }, () => 0),
		unitOptionsTaken: Array.from({ length: line.quantity }, () => 0),
	}))
}

function cloneState(state: State): State {
	return {
		lines: state.lines.map((line) => ({
			...line,
			unitRemaining: [...line.unitRemaining],
			unitBaseTaken: [...line.unitBaseTaken],
			unitOptionsTaken: [...line.unitOptionsTaken],
		})),
		deliveryRemaining: state.deliveryRemaining,
		deliveryFeeMinor: state.deliveryFeeMinor,
		currency: state.currency,
	}
}

function minutesOf(time: string): number {
	return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
}

const LOCAL_NOW_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

/** A real `YYYY-MM-DDTHH:MM`; anything else is outside every time window. */
function validLocalNow(localNow: string): boolean {
	if (typeof localNow !== 'string' || !LOCAL_NOW_PATTERN.test(localNow)) {
		return false
	}
	const ms = Date.parse(`${localNow}:00Z`)
	return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(localNow)
}

/** Whether a menu promotion's calendar (dates and weekly hours) is live now. */
export function discountPromotionLive(
	promotion: {
		startsAt?: string | null
		endsAt?: string | null
		schedule?: Readonly<NonNullable<DiscountRecord['schedule']>> | null
	},
	localNow: string,
): boolean {
	if (
		(promotion.startsAt || promotion.endsAt || promotion.schedule) &&
		!validLocalNow(localNow)
	) {
		return false
	}
	if (promotion.startsAt && promotion.startsAt > localNow) return false
	if (promotion.endsAt && promotion.endsAt <= localNow) return false
	if (promotion.schedule && !inSchedule(promotion.schedule, localNow)) {
		return false
	}
	return true
}

function inSchedule(
	windows: Readonly<NonNullable<DiscountRecord['schedule']>>,
	localNow: string,
): boolean {
	if (!validLocalNow(localNow)) return false
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

/**
 * What counts towards a minimum spend: every line except those the discount
 * leaves out (gift cards, and its excluded items and categories). Counting an
 * excluded line would let one unlock a discount it cannot receive.
 */
function qualifyingSubtotal(
	discount: DiscountRecord,
	lines: readonly DiscountCartLine[],
): number {
	const { target } = discount
	return sumMinor(
		lines
			.filter(
				(line) =>
					!line.excluded &&
					!target.excludeItemIds.includes(line.itemId) &&
					!line.categoryIds.some((id) =>
						target.excludeCategoryIds.includes(id),
					),
			)
			.map(lineTotalMinor),
	)
}

/** Why a discount can't apply to this cart and customer right now, or null. */
function refusalFor(
	discount: DiscountRecord,
	input: DiscountEvaluationInput,
): DiscountRefusalReason | null {
	const { context } = input
	if (discount.status !== 'active') return 'not_found'
	if (
		(discount.valueType === 'fixed' || discount.valueType === 'fixed_price') &&
		(!discount.currency || !sameCurrency(discount.currency, input.currency))
	) {
		return 'not_applicable'
	}
	// Without a usable wall clock no dated or scheduled discount can be judged,
	// so none applies (an empty string would otherwise sort before every end).
	if (
		(discount.startsAt || discount.endsAt || discount.schedule) &&
		!validLocalNow(context.localNow)
	) {
		return 'not_available_now'
	}
	if (discount.startsAt && context.localNow < discount.startsAt) {
		return 'not_started'
	}
	// The end is exclusive, like the end of a weekly window: a discount that ends
	// at 17:00 is gone from 17:00 on.
	if (discount.endsAt && context.localNow >= discount.endsAt) return 'expired'
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
		discount.maxDiscountMinor !== null ||
		discount.minSubtotalMinor !== null ||
		discount.maxDeliveryFeeMinor != null ||
		discount.tiers?.basis === 'spend' ||
		(discount.quantityRule.kind === 'buy_get' &&
			discount.quantityRule.buy.spendMinor !== undefined)
	) {
		// A cap, a minimum, a spend tier or a buy-side spend is in minor units of
		// its own currency.
		if (
			!discount.currency ||
			!sameCurrency(discount.currency, input.currency)
		) {
			return 'not_applicable'
		}
	}
	if (discount.minSubtotalMinor !== null) {
		if (qualifyingSubtotal(discount, input.lines) < discount.minSubtotalMinor) {
			return 'minimum_not_met'
		}
	}
	return null
}

/** True when no size is asked for, or the line's variant has one of the names. */
function variantMatches(
	names: readonly string[] | undefined,
	line: DiscountCartLine,
): boolean {
	if (!names || names.length === 0) return true
	if (!line.variantNames || line.variantNames.length === 0) return false
	const wanted = new Set(names.map((name) => name.trim().toLowerCase()))
	return line.variantNames.some((name) => wanted.has(name.trim().toLowerCase()))
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
	if (!variantMatches(target.variantNames, line)) return false
	if (target.scope === 'modifiers') {
		// The item filter for a modifier discount; empty means any item.
		if (target.itemIds.length === 0 && target.categoryIds.length === 0) {
			return true
		}
		return (
			target.itemIds.includes(line.itemId) ||
			line.categoryIds.some((id) => target.categoryIds.includes(id))
		)
	}
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

/** One entry per unit, each with what that unit has left. */
function unitsOf(line: WorkingLine, lineIndex: number): Unit[] {
	return line.unitRemaining.map((value, unitIndex) => ({
		lineIndex,
		lineId: line.lineId,
		unitIndex,
		value,
	}))
}

/**
 * What is left of one unit's base price and of its modifier choices, given
 * what discounts have taken from that unit so far. A set price takes from the
 * base only and a modifier discount from the choices only; anything else came
 * off both in proportion. `value` is what the unit has left in all.
 */
function unitParts(
	line: WorkingLine,
	unitIndex: number,
	value: number,
): { base: number; options: number; optionsFull: number } {
	const unit = line.unitMinor
	const optionsFull = Math.min(
		unit,
		(line.options ?? []).reduce((sum, option) => sum + option.totalMinor, 0),
	)
	const baseFull =
		line.baseUnitMinor === undefined
			? unit - optionsFull
			: Math.min(line.baseUnitMinor, unit)
	const takenBase = Math.min(line.unitBaseTaken[unitIndex] ?? 0, baseFull)
	const takenOptions = Math.min(
		line.unitOptionsTaken[unitIndex] ?? 0,
		optionsFull,
	)
	const den = unit - takenBase - takenOptions
	if (den <= 0 || value <= 0) return { base: 0, options: 0, optionsFull }
	return {
		base: mulDiv(baseFull - takenBase, value, den),
		options: mulDiv(optionsFull - takenOptions, value, den),
		optionsFull,
	}
}

/** What a set price replaces: the unit's base price, not its modifiers. */
function priceBasis(unit: Unit, state: State): number {
	return unitParts(state.lines[unit.lineIndex]!, unit.unitIndex, unit.value)
		.base
}

/**
 * Ties between units worth the same go by line id, then unit: never by where
 * the line sits in the cart, so adding lines in another order gives the same
 * discount. The line index only separates two lines that share an id.
 */
function byUnitKey(a: Unit, b: Unit): number {
	if (a.lineId !== b.lineId) return a.lineId < b.lineId ? -1 : 1
	return a.lineIndex - b.lineIndex || a.unitIndex - b.unitIndex
}

/** Units of the lines the discount may touch, highest value first. */
function eligibleUnits(discount: DiscountRecord, state: State): Unit[] {
	const eligible: Unit[] = []
	state.lines.forEach((line, lineIndex) => {
		if (!lineMatchesTarget(discount, line) || line.remaining <= 0) return
		for (const unit of unitsOf(line, lineIndex)) {
			if (unit.value > 0) eligible.push(unit)
		}
	})
	if (discount.valueType !== 'fixed_price') return eligible.sort(byValueDesc)
	// A set price takes from the base only, so units worth the same in all can
	// still differ in base: the one with the bigger base goes first, or the
	// result would depend on which line the guest added first.
	return eligible.sort(
		(a, b) =>
			b.value - a.value ||
			priceBasis(b, state) - priceBasis(a, state) ||
			byUnitKey(a, b),
	)
}

function byValueDesc(a: Unit, b: Unit): number {
	return b.value - a.value || byUnitKey(a, b)
}

function byValueAsc(a: Unit, b: Unit): number {
	return a.value - b.value || byUnitKey(a, b)
}

type ItemSet = {
	itemIds: readonly string[]
	categoryIds: readonly string[]
	variantNames?: readonly string[]
}

function lineInSet(set: ItemSet, line: DiscountCartLine): boolean {
	return (
		(set.itemIds.includes(line.itemId) ||
			line.categoryIds.some((id) => set.categoryIds.includes(id))) &&
		variantMatches(set.variantNames, line)
	)
}

/**
 * "Spend $30 on burgers, get a free dessert": every `spendMinor` spent on the
 * buy group earns `getQuantity` of the get group, cheapest first. A unit that
 * is discounted does not also count towards the spend. Set "items discounted
 * per use" to make it once per order. `getPool` is cheapest first.
 */
function pairBySpend(
	spendMinor: number,
	getQuantity: number,
	buyPool: readonly Unit[],
	getPool: readonly Unit[],
	maxUnits: number | null,
): Unit[] | null {
	let repetitions = Math.floor(getPool.length / getQuantity)
	if (maxUnits !== null) {
		repetitions = Math.min(repetitions, Math.floor(maxUnits / getQuantity))
	}
	for (; repetitions >= 1; repetitions -= 1) {
		const picked = getPool.slice(0, repetitions * getQuantity)
		const taken = new Set(picked)
		const spent = sumMinor(
			buyPool.filter((unit) => !taken.has(unit)).map((unit) => unit.value),
		)
		if (Math.floor(spent / spendMinor) >= repetitions) return picked
	}
	return null
}

/**
 * Pair bought units with discounted ones and return the discounted units.
 *
 * Each repetition uses `buy.quantity` units from the buy group and
 * `get.quantity` from the get group, and no unit serves both. A unit in both
 * groups (buy a pizza, get a pizza) counts for whichever side needs it: the
 * dearest go to the buy side, and the cheapest of what is left are
 * discounted, so what is free is never worth more than what was bought.
 * `units` is sorted dearest first.
 */
function pairBuyGet(
	rule: Extract<DiscountRecord['quantityRule'], { kind: 'buy_get' }>,
	units: readonly Unit[],
	lines: readonly WorkingLine[],
	maxUnits: number | null,
): Unit[] | null {
	const inBuy = (unit: Unit) => lineInSet(rule.buy, lines[unit.lineIndex]!)
	const inGet = (unit: Unit) => lineInSet(rule.get, lines[unit.lineIndex]!)
	if (rule.buy.quantity === undefined) {
		return pairBySpend(
			rule.buy.spendMinor ?? Number.POSITIVE_INFINITY,
			rule.get.quantity,
			units.filter(inBuy),
			units.filter(inGet).sort(byValueAsc),
			maxUnits,
		)
	}
	const buyQuantity = rule.buy.quantity
	const onlyBuy = units.filter((unit) => inBuy(unit) && !inGet(unit))
	const onlyGet = units.filter((unit) => !inBuy(unit) && inGet(unit))
	const shared = units.filter((unit) => inBuy(unit) && inGet(unit))
	const getQuantity = rule.get.quantity
	// Enough units on each side, and enough in all that none is used twice.
	let repetitions = Math.min(
		Math.floor((onlyBuy.length + shared.length) / buyQuantity),
		Math.floor((onlyGet.length + shared.length) / getQuantity),
		Math.floor(
			(onlyBuy.length + onlyGet.length + shared.length) /
				(buyQuantity + getQuantity),
		),
	)
	if (maxUnits !== null) {
		repetitions = Math.min(repetitions, Math.floor(maxUnits / getQuantity))
	}
	if (repetitions < 1) return null
	const sharedForBuy = Math.max(0, repetitions * buyQuantity - onlyBuy.length)
	const getPool = [...onlyGet, ...shared.slice(sharedForBuy)].sort(byValueAsc)
	return getPool.slice(0, repetitions * getQuantity)
}

/**
 * Fill as many bundles as the cart allows and return them, each a list of
 * units. The guest gets the best price: slots take the dearest units, and the
 * dearest units go into the first bundle. Slots are filled scarcest first, so
 * a slot with few candidates isn't starved by one that overlaps it.
 * `units` is sorted dearest first.
 */
function formBundles(
	rule: Extract<DiscountRecord['quantityRule'], { kind: 'bundle' }>,
	units: readonly Unit[],
	lines: readonly WorkingLine[],
	maxUnits: number | null,
): Unit[][] | null {
	const candidates = rule.slots.map((slot) =>
		units.filter((unit) => lineInSet(slot, lines[unit.lineIndex]!)),
	)
	const bundleSize = rule.slots.reduce((sum, slot) => sum + slot.quantity, 0)
	let repetitions = Math.min(
		...rule.slots.map((slot, index) =>
			Math.floor(candidates[index]!.length / slot.quantity),
		),
		Math.floor(units.length / bundleSize),
	)
	if (maxUnits !== null) {
		repetitions = Math.min(repetitions, Math.floor(maxUnits / bundleSize))
	}
	const scarcest = rule.slots
		.map((_, index) => index)
		.sort((a, b) => candidates[a]!.length - candidates[b]!.length || a - b)
	for (; repetitions >= 1; repetitions--) {
		const taken = new Set<Unit>()
		const bySlot: Unit[][] = []
		let filled = true
		for (const index of scarcest) {
			const need = repetitions * rule.slots[index]!.quantity
			const picked = candidates[index]!.filter(
				(unit) => !taken.has(unit),
			).slice(0, need)
			if (picked.length < need) {
				filled = false
				break
			}
			for (const unit of picked) taken.add(unit)
			bySlot[index] = picked
		}
		if (!filled) continue
		return Array.from({ length: repetitions }, (_, bundle) =>
			rule.slots.flatMap((slot, index) =>
				bySlot[index]!.slice(
					bundle * slot.quantity,
					(bundle + 1) * slot.quantity,
				),
			),
		)
	}
	return null
}

/**
 * The modifier choices a discount targets, one unit each, dearest first. A
 * choice is worth its price for one unit of its line, less the share of that
 * unit an earlier discount already took. `unitIndex` is the item unit the
 * choice sits on, so "first N per item" can group by it.
 */
function modifierUnits(discount: DiscountRecord, state: State): Unit[] {
	const groups = discount.target.modifierGroupIds ?? []
	const options = discount.target.modifierOptionIds ?? []
	const picked: Unit[] = []
	state.lines.forEach((line, lineIndex) => {
		if (!lineMatchesTarget(discount, line)) return
		if (line.remaining <= 0 || line.unitMinor <= 0 || !line.options?.length) {
			return
		}
		for (const parent of unitsOf(line, lineIndex)) {
			// What the choices have left, whatever else was taken off the unit.
			const parts = unitParts(line, parent.unitIndex, parent.value)
			if (parts.optionsFull <= 0) continue
			for (const option of line.options) {
				if (
					!groups.includes(option.groupId) &&
					!options.includes(option.optionId)
				) {
					continue
				}
				const count = Math.max(1, option.quantity)
				const each = Math.floor(option.totalMinor / count)
				const extra = option.totalMinor % count
				for (let piece = 0; piece < count; piece += 1) {
					const full = each + (piece < extra ? 1 : 0)
					const value = mulDiv(full, parts.options, parts.optionsFull)
					if (value > 0) {
						picked.push({
							lineIndex,
							lineId: line.lineId,
							unitIndex: parent.unitIndex,
							value,
						})
					}
				}
			}
		}
	})
	return picked.sort(byValueDesc)
}

/** Keep the first `perItem` of each item unit; `units` is dearest first. */
function firstPerItem(units: readonly Unit[], perItem: number): Unit[] {
	const taken = new Map<string, number>()
	return units.filter((unit) => {
		const key = `${unit.lineIndex}:${unit.unitIndex}`
		const count = taken.get(key) ?? 0
		if (count >= perItem) return false
		taken.set(key, count + 1)
		return true
	})
}

/**
 * Discount the choices on an item rather than the item: "2 toppings free on
 * every pizza", "sauces 50% off". The value applies to each chosen choice, so
 * a percentage takes that share of the choice's price and a set price is what
 * each one costs. `maxDiscountedUnits` caps choices across the order, dearest
 * first.
 */
function applyModifiers(discount: DiscountRecord, state: State): ApplyResult {
	let units = modifierUnits(discount, state)
	if (units.length === 0) return { ok: false, reason: 'not_applicable' }
	const rule = discount.quantityRule
	if (rule.kind === 'per_item') units = firstPerItem(units, rule.quantity)
	if (discount.maxDiscountedUnits !== null) {
		units = units.slice(0, discount.maxDiscountedUnits)
	}
	const values = units.map((unit) => unit.value)
	const valueMinor = sumMinor(values)
	const price = discount.amountMinor ?? 0
	let shares: number[]
	if (discount.valueType === 'percent') {
		shares = allocateProportionally(
			Math.min(percentTotal(discount, state, valueMinor), valueMinor),
			values,
		)
	} else if (discount.valueType === 'fixed_price') {
		shares = values.map((value) => Math.max(0, value - price))
	} else {
		shares = values.map((value) => Math.min(price, value))
	}
	return finishSelection(units, shares, state, 'options')
}

/** `buy_get` and `bundle`: the rules that choose their own items. */
function applySetRule(
	discount: DiscountRecord,
	rule: Extract<DiscountRecord['quantityRule'], { kind: 'buy_get' | 'bundle' }>,
	state: State,
): ApplyResult {
	const units = eligibleUnits(discount, state)
	if (units.length === 0) return { ok: false, reason: 'not_applicable' }
	const price = discount.amountMinor ?? 0

	if (rule.kind === 'buy_get') {
		const discounted = pairBuyGet(
			rule,
			units,
			state.lines,
			discount.maxDiscountedUnits,
		)
		if (!discounted) return { ok: false, reason: 'quantity_not_met' }
		const values = discounted.map((unit) => unit.value)
		const valueMinor = sumMinor(values)
		let shares: number[]
		if (discount.valueType === 'percent') {
			shares = allocateProportionally(
				Math.min(percentTotal(discount, state, valueMinor), valueMinor),
				values,
			)
		} else if (discount.valueType === 'fixed_price') {
			shares = discounted.map((unit) =>
				Math.max(0, priceBasis(unit, state) - price),
			)
		} else {
			// Fixed: an amount off each discounted unit.
			shares = values.map((value) => Math.min(price, value))
		}
		return finishSelection(
			discounted,
			shares,
			state,
			discount.valueType === 'fixed_price' ? 'base' : undefined,
		)
	}

	const bundles = formBundles(
		rule,
		units,
		state.lines,
		discount.maxDiscountedUnits,
	)
	if (!bundles) return { ok: false, reason: 'quantity_not_met' }
	const selected = bundles.flat()
	const values = selected.map((unit) => unit.value)
	const valueMinor = sumMinor(values)
	const bundleValues = bundles.map((bundle) =>
		sumMinor(
			bundle.map((unit) =>
				discount.valueType === 'fixed_price'
					? priceBasis(unit, state)
					: unit.value,
			),
		),
	)
	let total: number
	if (discount.valueType === 'percent') {
		total = percentTotal(discount, state, valueMinor)
	} else if (discount.valueType === 'fixed_price') {
		// Each bundle is priced on its own, so a cheap one is never "topped up".
		total = sumMinor(bundleValues.map((value) => Math.max(0, value - price)))
	} else {
		total = sumMinor(bundleValues.map((value) => Math.min(price, value)))
	}
	// A set price comes off the bases only, so it is spread over the bases.
	const weights =
		discount.valueType === 'fixed_price'
			? selected.map((unit) => priceBasis(unit, state))
			: values
	const shares = allocateProportionally(
		Math.min(total, sumMinor(weights)),
		weights,
	)
	return finishSelection(
		selected,
		shares,
		state,
		discount.valueType === 'fixed_price' ? 'base' : undefined,
	)
}

/**
 * Which of the eligible units a quantity rule discounts. Only units that still
 * have value count, for every rule alike: a burger an earlier discount made
 * free counts neither towards "3 or more" nor towards a buy-one-get-one, just
 * as it can't be discounted again. `units` is sorted dearest first.
 */
function selectUnits(
	rule: Exclude<DiscountRecord['quantityRule'], { kind: 'buy_get' | 'bundle' }>,
	units: readonly Unit[],
): Unit[] | null {
	switch (rule.kind) {
		case 'none':
			return [...units]
		case 'per_item':
			// Only reached for a modifier target, which `applyModifiers` handles.
			return null
		case 'minimum':
			return units.length >= rule.quantity ? [...units] : null
		case 'exact': {
			const covered = Math.floor(units.length / rule.quantity) * rule.quantity
			return covered > 0 ? units.slice(0, covered) : null
		}
		case 'bogo': {
			// Highest value first, so what is free is never worth more than what
			// was bought. Only complete groups count: buy 2 get 1 with 4 items
			// discounts one, and a leftover unit is never discounted.
			const group = rule.buyQuantity + rule.getQuantity
			const complete = Math.floor(units.length / group) * group
			const picked = units
				.slice(0, complete)
				.filter((_, index) => index % group >= rule.buyQuantity)
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

/**
 * The discount a ladder gives for this cart: the highest step the customer has
 * reached, as an ordinary discount with that step's value. Spend counts what
 * the matching lines cost before any discount (like a minimum spend); quantity
 * counts their units.
 */
function resolveTier(
	discount: DiscountRecord,
	state: State,
):
	| { ok: true; discount: DiscountRecord }
	| { ok: false; reason: DiscountRefusalReason } {
	const { basis, steps } = discount.tiers!
	let reached = 0
	for (const line of state.lines) {
		// A line another discount made free still counts, like it does for a
		// minimum spend: the ladder reads the cart, not what is left to pay.
		if (!lineMatchesTarget(discount, line)) continue
		reached += basis === 'spend' ? lineTotalMinor(line) : line.quantity
	}
	let step: (typeof steps)[number] | null = null
	for (const candidate of steps) {
		if (reached >= candidate.at && (!step || candidate.at > step.at)) {
			step = candidate
		}
	}
	if (!step) {
		return {
			ok: false,
			reason: basis === 'spend' ? 'minimum_not_met' : 'quantity_not_met',
		}
	}
	return {
		ok: true,
		discount: {
			...discount,
			tiers: null,
			percentBp: step.percentBp,
			amountMinor: step.amountMinor,
		},
	}
}

/**
 * Compute one discount against `state` and, on success, take it off `state`.
 *
 * A fixed amount on items or categories normally comes off each matching unit
 * ("$2 off every burger"). A ladder step ("spend $30 on mains, get $5") and an
 * amount the cashier types are one amount for the whole selection instead,
 * spread over the units like an order discount: `fixedAsTotal`.
 */
function applyDiscount(
	definition: DiscountRecord,
	state: State,
	options: { fixedAsTotal?: boolean } = {},
): ApplyResult {
	let discount = definition
	const fixedAsTotal =
		options.fixedAsTotal === true || Boolean(definition.tiers)
	if (discount.tiers) {
		const tier = resolveTier(discount, state)
		if (!tier.ok) return tier
		discount = tier.discount
	}
	if (discount.valueType === 'free_delivery') {
		if (state.deliveryRemaining <= 0)
			return { ok: false, reason: 'not_applicable' }
		// A long-distance fee isn't waived by "free delivery" up to a limit.
		if (
			discount.maxDeliveryFeeMinor != null &&
			state.deliveryFeeMinor > discount.maxDeliveryFeeMinor
		) {
			return { ok: false, reason: 'not_applicable' }
		}
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
	if (discount.target.scope === 'modifiers') {
		return applyModifiers(discount, state)
	}
	const rule = discount.quantityRule
	if (rule.kind === 'buy_get' || rule.kind === 'bundle') {
		return applySetRule(discount, rule, state)
	}
	const eligible = eligibleUnits(discount, state)
	if (eligible.length === 0) return { ok: false, reason: 'not_applicable' }
	let selected = selectUnits(rule, eligible)
	if (!selected) return { ok: false, reason: 'quantity_not_met' }
	if (discount.maxDiscountedUnits !== null) {
		selected = selected.slice(0, discount.maxDiscountedUnits)
	}
	const values = selected.map((unit) => unit.value)
	const eligibleMinor = sumMinor(values)
	let shares: number[]
	if (discount.valueType === 'percent') {
		shares = allocateProportionally(
			Math.min(percentTotal(discount, state, eligibleMinor), eligibleMinor),
			values,
		)
	} else if (discount.valueType === 'fixed_price') {
		// Every matching unit costs the set price; one already cheaper stays so.
		shares = selected.map((unit) =>
			Math.max(0, priceBasis(unit, state) - (discount.amountMinor ?? 0)),
		)
	} else if (discount.target.scope === 'order' || fixedAsTotal) {
		shares = allocateProportionally(
			Math.min(discount.amountMinor ?? 0, eligibleMinor),
			values,
		)
	} else {
		shares = values.map((value) => Math.min(discount.amountMinor ?? 0, value))
	}
	return finishSelection(
		selected,
		shares,
		state,
		discount.valueType === 'fixed_price' ? 'base' : undefined,
	)
}

/** The percentage of `eligibleMinor`, rounded down and held to the cap. */
function percentTotal(
	discount: DiscountRecord,
	state: State,
	eligibleMinor: number,
): number {
	const total = mulDiv(eligibleMinor, discount.percentBp ?? 0, BASIS_POINTS)
	if (
		discount.maxDiscountMinor !== null &&
		(!discount.currency ||
			!state.currency ||
			sameCurrency(discount.currency, state.currency))
	) {
		return Math.min(total, discount.maxDiscountMinor)
	}
	return total
}

/**
 * Turn per-unit shares into per-line amounts and take them off `state`.
 * `selected[i]` receives `shares[i]`.
 */
function finishSelection(
	selected: readonly Unit[],
	shares: readonly number[],
	state: State,
	/** Where the money came from, when it was not spread over the whole unit. */
	part?: 'base' | 'options',
): ApplyResult {
	// No unit gives more than it has left, even when several selected entries
	// (modifier choices) sit on the same unit.
	const taken = shares.map((share, index) => {
		const unit = selected[index]!
		const line = state.lines[unit.lineIndex]!
		const left = line.unitRemaining[unit.unitIndex] ?? 0
		const amount = Math.max(0, Math.min(share, left))
		line.unitRemaining[unit.unitIndex] = left - amount
		if (part === 'base') line.unitBaseTaken[unit.unitIndex]! += amount
		if (part === 'options') line.unitOptionsTaken[unit.unitIndex]! += amount
		line.remaining -= amount
		return amount
	})
	const amountMinor = sumMinor(taken)
	if (amountMinor <= 0) return { ok: false, reason: 'not_applicable' }
	const perLine = new Map<number, AppliedDiscountLine>()
	selected.forEach((unit, index) => {
		const line = state.lines[unit.lineIndex]!
		let entry = perLine.get(unit.lineIndex)
		if (!entry) {
			entry = { lineId: line.lineId, amountMinor: 0, units: 0 }
			perLine.set(unit.lineIndex, entry)
		}
		entry.amountMinor += taken[index]!
		entry.units += 1
	})
	const lines = [...perLine.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, entry]) => entry)
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

/**
 * Automatic discounts that compete in one cart. More than this is not
 * expected; the first by `byPriority` (lowest priority number, then older, then
 * id) compete and the rest are ignored. The planner is exponential
 * in this number, so it is kept small: crafted configurations cost far less
 * than they did at 24. Documented in docs/discounts-plan.md.
 */
const MAX_COMPETING_AUTOMATIC = 12

/** Two discounts stack only if each allows the other's kind. */
function compatible(a: DiscountRecord, b: DiscountRecord): boolean {
	return (
		combinesWithOf(a).includes(discountClassOf(b)) &&
		combinesWithOf(b).includes(discountClassOf(a))
	)
}

/** Bron-Kerbosch with pivoting: every largest group that all stack together. */
function maximalCliques(adjacent: readonly (readonly boolean[])[]): number[][] {
	const found: number[][] = []
	const expand = (chosen: number[], pool: number[], seen: number[]) => {
		if (pool.length === 0) {
			if (seen.length === 0) found.push([...chosen].sort((a, b) => a - b))
			return
		}
		let pivot = pool[0]!
		let reach = -1
		for (const node of [...pool, ...seen]) {
			const count = pool.filter((other) => adjacent[node]![other]).length
			if (count > reach) {
				reach = count
				pivot = node
			}
		}
		let remaining = pool
		let visited = seen
		for (const node of pool.filter((other) => !adjacent[pivot]![other])) {
			expand(
				[...chosen, node],
				remaining.filter((other) => adjacent[node]![other]),
				visited.filter((other) => adjacent[node]![other]),
			)
			remaining = remaining.filter((other) => other !== node)
			visited = [...visited, node]
		}
	}
	expand(
		[],
		adjacent.map((_, index) => index),
		[],
	)
	return found
}

/**
 * One plan for each largest group of candidates that may stack together, each
 * applied in order (the candidates' order, so a code, last). With `mustInclude`
 * only groups holding that candidate. No candidates is one plan that applies
 * nothing.
 */
function stackPlans(
	candidates: readonly Candidate[],
	from: State,
	mustInclude: number | null,
): Plan[] {
	if (candidates.length === 0) return [runPlan([], from)]
	const adjacent = candidates.map((a, row) =>
		candidates.map(
			(b, column) => row !== column && compatible(a.discount, b.discount),
		),
	)
	const groups = maximalCliques(adjacent)
	// Stacking more is almost always worth more, but rounding can make a group
	// worth a cent or two less than part of it (a later percentage rounds down
	// on what an earlier one left). Every single discount and every compatible
	// pair also competes, so a guest never gets less for qualifying for more.
	// At most 12 + 66 extra plans of one or two discounts each; they come after
	// the full groups, so on an equal total the full group still wins.
	for (let a = 0; a < candidates.length; a += 1) {
		groups.push([a])
		for (let b = a + 1; b < candidates.length; b += 1) {
			if (adjacent[a]![b]) groups.push([a, b])
		}
	}
	return groups
		.filter((group) => mustInclude === null || group.includes(mustInclude))
		.map((group) =>
			runPlan(
				group.map((index) => candidates[index]!),
				from,
			),
		)
}

function bestPlan(plans: readonly Plan[]): Plan {
	let best = plans[0]!
	for (const plan of plans.slice(1)) {
		if (comparePlans(plan, best) < 0) best = plan
	}
	return best
}

/** Older first, by the instant (not the text: offsets and precision vary). */
function byCreatedAt(a: DiscountRecord, b: DiscountRecord): number {
	const left = Date.parse(a.createdAt)
	const right = Date.parse(b.createdAt)
	const leftOk = Number.isFinite(left)
	const rightOk = Number.isFinite(right)
	// An unreadable instant sorts last; the schema rejects one anyway.
	if (leftOk && rightOk) return left - right
	return leftOk === rightOk ? 0 : leftOk ? -1 : 1
}

function byPriority(a: DiscountRecord, b: DiscountRecord): number {
	return (
		a.priority - b.priority ||
		byCreatedAt(a, b) ||
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
	assertCart(input.lines)
	const fee = input.context.deliveryFeeMinor
	const deliveryFee = Number.isSafeInteger(fee) && fee > 0 ? fee : 0
	const start: State = {
		lines: workingLines(input.lines),
		deliveryRemaining: deliveryFee,
		deliveryFeeMinor: deliveryFee,
		currency: input.currency,
	}

	const automatic = input.discounts
		.filter((discount) => discount.application === 'automatic')
		.filter((discount) => refusalFor(discount, input) === null)
		.sort(byPriority)
		.slice(0, MAX_COMPETING_AUTOMATIC)
		.map((discount): Candidate => ({ discount, code: null }))

	let best = bestPlan(stackPlans(automatic, start, null))

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
				refusalFor(discount, input) ??
				(record.maxUses !== null &&
				(input.codeUsage[record.id] ?? 0) >= record.maxUses
					? 'limit_reached'
					: null)
			const alone = refusal ? null : applyDiscount(discount, cloneState(start))
			if (refusal) {
				outcome = { status: 'refused', reason: refusal }
			} else if (alone && !alone.ok) {
				outcome = { status: 'refused', reason: alone.reason }
			} else {
				// The code stacks with whichever automatic discounts it is
				// compatible with, and the guest gets the larger of that and the
				// best stack without it.
				const candidates = [...automatic, { discount, code: record }]
				const withCode = stackPlans(
					candidates,
					start,
					candidates.length - 1,
				).filter((plan) =>
					plan.applied.some((entry) => entry.discountId === discount.id),
				)
				const stacked = withCode.length > 0 ? bestPlan(withCode) : null
				if (stacked && stacked.totalMinor >= best.totalMinor) {
					best = stacked
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

/**
 * Price one manual discount the cashier picked. A variable discount uses the
 * amount or percentage they typed; a fixed one uses the definition. The cap
 * on a variable discount is `maxDiscountMinor`.
 */
export function quoteManualDiscount(input: {
	discount: DiscountRecord
	lines: readonly DiscountCartLine[]
	amountMinor?: number | null
	percentBp?: number | null
	/** When set, dates, location, channel and currency are checked first. */
	currency?: string
	context?: DiscountContext
}):
	| { ok: true; amountMinor: number }
	| { ok: false; reason: DiscountRefusalReason } {
	if (input.discount.application !== 'manual') {
		return { ok: false, reason: 'not_applicable' }
	}
	assertCart(input.lines)
	if (input.context && input.currency) {
		const refusal = refusalFor(input.discount, {
			currency: input.currency,
			lines: input.lines,
			context: input.context,
			discounts: [],
			codes: [],
			usage: {},
			codeUsage: {},
		})
		if (refusal) return { ok: false, reason: refusal }
	}
	let priced = input.discount
	if (
		input.discount.valueType === 'variable_percent' ||
		input.discount.valueType === 'percent'
	) {
		const percentBp =
			input.discount.valueType === 'percent'
				? input.discount.percentBp
				: (input.percentBp ?? null)
		if (
			percentBp === null ||
			!Number.isSafeInteger(percentBp) ||
			percentBp < 1 ||
			percentBp > 10_000
		) {
			return { ok: false, reason: 'not_applicable' }
		}
		priced = {
			...input.discount,
			valueType: 'percent',
			percentBp,
			amountMinor: null,
		}
	} else if (
		input.discount.valueType === 'variable_amount' ||
		input.discount.valueType === 'fixed'
	) {
		let amount =
			input.discount.valueType === 'fixed'
				? input.discount.amountMinor
				: (input.amountMinor ?? null)
		if (amount === null || !Number.isSafeInteger(amount) || amount < 1) {
			return { ok: false, reason: 'not_applicable' }
		}
		if (
			input.discount.maxDiscountMinor !== null &&
			(!input.discount.currency ||
				!input.currency ||
				sameCurrency(input.discount.currency, input.currency))
		) {
			amount = Math.min(amount, input.discount.maxDiscountMinor)
		}
		priced = {
			...input.discount,
			valueType: 'fixed',
			amountMinor: amount,
			percentBp: null,
		}
	} else {
		return { ok: false, reason: 'not_applicable' }
	}
	const state: State = {
		lines: workingLines(input.lines),
		deliveryRemaining: 0,
		deliveryFeeMinor: 0,
		currency: input.currency,
	}
	// An amount the cashier types is for the whole selection, not per unit:
	// $5 off the burgers is $5, however many there are.
	const result = applyDiscount(priced, state, {
		fixedAsTotal: input.discount.valueType === 'variable_amount',
	})
	if (!result.ok) return result
	return { ok: true, amountMinor: result.amountMinor }
}

/** Negative when `a` beats `b`: bigger total, then lower priority, then older. */
function comparePlans(a: Plan, b: Plan): number {
	if (a.totalMinor !== b.totalMinor) return b.totalMinor - a.totalMinor
	if (a.lead && b.lead) return byPriority(a.lead, b.lead)
	return a.lead ? -1 : b.lead ? 1 : 0
}

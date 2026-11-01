import {
	allocateProportionally,
	combinesWithOf,
	discountClassOf,
	discountRecordSchema,
	evaluateDiscounts,
	localNowString,
	quoteManualDiscount,
	type AppliedDiscount,
	type DiscountFulfillment,
	type DiscountRecord,
} from '@repo/discounts'
import {
	lineTotalCents,
	lineUnitCents,
	type Adjustment,
	type CartLine,
} from './pricing.ts'
import {
	type CatalogSnapshot,
	type MenuCategory,
	type MenuItem,
} from './types.ts'

/**
 * Rules older than this are not applied: the till cannot know whether a
 * discount was paused, edited or ended since. Automatic and manual alike.
 */
export const TILL_RULES_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type TillRulesStatus =
	| { state: 'none' }
	| { state: 'fresh'; fetchedAt: number }
	| { state: 'expired'; fetchedAt: number }

/**
 * Whether the rules on this device may still be applied. A catalog stored before
 * rules carried a stamp uses the catalog's own fetch time.
 */
export function tillRulesStatus(
	snapshot: Pick<CatalogSnapshot, 'fetchedAt' | 'menu'> | null | undefined,
	now = Date.now(),
): TillRulesStatus {
	const rules = snapshot?.menu.discountRules
	if (!snapshot || !Array.isArray(rules) || rules.length === 0)
		return { state: 'none' }
	const fetchedAt = snapshot.menu.discountRulesAt ?? snapshot.fetchedAt
	return now - fetchedAt > TILL_RULES_MAX_AGE_MS
		? { state: 'expired', fetchedAt }
		: { state: 'fresh', fetchedAt }
}

/**
 * A discount with a use limit needs a count of uses the till cannot have
 * offline, so it never applies by itself at the till.
 */
export const isLimitedDiscount = (rule: DiscountRecord): boolean =>
	rule.totalLimit !== null || rule.perCustomerLimit !== null

/** Automatic rules the till skips for their use limits (they still apply online). */
export function limitedAutomaticRules(rules: unknown): DiscountRecord[] {
	return parseTillRules(rules).filter(
		(rule) =>
			rule.application === 'automatic' &&
			rule.status === 'active' &&
			isLimitedDiscount(rule),
	)
}

/** Two discounts stack only when each allows the other's kind. */
export function discountsStack(a: DiscountRecord, b: DiscountRecord): boolean {
	return (
		combinesWithOf(a).includes(discountClassOf(b)) &&
		combinesWithOf(b).includes(discountClassOf(a))
	)
}

export function parseTillRules(rules: unknown): DiscountRecord[] {
	if (!Array.isArray(rules)) return []
	const parsed: DiscountRecord[] = []
	for (const rule of rules) {
		const result = discountRecordSchema.safeParse(rule)
		if (result.success && result.data.channels.includes('pos')) {
			parsed.push(result.data)
		}
	}
	return parsed
}

export function categoryIdsByItem(
	categories: readonly MenuCategory[],
): Map<string, string[]> {
	const map = new Map<string, string[]>()
	// The category the item is directly in, never its parents: the server
	// (`collectMenuCategories`) matches a category discount the same way, so
	// "Pizza" does not discount the items in Pizza > Veg at the till only.
	const walk = (rows: readonly MenuCategory[]) => {
		for (const category of rows) {
			for (const item of category.items) {
				const existing = map.get(item.id) ?? []
				map.set(item.id, [...new Set([...existing, category.id])])
			}
			if (category.subcategories) walk(category.subcategories)
		}
	}
	walk(categories)
	return map
}

function cartLines(
	lines: readonly CartLine[],
	categories: Map<string, string[]>,
	items: ReadonlyMap<string, MenuItem>,
) {
	return lines.map((line) => {
		const item = items.get(line.itemId)
		const variant = item?.variations.variants.find(
			(row) => row.id === line.variantId,
		)
		return {
			lineId: line.id,
			itemId: line.itemId,
			variantId: line.variantId,
			categoryIds: categories.get(line.itemId) ?? [],
			quantity: line.quantity,
			unitMinor: lineUnitCents(line),
			baseUnitMinor: line.baseCents,
			variantNames:
				item && variant
					? item.variations.groups.flatMap((group) =>
							group.values
								.filter((value) => variant.valueIds.includes(value.id))
								.map((value) => value.name),
						)
					: undefined,
			options: line.options.map((option) => ({
				groupId: option.groupId,
				optionId: option.optionId,
				quantity: option.quantity,
				totalMinor: option.unitCents * option.quantity,
			})),
			excluded:
				item?.excludeFromDiscounts === true ||
				variant?.excludeFromDiscounts === true,
		}
	})
}

type TillContext = {
	categories: readonly MenuCategory[]
	items: ReadonlyMap<string, MenuItem>
	timeZone: string
	currency: string
	locationId: string | null
	fulfillment: DiscountFulfillment
}

function evaluationContext(input: TillContext, at: Date) {
	return {
		channel: 'pos' as const,
		fulfillment: input.fulfillment,
		locationId: input.locationId,
		isDrop: false,
		localNow: localNowString(at.getTime(), input.timeZone),
		deliveryFeeMinor: 0,
		customer: {
			signedIn: false,
			isNewCustomer: false,
			isLoyaltyMember: false,
		},
	}
}

function evaluateAutomatic(
	lines: readonly CartLine[],
	discounts: readonly DiscountRecord[],
	input: TillContext,
	at: Date,
): AppliedDiscount[] {
	if (discounts.length === 0 || lines.length === 0) return []
	return evaluateDiscounts({
		currency: input.currency,
		lines: cartLines(lines, categoryIdsByItem(input.categories), input.items),
		context: evaluationContext(input, at),
		discounts,
		codes: [],
		usage: {},
		codeUsage: {},
	}).applied
}

/**
 * Automatic discounts for the cart, one adjustment per discount with the
 * amount each line took.
 *
 * A tab is priced round by round. A round keeps the discounts it had when it
 * was sent: an expired happy hour never reprices what was already served. Each
 * round is evaluated with every earlier round, at the time it was sent (the
 * unsent lines at `now`), and it adds only what the discounts newly give; a
 * discount never grows smaller than it was. Discounts with a use limit never
 * apply here (the till cannot count uses offline), and `excludeIds` leaves out
 * automatic discounts that do not stack with a manual one.
 *
 * `kept` is the automatic rows the order already carries. What they gave sent
 * lines is a floor: a rule that was paused, deleted, edited smaller or is no
 * longer served at all (an empty list, rules too old) never takes it back. The
 * current rules may only add discounts that stack with what a line carries, or
 * grow an amount. Unsent lines come from the current rules alone.
 */
export function automaticTillAdjustments(
	input: TillContext & {
		lines: readonly CartLine[]
		rules: unknown
		now?: Date
		excludeIds?: ReadonlySet<string>
		kept?: readonly Adjustment[]
	},
): Adjustment[] {
	const allRules = parseTillRules(input.rules)
	const discounts = allRules.filter(
		(rule) =>
			rule.application === 'automatic' &&
			!isLimitedDiscount(rule) &&
			!input.excludeIds?.has(rule.id),
	)
	const keptRows = keptAutomaticRows(input.lines, input.kept, input.excludeIds)
	if (input.lines.length === 0) return []
	if (discounts.length === 0 && keptRows.size === 0) return []
	const nowMs = (input.now ?? new Date()).getTime()
	const timeOf = (line: CartLine) => line.sentAt ?? nowMs
	const times = [...new Set(input.lines.map(timeOf))].sort((a, b) => a - b)

	type Row = {
		discountId: string
		name: string
		version: number
		lines: Map<string, number>
	}
	const rows = new Map<string, Row>()
	// Every known rule, paused or limited too: a line carrying one still
	// decides what may join it.
	const ruleById = new Map(allRules.map((rule) => [rule.id, rule]))
	// Which discounts each line already carries from earlier rounds.
	const carried = new Map<string, Set<string>>()
	let previous = new Map<string, Map<string, number>>()
	for (const [discountId, kept] of keptRows) {
		rows.set(discountId, {
			discountId,
			name: kept.name,
			version: kept.version,
			lines: new Map(kept.lines),
		})
		previous.set(discountId, new Map(kept.lines))
		for (const lineId of kept.lines.keys()) {
			const held = carried.get(lineId) ?? new Set<string>()
			held.add(discountId)
			carried.set(lineId, held)
		}
	}
	for (const time of times) {
		const cart = input.lines.filter((line) => timeOf(line) <= time)
		const applied = evaluateAutomatic(cart, discounts, input, new Date(time))
		const current = new Map<string, Map<string, number>>()
		for (const discount of applied) {
			const byLine = new Map<string, number>()
			for (const line of discount.lines)
				if (line.amountMinor > 0) byLine.set(line.lineId, line.amountMinor)
			current.set(discount.discountId, byLine)
			const row = rows.get(discount.discountId) ?? {
				discountId: discount.discountId,
				name: discount.name,
				version: discount.version,
				lines: new Map<string, number>(),
			}
			const before = previous.get(discount.discountId)
			const rule = ruleById.get(discount.discountId)
			for (const [lineId, amount] of byLine) {
				const added = amount - (before?.get(lineId) ?? 0)
				if (added <= 0) continue
				// A line sent earlier keeps what it had. A discount it did not
				// carry joins only when it stacks with every one it does carry;
				// otherwise the later rule would pile on top of a rule the web
				// engine would have made the line choose between.
				if (!before?.has(lineId) && rule) {
					const held = carried.get(lineId)
					let blocked = false
					for (const heldId of held ?? []) {
						const heldRule = ruleById.get(heldId)
						// A rule no longer served cannot say it combines: nothing joins it.
						if (!heldRule || !discountsStack(rule, heldRule)) {
							blocked = true
							break
						}
					}
					if (blocked) continue
				}
				row.lines.set(lineId, (row.lines.get(lineId) ?? 0) + added)
				// It grew under today's rule, so it is that version's now.
				row.version = discount.version
				row.name = discount.name
			}
			rows.set(discount.discountId, row)
		}
		for (const row of rows.values())
			for (const lineId of row.lines.keys()) {
				const held = carried.get(lineId) ?? new Set<string>()
				held.add(row.discountId)
				carried.set(lineId, held)
			}
		// What an earlier round got is kept even when this moment's evaluation
		// no longer gives it (a rule that has ended since).
		previous = mergeMax(previous, current)
	}

	// No line can lose more than it costs, whatever the rounds added up to.
	const lineById = new Map(input.lines.map((line) => [line.id, line]))
	const remaining = new Map(
		input.lines.map((line) => [line.id, lineTotalCents(line)]),
	)
	const adjustments: Adjustment[] = []
	for (const row of rows.values()) {
		const lineAmounts: Record<string, number> = {}
		let amountCents = 0
		for (const [lineId, amount] of row.lines) {
			const left = remaining.get(lineId) ?? 0
			const scaled = scaleSentLineDiscount(lineById.get(lineId), amount)
			const taken = Math.min(scaled, left)
			if (taken <= 0) continue
			remaining.set(lineId, left - taken)
			lineAmounts[lineId] = taken
			amountCents += taken
		}
		if (amountCents <= 0) continue
		adjustments.push({
			id: `auto:${row.discountId}`,
			kind: 'discount',
			label: row.name,
			amountCents,
			lineAmounts,
			version: row.version,
		})
	}
	return adjustments
}

type KeptRow = { name: string; version: number; lines: Map<string, number> }

/** Sent lines that were voided down keep discount amounts in proportion. */
function scaleSentLineDiscount(
	line: CartLine | undefined,
	amountMinor: number,
): number {
	if (amountMinor <= 0) return 0
	if (!line?.sentAt) return amountMinor
	const sentQty = line.sentQuantity ?? line.quantity
	if (sentQty <= 0 || sentQty === line.quantity) return amountMinor
	return Math.floor((amountMinor * line.quantity) / sentQty)
}

/**
 * The amounts the order's automatic rows already gave lines that were sent and
 * are still on the order, by discount id. An unsent line is never kept: it is
 * priced from the rules again.
 */
function keptAutomaticRows(
	lines: readonly CartLine[],
	kept: readonly Adjustment[] | undefined,
	excludeIds: ReadonlySet<string> | undefined,
): Map<string, KeptRow> {
	const out = new Map<string, KeptRow>()
	const sent = new Set(lines.filter((line) => line.sentAt).map((l) => l.id))
	for (const row of kept ?? []) {
		if (!row.id.startsWith('auto:') || row.kind !== 'discount') continue
		const discountId = row.id.slice('auto:'.length)
		if (!discountId || excludeIds?.has(discountId)) continue
		const byLine = new Map<string, number>()
		for (const [lineId, amount] of Object.entries(row.lineAmounts ?? {}))
			if (sent.has(lineId) && amount > 0) byLine.set(lineId, amount)
		if (byLine.size === 0) continue
		out.set(discountId, {
			name: row.label,
			version: row.version ?? 0,
			lines: byLine,
		})
	}
	return out
}

/**
 * Labels of the automatic discounts a sent round still carries that the rules
 * on this device no longer offer (deleted, paused, limited or not for the till).
 * A rule that merely is not running right now (a happy hour that ended) is
 * still offered.
 */
export function keptButNotOffered(input: {
	rules: unknown
	lines: readonly CartLine[]
	adjustments: readonly Adjustment[]
}): { ids: string[]; names: string[] } {
	const offered = new Set(
		parseTillRules(input.rules)
			.filter(
				(rule) =>
					rule.application === 'automatic' &&
					rule.status === 'active' &&
					!isLimitedDiscount(rule),
			)
			.map((rule) => rule.id),
	)
	const kept = keptAutomaticRows(input.lines, input.adjustments, undefined)
	const ids: string[] = []
	const names: string[] = []
	for (const [discountId, row] of kept) {
		if (offered.has(discountId)) continue
		ids.push(discountId)
		names.push(row.name)
	}
	return { ids: ids.sort(), names }
}

function mergeMax(
	a: Map<string, Map<string, number>>,
	b: Map<string, Map<string, number>>,
): Map<string, Map<string, number>> {
	const out = new Map<string, Map<string, number>>()
	for (const source of [a, b]) {
		for (const [discountId, lines] of source) {
			const merged = out.get(discountId) ?? new Map<string, number>()
			for (const [lineId, amount] of lines)
				merged.set(lineId, Math.max(merged.get(lineId) ?? 0, amount))
			out.set(discountId, merged)
		}
	}
	return out
}

/** Sum of what each line has already lost to the given adjustments. */
export function lineAmountsOf(
	adjustments: readonly Adjustment[],
): Record<string, number> {
	const total: Record<string, number> = {}
	for (const adjustment of adjustments)
		for (const [lineId, amount] of Object.entries(adjustment.lineAmounts ?? {}))
			total[lineId] = (total[lineId] ?? 0) + amount
	return total
}

/**
 * Shrink each line by what it already lost to earlier discounts, so a manual
 * discount is quoted on the running total: a 100% discount cannot take more
 * than is left, and excluded items stay untouched.
 */
function shrinkByLine(
	lines: readonly CartLine[],
	priorByLine: Readonly<Record<string, number>>,
): CartLine[] {
	return lines.map((line) => {
		const total = lineTotalCents(line)
		const prior = Math.min(priorByLine[line.id] ?? 0, total)
		if (prior <= 0 || total <= 0) return line
		const factor = (total - prior) / total
		return {
			...line,
			baseCents: Math.max(0, Math.round(line.baseCents * factor)),
			options: line.options.map((option) => ({
				...option,
				unitCents: Math.max(0, Math.round(option.unitCents * factor)),
			})),
		}
	})
}

function isExcludedLine(
	line: CartLine,
	items: ReadonlyMap<string, MenuItem> | undefined,
): boolean {
	const item = items?.get(line.itemId)
	const variant = item?.variations.variants.find(
		(row) => row.id === line.variantId,
	)
	return (
		item?.excludeFromDiscounts === true ||
		variant?.excludeFromDiscounts === true
	)
}

/** A prior total spread over the lines it could have touched, when no line split is known. */
function spreadPrior(
	lines: readonly CartLine[],
	priorMinor: number,
	items: ReadonlyMap<string, MenuItem> | undefined,
): Record<string, number> {
	const eligible = lines.filter((line) => !isExcludedLine(line, items))
	const totals = eligible.map(lineTotalCents)
	const sum = totals.reduce((a, b) => a + b, 0)
	if (priorMinor <= 0 || sum <= 0) return {}
	const shares = allocateProportionally(Math.min(priorMinor, sum), totals)
	return Object.fromEntries(
		eligible.map((line, index) => [line.id, shares[index]!]),
	)
}

export type ManualRefusal =
	| 'not_found'
	| 'rules_stale'
	| 'value_required'
	| 'over_100'
	| 'over_max'
	| 'over_bill'
	| 'not_applicable'
	| (string & {})

export type ManualQuote =
	| {
			ok: true
			amountMinor: number
			label: string
			lineAmounts: Record<string, number>
	  }
	| { ok: false; reason: ManualRefusal; maxMinor?: number }

/** The discount as the engine prices it: the typed value in place of a variable one. */
function pricedManual(
	discount: DiscountRecord,
	input: { amountMinor?: number | null; percentBp?: number | null },
): DiscountRecord | null {
	if (
		discount.valueType === 'percent' ||
		discount.valueType === 'variable_percent'
	) {
		const percentBp =
			discount.valueType === 'percent' ? discount.percentBp : input.percentBp
		if (percentBp == null || !Number.isSafeInteger(percentBp)) return null
		return {
			...discount,
			application: 'automatic',
			valueType: 'percent',
			percentBp,
			amountMinor: null,
		}
	}
	if (
		discount.valueType === 'fixed' ||
		discount.valueType === 'variable_amount'
	) {
		let amount =
			discount.valueType === 'fixed' ? discount.amountMinor : input.amountMinor
		if (amount == null || !Number.isSafeInteger(amount)) return null
		if (discount.maxDiscountMinor !== null)
			amount = Math.min(amount, discount.maxDiscountMinor)
		return {
			...discount,
			application: 'automatic',
			valueType: 'fixed',
			amountMinor: amount,
			percentBp: null,
		}
	}
	return null
}

export function quoteTillManualDiscount(input: {
	discount: DiscountRecord
	lines: readonly CartLine[]
	categories: readonly MenuCategory[]
	items: ReadonlyMap<string, MenuItem>
	amountMinor?: number | null
	percentBp?: number | null
	/** What each line already lost to earlier discounts (preferred). */
	priorLineAmounts?: Readonly<Record<string, number>>
	/** A whole-sale prior total, when no line split is known. */
	priorDiscountMinor?: number
	currency?: string
	timeZone?: string
	locationId?: string | null
	fulfillment?: DiscountFulfillment
	now?: Date
}): ManualQuote {
	const { discount } = input
	// Say what is wrong with a typed value before the engine refuses it.
	if (discount.valueType === 'variable_percent') {
		if (input.percentBp == null || !(input.percentBp >= 1))
			return { ok: false, reason: 'value_required' }
		if (input.percentBp > 10_000) return { ok: false, reason: 'over_100' }
	}
	if (discount.valueType === 'variable_amount') {
		if (input.amountMinor == null || !(input.amountMinor >= 1))
			return { ok: false, reason: 'value_required' }
		if (
			discount.maxDiscountMinor !== null &&
			input.amountMinor > discount.maxDiscountMinor
		)
			return {
				ok: false,
				reason: 'over_max',
				maxMinor: discount.maxDiscountMinor,
			}
	}
	const prior =
		input.priorLineAmounts ??
		spreadPrior(input.lines, input.priorDiscountMinor ?? 0, input.items)
	const lines = shrinkByLine(input.lines, prior)
	const remaining = new Map(
		input.lines.map((line) => [
			line.id,
			Math.max(0, lineTotalCents(line) - (prior[line.id] ?? 0)),
		]),
	)
	const context: TillContext = {
		categories: input.categories,
		items: input.items,
		timeZone: input.timeZone ?? 'UTC',
		currency: input.currency ?? 'USD',
		locationId: input.locationId ?? null,
		fulfillment: input.fulfillment ?? 'pickup',
	}
	const at = input.now ?? new Date()
	const quoted = quoteManualDiscount({
		discount,
		lines: cartLines(lines, categoryIdsByItem(input.categories), input.items),
		amountMinor: input.amountMinor,
		percentBp: input.percentBp,
		currency: context.currency,
		context: evaluationContext(context, at),
	})
	if (!quoted.ok) return quoted
	if (quoted.amountMinor < 1) return { ok: false, reason: 'not_applicable' }

	// Which line took what, from the same engine run as an automatic discount.
	const priced = pricedManual(discount, input)
	const applied = priced
		? evaluateAutomatic(lines, [priced], context, at)[0]
		: undefined
	const weights = (applied?.lines ?? []).filter((row) => row.amountMinor > 0)
	const wholeBill =
		discount.valueType === 'percent'
			? discount.percentBp === 10_000
			: input.percentBp === 10_000
	let split = new Map<string, number>()
	if (weights.length > 0) {
		const shares = allocateProportionally(
			quoted.amountMinor,
			weights.map((row) => row.amountMinor),
		)
		weights.forEach((row, index) => split.set(row.lineId, shares[index]!))
		// Rounding on shrunken lines can leave a cent: a full discount takes all.
		if (wholeBill)
			split = new Map(
				weights.map((row) => [row.lineId, remaining.get(row.lineId) ?? 0]),
			)
	}
	const lineAmounts: Record<string, number> = {}
	let amountMinor = 0
	for (const [lineId, amount] of split) {
		const taken = Math.min(amount, remaining.get(lineId) ?? 0)
		if (taken <= 0) continue
		lineAmounts[lineId] = taken
		amountMinor += taken
	}
	if (amountMinor < 1) return { ok: false, reason: 'not_applicable' }
	// A typed amount larger than what it can take off is an error, not a silent cap.
	if (
		discount.valueType === 'variable_amount' &&
		input.amountMinor != null &&
		amountMinor < input.amountMinor
	)
		return { ok: false, reason: 'over_bill', maxMinor: amountMinor }
	return { ok: true, amountMinor, label: discount.name, lineAmounts }
}

/** What the cashier asked for: one manual discount, with the typed value and who approved it. */
export type ManualRequest = {
	discountId: string
	amountMinor?: number | null
	percentBp?: number | null
	approvedByStaffId?: string
	reason?: string
}

/** The till id of a manual discount. A variable one keeps the typed value in it. */
export function manualRowId(
	discount: Pick<DiscountRecord, 'id' | 'valueType'>,
	input: { amountMinor?: number | null; percentBp?: number | null },
): string {
	if (discount.valueType === 'variable_percent' && input.percentBp)
		return `manual:${discount.id}:bp:${input.percentBp}`
	if (discount.valueType === 'variable_amount' && input.amountMinor)
		return `manual:${discount.id}:amt:${input.amountMinor}`
	return `manual:${discount.id}`
}

/** The request behind a manual adjustment already in the cart, to quote it again. */
export function manualRequestFromRow(row: Adjustment): ManualRequest | null {
	if (!row.id.startsWith('manual:')) return null
	const [, discountId, kind, raw] = row.id.split(':')
	if (!discountId) return null
	return {
		discountId,
		percentBp: kind === 'bp' ? Number(raw) : null,
		amountMinor: kind === 'amt' ? Number(raw) : null,
		...(row.approvedByStaffId
			? { approvedByStaffId: row.approvedByStaffId }
			: {}),
		...(row.reason ? { reason: row.reason } : {}),
	}
}

export type SettledDiscounts = {
	automatic: Adjustment[]
	/** Null when no manual discount was asked for. */
	manual:
		| { ok: true; adjustment: Adjustment }
		| { ok: false; reason: ManualRefusal; maxMinor?: number }
		| null
	/** Names of automatic discounts a manual one replaced because they do not stack. */
	replaced: string[]
}

/**
 * Everything the till takes off a cart: the automatic discounts, then at most
 * one manual discount quoted on what is left. A manual discount that does not
 * stack with an automatic one replaces it. With rules too old to trust
 * (`rulesUsable` false) nothing applies and a manual request is refused.
 */
export function settleTillDiscounts(
	input: TillContext & {
		lines: readonly CartLine[]
		rules: unknown
		rulesUsable: boolean
		manual: ManualRequest | null
		now?: Date
		/** The order's automatic rows: what sent rounds keep (see `automaticTillAdjustments`). */
		kept?: readonly Adjustment[]
	},
): SettledDiscounts {
	if (!input.rulesUsable) {
		return {
			// Rules too old to apply give nothing new, and take nothing back.
			automatic: automaticTillAdjustments({ ...input, rules: [] }),
			manual: input.manual ? { ok: false, reason: 'rules_stale' } : null,
			replaced: [],
		}
	}
	const rules = parseTillRules(input.rules)
	const manualRule = input.manual
		? rules.find(
				(rule) =>
					rule.id === input.manual!.discountId && rule.application === 'manual',
			)
		: undefined
	if (input.manual && !manualRule) {
		return {
			automatic: automaticTillAdjustments(input),
			manual: { ok: false, reason: 'not_found' },
			replaced: [],
		}
	}
	const conflicts = new Set(
		manualRule
			? rules
					.filter(
						(rule) =>
							rule.application === 'automatic' &&
							!isLimitedDiscount(rule) &&
							!discountsStack(manualRule, rule),
					)
					.map((rule) => rule.id)
			: [],
	)
	const automatic = automaticTillAdjustments({
		...input,
		excludeIds: conflicts,
	})
	let replaced: string[] = []
	if (conflicts.size > 0) {
		replaced = automaticTillAdjustments(input)
			.filter((row) => conflicts.has(row.id.slice('auto:'.length)))
			.map((row) => row.label)
	}
	if (!input.manual || !manualRule) return { automatic, manual: null, replaced }
	const quoted = quoteTillManualDiscount({
		discount: manualRule,
		lines: input.lines,
		categories: input.categories,
		items: input.items,
		amountMinor: input.manual.amountMinor,
		percentBp: input.manual.percentBp,
		priorLineAmounts: lineAmountsOf(automatic),
		currency: input.currency,
		timeZone: input.timeZone,
		locationId: input.locationId,
		fulfillment: input.fulfillment,
		now: input.now,
	})
	if (!quoted.ok) {
		return {
			automatic: automaticTillAdjustments(input),
			manual: quoted,
			replaced: [],
		}
	}
	return {
		automatic,
		replaced,
		manual: {
			ok: true,
			adjustment: {
				id: manualRowId(manualRule, input.manual),
				kind: 'discount',
				label: quoted.label,
				amountCents: quoted.amountMinor,
				lineAmounts: quoted.lineAmounts,
				version: manualRule.version,
				...(input.manual.approvedByStaffId
					? { approvedByStaffId: input.manual.approvedByStaffId }
					: {}),
				...(input.manual.reason ? { reason: input.manual.reason } : {}),
			},
		},
	}
}

import {
	type CreateItem,
	costMicroFromPackPrice,
	type InventoryBaseUnit,
	MAX_ENTRY_QUANTITY,
	priceChangeBp,
	type RecordDelivery,
	standardUnitsFor,
	type SupplierProduct,
	type UnitRef,
	type UnitSystem,
} from '@repo/inventory'
import { parseQuantityText } from '@repo/ui/quantity-input'
import { minorToMajorText, parseMoneyToMinor } from '#app/utils/money-input.ts'
import {
	defaultEntryUnit,
	type ItemUnitLike,
	thousandthsInUnit,
} from './format.ts'
import {
	baseUnitFor,
	defaultMeasureUnit,
	type MeasuredIn,
} from './item-form.ts'

/**
 * Recording a delivery as pure functions: what one invoice line comes to
 * (packs times pack size, or the real weight for goods priced by weight),
 * how much the price moved, the check against the invoice total, and the
 * body `POST /deliveries` takes. Money is typed in major units and handled
 * in minor units; VAT stays apart from prices.
 */

/** A way to buy an item: a supplier's pack, one of the item's own units, or a plain unit. */
export type PackChoice = {
	/** `product:<id>`, `unit:<id>`, or a standard unit key such as `kg`. */
	id: string
	/** The pack as the invoice names it ("Box", "kg"). */
	name: string
	/** Base thousandths in one pack. */
	baseQuantity: number
	/** The supplier product this pack is, when it is one. */
	productId: string | null
	/** The invoice shows the real weight, not the nominal pack size. */
	pricedByWeight: boolean
	/** The remembered pack price (only with the cost grant). */
	priceMinor: number | null
}

export type DeliveryLineDraft = {
	/** Stable key for the row (not sent). */
	key: string
	itemId: string
	itemName: string
	baseUnit: InventoryBaseUnit
	pack: PackChoice
	/** How many packs arrived. */
	packsText: string
	/** The price of ONE pack (before VAT), in major units. */
	priceText: string
	/** The real weight on the invoice, for goods priced by weight. */
	weightText: string
	weightUnit: UnitRef
	/** What the invoice line says, when it differs from packs times price. */
	totalText: string
	/** The item's last cost per base unit (micro-minor), to show how the price moved. */
	previousCostMicro: number | null
}

export type LineProblem = 'packs' | 'price' | 'weight' | 'total'

export type ComputedLine = {
	packs: number | null
	/** Stored quantity in base thousandths. */
	quantity: number | null
	packPriceMinor: number | null
	lineTotalMinor: number | null
	realWeightQuantity: number | null
	/** Cost per base unit after this delivery (micro-minor). */
	costMicro: number | null
	/** Change against `previousCostMicro`, in basis points. */
	changeBp: number | null
	problems: LineProblem[]
}

function inRange(quantity: number): boolean {
	return (
		Number.isSafeInteger(quantity) &&
		quantity >= 1 &&
		quantity <= MAX_ENTRY_QUANTITY
	)
}

/** What one invoice line is, from what was typed. */
export function computeLine(
	line: DeliveryLineDraft,
	currency: string,
): ComputedLine {
	const problems: LineProblem[] = []
	const priceMinor = parseMoneyToMinor(line.priceText, { currency, min: 1 })
	if (priceMinor === null) problems.push('price')

	const packsTyped = line.packsText.trim() !== ''
	const packs = packsTyped ? parseQuantityText(line.packsText) : null
	if (packsTyped && (packs === null || packs <= 0)) problems.push('packs')

	let quantity: number | null = null
	let realWeightQuantity: number | null = null
	let computedTotal: number | null = null

	if (line.pack.pricedByWeight) {
		const weight = parseQuantityText(line.weightText)
		const perUnit = thousandthsInUnit(line.weightUnit, line.baseUnit)
		if (weight === null || weight <= 0 || perUnit === null) {
			problems.push('weight')
		} else {
			const real = Math.round(weight * perUnit)
			if (inRange(real)) {
				realWeightQuantity = real
				quantity = real
			} else problems.push('weight')
		}
		if (priceMinor !== null && quantity !== null) {
			// The pack price is for the nominal pack, so the invoice line is the
			// price per base unit times the weight that was really delivered.
			computedTotal = Math.round(
				(priceMinor * quantity) / line.pack.baseQuantity,
			)
		}
	} else {
		if (packs === null || packs <= 0) {
			if (!problems.includes('packs')) problems.push('packs')
		} else {
			const base = Math.round(packs * line.pack.baseQuantity)
			if (inRange(base)) quantity = base
			else problems.push('packs')
		}
		if (priceMinor !== null && packs !== null && packs > 0) {
			computedTotal = Math.round(packs * priceMinor)
		}
	}

	let lineTotalMinor = computedTotal
	if (line.totalText.trim() !== '') {
		lineTotalMinor = parseMoneyToMinor(line.totalText, { currency, min: 0 })
		if (lineTotalMinor === null) problems.push('total')
	}
	if (
		lineTotalMinor !== null &&
		lineTotalMinor <= 0 &&
		!problems.includes('total')
	) {
		problems.push('total')
	}

	const costMicro =
		quantity !== null && lineTotalMinor !== null && lineTotalMinor > 0
			? costMicroFromPackPrice(lineTotalMinor, quantity)
			: null
	const changeBp =
		costMicro !== null ? priceChangeBp(line.previousCostMicro, costMicro) : null

	return {
		packs: packs !== null && packs > 0 ? packs : null,
		quantity,
		packPriceMinor: priceMinor,
		lineTotalMinor,
		realWeightQuantity,
		costMicro,
		changeBp,
		problems,
	}
}

/** The total of every valid line. */
export function linesTotalMinor(computed: readonly ComputedLine[]): number {
	return computed.reduce((sum, line) => sum + (line.lineTotalMinor ?? 0), 0)
}

export type DeliveryTotals = {
	linesMinor: number
	/** `null` while the VAT field is empty. */
	vatMinor: number | null
	/** The invoice's grand total; `null` while it is empty. */
	invoiceMinor: number | null
	/** Invoice minus (lines plus VAT); `null` without an invoice total. */
	differenceMinor: number | null
	state: 'none' | 'match' | 'apart'
}

/**
 * The check against the paper invoice: "Lines SAR 1,912 · Invoice SAR 1,920 ·
 * SAR 8 apart". The invoice total includes VAT, so it is compared with the
 * lines plus the VAT typed beside them.
 */
export function deliveryTotals(
	computed: readonly ComputedLine[],
	input: { vatText: string; invoiceTotalText: string; currency: string },
): DeliveryTotals {
	const linesMinor = linesTotalMinor(computed)
	const vatMinor =
		input.vatText.trim() === ''
			? null
			: parseMoneyToMinor(input.vatText, { currency: input.currency, min: 0 })
	const invoiceMinor =
		input.invoiceTotalText.trim() === ''
			? null
			: parseMoneyToMinor(input.invoiceTotalText, {
					currency: input.currency,
					min: 0,
				})
	if (invoiceMinor === null) {
		return {
			linesMinor,
			vatMinor,
			invoiceMinor,
			differenceMinor: null,
			state: 'none',
		}
	}
	const differenceMinor = invoiceMinor - (linesMinor + (vatMinor ?? 0))
	return {
		linesMinor,
		vatMinor,
		invoiceMinor,
		differenceMinor,
		state: differenceMinor === 0 ? 'match' : 'apart',
	}
}

export type DeliveryDraft = {
	/** Empty for a delivery without a supplier. */
	supplierId: string
	invoiceNumber: string
	/** `YYYY-MM-DD` or empty. */
	invoiceDate: string
	vatText: string
	invoiceTotalText: string
	zatcaReference: string
	paid: boolean
	lines: DeliveryLineDraft[]
}

export type DeliveryHeaderField =
	| 'lines'
	| 'invoiceNumber'
	| 'invoiceDate'
	| 'vat'
	| 'invoiceTotal'
	| 'zatcaReference'

export type DeliveryProblems = {
	header: DeliveryHeaderField[]
	lines: Record<string, LineProblem[]>
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const CONTROL_CHARS = /\p{Cc}/u

/** The body of `POST /deliveries`, or what is wrong with the draft. */
export function buildRecordDelivery(
	draft: DeliveryDraft,
	context: { clientId: string; locationId: string; currency: string },
):
	| { ok: true; payload: RecordDelivery }
	| { ok: false; problems: DeliveryProblems } {
	const { currency } = context
	const header: DeliveryHeaderField[] = []
	const lineProblems: Record<string, LineProblem[]> = {}

	if (draft.lines.length === 0) header.push('lines')
	const computed = draft.lines.map((line) => computeLine(line, currency))
	draft.lines.forEach((line, index) => {
		const problems = computed[index]!.problems
		if (problems.length > 0) lineProblems[line.key] = problems
	})

	const invoiceNumber = draft.invoiceNumber.trim()
	if (invoiceNumber.length > 60 || CONTROL_CHARS.test(invoiceNumber)) {
		header.push('invoiceNumber')
	}
	const zatca = draft.zatcaReference.trim()
	if (zatca.length > 200 || CONTROL_CHARS.test(zatca)) {
		header.push('zatcaReference')
	}
	if (draft.invoiceDate !== '' && !DATE.test(draft.invoiceDate)) {
		header.push('invoiceDate')
	}
	const vatMinor =
		draft.vatText.trim() === ''
			? null
			: parseMoneyToMinor(draft.vatText, { currency, min: 0 })
	if (draft.vatText.trim() !== '' && vatMinor === null) header.push('vat')
	const totalMinor =
		draft.invoiceTotalText.trim() === ''
			? null
			: parseMoneyToMinor(draft.invoiceTotalText, { currency, min: 0 })
	if (draft.invoiceTotalText.trim() !== '' && totalMinor === null) {
		header.push('invoiceTotal')
	}

	if (header.length > 0 || Object.keys(lineProblems).length > 0) {
		return { ok: false, problems: { header, lines: lineProblems } }
	}

	const payload: RecordDelivery = {
		clientId: context.clientId,
		locationId: context.locationId,
		supplierId: draft.supplierId === '' ? null : draft.supplierId,
		...(invoiceNumber !== '' ? { invoiceNumber } : {}),
		...(draft.invoiceDate !== '' ? { invoiceDate: draft.invoiceDate } : {}),
		currency,
		...(vatMinor !== null ? { vatMinor } : {}),
		...(totalMinor !== null ? { totalMinor } : {}),
		...(zatca !== '' ? { zatcaReference: zatca } : {}),
		paid: draft.paid,
		lines: draft.lines.map((line, index) => {
			const result = computed[index]!
			return {
				itemId: line.itemId,
				// A supplier's pack only means something for that supplier.
				...(line.pack.productId && draft.supplierId !== ''
					? { supplierProductId: line.pack.productId }
					: {}),
				quantity: result.quantity!,
				...(result.packs !== null ? { packs: result.packs } : {}),
				packName: line.pack.name,
				packBaseQuantity: line.pack.baseQuantity,
				packPriceMinor: result.packPriceMinor!,
				lineTotalMinor: result.lineTotalMinor!,
				...(result.realWeightQuantity !== null
					? { realWeightQuantity: result.realWeightQuantity }
					: {}),
			}
		}),
	}
	return { ok: true, payload }
}

/** A price move worth showing: `null` when nothing changed or nothing to compare with. */
export function visiblePriceChangeBp(changeBp: number | null): number | null {
	return changeBp === null || changeBp === 0 ? null : changeBp
}

/** An item added from the delivery page when it is not in Stock yet: a name and what it is measured in. */
export function buildInlineItemPayload(input: {
	clientId: string
	name: string
	measuredIn: MeasuredIn
	category: string
	locationId: string
	system: UnitSystem
}): CreateItem {
	return {
		clientId: input.clientId,
		name: input.name.trim(),
		category: input.category,
		kind: 'bought',
		baseUnit: baseUnitFor(input.measuredIn),
		place: {
			locationId: input.locationId,
			countUnit: defaultMeasureUnit(input.measuredIn, input.system),
			areaIds: [],
			orderBelowQuantity: null,
			fillUpToQuantity: null,
		},
	}
}

/**
 * The packs an item can arrive in at a supplier: the supplier's own packs
 * first (preferred one leading), then the item's named units, then plain
 * units. `unitLabel` names a unit in the viewer's language.
 */
export function packChoicesFor(input: {
	baseUnit: InventoryBaseUnit
	units: readonly ItemUnitLike[]
	/** The chosen supplier's products for this item. */
	products: readonly SupplierProduct[]
	system: UnitSystem
	unitLabel: (unit: UnitRef) => string
}): PackChoice[] {
	const products = [...input.products].sort(
		(a, b) => Number(b.preferred) - Number(a.preferred),
	)
	const choices: PackChoice[] = products.map((product) => ({
		id: `product:${product.id}`,
		name: product.packName,
		baseQuantity: product.packBaseQuantity,
		productId: product.id,
		pricedByWeight: product.pricedByWeight,
		priceMinor: product.priceMinor ?? null,
	}))
	for (const unit of input.units) {
		if (unit.archived) continue
		const duplicate = choices.some(
			(choice) =>
				choice.baseQuantity === unit.baseQuantity &&
				choice.name.toLowerCase() === unit.name.toLowerCase(),
		)
		if (duplicate) continue
		choices.push({
			id: `unit:${unit.id}`,
			name: unit.name,
			baseQuantity: unit.baseQuantity,
			productId: null,
			pricedByWeight: false,
			priceMinor: null,
		})
	}
	for (const unit of standardUnitsFor(input.baseUnit, input.system)) {
		const perUnit = thousandthsInUnit(unit, input.baseUnit)
		if (perUnit === null) continue
		choices.push({
			id: unit,
			name: input.unitLabel(unit),
			baseQuantity: perUnit,
			productId: null,
			pricedByWeight: false,
			priceMinor: null,
		})
	}
	return choices
}

/** The pack a new line starts with: the supplier's preferred pack, else how the item is counted. */
export function defaultPackChoice(
	choices: readonly PackChoice[],
	countUnit: UnitRef | null,
): PackChoice | null {
	return (
		choices.find((choice) => choice.productId !== null) ??
		choices.find((choice) => choice.id === countUnit) ??
		choices[0] ??
		null
	)
}

/** A new, empty line for an item, priced from the supplier's remembered price when it is known. */
export function newLineDraft(input: {
	key: string
	itemId: string
	itemName: string
	baseUnit: InventoryBaseUnit
	pack: PackChoice
	currency: string
	system: UnitSystem
	previousCostMicro: number | null
}): DeliveryLineDraft {
	return {
		key: input.key,
		itemId: input.itemId,
		itemName: input.itemName,
		baseUnit: input.baseUnit,
		pack: input.pack,
		packsText: '',
		priceText:
			input.pack.priceMinor === null
				? ''
				: minorToMajorText(input.pack.priceMinor, input.currency),
		weightText: '',
		weightUnit: defaultEntryUnit(input.baseUnit, null, [], input.system),
		totalText: '',
		previousCostMicro: input.previousCostMicro,
	}
}

/** The same line bought in another pack; the remembered price follows the pack when there is one. */
export function withPack(
	line: DeliveryLineDraft,
	pack: PackChoice,
	currency: string,
): DeliveryLineDraft {
	return {
		...line,
		pack,
		priceText:
			pack.priceMinor === null
				? line.pack.id === pack.id
					? line.priceText
					: ''
				: minorToMajorText(pack.priceMinor, currency),
		weightText: pack.pricedByWeight ? line.weightText : '',
		totalText: '',
	}
}

/**
 * Keeps a line's pack valid when the supplier changes or their packs load:
 * a pack that is no longer offered falls back to the default one, and a line
 * with no price typed yet moves to the supplier's own pack (so the remembered
 * price fills in). A line the person already priced is left alone.
 */
export function reconcilePack(
	line: DeliveryLineDraft,
	choices: readonly PackChoice[],
	countUnit: UnitRef | null,
	currency: string,
): DeliveryLineDraft {
	const current = choices.find((choice) => choice.id === line.pack.id)
	if (!current) {
		const next = defaultPackChoice(choices, countUnit)
		return next ? withPack(line, next, currency) : line
	}
	const supplierPack = choices.find((choice) => choice.productId !== null)
	if (line.pack.productId === null && line.priceText === '' && supplierPack) {
		return withPack(line, supplierPack, currency)
	}
	return line
}

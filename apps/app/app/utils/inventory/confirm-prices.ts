import {
	STANDARD_UNIT_SPECS,
	toBaseQuantity,
	type ConfirmDeliveryPrices,
	type DeliveryDetail,
	type InventoryBaseUnit,
	type InventoryCategory,
	type InvoiceLineWarning,
	type InvoiceRead,
	type InvoiceReadLine,
	type StandardUnit,
} from '@repo/inventory'
import { minorToMajorText, parseMoneyToMinor } from '#app/utils/money-input.ts'

/**
 * Confirming the prices of a delivery that arrived without them (recorded at
 * Station, or by someone without the cost grant): a person with the
 * purchasing role reads the invoice and types what each line cost. Pure
 * functions for the dialog: which lines are waiting, what each one comes to,
 * filling from read invoice lines (#504), and the body of
 * `POST /deliveries/:id/confirm-prices`.
 */

export type ConfirmLineDraft = {
	lineId: string
	itemId?: string
	itemName: string
	baseUnit?: InventoryBaseUnit
	/** Packs that arrived, when the line was counted in packs. */
	packs: number | null
	packName: string | null
	/** Stored quantity (base thousandths), updated when invoice lines override quantity. */
	quantity?: number
	/** Base thousandths per pack (stored when invoice lines update packs/quantity). */
	packBaseQuantity?: number | null
	supplierProductId?: string | null
	/** True when "Use invoice lines" updated the line's quantity/packs. */
	quantityChanged?: boolean
	/** The invoice shows the real weight, so a total cannot come from packs times price. */
	weighed: boolean
	/** The price of one pack, in major units. */
	priceText: string
	/** The invoice line, before VAT, in major units. */
	totalText: string
	/** Raw text from the invoice reader (#504). */
	rawInvoiceText?: string | null
	/** Warnings from the invoice reader (#504). */
	warnings?: InvoiceLineWarning[]
}

export type ConfirmExtraLineDraft = {
	key: string
	include: boolean
	rawText: string
	itemMode: 'match' | 'create'
	itemId: string | null
	itemName: string | null
	createItemName: string
	baseUnit: InventoryBaseUnit
	category: InventoryCategory
	supplierProductId: string | null
	packs: number | null
	packName: string | null
	packBaseQuantity: number | null
	quantityText: string
	priceText: string
	totalText: string
	warnings: InvoiceLineWarning[]
}

export type ConfirmLineProblem = 'total' | 'price' | 'item' | 'quantity'

export type ConfirmHeaderDraft = {
	invoiceNumber: string
	invoiceDate: string
	vatText: string
	totalText: string
	paid: boolean
}

/** The lines still waiting for a price (every line when the region does not flag them). */
export function unpricedLines(
	delivery: Pick<DeliveryDetail, 'lines'>,
): DeliveryDetail['lines'] {
	const flagged = delivery.lines.filter((line) => line.priced === false)
	return flagged.length > 0 ? flagged : delivery.lines
}

export function confirmLineDrafts(
	delivery: Pick<DeliveryDetail, 'lines'>,
): ConfirmLineDraft[] {
	return unpricedLines(delivery).map((line) => ({
		lineId: line.id,
		itemId: line.itemId,
		itemName: line.itemName,
		packs: line.packs,
		packName: line.packName,
		quantity: line.quantity,
		weighed: line.realWeightQuantity !== null,
		priceText: '',
		totalText: '',
	}))
}

/** What a line comes to: the typed total, else packs times the typed pack price. */
export function confirmLineTotalMinor(
	line: ConfirmLineDraft,
	currency: string,
): number | null {
	if (line.totalText.trim() !== '') {
		return parseMoneyToMinor(line.totalText, { currency, min: 0 })
	}
	if (line.weighed || line.packs === null || line.priceText.trim() === '') {
		return null
	}
	const price = parseMoneyToMinor(line.priceText, { currency, min: 0 })
	return price === null ? null : Math.round(line.packs * price)
}

/** The total a line shows as a hint while its own field is empty. */
export function confirmLineHint(
	line: ConfirmLineDraft,
	currency: string,
): string {
	if (line.totalText.trim() !== '') return ''
	const total = confirmLineTotalMinor(line, currency)
	return total === null ? '' : minorToMajorText(total, currency)
}

const UNIT_ALIASES: Record<string, StandardUnit> = {
	g: 'g',
	gr: 'g',
	gm: 'g',
	gram: 'g',
	grams: 'g',
	kg: 'kg',
	kgs: 'kg',
	kilo: 'kg',
	kilos: 'kg',
	kilogram: 'kg',
	kilograms: 'kg',
	ml: 'ml',
	milliliter: 'ml',
	milliliters: 'ml',
	millilitre: 'ml',
	millilitres: 'ml',
	l: 'l',
	lt: 'l',
	ltr: 'l',
	liter: 'l',
	liters: 'l',
	litre: 'l',
	litres: 'l',
	oz: 'oz',
	lb: 'lb',
	lbs: 'lb',
	floz: 'fl_oz',
	'fl oz': 'fl_oz',
	fl_oz: 'fl_oz',
	'fl-oz': 'fl_oz',
	qt: 'qt',
	gal: 'gal',
	pc: 'piece',
	pcs: 'piece',
	piece: 'piece',
	pieces: 'piece',
	ea: 'piece',
	each: 'piece',
}

/** Converts an invoice-read line's quantity + unit into base thousandths when possible. */
export function invoiceLineBaseQuantity(
	line: InvoiceReadLine,
	targetBaseUnit?: InventoryBaseUnit,
): number | null {
	if (line.quantity === null || line.quantity <= 0) return null
	if (line.packBaseQuantity && line.packBaseQuantity > 0) {
		return Math.round(line.quantity * line.packBaseQuantity)
	}
	const unit = (line.unit ?? '').trim().toLowerCase()
	const standardUnit = UNIT_ALIASES[unit]
	if (!standardUnit) return null
	const spec = STANDARD_UNIT_SPECS[standardUnit]
	if (targetBaseUnit && spec.base !== targetBaseUnit) {
		return null
	}
	const converted = toBaseQuantity(
		line.quantity,
		{ kind: 'standard', unit: standardUnit },
		spec.base,
	)
	return converted > 0 ? converted : null
}

/**
 * Matches lines returned by `POST /deliveries/:id/invoice-photo/read` against
 * existing unpriced delivery lines (#504). Unmatched or additional invoice lines
 * become `extraLines` for the operator to match/create or leave out.
 */
export function matchInvoiceReadToConfirm(
	read: InvoiceRead,
	baseLines: readonly ConfirmLineDraft[],
	currency: string,
	selectedReadIndices?: ReadonlySet<number>,
): {
	lines: ConfirmLineDraft[]
	extraLines: ConfirmExtraLineDraft[]
	matchedReadIndices: number[]
} {
	const updated = baseLines.map((line) => ({ ...line }))
	const claimedDeliveryIds = new Set<string>()
	const matchedReadIndices: number[] = []
	const extraLines: ConfirmExtraLineDraft[] = []

	read.lines.forEach((invLine, index) => {
		const included = selectedReadIndices ? selectedReadIndices.has(index) : true
		const target =
			invLine.itemId !== null
				? updated.find(
						(line) =>
							line.itemId === invLine.itemId &&
							!claimedDeliveryIds.has(line.lineId),
					)
				: undefined

		if (target) {
			claimedDeliveryIds.add(target.lineId)
			matchedReadIndices.push(index)
			if (!included) return

			const priceMinor = invLine.unitPriceMinor ?? null
			const totalMinor =
				invLine.lineTotalMinor ??
				(priceMinor !== null && invLine.quantity !== null
					? Math.round(priceMinor * invLine.quantity)
					: null)
			const nextPacks =
				invLine.quantity !== null && invLine.quantity > 0
					? invLine.quantity
					: target.packs
			const nextBaseQty = invoiceLineBaseQuantity(invLine, target.baseUnit)

			target.rawInvoiceText = invLine.text
			target.warnings = invLine.warnings ?? []
			if (priceMinor !== null) {
				target.priceText = minorToMajorText(priceMinor, currency)
			}
			if (totalMinor !== null) {
				target.totalText = minorToMajorText(totalMinor, currency)
			}
			if (nextPacks !== null && nextPacks !== target.packs) {
				target.packs = nextPacks
				target.quantityChanged = true
			}
			if (
				nextBaseQty !== null &&
				nextBaseQty > 0 &&
				nextBaseQty !== target.quantity
			) {
				target.quantity = nextBaseQty
				target.quantityChanged = true
			}
			if (invLine.packBaseQuantity) {
				target.packBaseQuantity = invLine.packBaseQuantity
			}
			if (invLine.matchedSupplierProductId) {
				target.supplierProductId = invLine.matchedSupplierProductId
			}
		} else {
			const priceMinor = invLine.unitPriceMinor ?? null
			const totalMinor =
				invLine.lineTotalMinor ??
				(priceMinor !== null && invLine.quantity !== null
					? Math.round(priceMinor * invLine.quantity)
					: null)
			const qty =
				invLine.quantity !== null && invLine.quantity > 0 ? invLine.quantity : 1
			extraLines.push({
				key: `extra-${index}`,
				include: included,
				rawText: invLine.text,
				itemMode: invLine.itemId ? 'match' : 'create',
				itemId: invLine.itemId,
				itemName: invLine.itemName,
				createItemName: invLine.itemName ?? invLine.text.slice(0, 80),
				baseUnit: 'piece',
				category: 'other',
				supplierProductId: invLine.matchedSupplierProductId ?? null,
				packs: invLine.quantity,
				packName: invLine.packSizeText ?? invLine.unit ?? null,
				packBaseQuantity: invLine.packBaseQuantity ?? null,
				quantityText: String(qty),
				priceText:
					priceMinor !== null ? minorToMajorText(priceMinor, currency) : '',
				totalText:
					totalMinor !== null ? minorToMajorText(totalMinor, currency) : '',
				warnings: invLine.warnings ?? [],
			})
		}
	})

	return { lines: updated, extraLines, matchedReadIndices }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function buildConfirmPrices(
	lines: readonly ConfirmLineDraft[],
	header: ConfirmHeaderDraft,
	context: { expectedVersion: number; currency: string },
	extraLines: readonly ConfirmExtraLineDraft[] = [],
):
	| { ok: true; payload: ConfirmDeliveryPrices }
	| {
			ok: false
			lines: Record<string, ConfirmLineProblem[]>
			extraLines?: Record<string, ConfirmLineProblem[]>
			header: ('invoiceDate' | 'vat' | 'total')[]
	  } {
	const { currency } = context
	const lineProblems: Record<string, ConfirmLineProblem[]> = {}
	const extraProblems: Record<string, ConfirmLineProblem[]> = {}
	const out: ConfirmDeliveryPrices['lines'] = []
	for (const line of lines) {
		const problems: ConfirmLineProblem[] = []
		const total = confirmLineTotalMinor(line, currency)
		if (total === null) problems.push('total')
		const price =
			line.priceText.trim() === ''
				? null
				: parseMoneyToMinor(line.priceText, { currency, min: 0 })
		if (line.priceText.trim() !== '' && price === null) problems.push('price')
		if (problems.length > 0) {
			lineProblems[line.lineId] = problems
			continue
		}
		out.push({
			lineId: line.lineId,
			lineTotalMinor: total!,
			...(price !== null ? { packPriceMinor: price } : {}),
			...(line.quantityChanged &&
			line.quantity !== undefined &&
			line.quantity > 0
				? { quantity: line.quantity }
				: {}),
			...(line.quantityChanged && line.packs !== null && line.packs > 0
				? { packs: line.packs }
				: {}),
			...(line.quantityChanged && line.packBaseQuantity
				? { packBaseQuantity: line.packBaseQuantity }
				: {}),
			...(line.quantityChanged && line.supplierProductId
				? { supplierProductId: line.supplierProductId }
				: {}),
		})
	}

	const outExtras: NonNullable<ConfirmDeliveryPrices['extraLines']> = []
	for (const extra of extraLines) {
		if (!extra.include) continue
		const problems: ConfirmLineProblem[] = []
		if (extra.itemMode === 'match' && !extra.itemId) {
			problems.push('item')
		}
		if (extra.itemMode === 'create' && extra.createItemName.trim() === '') {
			problems.push('item')
		}
		const qtyNum = Number(extra.quantityText)
		if (!Number.isFinite(qtyNum) || qtyNum <= 0) {
			problems.push('quantity')
		}
		const totalMinor =
			extra.totalText.trim() !== ''
				? parseMoneyToMinor(extra.totalText, { currency, min: 0 })
				: extra.priceText.trim() !== '' && Number.isFinite(qtyNum) && qtyNum > 0
					? (() => {
							const p = parseMoneyToMinor(extra.priceText, { currency, min: 0 })
							return p === null ? null : Math.round(p * qtyNum)
						})()
					: null
		if (totalMinor === null) {
			problems.push('total')
		}
		const priceMinor =
			extra.priceText.trim() === ''
				? null
				: parseMoneyToMinor(extra.priceText, { currency, min: 0 })
		if (extra.priceText.trim() !== '' && priceMinor === null) {
			problems.push('price')
		}
		if (problems.length > 0) {
			extraProblems[extra.key] = problems
			continue
		}
		const perPack =
			extra.packBaseQuantity && extra.packBaseQuantity > 0
				? extra.packBaseQuantity
				: 1_000
		const quantity = Math.max(1, Math.round(qtyNum * perPack))
		outExtras.push({
			...(extra.itemMode === 'match'
				? { itemId: extra.itemId! }
				: {
						createItem: {
							name: extra.createItemName.trim(),
							baseUnit: extra.baseUnit,
							category: extra.category,
						},
					}),
			...(extra.supplierProductId
				? { supplierProductId: extra.supplierProductId }
				: {}),
			quantity,
			packs: qtyNum,
			...(extra.packName ? { packName: extra.packName } : {}),
			...(extra.packBaseQuantity
				? { packBaseQuantity: extra.packBaseQuantity }
				: {}),
			...(priceMinor !== null ? { packPriceMinor: priceMinor } : {}),
			lineTotalMinor: totalMinor!,
		})
	}

	const headerProblems: ('invoiceDate' | 'vat' | 'total')[] = []
	if (header.invoiceDate !== '' && !DATE.test(header.invoiceDate)) {
		headerProblems.push('invoiceDate')
	}
	const vat =
		header.vatText.trim() === ''
			? null
			: parseMoneyToMinor(header.vatText, { currency, min: 0 })
	if (header.vatText.trim() !== '' && vat === null) headerProblems.push('vat')
	const total =
		header.totalText.trim() === ''
			? null
			: parseMoneyToMinor(header.totalText, { currency, min: 0 })
	if (header.totalText.trim() !== '' && total === null) {
		headerProblems.push('total')
	}

	if (
		Object.keys(lineProblems).length > 0 ||
		Object.keys(extraProblems).length > 0 ||
		headerProblems.length > 0
	) {
		return {
			ok: false,
			lines: lineProblems,
			...(Object.keys(extraProblems).length > 0
				? { extraLines: extraProblems }
				: {}),
			header: headerProblems,
		}
	}
	const invoiceNumber = header.invoiceNumber.trim()
	return {
		ok: true,
		payload: {
			expectedVersion: context.expectedVersion,
			currency,
			...(invoiceNumber !== '' ? { invoiceNumber } : {}),
			...(header.invoiceDate !== '' ? { invoiceDate: header.invoiceDate } : {}),
			...(vat !== null ? { vatMinor: vat } : {}),
			...(total !== null ? { totalMinor: total } : {}),
			paid: header.paid,
			lines: out,
			...(outExtras.length > 0 ? { extraLines: outExtras } : {}),
		},
	}
}

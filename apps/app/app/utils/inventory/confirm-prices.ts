import {
	type ConfirmDeliveryPrices,
	type DeliveryDetail,
} from '@repo/inventory'
import { minorToMajorText, parseMoneyToMinor } from '#app/utils/money-input.ts'

/**
 * Confirming the prices of a delivery that arrived without them (recorded at
 * Station, or by someone without the cost grant): a person with the
 * purchasing role reads the invoice and types what each line cost. Pure
 * functions for the dialog: which lines are waiting, what each one comes to,
 * and the body of `POST /deliveries/:id/confirm-prices`.
 */

export type ConfirmLineDraft = {
	lineId: string
	itemName: string
	/** Packs that arrived, when the line was counted in packs. */
	packs: number | null
	packName: string | null
	/** The invoice shows the real weight, so a total cannot come from packs times price. */
	weighed: boolean
	/** The price of one pack, in major units. */
	priceText: string
	/** The invoice line, before VAT, in major units. */
	totalText: string
}

export type ConfirmLineProblem = 'total' | 'price'

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
		itemName: line.itemName,
		packs: line.packs,
		packName: line.packName,
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

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function buildConfirmPrices(
	lines: readonly ConfirmLineDraft[],
	header: ConfirmHeaderDraft,
	context: { expectedVersion: number; currency: string },
):
	| { ok: true; payload: ConfirmDeliveryPrices }
	| {
			ok: false
			lines: Record<string, ConfirmLineProblem[]>
			header: ('invoiceDate' | 'vat' | 'total')[]
	  } {
	const { currency } = context
	const lineProblems: Record<string, ConfirmLineProblem[]> = {}
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

	if (Object.keys(lineProblems).length > 0 || headerProblems.length > 0) {
		return { ok: false, lines: lineProblems, header: headerProblems }
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
		},
	}
}

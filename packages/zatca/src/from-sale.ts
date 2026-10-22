import {
	type ZatcaDocumentInput,
	type ZatcaLine,
	type ZatcaPaymentMeans,
	type ZatcaSeller,
} from './document.ts'

/**
 * Turns a walk-in sale (as the till holds it) into a ZATCA document. Amounts
 * outside the scope of VAT (tips, options the menu does not tax) are category
 * O; everything else is standard rated. The document's VAT is computed from its
 * own taxable amount, so ZATCA's arithmetic holds exactly; a halala between
 * that and what the guest paid (from tax-inclusive prices) is the payable
 * rounding amount.
 */

export type SaleForZatca = {
	lines: Array<{
		name: string
		variantLabel: string | null
		quantity: number
		baseCents: number
		options: Array<{ unitCents: number; quantity: number; taxable: boolean }>
	}>
	taxRatePercent: number
	taxInclusive: boolean
	totals: {
		adjustmentCents: number
		taxCents: number
		tipCents: number
		totalCents: number
	}
	payments: Array<{ method: ZatcaPaymentMeans }>
}

type Meta = {
	id: string
	uuid: string
	issuedAt: Date
	counter: number
	previousHash: string
	seller: ZatcaSeller
}

const meansOf = (
	payments: Array<{ method: ZatcaPaymentMeans }>,
): ZatcaPaymentMeans[] => [...new Set(payments.map((p) => p.method))]

/** Gross amounts of a sale by VAT treatment, before and after its discount. */
function split(sale: SaleForZatca) {
	let standardGross = 0
	let untaxed = 0
	for (const line of sale.lines) {
		standardGross +=
			(line.baseCents +
				line.options
					.filter((o) => o.taxable)
					.reduce((s, o) => s + o.unitCents * o.quantity, 0)) *
			line.quantity
		untaxed +=
			line.options
				.filter((o) => !o.taxable)
				.reduce((s, o) => s + o.unitCents * o.quantity, 0) * line.quantity
	}
	// The till's discount comes off the subtotal (taxed and untaxed items alike), in proportion.
	const discount = sale.totals.adjustmentCents
	const base = standardGross + untaxed
	const standardDiscount =
		base > 0 ? Math.round((discount * standardGross) / base) : 0
	return {
		standardGross,
		untaxed,
		standardDiscount,
		outOfScopeDiscount: discount - standardDiscount,
	}
}

/** What a sale holds outside the scope of VAT: untaxed options and tips, after its discount. */
export function outOfScopeCents(sale: SaleForZatca): number {
	const s = split(sale)
	return s.untaxed - s.outOfScopeDiscount + sale.totals.tipCents
}

export function fromSale(sale: SaleForZatca, meta: Meta): ZatcaDocumentInput {
	const rate = sale.taxRatePercent
	const net = (gross: number) =>
		sale.taxInclusive ? Math.round((gross * 100) / (100 + rate)) : gross
	const lines: ZatcaLine[] = []
	for (const line of sale.lines) {
		const name = line.variantLabel
			? `${line.name} (${line.variantLabel})`
			: line.name
		const taxed =
			line.baseCents +
			line.options
				.filter((o) => o.taxable)
				.reduce((s, o) => s + o.unitCents * o.quantity, 0)
		const untaxed = line.options
			.filter((o) => !o.taxable)
			.reduce((s, o) => s + o.unitCents * o.quantity, 0)
		lines.push({
			name,
			quantity: line.quantity,
			unitNetCents: net(taxed),
			category: 'S',
		})
		if (untaxed > 0)
			lines.push({
				name: `${name}: not subject to VAT`,
				quantity: line.quantity,
				unitNetCents: untaxed,
				category: 'O',
			})
	}
	if (sale.totals.tipCents > 0)
		lines.push({
			name: 'Tip',
			quantity: 1,
			unitNetCents: sale.totals.tipCents,
			category: 'O',
		})
	const s = split(sale)
	return {
		kind: 'invoice',
		...meta,
		currency: 'SAR',
		taxRatePercent: rate,
		lines,
		allowanceCents: net(s.standardDiscount),
		outOfScopeAllowanceCents: s.outOfScopeDiscount,
		payableCents: sale.totals.totalCents,
		paymentMeans: meansOf(sale.payments),
	}
}

/**
 * A credit note for money given back (or a debit note for money added) on a
 * sale, referring to its invoice. The amount is split between standard-rated
 * and out-of-scope in the proportions of the original sale, so a refund of a
 * sale with a tip does not claim VAT back on the tip.
 */
export function fromRefund(
	refund: {
		amountCents: number
		method: ZatcaPaymentMeans
		reason: string
		kind?: 'credit_note' | 'debit_note'
	},
	sale: { taxRatePercent: number; totalCents: number; outOfScopeCents: number },
	meta: Meta & { billingReference: { id: string; issueDate: string } },
): ZatcaDocumentInput {
	const rate = sale.taxRatePercent
	const outOfScope =
		sale.totalCents > 0
			? Math.round(
					(refund.amountCents * sale.outOfScopeCents) / sale.totalCents,
				)
			: 0
	const standardGross = refund.amountCents - outOfScope
	const label = refund.kind === 'debit_note' ? 'Additional charge' : 'Refund'
	const lines: ZatcaLine[] = [
		{
			name: label,
			quantity: 1,
			unitNetCents: Math.round((standardGross * 100) / (100 + rate)),
			category: 'S',
		},
		...(outOfScope > 0
			? [
					{
						name: `${label}: not subject to VAT`,
						quantity: 1,
						unitNetCents: outOfScope,
						category: 'O' as const,
					},
				]
			: []),
	]
	return {
		kind: refund.kind ?? 'credit_note',
		...meta,
		currency: 'SAR',
		taxRatePercent: rate,
		lines,
		payableCents: refund.amountCents,
		paymentMeans: [refund.method],
		reason: refund.reason,
	}
}

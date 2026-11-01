import {
	discountedTaxableCents,
	sumLineAmounts,
} from '@repo/common/pos-discount-base'
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
		/**
		 * The till's local line id: what a discount's `lineAmounts` is keyed by.
		 * Optional; without it no discount can name this line.
		 */
		id?: string
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
	/**
	 * Named discounts. Written when they are the whole of the till's discount.
	 * `lineAmounts` (optional, keyed by line `id`) is how much of the discount
	 * each line took; with it the taxable amount shrinks line by line, exactly
	 * as the till prices it.
	 */
	discounts?: Array<{
		name: string
		amountCents: number
		lineAmounts?: Record<string, number>
	}>
	/**
	 * Per-line amounts of adjustments that are not in `discounts` (a loyalty
	 * reward), keyed by line `id`. Used for the taxable amount only.
	 */
	otherLineAmounts?: Record<string, number>
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

/**
 * Gross amounts of a sale by VAT treatment, before and after its discount. The
 * standard-rated base after the discount comes from the one calculation the
 * till uses (`discountedTaxableCents`), fed the same per-line amounts, so the
 * document's VAT is the VAT on the bill.
 */
function split(sale: SaleForZatca) {
	let standardGross = 0
	let untaxed = 0
	const perLine = sumLineAmounts([
		...(sale.discounts ?? []),
		{ lineAmounts: sale.otherLineAmounts },
	])
	const pricing = sale.lines.map((line) => {
		const taxed =
			(line.baseCents +
				line.options
					.filter((o) => o.taxable)
					.reduce((s, o) => s + o.unitCents * o.quantity, 0)) *
			line.quantity
		const notTaxed =
			line.options
				.filter((o) => !o.taxable)
				.reduce((s, o) => s + o.unitCents * o.quantity, 0) * line.quantity
		standardGross += taxed
		untaxed += notTaxed
		return {
			totalCents: taxed + notTaxed,
			taxableCents: taxed,
			offCents: line.id === undefined ? undefined : perLine.get(line.id),
		}
	})
	const discount = sale.totals.adjustmentCents
	const standardAfter = discountedTaxableCents({
		lines: pricing,
		adjustmentCents: discount,
	}).taxableAfterCents
	const standardDiscount = standardGross - standardAfter
	return {
		standardGross,
		standardAfter,
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

/**
 * The standard-rated taxable amount (net) of a document whose standard-rated
 * part costs `grossCents` VAT included and whose VAT is `taxCents` (the till's
 * figure). It is the gross less that VAT, moved by at most a halala when that
 * is needed for VAT to be exactly `rate`% of it (BR-S-09); the halala then
 * shows as the payable rounding amount. `null` when no such amount exists (the
 * VAT does not belong to this gross), so the caller falls back to converting
 * the gross on its own.
 */
export function standardTaxableFor(
	grossCents: number,
	taxCents: number,
	rate: number,
): number | null {
	const exact = (grossCents * 100) / (100 + rate)
	const first = grossCents - taxCents
	const fits = [first, first - 1, first + 1]
		.filter((n) => n >= 0 && Math.round((n * rate) / 100) === taxCents)
		.sort((a, b) => Math.abs(a - exact) - Math.abs(b - exact))
	return fits[0] ?? null
}

/**
 * Splits `total` over `weights` so the parts add up to `total` exactly (largest
 * remainder, ties to the earlier row).
 */
function allocateExactly(total: number, weights: number[]): number[] {
	const sum = weights.reduce((a, b) => a + b, 0)
	if (total <= 0 || sum <= 0) return weights.map(() => 0)
	const raw = weights.map((w) => (total * w) / sum)
	const parts = raw.map(Math.floor)
	let left = total - parts.reduce((a, b) => a + b, 0)
	const order = raw
		.map((r, i) => ({ i, frac: r - Math.floor(r) }))
		.sort((a, b) => b.frac - a.frac || a.i - b.i)
	for (const { i } of order) {
		if (left <= 0) break
		parts[i]! += 1
		left -= 1
	}
	return parts
}

/** Allowance or charge that takes the standard-rated line nets to `target`. */
function reconcile(linesNet: number, target: number) {
	return linesNet >= target
		? { allowanceCents: linesNet - target, chargeCents: 0 }
		: { allowanceCents: 0, chargeCents: target - linesNet }
}

export function fromSale(sale: SaleForZatca, meta: Meta): ZatcaDocumentInput {
	const rate = sale.taxRatePercent
	const net = (gross: number) =>
		sale.taxInclusive ? Math.round((gross * 100) / (100 + rate)) : gross
	const lines: ZatcaLine[] = []
	let standardLinesNet = 0
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
		// The line's net is its unit price times its quantity (BR-KSA-EN16931-11);
		// rounding a VAT-inclusive unit price is evened out once, for the whole
		// document, below.
		lines.push({
			name,
			quantity: line.quantity,
			unitNetCents: net(taxed),
			category: 'S',
		})
		standardLinesNet += net(taxed) * line.quantity
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
	// One source of truth for VAT: the document's standard-rated amount is the
	// one whose VAT is the bill's own (`totals.taxCents`), converted from the
	// whole discounted gross at once rather than unit by unit.
	const target = sale.taxInclusive
		? (standardTaxableFor(s.standardAfter, sale.totals.taxCents, rate) ??
			net(s.standardAfter))
		: s.standardAfter
	const { allowanceCents, chargeCents } = reconcile(standardLinesNet, target)
	const named = (sale.discounts ?? []).filter((row) => row.amountCents > 0)
	const namedSum = named.reduce((sum, row) => sum + row.amountCents, 0)
	// Named discounts are gross till adjustments. They are written only when
	// they are the whole of the till's discount; each is then given its share
	// of the document's net allowances so the parts add up exactly.
	const namedAllowances =
		named.length > 0 &&
		chargeCents === 0 &&
		namedSum === sale.totals.adjustmentCents
			? {
					standard: allocateExactly(
						allowanceCents,
						named.map((row) => row.amountCents),
					),
					outOfScope: allocateExactly(
						s.outOfScopeDiscount,
						named.map((row) => row.amountCents),
					),
				}
			: null
	return {
		kind: 'invoice',
		...meta,
		currency: 'SAR',
		taxRatePercent: rate,
		lines,
		allowanceCents,
		...(namedAllowances && allowanceCents > 0
			? {
					standardAllowances: named.map((row, i) => ({
						reason: row.name,
						cents: namedAllowances.standard[i]!,
					})),
				}
			: {}),
		...(namedAllowances && s.outOfScopeDiscount > 0
			? {
					outOfScopeAllowances: named.map((row, i) => ({
						reason: row.name,
						cents: namedAllowances.outOfScope[i]!,
					})),
				}
			: {}),
		...(chargeCents > 0 ? { chargeCents } : {}),
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
	sale: {
		taxRatePercent: number
		totalCents: number
		outOfScopeCents: number
		/**
		 * The bill's VAT. With it the note's VAT is the bill's VAT in proportion to
		 * the amount (`posRefundTaxCents` in `@repo/common/pos-fiscal`, the figure
		 * on the till's credit note and in its reports).
		 */
		taxCents?: number
	},
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
	// Same formula as posRefundTaxCents.
	const noteTax =
		sale.taxCents === undefined
			? null
			: sale.totalCents > 0
				? Math.round((sale.taxCents * refund.amountCents) / sale.totalCents)
				: 0
	const standardNet =
		(noteTax === null
			? null
			: standardTaxableFor(standardGross, noteTax, rate)) ??
		Math.round((standardGross * 100) / (100 + rate))
	const label = refund.kind === 'debit_note' ? 'Additional charge' : 'Refund'
	const lines: ZatcaLine[] = [
		{
			name: label,
			quantity: 1,
			unitNetCents: standardNet,
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

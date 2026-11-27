import { csvLines } from './export.ts'

/**
 * The daily accounting journal (#189), pure: one location's business day of
 * sales facts in, a balanced journal out, and the file layouts for QuickBooks,
 * Xero and a generic CSV. No I/O, no guest data: every figure is an aggregate in
 * minor units of one currency, never added across currencies.
 *
 * Reading the journal
 *  - Credits: sales by category (gross, before discounts), service fees, tax by
 *    rate, tips, gift cards sold, and what a refund took back (a refund is a
 *    negative credit, so it reads as a debit).
 *  - Debits: discounts, loyalty rewards, cash discounts, and every way the guest
 *    paid (cash, cards, gift cards redeemed, pay at handoff, other).
 *  - Payments clearing: card money moves through it. The payout the provider
 *    deposited and its processing fees are debits (bank, fee expense) against
 *    one clearing credit, so they never change the balance.
 *  - Debits equal credits for a consistent day. When they do not, the journal
 *    carries a `difference` line: the gap is shown, never hidden.
 */

export const JOURNAL_LINE_KINDS = [
	'sales',
	'service_fees',
	'discounts',
	'loyalty_rewards',
	'cash_discounts',
	'refunds',
	'tax',
	'tips',
	'gift_cards_sold',
	'tender',
	'processing_fees',
	'payout',
	'payment_clearing',
	'difference',
] as const
export type JournalLineKind = (typeof JOURNAL_LINE_KINDS)[number]

/** One location's business day, in one currency, as the region reports it (totals only). */
export type AccountingDayFacts = {
	locationId: string
	locationName: string
	/** `YYYY-MM-DD`, the location's business day. */
	businessDate: string
	currency: string
	/** The location's day has ended (final) or is still open (provisional). */
	closed: boolean
	/** Sales by menu category: gross item sales after item-level adjustments. */
	categories: Array<{ key: string; label: string; minor: number }>
	/** Gross sales (items and fees before discounts) of sale rows. */
	grossMinor: number
	serviceFeesMinor: number
	discountsMinor: number
	loyaltyMinor: number
	cashDiscountsMinor: number
	/** What refunds took off net sales that day (negative or zero). */
	refundsNetMinor: number
	taxByRate: Array<{ rateBp: number; minor: number }>
	/** Signed: refunds of tips reduce it. */
	tipsMinor: number
	giftCardsSoldMinor: number
	/** Money received by tender (signed: refunds go back through the same tender). */
	tenders: Array<{ tender: string; minor: number }>
	processingFeesMinor: number
	payoutMinor: number
}

export type JournalLine = {
	lineKey: string
	kind: JournalLineKind
	label: string
	debitMinor: number
	creditMinor: number
}

export type JournalDay = {
	locationId: string
	locationName: string
	businessDate: string
	currency: string
	status: 'final' | 'provisional'
	lines: JournalLine[]
	debitMinor: number
	creditMinor: number
	/** Debits minus credits: 0 for a balanced day. */
	differenceMinor: number
}

export const TENDER_LABELS: Record<string, string> = {
	cash: 'Cash received',
	card_online: 'Card payments (online)',
	card_till: 'Card payments (till)',
	gift_card: 'Gift cards redeemed',
	gift_card_sales: 'Received for gift cards sold',
	other: 'Other payments',
	handoff: 'Pay at handoff (to collect)',
	none: 'Nothing to pay',
}

/** Where a signed amount of a credit-natured line goes: positive credits, negative debits. */
function creditNatured(
	lineKey: string,
	kind: JournalLineKind,
	label: string,
	minor: number,
): JournalLine | null {
	if (minor === 0) return null
	return minor > 0
		? { lineKey, kind, label, debitMinor: 0, creditMinor: minor }
		: { lineKey, kind, label, debitMinor: -minor, creditMinor: 0 }
}

/** Debit-natured: positive debits, negative credits. */
function debitNatured(
	lineKey: string,
	kind: JournalLineKind,
	label: string,
	minor: number,
): JournalLine | null {
	if (minor === 0) return null
	return minor > 0
		? { lineKey, kind, label, debitMinor: minor, creditMinor: 0 }
		: { lineKey, kind, label, debitMinor: 0, creditMinor: -minor }
}

export function buildJournalDay(facts: AccountingDayFacts): JournalDay {
	const lines: JournalLine[] = []
	const push = (line: JournalLine | null) => {
		if (line) lines.push(line)
	}
	// Sales by category, then what the categories do not explain (rounding,
	// uncategorised lines, earlier sales without a stamp), so the credit side is
	// always the day's gross item sales.
	const itemSalesMinor = facts.grossMinor - facts.serviceFeesMinor
	let categorised = 0
	for (const category of [...facts.categories].sort((a, b) =>
		a.key.localeCompare(b.key),
	)) {
		categorised += category.minor
		push(creditNatured(`sales:${category.key}`, 'sales', `Sales: ${category.label}`, category.minor))
	}
	push(
		creditNatured(
			'sales:other',
			'sales',
			'Sales: other and rounding',
			itemSalesMinor - categorised,
		),
	)
	push(creditNatured('service_fees', 'service_fees', 'Service fees', facts.serviceFeesMinor))
	push(debitNatured('discounts', 'discounts', 'Discounts', facts.discountsMinor))
	push(debitNatured('loyalty_rewards', 'loyalty_rewards', 'Loyalty rewards', facts.loyaltyMinor))
	push(debitNatured('cash_discounts', 'cash_discounts', 'Cash discounts', facts.cashDiscountsMinor))
	push(creditNatured('refunds', 'refunds', 'Refunds', facts.refundsNetMinor))
	for (const tax of [...facts.taxByRate].sort((a, b) => a.rateBp - b.rateBp)) {
		push(
			creditNatured(
				`tax:${tax.rateBp}`,
				'tax',
				tax.rateBp === 0 ? 'Tax' : `Tax ${tax.rateBp / 100}%`,
				tax.minor,
			),
		)
	}
	push(creditNatured('tips', 'tips', 'Tips payable', facts.tipsMinor))
	push(creditNatured('gift_cards_sold', 'gift_cards_sold', 'Gift cards sold', facts.giftCardsSoldMinor))
	// Card money received for gift cards sold is a tender of its own.
	for (const tender of [...facts.tenders].sort((a, b) => a.tender.localeCompare(b.tender))) {
		push(
			debitNatured(
				`tender:${tender.tender}`,
				'tender',
				TENDER_LABELS[tender.tender] ?? `Payments: ${tender.tender}`,
				tender.minor,
			),
		)
	}
	// Payments clearing: the deposit and the fees leave it together.
	push(debitNatured('processing_fees', 'processing_fees', 'Payment processing fees', facts.processingFeesMinor))
	push(debitNatured('payout', 'payout', 'Paid out to the bank', facts.payoutMinor))
	push(
		creditNatured(
			'payment_clearing',
			'payment_clearing',
			'Payments clearing',
			facts.payoutMinor + facts.processingFeesMinor,
		),
	)

	let debit = lines.reduce((sum, line) => sum + line.debitMinor, 0)
	let credit = lines.reduce((sum, line) => sum + line.creditMinor, 0)
	const difference = debit - credit
	if (difference !== 0) {
		// Shown, never hidden: the gap sits on the side that is short.
		lines.push(
			difference > 0
				? {
						lineKey: 'difference',
						kind: 'difference',
						label: 'Difference (needs review)',
						debitMinor: 0,
						creditMinor: difference,
					}
				: {
						lineKey: 'difference',
						kind: 'difference',
						label: 'Difference (needs review)',
						debitMinor: -difference,
						creditMinor: 0,
					},
		)
		debit = lines.reduce((sum, line) => sum + line.debitMinor, 0)
		credit = lines.reduce((sum, line) => sum + line.creditMinor, 0)
	}
	return {
		locationId: facts.locationId,
		locationName: facts.locationName,
		businessDate: facts.businessDate,
		currency: facts.currency,
		status: facts.closed ? 'final' : 'provisional',
		lines,
		debitMinor: debit,
		creditMinor: credit,
		differenceMinor: difference,
	}
}

/** A stable fingerprint of a day's lines: equal means nothing changed. */
export function journalHash(lines: readonly JournalLine[]): string {
	const text = [...lines]
		.sort((a, b) => a.lineKey.localeCompare(b.lineKey))
		.map((l) => `${l.lineKey}|${l.debitMinor}|${l.creditMinor}`)
		.join(';')
	let hash = 0x811c9dc5
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash.toString(16).padStart(8, '0')
}

/**
 * The adjusting entry for a day exported before: the change in every line since
 * the last export (a late refund, a late payout). Lines that did not change
 * are left out; an unchanged day gives none. The entry balances whenever both
 * exports did, and never rewrites what was exported.
 */
export function adjustingLines(
	previous: readonly JournalLine[],
	current: readonly JournalLine[],
): JournalLine[] {
	const net = (line: JournalLine) => line.debitMinor - line.creditMinor
	const before = new Map(previous.map((l) => [l.lineKey, net(l)]))
	const now = new Map(current.map((l) => [l.lineKey, net(l)]))
	const meta = new Map<string, JournalLine>()
	for (const line of [...previous, ...current]) meta.set(line.lineKey, line)
	const out: JournalLine[] = []
	for (const key of [...new Set([...before.keys(), ...now.keys()])].sort()) {
		const delta = (now.get(key) ?? 0) - (before.get(key) ?? 0)
		if (delta === 0) continue
		const line = meta.get(key)!
		out.push({
			lineKey: key,
			kind: line.kind,
			label: line.label,
			debitMinor: delta > 0 ? delta : 0,
			creditMinor: delta < 0 ? -delta : 0,
		})
	}
	return out
}

export type JournalEntry = {
	/** `JNL-<date>-<location>` and `-ADJ<n>` for an adjusting entry. */
	reference: string
	locationId: string
	locationName: string
	businessDate: string
	currency: string
	status: 'final' | 'provisional' | 'adjustment'
	/** 1 for the day's own entry, 2... for adjusting entries. */
	sequence: number
	lines: JournalLine[]
	debitMinor: number
	creditMinor: number
	differenceMinor: number
}

export function entryFromDay(day: JournalDay, sequence = 1): JournalEntry {
	return {
		reference: referenceFor(day.businessDate, day.locationId, day.currency, sequence),
		locationId: day.locationId,
		locationName: day.locationName,
		businessDate: day.businessDate,
		currency: day.currency,
		status: sequence > 1 ? 'adjustment' : day.status,
		sequence,
		lines: day.lines,
		debitMinor: day.debitMinor,
		creditMinor: day.creditMinor,
		differenceMinor: day.differenceMinor,
	}
}

export function adjustingEntry(
	day: JournalDay,
	delta: JournalLine[],
	sequence: number,
): JournalEntry {
	const debit = delta.reduce((s, l) => s + l.debitMinor, 0)
	const credit = delta.reduce((s, l) => s + l.creditMinor, 0)
	return {
		reference: referenceFor(day.businessDate, day.locationId, day.currency, sequence),
		locationId: day.locationId,
		locationName: day.locationName,
		businessDate: day.businessDate,
		currency: day.currency,
		status: 'adjustment',
		sequence,
		lines: delta,
		debitMinor: debit,
		creditMinor: credit,
		differenceMinor: debit - credit,
	}
}

function referenceFor(date: string, locationId: string, currency: string, sequence: number) {
	const base = `JNL-${date}-${locationId.slice(0, 8)}-${currency}`
	return sequence > 1 ? `${base}-ADJ${sequence - 1}` : base
}

// ---------------------------------------------------------------------------
// Mapping and layouts
// ---------------------------------------------------------------------------

export type AccountMapping = Record<string, { code: string; name: string }>

/** Account names the journal uses until the operator maps a line. */
export function defaultAccountName(line: Pick<JournalLine, 'kind' | 'label'>): string {
	switch (line.kind) {
		case 'sales':
		case 'service_fees':
			return line.label
		case 'tax':
			return `${line.label} payable`
		case 'tips':
			return 'Tips payable'
		case 'gift_cards_sold':
			return 'Gift card liability'
		case 'payment_clearing':
			return 'Payments clearing'
		case 'processing_fees':
			return 'Payment processing fees'
		case 'payout':
			return 'Bank'
		case 'difference':
			return 'Journal difference (review)'
		default:
			return line.label
	}
}

export function accountFor(line: JournalLine, mapping: AccountMapping) {
	const mapped = mapping[line.lineKey]
	return {
		code: mapped?.code ?? '',
		name: mapped?.name && mapped.name.length > 0 ? mapped.name : defaultAccountName(line),
		mapped: Boolean(mapped?.name),
	}
}

export const ACCOUNTING_LAYOUTS = ['quickbooks', 'xero', 'generic'] as const
export type AccountingLayout = (typeof ACCOUNTING_LAYOUTS)[number]

function major(minor: number, currency: string): string {
	const digits = ['KWD', 'BHD', 'OMR', 'JOD', 'TND'].includes(currency) ? 3 : currency === 'JPY' ? 0 : 2
	return (minor / 10 ** digits).toFixed(digits)
}

function slashDate(date: string): string {
	const [y, m, d] = date.split('-')
	return `${m}/${d}/${y}`
}

function xeroDate(date: string): string {
	const [y, m, d] = date.split('-')
	return `${d}/${m}/${y}`
}

const entryNote = (entry: JournalEntry) =>
	entry.status === 'adjustment'
		? `Adjustment ${entry.businessDate}`
		: entry.status === 'provisional'
			? `Provisional ${entry.businessDate}`
			: `Daily sales ${entry.businessDate}`

/**
 * The journal as a CSV in one of three layouts. Every cell goes through the
 * shared formula-safe CSV writer.
 *  - quickbooks: QuickBooks Online "Import journal entries" columns
 *    (Journal No, Journal Date, Account Name, Debits, Credits, Description,
 *    Name, Currency, Location).
 *  - xero: Xero manual journals import (Narration, Date, Description,
 *    AccountCode, TaxRate, Amount; debits positive, credits negative).
 *  - generic: Date, Location, Reference, Status, Account code, Account name,
 *    Debit, Credit, Currency, Memo.
 * A file also names an out-of-balance day with a `Difference` line, never
 * dropping it.
 */
export function journalToCsv(
	entries: readonly JournalEntry[],
	mapping: AccountMapping,
	layout: AccountingLayout,
): string {
	const rows: string[][] = []
	if (layout === 'quickbooks') {
		rows.push([
			'*JournalNo',
			'*JournalDate',
			'*AccountName',
			'*Debits',
			'*Credits',
			'Description',
			'Name',
			'Currency',
			'Location',
		])
		for (const entry of entries) {
			for (const line of entry.lines) {
				const account = accountFor(line, mapping)
				rows.push([
					entry.reference,
					slashDate(entry.businessDate),
					account.name,
					line.debitMinor ? major(line.debitMinor, entry.currency) : '',
					line.creditMinor ? major(line.creditMinor, entry.currency) : '',
					`${entryNote(entry)}: ${line.label}`,
					'',
					entry.currency,
					entry.locationName,
				])
			}
		}
	} else if (layout === 'xero') {
		rows.push([
			'*Narration',
			'*Date',
			'Description',
			'*AccountCode',
			'*TaxRate',
			'*Amount',
			'TrackingName1',
			'TrackingOption1',
		])
		for (const entry of entries) {
			for (const line of entry.lines) {
				const account = accountFor(line, mapping)
				const signed = line.debitMinor - line.creditMinor
				rows.push([
					`${entryNote(entry)} ${entry.locationName} ${entry.reference}`,
					xeroDate(entry.businessDate),
					line.label,
					account.code || account.name,
					'Tax Exempt',
					major(signed, entry.currency),
					'Location',
					entry.locationName,
				])
			}
		}
	} else {
		rows.push([
			'Date',
			'Location',
			'Reference',
			'Status',
			'Account code',
			'Account name',
			'Debit',
			'Credit',
			'Currency',
			'Memo',
		])
		for (const entry of entries) {
			for (const line of entry.lines) {
				const account = accountFor(line, mapping)
				rows.push([
					entry.businessDate,
					entry.locationName,
					entry.reference,
					entry.status,
					account.code,
					account.name,
					line.debitMinor ? major(line.debitMinor, entry.currency) : '',
					line.creditMinor ? major(line.creditMinor, entry.currency) : '',
					entry.currency,
					line.label,
				])
			}
		}
	}
	return csvLines(rows)
}

/** The lines the mapping screen offers: every distinct line key with a default name. */
export function mappableLines(entries: readonly JournalEntry[]): Array<{
	lineKey: string
	label: string
	defaultName: string
}> {
	const seen = new Map<string, JournalLine>()
	for (const entry of entries) {
		for (const line of entry.lines) {
			if (line.kind === 'difference') continue
			if (!seen.has(line.lineKey)) seen.set(line.lineKey, line)
		}
	}
	return [...seen.values()]
		.sort((a, b) => a.lineKey.localeCompare(b.lineKey))
		.map((line) => ({
			lineKey: line.lineKey,
			label: line.label,
			defaultName: defaultAccountName(line),
		}))
}

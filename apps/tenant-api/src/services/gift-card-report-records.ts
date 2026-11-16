import { giftCardLedger, giftCards, type TenantDatabase } from '@repo/tenant-db'
import { desc, eq } from 'drizzle-orm'
import { type ReportRecord } from '@repo/reports'
import { effectiveGiftCardStatus } from '@repo/common/gift-cards'

/**
 * Records for the gift card report subjects (`gift_card_sales`,
 * `gift_card_redemptions`, `gift_card_balances`, `gift_card_settlement`).
 * Money facts only: an amount, a day, a location, a channel, a status and an
 * age. No code, name or email ever enters a record. Gift card sales are not
 * food revenue (they are not orders) and a redemption is a tender, not a
 * discount: these records are the only place gift card money is counted.
 *
 * A refund back to a card carries the location of the redemption it
 * reverses, so it nets out where the card was spent.
 */

export const GIFT_CARD_REPORT_MAX_ROWS = 50_000

export type GiftCardReportContext = {
	db: TenantDatabase
	/** Limits records to these locations; `null` is every location. */
	locationIds: readonly string[] | null
	now: number
	timeZone: string
	/** Location names by id (the id stands in for a name it cannot find). */
	locationNames: ReadonlyMap<string, string>
}

const DAY_MS = 86_400_000

/** `0-3 months`, `3-12 months`, `1-2 years` or `older`, by the card's age. */
export function giftCardAgeBucket(issuedAt: number, now: number): string {
	const days = Math.max(0, (now - issuedAt) / DAY_MS)
	if (days < 91) return '0-3 months'
	if (days < 365) return '3-12 months'
	if (days < 730) return '1-2 years'
	return 'older'
}

function businessDate(at: number, timeZone: string): string {
	try {
		return new Intl.DateTimeFormat('en-CA', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
		}).format(at)
	} catch {
		return new Date(at).toISOString().slice(0, 10)
	}
}

export type GiftCardReportRow = {
	kind: string
	amountMinor: number
	channel: string
	at: number
	entryLocation: string | null
	cardLocation: string | null
	currency: string
	cardId: string
	createdAt: number
	lastUsedAt: number | null
	status: string
	expiresAt: number | null
}

async function readRows(ctx: GiftCardReportContext): Promise<{ rows: GiftCardReportRow[]; truncated: boolean }> {
	const rows = await ctx.db
		.select({
			kind: giftCardLedger.kind,
			amountMinor: giftCardLedger.amountMinor,
			channel: giftCardLedger.channel,
			at: giftCardLedger.at,
			entryLocation: giftCardLedger.locationId,
			cardLocation: giftCards.locationId,
			currency: giftCards.currency,
			cardId: giftCards.id,
			createdAt: giftCards.createdAt,
			lastUsedAt: giftCards.lastUsedAt,
			status: giftCards.status,
			expiresAt: giftCards.expiresAt,
		})
		.from(giftCardLedger)
		.innerJoin(giftCards, eq(giftCards.id, giftCardLedger.cardId))
		.orderBy(desc(giftCardLedger.at))
		.limit(GIFT_CARD_REPORT_MAX_ROWS + 1)
	return {
		rows: rows.slice(0, GIFT_CARD_REPORT_MAX_ROWS),
		truncated: rows.length > GIFT_CARD_REPORT_MAX_ROWS,
	}
}

function inScope(ctx: GiftCardReportContext, ...locations: Array<string | null>) {
	if (ctx.locationIds === null) return true
	return locations.some((location) => location !== null && ctx.locationIds!.includes(location))
}

function nameOf(ctx: GiftCardReportContext, id: string | null): string {
	if (!id) return 'Unassigned'
	return ctx.locationNames.get(id) ?? id
}

export function giftCardSalesRecords(ctx: GiftCardReportContext, rows: readonly GiftCardReportRow[]): ReportRecord[] {
	const out: ReportRecord[] = []
	for (const row of rows) {
		if (row.kind !== 'issue' && row.kind !== 'top_up' && row.kind !== 'import') continue
		const location = row.entryLocation ?? row.cardLocation
		if (!inScope(ctx, location)) continue
		out.push({
			at: new Date(row.at),
			businessDate: businessDate(row.at, ctx.timeZone),
			location: nameOf(ctx, location),
			channel: row.channel,
			kind: row.kind,
			amount: row.amountMinor / 100,
			currency: row.currency,
		})
	}
	return out
}

/** Spent (positive) and returned to the card (negative) at the location that took it. */
export function giftCardRedemptionRecords(ctx: GiftCardReportContext, rows: readonly GiftCardReportRow[]): ReportRecord[] {
	const out: ReportRecord[] = []
	for (const row of rows) {
		if (row.kind !== 'redeem' && row.kind !== 'refund') continue
		const location = row.entryLocation
		if (!inScope(ctx, location)) continue
		out.push({
			at: new Date(row.at),
			businessDate: businessDate(row.at, ctx.timeZone),
			location: nameOf(ctx, location),
			sellingLocation: nameOf(ctx, row.cardLocation),
			channel: row.channel,
			amount: -row.amountMinor / 100,
			currency: row.currency,
		})
	}
	return out
}

export function giftCardBalanceRecords(ctx: GiftCardReportContext, rows: readonly GiftCardReportRow[]): ReportRecord[] {
	const cards = new Map<string, { row: GiftCardReportRow; balance: number }>()
	for (const row of rows) {
		const entry = cards.get(row.cardId) ?? { row, balance: 0 }
		entry.balance += row.amountMinor
		cards.set(row.cardId, entry)
	}
	const out: ReportRecord[] = []
	for (const { row, balance } of cards.values()) {
		if (balance <= 0) continue
		const status = effectiveGiftCardStatus(
			{ status: row.status as never, expiresAt: row.expiresAt },
			ctx.now,
		)
		// Outstanding means still owed to a guest: spendable or waiting to be.
		if (status === 'voided' || status === 'expired' || status === 'pending') continue
		if (!inScope(ctx, row.cardLocation)) continue
		out.push({
			issuedAt: new Date(row.createdAt),
			lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt) : null,
			sellingLocation: nameOf(ctx, row.cardLocation),
			ageBucket: giftCardAgeBucket(row.createdAt, ctx.now),
			status,
			balance: balance / 100,
			cards: 1,
			currency: row.currency,
		})
	}
	return out
}

/**
 * Two rows per cross-location redemption (and per refund of one): the
 * selling location is owed, the location that took the card owes. Summed over
 * every location the net is exactly zero; nothing here moves money.
 */
export function giftCardSettlementRecords(ctx: GiftCardReportContext, rows: readonly GiftCardReportRow[]): ReportRecord[] {
	const out: ReportRecord[] = []
	for (const row of rows) {
		if (row.kind !== 'redeem' && row.kind !== 'refund') continue
		const spentAt = row.entryLocation
		const soldAt = row.cardLocation
		if (!spentAt || !soldAt || spentAt === soldAt) continue
		const amount = -row.amountMinor / 100
		const base = {
			at: new Date(row.at),
			businessDate: businessDate(row.at, ctx.timeZone),
			currency: row.currency,
		}
		if (inScope(ctx, soldAt)) {
			out.push({ ...base, location: nameOf(ctx, soldAt), side: 'owed', net: amount })
		}
		if (inScope(ctx, spentAt)) {
			out.push({ ...base, location: nameOf(ctx, spentAt), side: 'owes', net: -amount })
		}
	}
	return out
}

export async function loadGiftCardReportRecords(
	ctx: GiftCardReportContext,
	subject: 'gift_card_sales' | 'gift_card_redemptions' | 'gift_card_balances' | 'gift_card_settlement',
): Promise<{ records: ReportRecord[]; truncated: boolean }> {
	const { rows, truncated } = await readRows(ctx)
	const records =
		subject === 'gift_card_sales'
			? giftCardSalesRecords(ctx, rows)
			: subject === 'gift_card_redemptions'
				? giftCardRedemptionRecords(ctx, rows)
				: subject === 'gift_card_balances'
					? giftCardBalanceRecords(ctx, rows)
					: giftCardSettlementRecords(ctx, rows)
	return { records, truncated }
}

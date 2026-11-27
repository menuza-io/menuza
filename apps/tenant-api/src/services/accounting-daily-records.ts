import { type AccountingDayFacts } from '@repo/reports'
import {
	createReportDefinition,
	getSubject,
	type ReportRecord,
} from '@repo/reports'
import { currencyExponent } from '@repo/common/money'
import { getLocalizedMenuValue } from '@repo/common/menu-types'
import { giftCardLedger, giftCards, type TenantDatabase } from '@repo/tenant-db'
import { localParts } from '@repo/zoned-time'
import { and, eq, gte, inArray, lt } from 'drizzle-orm'
import { getNodeRegion } from '../lib/region.ts'
import { activeReportCatalog } from '../restaurant/staffing-report-catalog.ts'
import { readSaleLines } from './item-sales.ts'
import { loadSalesRecords } from './sales-report-records.ts'

/**
 * The accounting export's figures (#189, `GET /analytics/accounting-daily`):
 * one entry per location, business day and currency, totals only. It reads the
 * SAME loaders as the sales report (`loadSalesRecords`: web, QR and Station
 * sales combined, QR rounds rung up on Station counted once, refunds on the
 * day the money went back) and the items-sold walker for the menu categories,
 * so the journal agrees with the reports. Payouts and processing fees are the
 * payment provider's and live in the App; this reports none.
 *
 * - A business day is the location's calendar day in its own time zone.
 * - A day is `closed` (final) once that local date has passed.
 * - Categories are shown at gross: each location-day's category sales are
 *   scaled so they add up to its gross item sales (discounts are carried on
 *   their own line); what categories do not explain is a visible "other" line.
 * - Tax is grouped by the order's effective rate (tax over net), snapped to a
 *   quarter point, so mixed rates stay on their own lines.
 */

export const ACCOUNTING_MAX_DAYS = 62

const RATE_STEP_BP = 25

/** Effective tax rate in basis points, to the nearest quarter point. */
export function effectiveRateBp(taxMinor: number, netMinor: number): number {
	if (netMinor === 0 || taxMinor === 0) return 0
	const raw = (Math.abs(taxMinor) / Math.abs(netMinor)) * 10_000
	return Math.round(raw / RATE_STEP_BP) * RATE_STEP_BP
}

const DAY = 86_400_000

function dateKey(ms: number, zone: string): string {
	const p = localParts(ms, zone)
	return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

type Bucket = {
	locationId: string
	locationName: string
	businessDate: string
	currency: string
	zone: string
	categories: Map<string, { label: string; net: number }>
	gross: number
	serviceFees: number
	discounts: number
	loyalty: number
	cashDiscounts: number
	refundsNet: number
	tax: Map<number, number>
	tips: number
	giftSold: number
	tenders: Map<string, number>
}

export async function loadAccountingFacts(input: {
	db: TenantDatabase
	orgId: string
	locationIds: readonly string[] | null
	fromDate: string
	toDate: string
	now?: Date
}): Promise<{ days: AccountingDayFacts[]; truncated: boolean }> {
	const now = input.now ?? new Date()
	const [fy, fm, fd] = input.fromDate.split('-').map(Number) as [
		number,
		number,
		number,
	]
	const [ty, tm, td] = input.toDate.split('-').map(Number) as [
		number,
		number,
		number,
	]
	const fromMs = Date.UTC(fy, fm - 1, fd) - DAY
	const toMs = Date.UTC(ty, tm - 1, td) + 2 * DAY
	const subject = getSubject(activeReportCatalog(), 'sales')!
	const definition = createReportDefinition({
		subject: 'sales',
		timeframe: {
			field: 'occurredAt',
			preset: 'custom',
			start: new Date(fromMs).toISOString(),
			end: new Date(toMs).toISOString(),
		},
		visualization: { chartStyle: 'table', measure: 'count' },
		settings: { title: 'Accounting', timezone: 'UTC' },
	})
	const loaded = await loadSalesRecords(
		{ db: input.db, orgId: input.orgId, locationIds: input.locationIds, now },
		subject,
		definition,
	)

	const buckets = new Map<string, Bucket>()
	const bucketOf = (
		locationId: string,
		locationName: string,
		date: string,
		currency: string,
		zone: string,
	) => {
		const key = JSON.stringify([locationId, date, currency])
		let bucket = buckets.get(key)
		if (!bucket) {
			bucket = {
				locationId,
				locationName,
				businessDate: date,
				currency,
				zone,
				categories: new Map(),
				gross: 0,
				serviceFees: 0,
				discounts: 0,
				loyalty: 0,
				cashDiscounts: 0,
				refundsNet: 0,
				tax: new Map(),
				tips: 0,
				giftSold: 0,
				tenders: new Map(),
			}
			buckets.set(key, bucket)
		}
		return bucket
	}
	const minor = (value: unknown, currency: string) =>
		Math.round(Number(value ?? 0) * 10 ** currencyExponent(currency))

	// One order's tax is grouped at one rate: sum its rows (a sale is one row per tender).
	const orderKey = (r: ReportRecord) =>
		`${r.locationId}|${r.entry}|${String(r.orderNumber)}`
	const orderTotals = new Map<string, { tax: number; net: number }>()
	for (const r of loaded.records) {
		if (r.entry !== 'sale' && r.entry !== 'refund') continue
		const currency = String(r.currency)
		const t = orderTotals.get(orderKey(r)) ?? { tax: 0, net: 0 }
		t.tax += minor(r.tax, currency)
		t.net += minor(r.netSales, currency)
		orderTotals.set(orderKey(r), t)
	}

	for (const r of loaded.records) {
		if (r.entry !== 'sale' && r.entry !== 'refund') continue
		const currency = String(r.currency)
		const zone = String(r.locationTimeZone || 'UTC')
		const at = (r.occurredAt as Date).getTime()
		const date = dateKey(at, zone)
		if (date < input.fromDate || date > input.toDate) continue
		const bucket = bucketOf(
			String(r.locationId),
			String(r.location ?? r.locationId),
			date,
			currency,
			zone,
		)
		const tender = String(r.tender ?? 'other')
		bucket.tenders.set(
			tender,
			(bucket.tenders.get(tender) ?? 0) + minor(r.collected, currency),
		)
		bucket.tips += minor(r.tips, currency)
		const rowTax = minor(r.tax, currency)
		if (rowTax !== 0) {
			const totals = orderTotals.get(orderKey(r))!
			const rate = effectiveRateBp(totals.tax, totals.net)
			bucket.tax.set(rate, (bucket.tax.get(rate) ?? 0) + rowTax)
		}
		if (r.entry === 'sale') {
			bucket.gross += minor(r.grossSales, currency)
			bucket.serviceFees += minor(r.serviceCharges, currency)
			bucket.discounts += minor(r.discounts, currency)
			bucket.loyalty += minor(r.loyaltyRewards, currency)
			bucket.cashDiscounts += minor(r.cashDiscounts, currency)
		} else {
			bucket.refundsNet += minor(r.netSales, currency)
		}
	}

	// Menu categories, from the same walker the items-sold reports use.
	const lines = await readSaleLines(input.db, {
		fromDate: input.fromDate,
		toDate: input.toDate,
		locationIds: input.locationIds,
	})
	for (const sale of lines.sales) {
		const currency = sale.currency.toUpperCase()
		const bucket = buckets.get(
			JSON.stringify([sale.locationId, sale.businessDate, currency]),
		)
		if (!bucket) continue
		for (const line of sale.lines) {
			const category = line.placement
				? getLocalizedMenuValue(line.placement.categoryName) || 'Uncategorised'
				: 'Uncategorised'
			const key = line.placement?.categoryId || 'uncategorised'
			const entry = bucket.categories.get(key) ?? { label: category, net: 0 }
			entry.net += line.netMinor
			bucket.categories.set(key, entry)
		}
	}

	// Gift cards sold (issued or topped up) that day, at the card's location.
	const zoneOfLocation = new Map<string, { zone: string; name: string }>()
	for (const bucket of buckets.values()) {
		zoneOfLocation.set(bucket.locationId, {
			zone: bucket.zone,
			name: bucket.locationName,
		})
	}
	const sold = await input.db
		.select({
			amountMinor: giftCardLedger.amountMinor,
			at: giftCardLedger.at,
			entryLocation: giftCardLedger.locationId,
			cardLocation: giftCards.locationId,
			currency: giftCards.currency,
		})
		.from(giftCardLedger)
		.innerJoin(giftCards, eq(giftCards.id, giftCardLedger.cardId))
		.where(
			and(
				inArray(giftCardLedger.kind, ['issue', 'top_up']),
				gte(giftCardLedger.at, fromMs),
				lt(giftCardLedger.at, toMs),
			),
		)
	const allowed = input.locationIds ? new Set(input.locationIds) : null
	for (const row of sold) {
		const locationId = row.entryLocation ?? row.cardLocation ?? 'unassigned'
		if (allowed && !allowed.has(locationId)) continue
		const known = zoneOfLocation.get(locationId)
		const zone = known?.zone ?? 'UTC'
		const date = dateKey(row.at, zone)
		if (date < input.fromDate || date > input.toDate) continue
		const currency = row.currency.toUpperCase()
		bucketOf(
			locationId,
			known?.name ?? locationId,
			date,
			currency,
			zone,
		).giftSold += row.amountMinor
	}
	// Cards paid for are money received: a tender line of their own.
	for (const bucket of buckets.values()) {
		if (bucket.giftSold !== 0) {
			bucket.tenders.set(
				'gift_card_sales',
				(bucket.tenders.get('gift_card_sales') ?? 0) + bucket.giftSold,
			)
		}
	}

	const out: AccountingDayFacts[] = []
	const todayByZone = new Map<string, string>()
	for (const bucket of buckets.values()) {
		const today =
			todayByZone.get(bucket.zone) ??
			(todayByZone.set(bucket.zone, dateKey(now.getTime(), bucket.zone)),
			todayByZone.get(bucket.zone)!)
		const itemSales = bucket.gross - bucket.serviceFees
		const catTotal = [...bucket.categories.values()].reduce(
			(s, c) => s + c.net,
			0,
		)
		const ordered = [...bucket.categories.entries()].sort(
			(a, b) => b[1].net - a[1].net || a[0].localeCompare(b[0]),
		)
		let categories: AccountingDayFacts['categories'] = []
		if (catTotal > 0 && itemSales > 0) {
			// Scale to gross; the largest category takes the rounding remainder.
			let assigned = 0
			categories = ordered.map(([key, c], index) => {
				const share =
					index === 0 ? 0 : Math.round((c.net * itemSales) / catTotal)
				assigned += share
				return { key, label: c.label, minor: share }
			})
			categories[0]!.minor = itemSales - assigned
		}
		out.push({
			locationId: bucket.locationId,
			locationName: bucket.locationName,
			businessDate: bucket.businessDate,
			currency: bucket.currency,
			closed: bucket.businessDate < today,
			...(getNodeRegion() === 'ksa' ? { zatca: true } : {}),
			categories,
			grossMinor: bucket.gross,
			serviceFeesMinor: bucket.serviceFees,
			discountsMinor: bucket.discounts,
			loyaltyMinor: bucket.loyalty,
			cashDiscountsMinor: bucket.cashDiscounts,
			refundsNetMinor: bucket.refundsNet,
			taxByRate: [...bucket.tax.entries()]
				.map(([rateBp, m]) => ({ rateBp, minor: m }))
				.sort((a, b) => a.rateBp - b.rateBp),
			tipsMinor: bucket.tips,
			giftCardsSoldMinor: bucket.giftSold,
			tenders: [...bucket.tenders.entries()].map(([tender, m]) => ({
				tender,
				minor: m,
			})),
			processingFeesMinor: 0,
			payoutMinor: 0,
		})
	}
	out.sort(
		(a, b) =>
			a.businessDate.localeCompare(b.businessDate) ||
			a.locationName.localeCompare(b.locationName) ||
			a.currency.localeCompare(b.currency),
	)
	return { days: out, truncated: loaded.truncated }
}

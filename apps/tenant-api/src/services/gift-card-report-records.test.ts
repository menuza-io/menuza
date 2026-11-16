import { describe, expect, it } from 'vitest'
import {
	giftCardAgeBucket,
	giftCardBalanceRecords,
	giftCardRedemptionRecords,
	giftCardSalesRecords,
	giftCardSettlementRecords,
	type GiftCardReportContext,
	type GiftCardReportRow,
} from './gift-card-report-records.ts'

const NOW = Date.UTC(2026, 10, 15, 12)
const DAY = 86_400_000
const names = new Map([
	['A', 'Downtown'],
	['B', 'Airport'],
	['C', 'Mall'],
])
const ctx = (locationIds: string[] | null = null): GiftCardReportContext => ({
	db: null as never,
	locationIds,
	now: NOW,
	timeZone: 'America/Chicago',
	locationNames: names,
})

function row(over: Partial<GiftCardReportRow>): GiftCardReportRow {
	return {
		kind: 'issue',
		amountMinor: 5000,
		channel: 'pos',
		at: NOW - DAY,
		entryLocation: 'A',
		cardLocation: 'A',
		currency: 'USD',
		cardId: 'card1',
		createdAt: NOW - 10 * DAY,
		lastUsedAt: null,
		status: 'active',
		expiresAt: null,
		...over,
	}
}

describe('gift card report records', () => {
	it('sales count cards sold and topped up, never spending, and never as food revenue', () => {
		const rows = [
			row({ kind: 'issue', amountMinor: 5000 }),
			row({ kind: 'top_up', amountMinor: 2000, channel: 'pos' }),
			row({ kind: 'redeem', amountMinor: -1000 }),
			row({ kind: 'adjust', amountMinor: 100 }),
		]
		const sales = giftCardSalesRecords(ctx(), rows)
		expect(sales.map((r) => [r.kind, r.amount])).toEqual([
			['issue', 50],
			['top_up', 20],
		])
		expect(sales[0]).toMatchObject({ location: 'Downtown', businessDate: '2026-11-14' })
	})

	it('redemptions are positive spend; a refund back to the card reverses it where it was spent', () => {
		const rows = [
			row({ kind: 'redeem', amountMinor: -3000, entryLocation: 'B', cardLocation: 'A' }),
			row({ kind: 'refund', amountMinor: 1000, entryLocation: 'B', cardLocation: 'A' }),
		]
		const records = giftCardRedemptionRecords(ctx(), rows)
		expect(records.map((r) => [r.location, r.amount])).toEqual([
			['Airport', 30],
			['Airport', -10],
		])
		expect(records[0]).toMatchObject({ sellingLocation: 'Downtown' })
	})

	it('settlement: a card sold at A and spent at B leaves B owing A, and the net across locations is zero', () => {
		const rows = [
			row({ kind: 'redeem', amountMinor: -3000, entryLocation: 'B', cardLocation: 'A', cardId: 'c1' }),
			row({ kind: 'redeem', amountMinor: -1200, entryLocation: 'C', cardLocation: 'A', cardId: 'c2' }),
			row({ kind: 'redeem', amountMinor: -700, entryLocation: 'A', cardLocation: 'B', cardId: 'c3' }),
			// Spent where it was sold: no settlement.
			row({ kind: 'redeem', amountMinor: -900, entryLocation: 'A', cardLocation: 'A', cardId: 'c4' }),
			// A refund reverses the redemption at the location that took it.
			row({ kind: 'refund', amountMinor: 500, entryLocation: 'B', cardLocation: 'A', cardId: 'c1' }),
		]
		const records = giftCardSettlementRecords(ctx(), rows)
		const net = new Map<string, number>()
		for (const record of records) {
			net.set(String(record.location), (net.get(String(record.location)) ?? 0) + Number(record.net))
		}
		// A is owed 30 + 12 - 5 and owes 7; B owes 25 and is owed 7; C owes 12.
		expect(net.get('Downtown')).toBeCloseTo(30 + 12 - 5 - 7)
		expect(net.get('Airport')).toBeCloseTo(-25 + 7)
		expect(net.get('Mall')).toBeCloseTo(-12)
		expect([...net.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(0)
		const owed = records.find((r) => r.location === 'Downtown' && r.side === 'owed')
		expect(owed).toBeDefined()
	})

	it('a location-scoped viewer sees only their own side', () => {
		const rows = [
			row({ kind: 'redeem', amountMinor: -3000, entryLocation: 'B', cardLocation: 'A' }),
		]
		const records = giftCardSettlementRecords(ctx(['B']), rows)
		expect(records.map((r) => [r.location, r.net])).toEqual([['Airport', -30]])
		expect(giftCardSalesRecords(ctx(['C']), [row({})])).toEqual([])
	})

	it('outstanding balance by age matches the sum of card balances', () => {
		const rows = [
			row({ cardId: 'a', amountMinor: 5000, createdAt: NOW - 10 * DAY }),
			row({ cardId: 'a', kind: 'redeem', amountMinor: -2000, createdAt: NOW - 10 * DAY }),
			row({ cardId: 'b', amountMinor: 4000, createdAt: NOW - 200 * DAY }),
			row({ cardId: 'c', amountMinor: 3000, createdAt: NOW - 500 * DAY, lastUsedAt: NOW - 400 * DAY }),
			row({ cardId: 'd', amountMinor: 1000, createdAt: NOW - 900 * DAY }),
			// Spent down, voided and expired cards owe nothing.
			row({ cardId: 'e', amountMinor: 1000 }),
			row({ cardId: 'e', kind: 'redeem', amountMinor: -1000 }),
			row({ cardId: 'f', amountMinor: 1000, status: 'voided' }),
			row({ cardId: 'g', amountMinor: 1000, expiresAt: NOW - DAY }),
		]
		const records = giftCardBalanceRecords(ctx(), rows)
		const byBucket = new Map<string, number>()
		for (const record of records) {
			byBucket.set(String(record.ageBucket), (byBucket.get(String(record.ageBucket)) ?? 0) + Number(record.balance))
		}
		expect(Object.fromEntries(byBucket)).toEqual({
			'0-3 months': 30,
			'3-12 months': 40,
			'1-2 years': 30,
			older: 10,
		})
		const total = records.reduce((sum, r) => sum + Number(r.balance), 0)
		expect(total).toBeCloseTo(30 + 40 + 30 + 10)
		expect(records.find((r) => r.ageBucket === '1-2 years')?.lastUsedAt).toEqual(new Date(NOW - 400 * DAY))
	})

	it('age buckets cut at three months, a year and two years', () => {
		expect(giftCardAgeBucket(NOW - 90 * DAY, NOW)).toBe('0-3 months')
		expect(giftCardAgeBucket(NOW - 91 * DAY, NOW)).toBe('3-12 months')
		expect(giftCardAgeBucket(NOW - 364 * DAY, NOW)).toBe('3-12 months')
		expect(giftCardAgeBucket(NOW - 365 * DAY, NOW)).toBe('1-2 years')
		expect(giftCardAgeBucket(NOW - 729 * DAY, NOW)).toBe('1-2 years')
		expect(giftCardAgeBucket(NOW - 730 * DAY, NOW)).toBe('older')
	})
})

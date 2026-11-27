import { AccountingExport, db, eq } from '@repo/database'
import { buildMockPayoutsSnapshot } from '@repo/payments'
import { buildJournalDay, type AccountingDayFacts } from '@repo/reports'
import { describe, expect, it } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import {
	loadAccountMapping,
	mergeAccountingDays,
	prepareAccountingExport,
	providerDayFacts,
	saveAccountMapping,
} from './accounting.server.ts'

function day(over: Partial<AccountingDayFacts> = {}): AccountingDayFacts {
	return {
		locationId: 'loc_main',
		locationName: 'Main St',
		businessDate: '2026-11-20',
		currency: 'USD',
		closed: true,
		categories: [{ key: 'mains', label: 'Mains', minor: 10_000 }],
		grossMinor: 10_000,
		serviceFeesMinor: 0,
		discountsMinor: 0,
		loyaltyMinor: 0,
		cashDiscountsMinor: 0,
		refundsNetMinor: 0,
		taxByRate: [{ rateBp: 1500, minor: 1500 }],
		tipsMinor: 0,
		giftCardsSoldMinor: 0,
		tenders: [
			{ tender: 'cash', minor: 4000 },
			{ tender: 'card_till', minor: 7500 },
		],
		processingFeesMinor: 0,
		payoutMinor: 0,
		...over,
	}
}

describe('the payout line (#189, #168)', () => {
	it('equals the payout report: the same payouts, summed per arrival day and currency', () => {
		const snapshot = buildMockPayoutsSnapshot({
			provider: 'connect',
			currency: 'USD',
		})
		expect(snapshot.payouts.length).toBeGreaterThan(0)
		const dates = snapshot.payouts.map((p) => p.arrivalDate.slice(0, 10)).sort()
		const facts = providerDayFacts({
			payouts: snapshot.payouts.map((p) => ({
				arrivalDate: p.arrivalDate,
				currency: p.currency,
				amountCents: p.amountCents,
				status: p.status,
				feeCents: 0,
			})),
			from: dates[0]!,
			to: '2099-01-01',
			timeZone: 'UTC',
			today: '2099-01-02',
		})
		// What the payout report lists as moving money (not failed or cancelled).
		const expected = new Map<string, number>()
		for (const p of snapshot.payouts) {
			if (p.status === 'failed' || p.status === 'canceled') continue
			const key = `${p.arrivalDate.slice(0, 10)}|${p.currency.toUpperCase()}`
			expected.set(key, (expected.get(key) ?? 0) + p.amountCents)
		}
		for (const fact of facts) {
			expect(fact.payoutMinor).toBe(
				expected.get(`${fact.businessDate}|${fact.currency}`),
			)
			// The provider's day balances on its own: bank debit against clearing.
			expect(buildJournalDay(fact).differenceMinor).toBe(0)
			expect(
				buildJournalDay(fact).lines.find((l) => l.lineKey === 'payout')!
					.debitMinor,
			).toBe(fact.payoutMinor)
		}
		expect(facts.reduce((s, f) => s + f.payoutMinor, 0)).toBe(
			[...expected.values()].reduce((s, v) => s + v, 0),
		)
	})

	it('takes fees with the payout and ignores failed payouts', () => {
		const facts = providerDayFacts({
			payouts: [
				{
					arrivalDate: '2026-11-21T10:00:00Z',
					currency: 'usd',
					amountCents: 9000,
					status: 'paid',
					feeCents: 400,
				},
				{
					arrivalDate: '2026-11-21T11:00:00Z',
					currency: 'usd',
					amountCents: 5000,
					status: 'failed',
					feeCents: 100,
				},
			],
			from: '2026-11-20',
			to: '2026-11-22',
			timeZone: 'America/Chicago',
			today: '2026-11-25',
		})
		expect(facts).toHaveLength(1)
		expect(facts[0]).toMatchObject({
			payoutMinor: 9000,
			processingFeesMinor: 400,
			closed: true,
		})
	})
})

describe('mapping and export (#189)', () => {
	it('saves each line once and reads it back; an empty name removes it', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		await saveAccountMapping(organization.id, [
			{
				lineKey: 'sales:mains',
				accountCode: '4000',
				accountName: 'Food sales',
			},
			{
				lineKey: 'tax:1500',
				accountCode: '2200',
				accountName: 'Sales tax payable',
			},
			{ lineKey: 'not a key!', accountCode: '1', accountName: 'x' },
		])
		expect(await loadAccountMapping(organization.id)).toEqual({
			'sales:mains': { code: '4000', name: 'Food sales' },
			'tax:1500': { code: '2200', name: 'Sales tax payable' },
		})
		await saveAccountMapping(organization.id, [
			{ lineKey: 'tax:1500', accountCode: '', accountName: '' },
		])
		expect(Object.keys(await loadAccountMapping(organization.id))).toEqual([
			'sales:mains',
		])
	})

	it('exports a closed day once as final, then nothing if unchanged', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const mapping = await loadAccountMapping(organization.id)
		const first = await prepareAccountingExport({
			organizationId: organization.id,
			userId: user.id,
			days: [day()],
			mapping,
			layout: 'quickbooks',
			record: true,
		})
		expect(first.entries).toHaveLength(1)
		expect(first.entries[0]!.status).toBe('final')
		expect(first.csv.split('\n')[0]).toBe(
			'*JournalNo,*JournalDate,*AccountName,*Debits,*Credits,Description,Name,Currency,Location',
		)
		const again = await prepareAccountingExport({
			organizationId: organization.id,
			userId: user.id,
			days: [day()],
			mapping,
			layout: 'quickbooks',
			record: true,
		})
		expect(again.entries).toEqual([])
		expect(again.unchanged).toBe(1)
		expect(again.csv.trim().split('\n')).toHaveLength(1) // header only
		const rows = await db
			.select()
			.from(AccountingExport)
			.where(eq(AccountingExport.organizationId, organization.id))
		expect(rows).toHaveLength(1)
	})

	it('a late refund on an exported day produces an adjusting entry, never a silent change', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const run = (days: AccountingDayFacts[], record = true) =>
			prepareAccountingExport({
				organizationId: organization.id,
				userId: user.id,
				days,
				mapping: {},
				layout: 'generic',
				record,
			})
		const original = await run([day()])
		expect(original.entries[0]!.reference).not.toMatch(/ADJ/)
		// The same day again after a 10.00 + 1.50 tax refund went back through cash.
		const changed = day({
			refundsNetMinor: -1000,
			taxByRate: [{ rateBp: 1500, minor: 1350 }],
			tenders: [
				{ tender: 'cash', minor: 4000 - 1150 },
				{ tender: 'card_till', minor: 7500 },
			],
		})
		const adjusted = await run([changed])
		expect(adjusted.adjustments).toBe(1)
		expect(adjusted.entries).toHaveLength(1)
		const entry = adjusted.entries[0]!
		expect(entry.status).toBe('adjustment')
		expect(entry.reference).toMatch(/-ADJ1$/)
		expect(entry.debitMinor).toBe(entry.creditMinor)
		expect(adjusted.csv).toContain('adjustment')
		expect(adjusted.csv).toContain('Refunds')
		// Exporting that same state again is quiet; a second change is ADJ2.
		expect((await run([changed])).entries).toEqual([])
		const again = await run([
			day({
				...changed,
				refundsNetMinor: -1500,
				taxByRate: [{ rateBp: 1500, minor: 1275 }],
				tenders: [
					{ tender: 'cash', minor: 4000 - 1725 },
					{ tender: 'card_till', minor: 7500 },
				],
			}),
		])
		expect(again.entries[0]!.reference).toMatch(/-ADJ2$/)
		const rows = await db
			.select()
			.from(AccountingExport)
			.where(eq(AccountingExport.organizationId, organization.id))
		expect(rows.map((r) => r.sequence).sort()).toEqual([1, 2, 3])
	})

	it('shows an open day as provisional and records nothing for it', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const result = await prepareAccountingExport({
			organizationId: organization.id,
			userId: user.id,
			days: [day({ closed: false })],
			mapping: {},
			layout: 'generic',
			record: true,
		})
		expect(result.provisional).toBe(1)
		expect(result.entries[0]!.status).toBe('provisional')
		const rows = await db
			.select()
			.from(AccountingExport)
			.where(eq(AccountingExport.organizationId, organization.id))
		expect(rows).toHaveLength(0)
	})

	it('names a day that does not balance instead of hiding it', async () => {
		const { user, organization } = await setupTestOrgWithUser('admin')
		const result = await prepareAccountingExport({
			organizationId: organization.id,
			userId: user.id,
			days: [day({ tenders: [{ tender: 'cash', minor: 100 }] })],
			mapping: {},
			layout: 'generic',
			record: false,
		})
		expect(result.outOfBalance).toBe(1)
		expect(result.csv).toContain('Difference (needs review)')
	})

	it("merges a location's day with the provider's and keeps currencies apart", () => {
		const merged = mergeAccountingDays(
			[
				day(),
				day({ currency: 'SAR', locationId: 'loc_ruh', locationName: 'Riyadh' }),
			],
			providerDayFacts({
				payouts: [
					{
						arrivalDate: '2026-11-20T10:00:00Z',
						currency: 'USD',
						amountCents: 500,
						status: 'paid',
						feeCents: 10,
					},
				],
				from: '2026-11-20',
				to: '2026-11-20',
				timeZone: 'UTC',
				today: '2026-12-01',
			}),
		)
		expect(merged.map((d) => `${d.locationId}/${d.currency}`).sort()).toEqual([
			'loc_main/USD',
			'loc_ruh/SAR',
			'provider/USD',
		])
		expect(new Set(merged.map((d) => d.currency))).toEqual(
			new Set(['USD', 'SAR']),
		)
	})
})

import { describe, expect, it } from 'vitest'
import {
	adjustingEntry,
	adjustingLines,
	buildJournalDay,
	entryFromDay,
	journalHash,
	journalToCsv,
	mappableLines,
	type AccountingDayFacts,
} from './accounting-journal.ts'

function facts(over: Partial<AccountingDayFacts> = {}): AccountingDayFacts {
	return {
		locationId: 'loc_main',
		locationName: 'Main St',
		businessDate: '2026-11-20',
		currency: 'USD',
		closed: true,
		categories: [
			{ key: 'mains', label: 'Mains', minor: 8000 },
			{ key: 'drinks', label: 'Drinks', minor: 2000 },
		],
		grossMinor: 10_500,
		serviceFeesMinor: 500,
		discountsMinor: 1000,
		loyaltyMinor: 200,
		cashDiscountsMinor: 0,
		refundsNetMinor: 0,
		taxByRate: [
			{ rateBp: 500, minor: 300 },
			{ rateBp: 1500, minor: 600 },
		],
		tipsMinor: 700,
		giftCardsSoldMinor: 5000,
		// collected = net (10500 - 1000 - 200 = 9300) + tax 900 + tips 700 = 10900, plus 5000 for gift cards sold
		tenders: [
			{ tender: 'cash', minor: 4000 },
			{ tender: 'card_online', minor: 6900 },
			{ tender: 'card_till', minor: 5000 },
		],
		processingFeesMinor: 400,
		payoutMinor: 9000,
		...over,
	}
}

describe('the daily journal (#189)', () => {
	it('balances, by rate and tender, and carries every line the issue names', () => {
		const day = buildJournalDay(facts())
		expect(day.differenceMinor).toBe(0)
		expect(day.debitMinor).toBe(day.creditMinor)
		const keys = day.lines.map((l) => l.lineKey)
		expect(keys).toEqual(
			expect.arrayContaining([
				'sales:mains',
				'sales:drinks',
				'service_fees',
				'discounts',
				'loyalty_rewards',
				'tax:500',
				'tax:1500',
				'tips',
				'gift_cards_sold',
				'tender:cash',
				'tender:card_online',
				'processing_fees',
				'payout',
				'payment_clearing',
			]),
		)
		expect(day.status).toBe('final')
		// Mixed tax rates stay on their own lines.
		expect(day.lines.find((l) => l.lineKey === 'tax:500')!.creditMinor).toBe(
			300,
		)
		expect(day.lines.find((l) => l.lineKey === 'tax:1500')!.creditMinor).toBe(
			600,
		)
		// The payout line is the payout figure, and the clearing credit equals payout plus fees.
		expect(day.lines.find((l) => l.lineKey === 'payout')!.debitMinor).toBe(9000)
		expect(
			day.lines.find((l) => l.lineKey === 'payment_clearing')!.creditMinor,
		).toBe(9400)
	})

	it('balances every consistent day: a property test over 300 random days', () => {
		let seed = 987_654_321
		const rand = (n: number) => {
			seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
			return seed % n
		}
		for (let i = 0; i < 300; i += 1) {
			const categories = Array.from({ length: 1 + rand(4) }, (_, c) => ({
				key: `c${c}`,
				label: `Category ${c}`,
				minor: rand(50_000),
			}))
			const items =
				categories.reduce((s, c) => s + c.minor, 0) + rand(300) - 150 // rounding noise
			const serviceFees = rand(2_000)
			const gross = Math.max(0, items) + serviceFees
			const discounts = rand(Math.max(1, Math.floor(gross / 3)))
			const loyalty = rand(Math.max(1, Math.floor(gross / 10)))
			const cashDiscounts = rand(100)
			const net = gross - discounts - loyalty - cashDiscounts
			const rates = [0, 500, 1500, 2000].slice(0, 1 + rand(4))
			const taxByRate = rates.map((rateBp) => ({ rateBp, minor: rand(3_000) }))
			const tax = taxByRate.reduce((s, t) => s + t.minor, 0)
			const tips = rand(4_000)
			const refundNet = -rand(Math.max(1, Math.floor(net / 4)))
			const refundTax = -rand(200)
			const refundTip = -rand(100)
			const giftSold = rand(3) === 0 ? rand(20_000) : 0
			const collected =
				net + tax + tips + (refundNet + refundTax + refundTip) + giftSold
			// Split what was collected over tenders.
			const cash = rand(Math.max(1, collected))
			const gift = rand(Math.max(1, collected - cash))
			const rest = collected - cash - gift
			const payout = rand(Math.max(1, Math.abs(collected)))
			const fees = rand(500)
			const day = buildJournalDay({
				...facts(),
				categories,
				grossMinor: gross,
				serviceFeesMinor: serviceFees,
				discountsMinor: discounts,
				loyaltyMinor: loyalty,
				cashDiscountsMinor: cashDiscounts,
				refundsNetMinor: refundNet,
				taxByRate: [
					...taxByRate,
					{ rateBp: 9999, minor: refundTax }, // the tax a refund took back
				],
				tipsMinor: tips + refundTip,
				giftCardsSoldMinor: giftSold,
				tenders: [
					{ tender: 'cash', minor: cash },
					{ tender: 'gift_card', minor: gift },
					{ tender: 'card_online', minor: rest },
				],
				processingFeesMinor: fees,
				payoutMinor: payout,
			})
			expect(day.differenceMinor, `day ${i}`).toBe(0)
			expect(day.debitMinor).toBe(day.creditMinor)
			expect(day.lines.some((l) => l.kind === 'difference')).toBe(false)
		}
	})

	it('shows the difference when a day does not balance, never hiding it', () => {
		const day = buildJournalDay(
			facts({ tenders: [{ tender: 'cash', minor: 1000 }] }),
		)
		expect(day.differenceMinor).not.toBe(0)
		const line = day.lines.find((l) => l.kind === 'difference')!
		expect(line.label).toContain('Difference')
		// With the difference line the totals match, and the gap is named in a file.
		expect(day.debitMinor).toBe(day.creditMinor)
		const csv = journalToCsv([entryFromDay(day)], {}, 'generic')
		expect(csv).toContain('Difference (needs review)')
	})

	it('is provisional until the day closes', () => {
		expect(buildJournalDay(facts({ closed: false })).status).toBe('provisional')
	})

	it('a late refund produces an adjusting entry; an unchanged day produces none', () => {
		const first = buildJournalDay(facts())
		// The refund arrives after the day was exported: net -1000, tax -150 (rate 15%), tip -0, back through cash.
		const later = buildJournalDay(
			facts({
				refundsNetMinor: -1000,
				taxByRate: [
					{ rateBp: 500, minor: 300 },
					{ rateBp: 1500, minor: 450 },
				],
				tenders: [
					{ tender: 'cash', minor: 4000 - 1150 },
					{ tender: 'card_online', minor: 6900 },
					{ tender: 'card_till', minor: 5000 },
				],
			}),
		)
		expect(first.differenceMinor).toBe(0)
		expect(later.differenceMinor).toBe(0)
		expect(journalHash(later.lines)).not.toBe(journalHash(first.lines))
		const delta = adjustingLines(first.lines, later.lines)
		expect(delta.length).toBeGreaterThan(0)
		const entry = adjustingEntry(later, delta, 2)
		expect(entry.status).toBe('adjustment')
		expect(entry.reference).toMatch(/-ADJ1$/)
		// The adjustment balances and names exactly what moved.
		expect(entry.debitMinor).toBe(entry.creditMinor)
		const byKey = Object.fromEntries(delta.map((l) => [l.lineKey, l]))
		expect(byKey.refunds).toMatchObject({ debitMinor: 1000, creditMinor: 0 })
		expect(byKey['tax:1500']).toMatchObject({ debitMinor: 150, creditMinor: 0 })
		expect(byKey['tender:cash']).toMatchObject({
			debitMinor: 0,
			creditMinor: 1150,
		})
		// Nothing changed: nothing to adjust, same hash.
		const same = buildJournalDay(facts())
		expect(adjustingLines(first.lines, same.lines)).toEqual([])
		expect(journalHash(same.lines)).toBe(journalHash(first.lines))
	})
})

describe('file layouts (#189)', () => {
	const day = buildJournalDay(
		facts({
			categories: [{ key: 'mains', label: 'Mains', minor: 10_000 }],
			grossMinor: 10_000,
			serviceFeesMinor: 0,
			discountsMinor: 0,
			loyaltyMinor: 0,
			taxByRate: [{ rateBp: 1500, minor: 1500 }],
			tipsMinor: 0,
			giftCardsSoldMinor: 0,
			tenders: [
				{ tender: 'cash', minor: 4000 },
				{ tender: 'card_till', minor: 7500 },
			],
			processingFeesMinor: 0,
			payoutMinor: 0,
		}),
	)
	const entry = entryFromDay(day)
	const mapping = {
		'sales:mains': { code: '4000', name: 'Food sales' },
		'tax:1500': { code: '2200', name: 'Sales tax payable' },
		'tender:cash': { code: '1000', name: 'Cash on hand' },
		'tender:card_till': { code: '1100', name: 'Card clearing' },
	}

	it('QuickBooks layout (snapshot)', () => {
		expect(journalToCsv([entry], mapping, 'quickbooks')).toMatchInlineSnapshot(`
			"*JournalNo,*JournalDate,*AccountName,*Debits,*Credits,Description,Name,Currency,Location
			JNL-2026-11-20-loc_main-USD,11/20/2026,Food sales,,100.00,Daily sales 2026-11-20: Sales: Mains,,USD,Main St
			JNL-2026-11-20-loc_main-USD,11/20/2026,Sales tax payable,,15.00,Daily sales 2026-11-20: Tax 15%,,USD,Main St
			JNL-2026-11-20-loc_main-USD,11/20/2026,Card clearing,75.00,,Daily sales 2026-11-20: Card payments (till),,USD,Main St
			JNL-2026-11-20-loc_main-USD,11/20/2026,Cash on hand,40.00,,Daily sales 2026-11-20: Cash received,,USD,Main St
			"
		`)
	})

	it('Xero layout (snapshot): debits positive, credits negative', () => {
		expect(journalToCsv([entry], mapping, 'xero')).toMatchInlineSnapshot(`
			"*Narration,*Date,Description,*AccountCode,*TaxRate,*Amount,TrackingName1,TrackingOption1
			Daily sales 2026-11-20 Main St JNL-2026-11-20-loc_main-USD,20/11/2026,Sales: Mains,4000,Tax Exempt,-100.00,Location,Main St
			Daily sales 2026-11-20 Main St JNL-2026-11-20-loc_main-USD,20/11/2026,Tax 15%,2200,Tax Exempt,-15.00,Location,Main St
			Daily sales 2026-11-20 Main St JNL-2026-11-20-loc_main-USD,20/11/2026,Card payments (till),1100,Tax Exempt,75.00,Location,Main St
			Daily sales 2026-11-20 Main St JNL-2026-11-20-loc_main-USD,20/11/2026,Cash received,1000,Tax Exempt,40.00,Location,Main St
			"
		`)
	})

	it('generic layout (snapshot), with unmapped lines named by default', () => {
		expect(journalToCsv([entry], {}, 'generic')).toMatchInlineSnapshot(`
			"Date,Location,Reference,Status,Account code,Account name,Debit,Credit,Currency,Memo
			2026-11-20,Main St,JNL-2026-11-20-loc_main-USD,final,,Sales: Mains,,100.00,USD,Sales: Mains
			2026-11-20,Main St,JNL-2026-11-20-loc_main-USD,final,,Tax 15% payable,,15.00,USD,Tax 15%
			2026-11-20,Main St,JNL-2026-11-20-loc_main-USD,final,,Card payments (till),75.00,,USD,Card payments (till)
			2026-11-20,Main St,JNL-2026-11-20-loc_main-USD,final,,Cash received,40.00,,USD,Cash received
			"
		`)
	})

	it('every layout balances: debits equal credits in the file', () => {
		for (const layout of ['quickbooks', 'generic'] as const) {
			const rows = journalToCsv([entry], mapping, layout)
				.trim()
				.split('\n')
				.slice(1)
			let debit = 0
			let credit = 0
			for (const row of rows) {
				const cells = row.split(',')
				const d = layout === 'quickbooks' ? cells[3]! : cells[6]!
				const c = layout === 'quickbooks' ? cells[4]! : cells[7]!
				debit += Number(d || 0)
				credit += Number(c || 0)
			}
			expect(debit).toBeCloseTo(credit, 2)
		}
		const xero = journalToCsv([entry], mapping, 'xero')
			.trim()
			.split('\n')
			.slice(1)
		expect(xero.reduce((s, r) => s + Number(r.split(',')[5]), 0)).toBeCloseTo(
			0,
			2,
		)
	})

	it('is formula-safe: an account name starting with = is neutralised', () => {
		const csv = journalToCsv(
			[entry],
			{ 'sales:mains': { code: '', name: '=HYPERLINK("evil")' } },
			'generic',
		)
		expect(csv.split('\n').some((l) => l.includes(',=HYPERLINK'))).toBe(false)
		expect(csv).toContain("'=HYPERLINK")
	})

	it('lists the lines to map, once each', () => {
		const lines = mappableLines([entry, entryFromDay(day, 2)])
		expect(lines.map((l) => l.lineKey)).toEqual([
			'sales:mains',
			'tax:1500',
			'tender:card_till',
			'tender:cash',
		])
	})
})

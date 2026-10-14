import { describe, expect, it } from 'vitest'
import { card, dayView, person } from './timesheet-fixtures.ts'
import {
	batchResultSchema,
	cardDetailSchema,
	dayViewSchema,
	exportSchema,
	payPeriodSettingsSchema,
	payrollSummarySchema,
	periodViewSchema,
	reviewViewSchema,
	writeResultSchema,
} from './timesheet-types.ts'

const period = {
	type: 'biweekly',
	start: '2026-03-02',
	end: '2026-03-15',
	days: 14,
	previousStart: '2026-02-16',
	nextStart: '2026-03-16',
}

describe('response schemas accept what the node sends', () => {
	it('day, period and review views', () => {
		const view = dayView([
			person({}, [card({ issues: ['missed_break'], status: 'needs_review' })]),
		])
		expect(dayViewSchema.safeParse(view).success).toBe(true)
		expect(periodViewSchema.safeParse({ ...view, period }).success).toBe(true)
		expect(
			reviewViewSchema.safeParse({ ...view, byIssue: { missed_break: 1 } })
				.success,
		).toBe(true)
	})

	it('money keys are optional and parsed when present', () => {
		const money = {
			estimate: true as const,
			currency: 'USD',
			rateMinor: 2000,
			payMinor: 16000,
			cashTipsMinor: 0,
			creditTipsMinor: 0,
		}
		const view = dayView([person({}, [card({ money })])], {
			labor: {
				estimate: true,
				payMinorByCurrency: { USD: 16000 },
				unpricedMinutes: 0,
			},
		})
		const parsed = dayViewSchema.parse(view)
		expect(parsed.people[0]!.cards[0]!.money?.payMinor).toBe(16000)
		expect(parsed.labor?.payMinorByCurrency.USD).toBe(16000)
	})

	it('rejects a status it does not know instead of guessing', () => {
		expect(
			dayViewSchema.safeParse(
				dayView([person({}, [card({ status: 'weird' as never })])]),
			).success,
		).toBe(false)
	})

	it('card detail, write result, batch, summary, export and settings', () => {
		const c = card()
		const edit = {
			id: 'e1',
			entryId: 'c1',
			editorId: 'u1',
			via: 'manager',
			action: 'update',
			reason: 'r',
			before: { clockOutAt: 1 },
			after: { clockOutAt: 2 },
			hoursDeltaMinutes: -30,
			createdAt: 5,
		}
		const { people } = dayView()
		const { cards: ignoredCards, totals: ignoredTotals, ...info } = people[0]!
		expect(
			cardDetailSchema.safeParse({
				serverNow: 1,
				person: info,
				card: c,
				edits: [edit],
				punches: [
					{
						id: 'p',
						kind: 'clock_in',
						effectiveAt: null,
						serverAt: 1,
						source: 'kiosk',
						flags: [],
					},
				],
			}).success,
		).toBe(true)
		expect(
			writeResultSchema.safeParse({ card: null, edit, reducedHours: true })
				.success,
		).toBe(true)
		expect(
			batchResultSchema.safeParse({
				results: [
					{
						id: 'c1',
						ok: false,
						code: 'needs_fix',
						version: 2,
						status: 'needs_review',
					},
				],
				changed: 0,
				skipped: 1,
			}).success,
		).toBe(true)
		expect(
			payrollSummarySchema.safeParse({
				serverNow: 1,
				period,
				filters: {
					scopeId: null,
					positionId: null,
					staffId: null,
					status: null,
				},
				rows: [
					{
						staffId: 's1',
						employeeNumber: null,
						firstName: 'a',
						lastName: 'b',
						cards: 1,
						regularMinutes: 1,
						overtimeMinutes: 0,
						doubleTimeMinutes: 0,
						holidayMinutes: 0,
						paidMinutes: 1,
						unpaidBreakMinutes: 0,
						unapprovedCards: 0,
					},
				],
				totals: {
					regularMinutes: 1,
					overtimeMinutes: 0,
					doubleTimeMinutes: 0,
					holidayMinutes: 0,
					paidMinutes: 1,
					unpaidBreakMinutes: 0,
					cards: 1,
					unapprovedCards: 0,
				},
				readyForPayroll: true,
				truncated: false,
			}).success,
		).toBe(true)
		expect(
			exportSchema.safeParse({
				filename: 'a.csv',
				kind: 'cards',
				rowCount: 1,
				includesMoney: false,
				headers: ['a'],
				rows: [['x', 1, null, true]],
				csv: '',
			}).success,
		).toBe(true)
		expect(
			payPeriodSettingsSchema.parse({
				payPeriod: 'nonsense',
				payPeriodAnchor: null,
				current: period,
			}).payPeriod,
		).toBe('weekly')
	})
})

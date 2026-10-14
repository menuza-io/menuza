import { describe, expect, it } from 'vitest'
import { card, HOUR, NINE_AM, person } from './timesheet-fixtures.ts'
import { timesheetCardSchema } from './timesheet-types.ts'
import {
	approvalModeFor,
	cardActions,
	chunk,
	filterRows,
	flattenRows,
	formatHours,
	formatPeriodLabel,
	groupRows,
	isReadyToApprove,
	isValidDate,
	parseTimesheetSearch,
	sortIssues,
	sumCards,
	summarizeBatch,
	timeInputOf,
	calendarDateOf,
	dayOffset,
	todayIn,
	writeTimesheetSearch,
} from './timesheet-view.ts'

const TODAY = '2026-03-04'

describe('address bar state', () => {
	it('falls back to defaults for anything unknown or malformed', () => {
		const state = parseTimesheetSearch(
			new URLSearchParams('view=bogus&date=2026-02-31&group=x&status=nope'),
			TODAY,
		)
		expect(state).toMatchObject({
			view: 'period',
			date: TODAY,
			group: 'person',
			status: 'all',
			scopeId: 'all',
		})
	})

	it('keeps typed search text, which can be a name, out of the address bar', () => {
		expect(
			parseTimesheetSearch(new URLSearchParams('q=rana&view=day'), TODAY).q,
		).toBe('')
		expect(
			writeTimesheetSearch(
				new URLSearchParams('q=rana'),
				{ q: 'rana' },
				TODAY,
			).toString(),
		).toBe('')
	})

	it('never groups a single day by date', () => {
		const state = parseTimesheetSearch(
			new URLSearchParams('view=day&group=date'),
			TODAY,
		)
		expect(state.group).toBe('person')
	})

	it('writes only what differs from the defaults and round-trips', () => {
		const written = writeTimesheetSearch(
			new URLSearchParams(),
			{ view: 'day', date: '2026-03-01', scopeId: 'loc-1', q: ' rana ' },
			TODAY,
		)
		expect(written.toString()).toBe('view=day&date=2026-03-01&scope=loc-1')
		expect(parseTimesheetSearch(written, TODAY)).toMatchObject({
			view: 'day',
			date: '2026-03-01',
			scopeId: 'loc-1',
			q: '',
		})
		expect(
			writeTimesheetSearch(
				new URLSearchParams(),
				{ date: TODAY },
				TODAY,
			).toString(),
		).toBe('')
	})

	it('validates dates strictly', () => {
		expect(isValidDate('2026-03-02')).toBe(true)
		expect(isValidDate('2026-02-30')).toBe(false)
		expect(isValidDate('2026-13-01')).toBe(false)
		expect(isValidDate('20260302')).toBe(false)
		expect(isValidDate(null)).toBe(false)
	})
})

describe('dates and numbers', () => {
	it('reads local dates and times in the card zone, across midnight', () => {
		// 2026-03-03 03:30 UTC is still 21:30 on Mar 2 in Chicago.
		const at = Date.UTC(2026, 2, 3, 3, 30)
		expect(calendarDateOf(at, 'America/Chicago')).toBe('2026-03-02')
		expect(timeInputOf(at, 'America/Chicago')).toBe('21:30')
		expect(calendarDateOf(at, 'Asia/Riyadh')).toBe('2026-03-03')
		expect(dayOffset(NINE_AM, NINE_AM + 17 * HOUR, 'America/Chicago')).toBe(1)
		expect(todayIn(at, 'America/Chicago')).toBe('2026-03-02')
	})

	it('formats decimal hours and period labels', () => {
		expect(formatHours(450)).toBe('7.50')
		expect(formatHours(0)).toBe('0.00')
		expect(formatPeriodLabel('2026-03-02', '2026-03-15', 'en')).toMatch(
			/Mar 2.*15, 2026/,
		)
	})
})

describe('rows, totals and groups', () => {
	const rana = person({}, [
		card({ id: 'a', clockInAt: NINE_AM + 24 * HOUR, localDate: '2026-03-03' }),
		card({ id: 'b' }),
	])
	const omar = person(
		{
			staffId: 's2',
			firstName: 'Omar',
			lastName: 'Aziz',
			employeeNumber: 'E-9',
		},
		[
			card({
				id: 'c',
				staffId: 's2',
				positionId: 'p2',
				positionName: 'Cook',
				positionNameAr: 'طباخ',
				status: 'needs_review',
				issues: ['missed_break'],
				minutes: {
					regularMinutes: 400,
					overtimeMinutes: 80,
					doubleTimeMinutes: 0,
					holidayMinutes: 0,
					paidMinutes: 480,
					unpaidBreakMinutes: 30,
				},
				money: {
					estimate: true,
					currency: 'USD',
					rateMinor: 2000,
					payMinor: 17000,
					cashTipsMinor: 0,
					creditTipsMinor: 0,
				},
			}),
		],
	)
	const rows = flattenRows([rana, omar])

	it('flattens every card with its person', () => {
		expect(rows.map((r) => r.card.id)).toEqual(['a', 'b', 'c'])
		expect(rows[2]!.person.firstName).toBe('Omar')
	})

	it('totals minutes, statuses and money without mixing currencies', () => {
		const totals = sumCards(rows.map((r) => r.card))
		expect(totals).toMatchObject({
			cards: 3,
			paidMinutes: 1440,
			overtimeMinutes: 80,
			needsReview: 1,
			unpaidBreakMinutes: 30,
			payMinorByCurrency: { USD: 17000 },
		})
		expect(sumCards([card()]).payMinorByCurrency).toBeNull()
	})

	it('counts a card with no rate as unpriced, not zero', () => {
		const totals = sumCards([
			card({
				money: {
					estimate: true,
					currency: null,
					rateMinor: null,
					payMinor: null,
					cashTipsMinor: 0,
					creditTipsMinor: 0,
				},
			}),
		])
		expect(totals.unpricedMinutes).toBe(480)
		expect(totals.payMinorByCurrency).toEqual({})
	})

	it('groups by person with cards in time order and people by name', () => {
		const groups = groupRows(rows, 'person', 'en')
		expect(groups.map((g) => g.person?.firstName)).toEqual(['Omar', 'Rana'])
		expect(groups[1]!.rows.map((r) => r.card.id)).toEqual(['b', 'a'])
		expect(groups[1]!.totals.cards).toBe(2)
	})

	it('groups by date ascending and by position with a "none" bucket last', () => {
		expect(groupRows(rows, 'date', 'en').map((g) => g.date)).toEqual([
			'2026-03-02',
			'2026-03-03',
		])
		const noPosition = flattenRows([
			person({}, [card({ id: 'x', positionId: null, positionName: null })]),
		])
		const groups = groupRows([...rows, ...noPosition], 'position', 'ar')
		expect(groups.map((g) => g.positionName)).toEqual(
			['Server', 'طباخ', null].sort((a, b) =>
				(a ?? '￿').localeCompare(b ?? '￿'),
			),
		)
		expect(groups.at(-1)!.positionName).toBeNull()
	})

	it('searches names, payroll IDs and positions', () => {
		expect(filterRows(rows, 'omar', 'en')).toHaveLength(1)
		expect(filterRows(rows, 'e-9', 'en')).toHaveLength(1)
		expect(filterRows(rows, 'cook', 'en')).toHaveLength(1)
		expect(filterRows(rows, 'طباخ', 'ar')).toHaveLength(1)
		expect(filterRows(rows, '  ', 'en')).toHaveLength(3)
		expect(filterRows(rows, 'nobody', 'en')).toHaveLength(0)
	})
})

describe('what a card can do', () => {
	const can = { approve: true, update: true }

	it('approves closed and reviewable cards only when approval is on', () => {
		const closed = card()
		expect(cardActions(closed, 'approve', can).approve).toBe(true)
		expect(cardActions(closed, 'none', can).approve).toBe(false)
		expect(cardActions(closed, 'unknown', can).approve).toBe(true)
		expect(
			cardActions(closed, 'approve', { ...can, approve: false }).approve,
		).toBe(false)
	})

	it('never approves a card that needs fixing', () => {
		for (const issue of [
			'missing_clock_out',
			'open_break',
			'negative_duration',
		]) {
			const broken = card({ status: 'needs_review', issues: [issue as never] })
			expect(cardActions(broken, 'approve', can).approve).toBe(false)
			expect(cardActions(broken, 'approve', can).review).toBe(false)
		}
		const open = card({ clockOutAt: null, status: 'open' })
		expect(cardActions(open, 'approve', can).approve).toBe(false)
	})

	it('lets a missed break be marked as looked at, and approved', () => {
		const soft = card({ status: 'needs_review', issues: ['missed_break'] })
		const actions = cardActions(soft, 'approve', can)
		expect(actions.review).toBe(true)
		expect(actions.approve).toBe(true)
		expect(isReadyToApprove(soft)).toBe(false)
		expect(isReadyToApprove(card())).toBe(true)
	})

	it('locks only approved cards and only where locking is on', () => {
		const approved = card({ status: 'approved' })
		expect(cardActions(approved, 'approve_lock', can).lock).toBe(true)
		expect(cardActions(approved, 'approve', can).lock).toBe(false)
		expect(cardActions(approved, 'approve_lock', can).reopen).toBe(true)
		expect(cardActions(approved, 'approve_lock', can).edit).toBe(false)
	})

	it('offers unlock for locked cards and no edit for anyone', () => {
		const locked = card({ status: 'locked' })
		const actions = cardActions(locked, 'approve_lock', can)
		expect(actions.unlock).toBe(true)
		expect(actions.edit).toBe(false)
		expect(actions.reopen).toBe(false)
	})

	it('without update access nothing edits', () => {
		const actions = cardActions(card(), 'approve', {
			approve: false,
			update: false,
		})
		expect(Object.values(actions).some(Boolean)).toBe(false)
	})

	it('reads the approval mode from the workplace, then the default', () => {
		const policies = {
			default: { timesheetApprovalMode: 'approve' },
			scopes: [{ scopeId: 'loc-2', timesheetApprovalMode: 'none' }],
		}
		expect(approvalModeFor(policies, 'loc-1')).toBe('approve')
		expect(approvalModeFor(policies, 'loc-2')).toBe('none')
		expect(approvalModeFor({ default: null, scopes: [] }, 'loc-1')).toBe('none')
		expect(approvalModeFor(null, 'loc-1')).toBe('unknown')
	})
})

describe('batches and issues', () => {
	it('summarizes per-card results by code', () => {
		expect(
			summarizeBatch([
				{ ok: true },
				{ ok: false, code: 'needs_fix' },
				{ ok: false, code: 'needs_fix' },
				{ ok: false },
			]),
		).toEqual({ done: 1, skipped: 3, codes: { needs_fix: 2, failed: 1 } })
	})

	it('chunks into batches the API accepts', () => {
		const items = Array.from({ length: 450 }, (_, i) => i)
		expect(chunk(items, 200).map((c) => c.length)).toEqual([200, 200, 50])
		expect(chunk([], 200)).toEqual([])
	})

	it('puts the issues that need a manager first', () => {
		expect(
			sortIssues(['late', 'edited', 'missed_break', 'long_shift']),
		).toEqual(['missed_break', 'long_shift', 'late', 'edited'])
	})
})

describe('schema', () => {
	it('accepts a card with unknown issue codes and no money', () => {
		const parsed = timesheetCardSchema.safeParse(
			card({ issues: ['future_thing' as never] }),
		)
		expect(parsed.success).toBe(true)
		expect(parsed.success && parsed.data.money).toBeUndefined()
	})
})

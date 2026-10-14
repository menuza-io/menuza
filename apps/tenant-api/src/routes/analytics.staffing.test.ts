import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReportDefinition, type ReportDefinition } from '@repo/reports'
import {
	mintOperatorAnalyticsToken,
	type RestrictedReportSubject,
} from '@repo/reports/token'
import { hiringApplications, shifts, staffAuditLog } from '@repo/tenant-db'
import { registerOrderSource } from '../services/order-source.ts'
import { createFakeOrderSource } from '../../tests/order-source.ts'
import {
	INTERNAL_TOKEN,
	makeOrg,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import {
	at,
	CHI,
	createClockHarness,
	laborFixture,
	LOC_1,
	LOC_2,
	ORG_A,
	ORG_B,
	type ClockHarness,
	type LaborFixture,
} from '../../tests/labor-harness.ts'

const facts = vi.hoisted(
	() => new Map<string, { name: string; timeZone: string }>(),
)
const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/scope-context.ts', () => ({
	getScopeFacts: vi.fn(
		async (_org: string, scope: string) => facts.get(scope) ?? null,
	),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

const WEEK_TIMEFRAME = {
	field: 'clockInAt',
	preset: 'custom' as const,
	start: '2026-03-01T00:00:00.000Z',
	end: '2026-03-10T00:00:00.000Z',
}

type Query = {
	subject: string
	timeframeField?: string
	groupBy?: string[]
	chartStyle?: ReportDefinition['visualization']['chartStyle']
	measure?: ReportDefinition['visualization']['measure']
	valueField?: string
	timeBucket?: ReportDefinition['timeBucket']
	columns?: string[]
}

function definitionOf(query: Query) {
	return createReportDefinition({
		subject: query.subject,
		timeframe: {
			...WEEK_TIMEFRAME,
			field: query.timeframeField ?? 'clockInAt',
		},
		groupBy: query.groupBy ?? [],
		timeBucket: query.timeBucket ?? 'day',
		columns: query.columns ?? [],
		visualization: {
			chartStyle: query.chartStyle ?? 'single_number',
			measure: query.measure ?? 'count',
			...(query.valueField ? { valueField: query.valueField } : {}),
			sortBy: 'none',
			hideCounts: false,
		},
		settings: { title: 'Test', notes: '', timezone: 'UTC' },
	})
}

describe('/analytics/query on staff subjects', () => {
	let h: ClockHarness
	let l: LaborFixture

	async function run(
		query: Query,
		options: {
			subjects?: readonly RestrictedReportSubject[]
			scopeIds?: readonly string[] | null | undefined
			orgId?: string
			token?: string | null
		} = {},
	) {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
		}
		if (options.token !== null) {
			const minted =
				options.token ??
				(
					await mintOperatorAnalyticsToken({
						internalCommandToken: INTERNAL_TOKEN,
						userId: 'user-1',
						orgId: options.orgId ?? ORG_A,
						role: 'operator',
						subjects: options.subjects ?? [],
						scopeIds: options.scopeIds === undefined ? null : options.scopeIds,
					})
				).token
			headers.Authorization = `Bearer ${minted}`
		}
		const response = await h.app.request('/analytics/query', {
			method: 'POST',
			headers,
			body: JSON.stringify({ definition: definitionOf(query) }),
		})
		return { status: response.status, body: (await response.json()) as any }
	}

	/**
	 * The hand-calculated week of the labor suite (Monday 2026-03-02 to Sunday
	 * 03-08, Chicago): Ana $20/h, Ben $12/h.
	 *
	 *   Mon  Ana 09-17, Ben 10-16       Tue  Ana 09-17     Wed  Ben 08:00-13:30
	 *   Fri  Ana 09-17, Ben 09-17       Sat  Ana 09-19
	 */
	async function seedWeek() {
		const a = await l.staff({
			firstName: 'Ana',
			lastName: 'Adams',
			rateMinor: 2000,
		})
		const b = await l.staff({
			firstName: 'Ben',
			lastName: 'Brown',
			rateMinor: 1200,
		})
		const card = async (
			staffId: string,
			date: string,
			startTime: string,
			endTime: string,
		) => {
			const response = await l.card({
				staffId,
				scopeId: LOC_1,
				date,
				startTime,
				endTime,
				reason: 'Test week',
			})
			expect(response.status).toBe(201)
		}
		await card(a.staffId, '2026-03-02', '09:00', '17:00')
		await card(b.staffId, '2026-03-02', '10:00', '16:00')
		await card(a.staffId, '2026-03-03', '09:00', '17:00')
		await card(b.staffId, '2026-03-04', '08:00', '13:30')
		await card(a.staffId, '2026-03-06', '09:00', '17:00')
		await card(b.staffId, '2026-03-06', '09:00', '17:00')
		await card(a.staffId, '2026-03-07', '09:00', '19:00')
		return { a, b }
	}

	async function enterWeekSales() {
		const response = await l.send('POST', '/sales/bulk', {
			scopeId: LOC_1,
			currency: 'USD',
			entries: [
				{ date: '2026-03-02', netSalesMinor: 80_000 },
				{ date: '2026-03-03', netSalesMinor: 64_000 },
				{ date: '2026-03-05', netSalesMinor: 50_000 },
				{ date: '2026-03-06', netSalesMinor: 128_000 },
				{ date: '2026-03-07', netSalesMinor: 100_000 },
			],
		})
		expect(response.status).toBe(200)
		await l.send('PUT', '/settings', {
			scopeId: LOC_1,
			salesSource: 'manual',
		})
	}

	async function seedShifts(
		rows: Array<{
			staffId: string
			date: string
			start: string
			end: string
			scopeId?: string
			staffless?: boolean
		}>,
	) {
		const db = await h.db(ORG_A)
		for (const row of rows) {
			await db.insert(shifts).values({
				scopeId: row.scopeId ?? LOC_1,
				staffId: row.staffless ? null : row.staffId,
				startsAt: at(row.date, row.start),
				endsAt: at(row.date, row.end),
				localDate: row.date,
				timeZone: CHI,
				status: 'published',
				publishedAt: at(row.date, '00:00'),
			})
		}
	}

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: CHI })
		facts.set(LOC_2, { name: 'Airport', timeZone: CHI })
		h = await createClockHarness([ORG_A, ORG_B])
		l = laborFixture(h)
		h.setClock(at('2026-03-10', '12:00'))
	})
	afterEach(async () => {
		await h.cleanup()
	})

	describe('permissions', () => {
		it('refuses every staff subject without its token grant', async () => {
			await seedWeek()
			for (const subject of [
				'time_entries',
				'shifts',
				'labor_daily',
				'applications',
			]) {
				const none = await run({
					subject,
					timeframeField: subject === 'labor_daily' ? 'date' : undefined,
				})
				expect(none.status, subject).toBe(403)
				expect(none.body.error).toBe('forbidden_subject')
			}
		})

		it('keeps one staff grant from opening another subject', async () => {
			await seedWeek()
			const wrong = await run(
				{ subject: 'time_entries' },
				{ subjects: ['labor_daily', 'shifts', 'applications'] },
			)
			expect(wrong.status).toBe(403)
			const labor = await run(
				{ subject: 'labor_daily', timeframeField: 'date' },
				{ subjects: ['time_entries', 'shifts'] },
			)
			expect(labor.status).toBe(403)
		})

		it('keeps wages behind the pay permission', async () => {
			await seedWeek()
			const hoursOnly = await run(
				{
					subject: 'time_entries',
					groupBy: ['employee'],
					chartStyle: 'bar',
					measure: 'sum',
					valueField: 'paidMinutes',
				},
				{ subjects: ['time_entries'] },
			)
			expect(hoursOnly.status).toBe(200)
			const wages = await run(
				{
					subject: 'time_entries',
					groupBy: ['employee'],
					chartStyle: 'bar',
					measure: 'sum',
					valueField: 'cost',
				},
				{ subjects: ['time_entries'] },
			)
			expect(wages.status).toBe(403)
			expect(wages.body.message).toMatch(/pay data/)
			// A wage filter counts as reading wages.
			const filtered = await run(
				{ subject: 'time_entries' },
				{ subjects: ['time_entries'] },
			)
			expect(filtered.status).toBe(200)
		})

		it('does not let labor access reveal one person’s wages', async () => {
			await seedWeek()
			const response = await run(
				{
					subject: 'time_entries',
					groupBy: ['employee'],
					chartStyle: 'bar',
					measure: 'sum',
					valueField: 'cost',
				},
				{ subjects: ['time_entries', 'labor_daily'] },
			)
			expect(response.status).toBe(403)
		})

		it('rejects a token for another audience and a forged claim', async () => {
			const bad = await run(
				{ subject: 'time_entries' },
				{ token: 'not-a-token' },
			)
			expect(bad.status).toBe(401)
			const missing = await run({ subject: 'time_entries' }, { token: null })
			expect(missing.status).toBe(401)
		})

		it('treats a pay token that lives too long as invalid', async () => {
			const { SignJWT } = await import('jose')
			const { createHash } = await import('node:crypto')
			const key = createHash('sha256')
				.update('tenant-operator-analytics-v1:')
				.update(INTERNAL_TOKEN)
				.digest()
			const token = await new SignJWT({
				orgId: ORG_A,
				role: 'operator',
				scope: 'analytics',
				subjects: ['time_entries', 'staff_pay'],
				scopeIds: null,
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setSubject('user-1')
				.setIssuer('epic-startup-control-plane')
				.setAudience('tenant-api-operator')
				.setIssuedAt()
				.setExpirationTime('15m')
				.sign(key)
			const response = await run({ subject: 'time_entries' }, { token })
			expect(response.status).toBe(401)
		})
	})

	describe('scope limit', () => {
		it('limits every staff subject to the token’s scopes', async () => {
			await seedWeek()
			await enterWeekSales()
			const all = await run(
				{ subject: 'time_entries' },
				{ subjects: ['time_entries'], scopeIds: null },
			)
			expect(all.body.total).toBe(7)
			const mine = await run(
				{ subject: 'time_entries' },
				{ subjects: ['time_entries'], scopeIds: [LOC_1] },
			)
			expect(mine.body.total).toBe(7)
			const other = await run(
				{ subject: 'time_entries' },
				{ subjects: ['time_entries'], scopeIds: [LOC_2] },
			)
			expect(other.body.total).toBe(0)
			const none = await run(
				{ subject: 'time_entries' },
				{ subjects: ['time_entries'], scopeIds: [] },
			)
			expect(none.body.total).toBe(0)

			const laborOther = await run(
				{ subject: 'labor_daily', timeframeField: 'date' },
				{ subjects: ['labor_daily'], scopeIds: [LOC_2] },
			)
			expect(laborOther.body.total).toBe(0)
			const laborNone = await run(
				{ subject: 'labor_daily', timeframeField: 'date' },
				{ subjects: ['labor_daily'], scopeIds: [] },
			)
			expect(laborNone.body.total).toBe(0)
		})

		it('treats a token with no scope claim as no scopes', async () => {
			await seedWeek()
			const { SignJWT } = await import('jose')
			const { createHash } = await import('node:crypto')
			const key = createHash('sha256')
				.update('tenant-operator-analytics-v1:')
				.update(INTERNAL_TOKEN)
				.digest()
			const token = await new SignJWT({
				orgId: ORG_A,
				role: 'operator',
				scope: 'analytics',
				subjects: ['time_entries'],
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setSubject('user-1')
				.setIssuer('epic-startup-control-plane')
				.setAudience('tenant-api-operator')
				.setIssuedAt()
				.setExpirationTime('10m')
				.sign(key)
			const response = await run({ subject: 'time_entries' }, { token })
			expect(response.status).toBe(200)
			expect(response.body.total).toBe(0)
		})

		it('never returns another organization’s rows', async () => {
			await seedWeek()
			const other = await run(
				{ subject: 'time_entries' },
				{ subjects: ['time_entries'], orgId: ORG_B },
			)
			expect(other.status).toBe(200)
			expect(other.body.total).toBe(0)
		})
	})

	describe('time cards', () => {
		it('sums hours by employee to the minute', async () => {
			await seedWeek()
			const result = await run(
				{
					subject: 'time_entries',
					groupBy: ['employee'],
					chartStyle: 'bar',
					measure: 'sum',
					valueField: 'paidMinutes',
				},
				{ subjects: ['time_entries'] },
			)
			expect(result.status).toBe(200)
			const byName = Object.fromEntries(
				result.body.segments.map((s: any) => [s.label, s.value]),
			)
			// Ana: 8 + 8 + 8 + 10 hours. Ben: 6 + 5.5 + 8 hours.
			expect(byName).toEqual({ 'Ana Adams': 2040, 'Ben Brown': 1170 })
			expect(result.body.valueInfo).toMatchObject({ type: 'duration' })
			expect(result.body.value).toBe(3210)
			expect(result.body.timeZone).toBe('UTC')
		})

		it('prices cards for someone who holds the pay permission', async () => {
			await seedWeek()
			const result = await run(
				{
					subject: 'time_entries',
					groupBy: ['employee'],
					chartStyle: 'bar',
					measure: 'sum',
					valueField: 'cost',
				},
				{ subjects: ['time_entries', 'staff_pay'] },
			)
			expect(result.status).toBe(200)
			const byName = Object.fromEntries(
				result.body.segments.map((s: any) => [s.label, s.value]),
			)
			// Ana 34 h at $20; Ben 19.5 h at $12.
			expect(byName['Ana Adams']).toBe(680)
			expect(byName['Ben Brown']).toBe(234)
			expect(result.body.valueInfo).toMatchObject({
				type: 'currency',
				currency: 'USD',
			})
		})

		it('marks arrivals against the published schedule', async () => {
			const { a, b } = await seedWeek()
			await seedShifts([
				// Monday, on the dot.
				{
					staffId: a.staffId,
					date: '2026-03-02',
					start: '09:00',
					end: '17:00',
				},
				// Tuesday: starts 08:30, clocked in at 09:00.
				{
					staffId: a.staffId,
					date: '2026-03-03',
					start: '08:30',
					end: '17:00',
				},
				// Ben clocks in 3 minutes after: inside the grace window.
				{
					staffId: b.staffId,
					date: '2026-03-02',
					start: '09:57',
					end: '16:00',
				},
			])
			const result = await run(
				{
					subject: 'time_entries',
					groupBy: ['arrival'],
					chartStyle: 'pie',
					measure: 'count',
				},
				{ subjects: ['time_entries'] },
			)
			const byKey = Object.fromEntries(
				result.body.segments.map((s: any) => [s.key, s.count]),
			)
			expect(byKey).toEqual({ on_time: 2, late: 1, unscheduled: 4 })

			const late = await run(
				{
					subject: 'time_entries',
					chartStyle: 'single_number',
					measure: 'average',
					valueField: 'lateMinutes',
					groupBy: [],
				},
				{ subjects: ['time_entries'] },
			)
			expect(late.body.value).toBe(30)
		})

		it('leaves voided cards out', async () => {
			await seedWeek()
			const db = await h.db(ORG_A)
			const { timeEntries } = await import('@repo/tenant-db')
			const [first] = await db.select().from(timeEntries).limit(1)
			await db
				.update(timeEntries)
				.set({ voidedAt: Date.now() })
				.where(eq(timeEntries.id, first!.id))
			const result = await run(
				{ subject: 'time_entries' },
				{ subjects: ['time_entries'] },
			)
			expect(result.body.total).toBe(6)
		})
	})

	describe('scheduled shifts', () => {
		it('lists open and held shifts with their scheduled hours', async () => {
			const { a } = await seedWeek()
			await seedShifts([
				{
					staffId: a.staffId,
					date: '2026-03-02',
					start: '09:00',
					end: '17:00',
				},
				{
					staffId: a.staffId,
					date: '2026-03-03',
					start: '09:00',
					end: '13:00',
					staffless: true,
				},
			])
			const open = await run(
				{
					subject: 'shifts',
					timeframeField: 'startsAt',
					groupBy: ['openShift'],
					chartStyle: 'bar',
					measure: 'sum',
					valueField: 'scheduledMinutes',
				},
				{ subjects: ['shifts'] },
			)
			expect(open.status).toBe(200)
			const byKey = Object.fromEntries(
				open.body.segments.map((s: any) => [s.key, s.value]),
			)
			expect(byKey).toEqual({ false: 480, true: 240 })
		})
	})

	describe('daily labor', () => {
		it('matches the labor screen: ratio of sums, not the average of days', async () => {
			await seedWeek()
			await enterWeekSales()
			const result = await run(
				{
					subject: 'labor_daily',
					timeframeField: 'date',
					measure: 'ratio',
					valueField: 'laborCostPercent',
				},
				{ subjects: ['labor_daily'] },
			)
			expect(result.status).toBe(200)
			// $848 of wages over $4,220 of sales on the five days that have sales
			// (the labor suite's hand calculation: 2009 basis points).
			expect(result.body.value).toBeCloseTo(20.0948, 3)
			expect(Math.round(result.body.value * 100)).toBe(2009)
			// Wednesday has wages and no sales entered, so it is left out and said so.
			expect(result.body.valueInfo).toMatchObject({
				measure: 'ratio',
				type: 'percent',
				excluded: 1,
			})
			expect(result.body.valueInfo.note).toMatch(/estimates/)
		})

		it('gives each day its own share and sales per labor hour', async () => {
			await seedWeek()
			await enterWeekSales()
			const byDay = await run(
				{
					subject: 'labor_daily',
					timeframeField: 'date',
					groupBy: ['date'],
					chartStyle: 'bar',
					measure: 'ratio',
					valueField: 'laborCostPercent',
				},
				{ subjects: ['labor_daily'] },
			)
			const share = Object.fromEntries(
				byDay.body.segments
					.filter((s: any) => s.value !== undefined)
					.map((s: any) => [s.key, Math.round(s.value * 100)]),
			)
			expect(share).toEqual({
				'2026-03-02': 2900,
				'2026-03-03': 2500,
				'2026-03-05': 0,
				'2026-03-06': 2000,
				'2026-03-07': 2000,
			})
			const perHour = await run(
				{
					subject: 'labor_daily',
					timeframeField: 'date',
					measure: 'ratio',
					valueField: 'salesPerLaborHour',
				},
				{ subjects: ['labor_daily'] },
			)
			// $4,220 over the 48 paid hours on days with sales: $87.92 an hour.
			expect(perHour.body.value).toBeCloseTo(87.9167, 3)
			expect(perHour.body.valueInfo).toMatchObject({
				perHour: true,
				currency: 'USD',
			})
		})

		it('compares scheduled hours with the hours worked', async () => {
			const { a } = await seedWeek()
			await seedShifts([
				{
					staffId: a.staffId,
					date: '2026-03-02',
					start: '09:00',
					end: '15:00',
				},
				{
					staffId: a.staffId,
					date: '2026-03-03',
					start: '09:00',
					end: '17:00',
				},
			])
			const rows = await run(
				{
					subject: 'labor_daily',
					timeframeField: 'date',
					chartStyle: 'table',
					columns: [
						'date',
						'scheduledMinutes',
						'paidMinutes',
						'varianceMinutes',
						'shifts',
						'clockIns',
					],
				},
				{ subjects: ['labor_daily'] },
			)
			expect(rows.status).toBe(200)
			const monday = rows.body.rows.find((r: any) => r.date === '2026-03-02')
			expect(monday).toMatchObject({
				scheduledMinutes: '6h',
				paidMinutes: '14h',
				varianceMinutes: '8h',
				shifts: '1',
				clockIns: '2',
			})
		})

		it('counts online order tips by business day', async () => {
			await seedWeek()
			const orders = createFakeOrderSource(LOC_1)
			registerOrderSource(orders.source)
			try {
				orders.add(at('2026-03-02', '12:00'), { tipCents: 750 })
				const result = await run(
					{
						subject: 'labor_daily',
						timeframeField: 'date',
						measure: 'sum',
						valueField: 'tips',
					},
					{ subjects: ['labor_daily'] },
				)
				expect(result.body.value).toBe(7.5)
			} finally {
				registerOrderSource(null)
			}
		})
	})

	describe('applications', () => {
		const DAY = 86_400_000
		const MARCH_3 = Date.UTC(2026, 2, 3, 12)

		async function seedApplications() {
			const db = await h.db(ORG_A)
			const base = {
				postingId: 'p1',
				postingSlug: 'line-cook',
				postingTitle: 'Line cook',
				positionName: 'Line cook',
				firstName: 'SECRET-FIRST',
				lastName: 'SECRET-LAST',
				email: 'secret@example.com',
				consentAt: 1,
				consentVersion: '2026-10',
			}
			await db.insert(hiringApplications).values([
				{ ...base, scopeId: LOC_1, stage: 'new', createdAt: MARCH_3 },
				{
					...base,
					scopeId: LOC_1,
					stage: 'hired',
					source: 'qr',
					createdAt: MARCH_3,
					hiredAt: MARCH_3 + 4 * DAY,
				},
				{
					...base,
					scopeId: LOC_2,
					stage: 'declined',
					createdAt: MARCH_3,
					declinedAt: MARCH_3 + 2 * DAY,
				},
				{ ...base, scopeId: null, stage: 'new', createdAt: MARCH_3 },
				// Outside the timeframe.
				{
					...base,
					scopeId: LOC_1,
					stage: 'new',
					createdAt: MARCH_3 - 30 * DAY,
				},
			])
		}

		const funnel = (
			subjects: readonly RestrictedReportSubject[] = ['applications'],
			scopeIds?: readonly string[] | null,
		) =>
			run(
				{
					subject: 'applications',
					timeframeField: 'appliedAt',
					groupBy: ['stage'],
					chartStyle: 'pie',
				},
				{ subjects, scopeIds },
			)

		it('answers an empty report when nobody has applied', async () => {
			const result = await funnel()
			expect(result.status).toBe(200)
			expect(result.body.total).toBe(0)
		})

		it('counts the funnel by stage inside the timeframe', async () => {
			await seedApplications()
			const result = await funnel()
			expect(result.status).toBe(200)
			expect(result.body.total).toBe(4)
			const text = JSON.stringify(result.body)
			for (const label of ['New', 'Hired', 'Declined']) {
				expect(text).toContain(label)
			}
			expect(text).not.toContain('Screening')
		})

		it('measures days to decision for hired and declined applicants', async () => {
			await seedApplications()
			const result = await run(
				{
					subject: 'applications',
					timeframeField: 'appliedAt',
					chartStyle: 'single_number',
					measure: 'average',
					valueField: 'daysToDecision',
				},
				{ subjects: ['applications'] },
			)
			expect(result.status).toBe(200)
			// 4 days (hired) and 2 days (declined); open applicants have none.
			expect(result.body.value).toBe(3)
		})

		it('breaks down by where the applicant found the job', async () => {
			await seedApplications()
			const result = await run(
				{
					subject: 'applications',
					timeframeField: 'appliedAt',
					groupBy: ['source'],
					chartStyle: 'bar',
				},
				{ subjects: ['applications'] },
			)
			expect(result.status).toBe(200)
			expect(result.body.total).toBe(4)
		})

		it('keeps a manager to their own scopes, and organization-wide jobs to all-scope managers', async () => {
			await seedApplications()
			expect((await funnel(['applications'], [LOC_1])).body.total).toBe(2)
			expect((await funnel(['applications'], [LOC_2])).body.total).toBe(1)
			expect((await funnel(['applications'], [])).body.total).toBe(0)
			expect((await funnel(['applications'], null)).body.total).toBe(4)
		})

		it('needs the applications subject and never reads a person', async () => {
			await seedApplications()
			const denied = await funnel(['time_entries'])
			expect([401, 403]).toContain(denied.status)
			const result = await run(
				{
					subject: 'applications',
					timeframeField: 'appliedAt',
					columns: ['appliedAt', 'position', 'stage'],
					chartStyle: 'table',
				},
				{ subjects: ['applications'] },
			)
			expect(JSON.stringify(result.body)).not.toMatch(/SECRET|example\.com/)
		})
	})

	describe('audit', () => {
		it('records each run over staff data without names or amounts', async () => {
			await seedWeek()
			await run(
				{
					subject: 'time_entries',
					groupBy: ['employee'],
					chartStyle: 'bar',
					measure: 'sum',
					valueField: 'cost',
				},
				{ subjects: ['time_entries', 'staff_pay'] },
			)
			const db = await h.db(ORG_A)
			const rows = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'report.run'))
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				entityType: 'report',
				sensitivity: 'pay',
				actorId: 'user-1',
			})
			expect(JSON.stringify(rows[0]!.changes)).not.toMatch(/Ana|Ben|680/)
			expect(rows[0]!.changes).toEqual({ subject: 'time_entries', rows: 7 })
		})
	})
})

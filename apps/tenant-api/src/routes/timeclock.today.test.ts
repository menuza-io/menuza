import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STAFFING_PERMISSIONS as P } from '@repo/staffing'
import {
	CLOCK_READ_GRANTS,
	createClockHarness,
	LOC_1,
	LOC_2,
	ORG_A,
	ORG_B,
	type ClockHarness,
} from '../../tests/timeclock-harness.ts'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'

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

const TODAY_GRANTS = [P.READ_STAFF, P.READ_TIMESHEET]
const HOUR = 60 * 60 * 1000

describe('/operator/timeclock/today', () => {
	let h: ClockHarness

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: 'America/Chicago' })
		facts.set(LOC_2, { name: 'Airport', timeZone: 'America/Toronto' })
		h = await createClockHarness([ORG_A, ORG_B])
	})
	afterEach(async () => {
		await h.cleanup()
	})

	const today = (
		options: Parameters<ClockHarness['operator']>[2] = {},
		query = '',
	) =>
		h.operator('GET', `/today${query}`, {
			grants: TODAY_GRANTS,
			...options,
		})

	it('lists who is clocked in and who is on a break, names and times only', async () => {
		const a = await h.seedStaff(ORG_A, {
			firstName: 'Rana',
			lastName: 'Khalid',
			positions: [{ name: 'Server', rateMinor: 2500 }],
		})
		const b = await h.seedStaff(ORG_A, {
			firstName: 'Omar',
			lastName: 'Saleh',
		})
		const kiosk = await h.pair(ORG_A, LOC_1)
		await h.punch(kiosk.secret, { pin: a.pin, kind: 'clock_in' })
		h.advance(5 * 60 * 1000)
		await h.punch(kiosk.secret, { pin: b.pin, kind: 'clock_in' })
		h.advance(2 * HOUR)
		await h.punch(kiosk.secret, {
			pin: b.pin,
			kind: 'break_start',
			breakKind: 'meal',
		})

		const response = await today()
		expect(response.status).toBe(200)
		expect(response.body.serverNow).toBe(h.clock.now)
		const rows = response.body.present as any[]
		expect(rows.map((row) => row.firstName)).toEqual(['Rana', 'Omar'])
		expect(rows[0]).toMatchObject({
			lastName: 'Khalid',
			state: 'in',
			late: false,
			missingClockOut: false,
		})
		expect(rows[1]).toMatchObject({ state: 'on_break' })
		expect(rows[1].breakStartAt).toBe(h.clock.now)
		// No wage or pin material ever rides along.
		expect(response.raw).not.toMatch(/rate|pin|2500|currency/i)
	})

	it('flags someone still clocked in far past a normal shift', async () => {
		const a = await h.seedStaff(ORG_A, { firstName: 'Rana' })
		const kiosk = await h.pair(ORG_A, LOC_1)
		await h.punch(kiosk.secret, { pin: a.pin, kind: 'clock_in' })
		h.advance(20 * HOUR)
		const response = await today()
		expect(response.body.present[0].missingClockOut).toBe(true)
	})

	it('moves people to recent when they clock out', async () => {
		const a = await h.seedStaff(ORG_A, { firstName: 'Rana' })
		const kiosk = await h.pair(ORG_A, LOC_1)
		await h.punch(kiosk.secret, { pin: a.pin, kind: 'clock_in' })
		h.advance(4 * HOUR)
		await h.punch(kiosk.secret, { pin: a.pin, kind: 'clock_out' })
		const response = await today()
		expect(response.body.present).toEqual([])
		expect(response.body.recent).toHaveLength(1)
		expect(response.body.recent[0]).toMatchObject({
			firstName: 'Rana',
			clockOutAt: h.clock.now,
		})
		// Older than the window drops off.
		h.advance(13 * HOUR)
		expect((await today()).body.recent).toEqual([])
	})

	it('limits the list to the token scopes and answers 404 for others', async () => {
		const a = await h.seedStaff(ORG_A, {
			firstName: 'Rana',
			scopeIds: [LOC_1],
		})
		const b = await h.seedStaff(ORG_A, {
			firstName: 'Omar',
			scopeIds: [LOC_2],
		})
		const k1 = await h.pair(ORG_A, LOC_1)
		const k2 = await h.pair(ORG_A, LOC_2)
		await h.punch(k1.secret, { pin: a.pin, kind: 'clock_in' })
		await h.punch(k2.secret, { pin: b.pin, kind: 'clock_in' })

		const scoped = await today({ scopeIds: [LOC_1] })
		expect(scoped.body.present.map((row: any) => row.firstName)).toEqual([
			'Rana',
		])
		const outside = await today({ scopeIds: [LOC_1] }, `?scopeId=${LOC_2}`)
		expect(outside.status).toBe(404)
		const nobody = await today({ scopeIds: [] })
		expect(nobody.body.present).toEqual([])

		const filtered = await today({}, `?scopeId=${LOC_2}`)
		expect(filtered.body.present.map((row: any) => row.firstName)).toEqual([
			'Omar',
		])
	})

	it('needs the timesheet and staff read grants', async () => {
		const noTimesheet = await today({ grants: [P.READ_STAFF] })
		expect(noTimesheet.status).toBe(403)
		const noStaff = await today({ grants: [P.READ_TIMESHEET] })
		expect(noStaff.status).toBe(403)
		const policyOnly = await today({ grants: CLOCK_READ_GRANTS })
		expect(policyOnly.status).toBe(403)
		expect((await today({ token: null })).status).toBe(401)
	})

	it("never shows another organization's people", async () => {
		const a = await h.seedStaff(ORG_A, { firstName: 'Rana' })
		const kiosk = await h.pair(ORG_A, LOC_1)
		await h.punch(kiosk.secret, { pin: a.pin, kind: 'clock_in' })
		const other = await today({ orgId: ORG_B })
		expect(other.status).toBe(200)
		expect(other.body.present).toEqual([])
	})

	it('rejects a malformed scope id without a query error', async () => {
		const response = await today({}, '?scopeId=../../x')
		expect(response.status).toBe(404)
	})
})

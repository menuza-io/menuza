import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand.ts'
import { addDays, localDateOf, startOfWeek } from '@repo/staffing'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	timeEntries,
	timeEntryEvents,
} from '@repo/tenant-db'
import { kioskRoutes } from './kiosk.ts'
import { operatorStaffingRoutes } from './operator-staffing.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(async (id: string) => ({
		id,
		slug: id,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	})),
}))
vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const orgA = 'clw9x0a12000008l0tsheet1'
const operatorSecret = 'test-operator-token-timesheets-123'
const LOCATIONS = [
	{ id: 'loc_main', tz: 'America/New_York' },
	{ id: 'loc_second', tz: 'America/Chicago' },
]

async function mint(claims: Record<string, unknown> = {}) {
	return new SignJWT({
		orgId: orgA,
		role: 'operator',
		scope: 'staffing',
		areas: { staff: 'write', schedule: 'write', timeclock: 'write' },
		locationIds: null,
		locations: LOCATIONS,
		...claims,
	})
		.setSubject('user_manager')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(operatorSecret))
}

describe('timesheets', () => {
	let tempDir: string
	let app: Hono
	const today = localDateOf(new Date(), 'America/New_York')
	const day = addDays(today, -3)

	async function call(
		method: string,
		pathname: string,
		token: string,
		body?: unknown,
	) {
		const response = await app.request(`/operator/staffing${pathname}`, {
			method,
			headers: {
				Authorization: `Bearer ${token}`,
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		return {
			status: response.status,
			body: (await response.json()) as Record<string, any>,
		}
	}

	async function setup() {
		const token = await mint()
		const cook = await call('POST', '/positions', token, {
			name: 'Cook',
			colorKey: 'orange',
		})
		const cookId = cook.body.position.id as string
		const staff = async (firstName: string) =>
			(
				await call('POST', '/staff', token, {
					firstName,
					lastName: 'Lopez',
					assignments: [{ locationId: 'loc_main', positionId: cookId }],
				})
			).body.staff.id as string
		return {
			token,
			cookId,
			anaId: await staff('Ana'),
			benId: await staff('Ben'),
		}
	}

	function entry(overrides: Record<string, unknown>) {
		return {
			locationId: 'loc_main',
			positionId: null,
			localDate: day,
			clockIn: '09:00',
			clockOut: '17:00',
			unpaidBreakMinutes: 30,
			note: '',
			...overrides,
		}
	}

	async function timesheet(token: string, from = day, to = day) {
		const result = await call(
			'GET',
			`/timesheets?locationId=loc_main&from=${from}&to=${to}`,
			token,
		)
		expect(result.status).toBe(200)
		return result.body.timesheet
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-timesheets-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.NODE_ENV = 'test'
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-for-timesheets'
		process.env.STAFFING_EMAIL_ENABLED = 'false'
		process.env.STAFFING_KIOSK_ENABLED = 'true'
		await provisionTenantDb(orgA)
		app = new Hono()
		app.route('/operator/staffing', operatorStaffingRoutes)
		app.route('/kiosk', kioskRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgA)
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('adds, corrects, and deletes cards with a full edit trail', async () => {
		const { token, cookId, anaId } = await setup()
		const created = await call(
			'POST',
			'/time-entries',
			token,
			entry({ staffId: anaId }),
		)
		expect(created.status).toBe(200)
		const entryId = created.body.entry.id as string

		let view = await timesheet(token)
		expect(view.entries).toHaveLength(1)
		expect(view.entries[0]).toMatchObject({
			staffId: anaId,
			// No position given: the primary position at the location.
			positionId: cookId,
			source: 'manager',
			paidMinutes: 450,
			issues: ['unscheduled'],
			edited: true,
			approvedAt: null,
		})
		expect(view.staff.map((member: any) => member.firstName)).toEqual([
			'Ana',
			'Ben',
		])

		const overlap = await call(
			'POST',
			'/time-entries',
			token,
			entry({ staffId: anaId, clockIn: '16:00', clockOut: '18:00' }),
		)
		expect(overlap).toMatchObject({
			status: 409,
			body: { error: 'entry_overlap' },
		})

		const overnight = await call(
			'POST',
			'/time-entries',
			token,
			entry({
				staffId: anaId,
				clockIn: '22:00',
				clockOut: '02:00',
				unpaidBreakMinutes: 0,
			}),
		)
		expect(overnight.status).toBe(200)

		const noReason = await call('PATCH', `/time-entries/${entryId}`, token, {
			...entry({ clockOut: '18:00' }),
			reason: '',
		})
		expect(noReason.status).toBe(400)
		const edited = await call('PATCH', `/time-entries/${entryId}`, token, {
			...entry({ clockOut: '18:00' }),
			reason: 'Stayed late for inventory',
		})
		expect(edited.status).toBe(200)

		view = await timesheet(token)
		expect(
			view.entries
				.map((item: any) => item.paidMinutes)
				.sort((a: number, b: number) => a - b),
		).toEqual([240, 510])

		const history = await call('GET', `/time-entries/${entryId}/history`, token)
		expect(history.body.history.events).toMatchObject([
			{
				kind: 'manual_create',
				actorType: 'operator',
				actorRef: 'user_manager',
			},
			{
				kind: 'edit',
				reason: 'Stayed late for inventory',
				before: { clockOutAt: expect.any(String) },
				after: { clockOutAt: expect.any(String) },
			},
		])
		const [first, second] = history.body.history.events
		expect(first.after.clockOutAt).toBe(second.before.clockOutAt)
		expect(second.after.clockOutAt).not.toBe(second.before.clockOutAt)

		const removed = await call('DELETE', `/time-entries/${entryId}`, token, {
			reason: 'Duplicate',
		})
		expect(removed.status).toBe(200)
		view = await timesheet(token)
		expect(view.entries).toHaveLength(1)
		const afterDelete = await call(
			'GET',
			`/time-entries/${entryId}/history`,
			token,
		)
		expect(afterDelete.body.history.events.at(-1)).toMatchObject({
			kind: 'delete',
			reason: 'Duplicate',
		})
		// The row survives a delete so raw punches are never lost.
		const db = await getTenantDb(orgA)
		const rows = await db.select().from(timeEntries)
		expect(rows).toHaveLength(2)
	})

	it('locks approved cards until a manager reopens them', async () => {
		const { token, anaId, benId } = await setup()
		const closed = await call(
			'POST',
			'/time-entries',
			token,
			entry({ staffId: anaId }),
		)
		const open = await call(
			'POST',
			'/time-entries',
			token,
			entry({ staffId: benId, clockOut: null, unpaidBreakMinutes: 0 }),
		)
		const closedId = closed.body.entry.id as string
		const openId = open.body.entry.id as string

		const approved = await call('POST', '/time-entries/approve', token, {
			locationId: 'loc_main',
			entryIds: [closedId, openId, 'missing'],
		})
		expect(approved.body.result).toEqual({
			approved: 1,
			skipped: [
				{ id: openId, reason: 'open' },
				{ id: 'missing', reason: 'not_found' },
			],
		})

		const view = await timesheet(token)
		const openView = view.entries.find((item: any) => item.id === openId)
		expect(openView.issues).toContain('missing_clock_out')

		for (const attempt of [
			call('PATCH', `/time-entries/${closedId}`, token, {
				...entry({}),
				reason: 'Fix',
			}),
			call('DELETE', `/time-entries/${closedId}`, token, { reason: 'Fix' }),
		]) {
			expect(await attempt).toMatchObject({
				status: 409,
				body: { error: 'entry_locked' },
			})
		}

		const reopened = await call(
			'POST',
			`/time-entries/${closedId}/reopen`,
			token,
			{ reason: 'Wrong break' },
		)
		expect(reopened.status).toBe(200)
		const fixed = await call('PATCH', `/time-entries/${closedId}`, token, {
			...entry({ unpaidBreakMinutes: 0 }),
			reason: 'Wrong break',
		})
		expect(fixed.status).toBe(200)

		const db = await getTenantDb(orgA)
		const kinds = (await db.select().from(timeEntryEvents))
			.filter((event) => event.entryId === closedId)
			.map((event) => event.kind)
		expect(kinds).toEqual(['manual_create', 'approve', 'reopen', 'edit'])

		const secondOpen = await call(
			'POST',
			'/time-entries',
			token,
			entry({
				staffId: benId,
				localDate: addDays(day, 1),
				clockOut: null,
				unpaidBreakMinutes: 0,
			}),
		)
		expect(secondOpen.status).toBe(409)
	})

	it('flags late and unscheduled cards against the published schedule', async () => {
		const { token, cookId, anaId, benId } = await setup()
		await call('POST', '/shifts', token, {
			shift: {
				locationId: 'loc_main',
				staffId: anaId,
				positionId: cookId,
				localDate: day,
				startTime: '09:00',
				endTime: '17:00',
				unpaidBreakMinutes: 30,
				note: '',
			},
		})
		await call('POST', '/shifts', token, {
			shift: {
				locationId: 'loc_main',
				staffId: benId,
				positionId: cookId,
				localDate: day,
				startTime: '09:00',
				endTime: '17:00',
				unpaidBreakMinutes: 30,
				note: '',
			},
		})
		const draftOnly = await call(
			'POST',
			'/time-entries',
			token,
			entry({ staffId: anaId, clockIn: '09:20' }),
		)
		let view = await timesheet(token)
		// Drafts are not the schedule anyone was told about.
		expect(view.entries[0].issues).toEqual(['unscheduled'])

		const published = await call('POST', '/schedule/publish', token, {
			locationId: 'loc_main',
			weekStart: startOfWeek(day, 'monday'),
			locationName: 'Main St',
		})
		expect(published.status).toBe(200)
		await call(
			'POST',
			'/time-entries',
			token,
			entry({ staffId: benId, clockIn: '09:04' }),
		)
		view = await timesheet(token)
		const byStaff = new Map(
			view.entries.map((item: any) => [item.staffId, item]),
		)
		expect(byStaff.get(anaId)).toMatchObject({
			id: draftOnly.body.entry.id,
			issues: ['late'],
			scheduled: { positionId: cookId },
		})
		expect(byStaff.get(benId).issues).toEqual([])
	})

	it('totals weekly hours against the threshold across the whole week', async () => {
		const { token, anaId } = await setup()
		const weekStart = addDays(startOfWeek(today, 'monday'), -7)
		for (let offset = 0; offset < 5; offset++) {
			const result = await call(
				'POST',
				'/time-entries',
				token,
				entry({
					staffId: anaId,
					localDate: addDays(weekStart, offset),
					clockIn: '08:00',
					clockOut: '17:00',
					unpaidBreakMinutes: 0,
				}),
			)
			expect(result.status).toBe(200)
		}
		// A one-day view still reports the whole week's split.
		const view = await timesheet(token, weekStart, weekStart)
		expect(view.entries).toHaveLength(1)
		expect(view.weeks).toEqual([
			{
				staffId: anaId,
				weekStart,
				paidMinutes: 45 * 60,
				regularMinutes: 40 * 60,
				overThresholdMinutes: 5 * 60,
			},
		])
	})

	it('rejects impossible times and enforces read, write, and location scope', async () => {
		const { token, anaId } = await setup()
		const future = await call(
			'POST',
			'/time-entries',
			token,
			entry({ staffId: anaId, localDate: addDays(today, 2) }),
		)
		expect(future).toMatchObject({ status: 400, body: { error: 'in_future' } })
		const longBreak = await call(
			'POST',
			'/time-entries',
			token,
			entry({ staffId: anaId, clockOut: '09:30', unpaidBreakMinutes: 30 }),
		)
		expect(longBreak.body.error).toBe('break_too_long')
		const elsewhere = await call(
			'POST',
			'/time-entries',
			token,
			entry({ staffId: anaId, locationId: 'loc_second' }),
		)
		expect(elsewhere.body.error).toBe('staff_not_assigned')
		const created = await call(
			'POST',
			'/time-entries',
			token,
			entry({ staffId: anaId }),
		)
		const entryId = created.body.entry.id as string

		const reader = await mint({ areas: { timeclock: 'read' } })
		expect((await timesheet(reader)).entries).toHaveLength(1)
		const denied = await call(
			'POST',
			'/time-entries',
			reader,
			entry({ staffId: anaId }),
		)
		expect(denied.status).toBe(403)

		const scoped = await mint({ locationIds: ['loc_second'] })
		const hidden = await call(
			'GET',
			`/timesheets?locationId=loc_main&from=${day}&to=${day}`,
			scoped,
		)
		expect(hidden.body.error).toBe('unknown_location')
		expect(
			(await call('GET', `/time-entries/${entryId}/history`, scoped)).status,
		).toBe(404)
		expect(
			(
				await call('PATCH', `/time-entries/${entryId}`, scoped, {
					...entry({}),
					reason: 'x',
				})
			).status,
		).toBe(404)

		const tooLong = await call(
			'GET',
			`/timesheets?locationId=loc_main&from=${addDays(day, -40)}&to=${day}`,
			token,
		)
		expect(tooLong.status).toBe(400)
	})
})

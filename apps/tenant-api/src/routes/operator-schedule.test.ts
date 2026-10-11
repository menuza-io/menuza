import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand.ts'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	shifts,
} from '@repo/tenant-db'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { upcomingPublishedShifts } from '../services/staffing-schedule.ts'
import { operatorStaffingRoutes } from './operator-staffing.ts'

const orgA = 'clw9x0a12000008l0sched01'
const orgB = 'clw9x0a12000008l0sched02'
const operatorSecret = 'test-operator-token-schedule-123'

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

const LOCATIONS = [
	{ id: 'loc_main', tz: 'America/New_York' },
	{ id: 'loc_second', tz: 'America/Chicago' },
]
const WEEK = '2026-10-12'
const NEXT_WEEK = '2026-10-19'

async function mint(claims: Record<string, unknown> = {}) {
	return new SignJWT({
		orgId: orgA,
		role: 'operator',
		scope: 'staffing',
		areas: { staff: 'write', schedule: 'write' },
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

describe('operator staffing schedule', () => {
	let tempDir: string
	let app: Hono

	async function call(
		method: string,
		pathname: string,
		token: string,
		body?: unknown,
	) {
		const response = await app.request(pathname, {
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

	async function seed(token: string) {
		const position = await call('POST', '/positions', token, {
			name: 'Cook',
			colorKey: 'orange',
		})
		const positionId = position.body.position.id as string
		const ana = await call('POST', '/staff', token, {
			firstName: 'Ana',
			lastName: 'Diaz',
			email: 'ana@example.com',
			assignments: [{ locationId: 'loc_main', positionId }],
		})
		const ben = await call('POST', '/staff', token, {
			firstName: 'Ben',
			assignments: [{ locationId: 'loc_main', positionId }],
		})
		return {
			positionId,
			anaId: ana.body.staff.id as string,
			benId: ben.body.staff.id as string,
		}
	}

	function shift(overrides: Record<string, unknown>) {
		return {
			locationId: 'loc_main',
			staffId: null,
			positionId: null,
			localDate: WEEK,
			startTime: '09:00',
			endTime: '17:00',
			unpaidBreakMinutes: 30,
			note: '',
			...overrides,
		}
	}

	async function schedule(token: string, weekStart = WEEK) {
		const result = await call(
			'GET',
			`/schedule?locationId=loc_main&weekStart=${weekStart}`,
			token,
		)
		expect(result.status).toBe(200)
		return result.body.schedule as Record<string, any>
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-schedule-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.NODE_ENV = 'test'
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		process.env.STAFFING_EMAIL_ENABLED = 'true'
		vi.mocked(sendTenantEmail).mockClear()
		await provisionTenantDb(orgA)
		await provisionTenantDb(orgB)
		app = new Hono()
		app.route('/', operatorStaffingRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgA)
		await destroyTenantDb(orgB)
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('drafts, publishes, and emails each person only their own shifts', async () => {
		const token = await mint()
		const { positionId, anaId, benId } = await seed(token)

		const created = await call('POST', '/shifts', token, {
			shift: shift({ staffId: anaId, positionId }),
			alsoOn: ['2026-10-14'],
		})
		expect(created.status).toBe(200)
		expect(created.body.shifts).toHaveLength(2)
		expect(created.body.shifts[0]).toMatchObject({
			state: 'draft',
			timeZone: 'America/New_York',
			startAt: '2026-10-12T13:00:00.000Z',
		})
		const overnight = await call('POST', '/shifts', token, {
			shift: shift({ staffId: benId, startTime: '22:00', endTime: '02:00' }),
		})
		expect(overnight.body.shifts[0]).toMatchObject({
			startAt: '2026-10-13T02:00:00.000Z',
			endAt: '2026-10-13T06:00:00.000Z',
		})
		await call('POST', '/shifts', token, {
			shift: shift({ localDate: '2026-10-15' }),
		})

		let view = await schedule(token)
		expect(view.unpublishedCount).toBe(4)
		expect(view.staff.map((member: any) => member.firstName)).toEqual([
			'Ana',
			'Ben',
		])

		const published = await call('POST', '/schedule/publish', token, {
			locationId: 'loc_main',
			weekStart: WEEK,
			locationName: 'Main St',
		})
		expect(published.status).toBe(200)
		expect(published.body.result).toMatchObject({
			changedCount: 4,
			shiftCount: 4,
			notified: 1,
			notNotified: [{ staffId: benId, name: 'Ben', reason: 'no_email' }],
		})
		expect(vi.mocked(sendTenantEmail)).toHaveBeenCalledTimes(1)
		const email = vi.mocked(sendTenantEmail).mock.calls[0]![0]
		expect(email.to).toBe('ana@example.com')
		expect(email.subject).toContain('Main St')
		expect(email.text).toContain('Cook')
		expect(email.text).not.toContain('22:00')
		expect(email.text).not.toContain('10:00 PM')

		view = await schedule(token)
		expect(view.unpublishedCount).toBe(0)
		expect(view.publications).toHaveLength(1)
		expect(view.publications[0]).toMatchObject({
			notifiedCount: 1,
			notNotifiedCount: 1,
		})

		const nothing = await call('POST', '/schedule/publish', token, {
			locationId: 'loc_main',
			weekStart: WEEK,
			locationName: 'Main St',
		})
		expect(nothing).toMatchObject({
			status: 409,
			body: { error: 'nothing_to_publish' },
		})

		// Editing keeps the published copy until the next publish.
		const anaShift = created.body.shifts[0].id as string
		const edited = await call(
			'PATCH',
			`/shifts/${anaShift}`,
			token,
			shift({ staffId: anaId, positionId, startTime: '10:00' }),
		)
		expect(edited.body.shift).toMatchObject({
			state: 'changed',
			published: { startTime: '09:00' },
		})
		const removed = await call(
			'DELETE',
			`/shifts/${created.body.shifts[1].id}`,
			token,
		)
		expect(removed.body.result.pendingPublish).toBe(true)
		view = await schedule(token)
		expect(
			view.shifts.find((row: any) => row.id === created.body.shifts[1].id)
				.state,
		).toBe('removed')

		vi.mocked(sendTenantEmail).mockClear()
		const republished = await call('POST', '/schedule/publish', token, {
			locationId: 'loc_main',
			weekStart: WEEK,
			locationName: 'Main St',
			emailLocale: 'ar',
		})
		expect(republished.body.result).toMatchObject({
			changedCount: 2,
			shiftCount: 3,
			notified: 1,
			notNotified: [],
		})
		const second = vi.mocked(sendTenantEmail).mock.calls[0]![0]
		expect(second.html).toContain('dir="rtl"')
		expect(second.text).toContain('لم تعد مجدولًا')
		view = await schedule(token)
		expect(view.shifts).toHaveLength(3)
	})

	it('never shows drafts to staff, only the published version', async () => {
		const token = await mint()
		const { anaId } = await seed(token)
		const created = await call('POST', '/shifts', token, {
			shift: shift({ staffId: anaId }),
		})
		const db = await getTenantDb(orgA)
		const now = new Date('2026-10-11T12:00:00Z')
		expect(await upcomingPublishedShifts(db, anaId, now)).toHaveLength(0)
		await call('POST', '/schedule/publish', token, {
			locationId: 'loc_main',
			weekStart: WEEK,
			locationName: 'Main St',
		})
		await call(
			'PATCH',
			`/shifts/${created.body.shifts[0].id}`,
			token,
			shift({ staffId: anaId, startTime: '11:00' }),
		)
		const upcoming = await upcomingPublishedShifts(db, anaId, now)
		expect(upcoming).toHaveLength(1)
		expect(upcoming[0]).toMatchObject({ startTime: '09:00' })
	})

	it('reports everyone as not notified when the email kill switch is off', async () => {
		process.env.STAFFING_EMAIL_ENABLED = 'false'
		const token = await mint()
		const { anaId } = await seed(token)
		await call('POST', '/shifts', token, { shift: shift({ staffId: anaId }) })
		const published = await call('POST', '/schedule/publish', token, {
			locationId: 'loc_main',
			weekStart: WEEK,
			locationName: 'Main St',
		})
		expect(published.body.result).toMatchObject({
			notified: 0,
			notNotified: [{ staffId: anaId, reason: 'email_disabled' }],
		})
		expect(vi.mocked(sendTenantEmail)).not.toHaveBeenCalled()
	})

	it('copies a week, opening shifts for people who left', async () => {
		const token = await mint()
		const { positionId, anaId, benId } = await seed(token)
		await call('POST', '/shifts', token, {
			shift: shift({ staffId: anaId, positionId }),
			alsoOn: ['2026-10-13'],
		})
		await call('POST', '/shifts', token, {
			shift: shift({ staffId: benId, localDate: '2026-10-16' }),
		})
		await call('POST', `/staff/${benId}/terminate`, token, {
			terminatedOn: '2026-10-17',
			reason: '',
		})
		const copied = await call('POST', '/schedule/copy-week', token, {
			locationId: 'loc_main',
			fromWeekStart: WEEK,
			toWeekStart: NEXT_WEEK,
		})
		expect(copied.body.result).toEqual({ created: 3, opened: 1, removed: 0 })
		const next = await schedule(token, NEXT_WEEK)
		expect(next.shifts.map((row: any) => row.localDate).sort()).toEqual([
			'2026-10-19',
			'2026-10-20',
			'2026-10-23',
		])
		expect(next.shifts.filter((row: any) => row.staffId === null)).toHaveLength(
			1,
		)

		const replaced = await call('POST', '/schedule/copy-week', token, {
			locationId: 'loc_main',
			fromWeekStart: WEEK,
			toWeekStart: NEXT_WEEK,
			positionId,
			replace: true,
		})
		expect(replaced.body.result).toEqual({ created: 2, opened: 0, removed: 2 })
		expect((await schedule(token, NEXT_WEEK)).shifts).toHaveLength(3)
	})

	it('turns shifts after the last day into open shifts on termination', async () => {
		const token = await mint()
		const { anaId } = await seed(token)
		await call('POST', '/shifts', token, {
			shift: shift({ staffId: anaId }),
			alsoOn: ['2026-10-14', '2026-10-16'],
		})
		const terminated = await call('POST', `/staff/${anaId}/terminate`, token, {
			terminatedOn: '2026-10-14',
			reason: '',
		})
		expect(terminated.body.staff.releasedShifts).toBe(1)
		const db = await getTenantDb(orgA)
		const rows = await db.select().from(shifts)
		expect(
			rows.filter((row) => row.staffId === null).map((row) => row.localDate),
		).toEqual(['2026-10-16'])
	})

	it('rejects bad references and unknown locations', async () => {
		const token = await mint()
		const { anaId } = await seed(token)
		const elsewhere = await call('POST', '/shifts', token, {
			shift: shift({ staffId: anaId, locationId: 'loc_second' }),
		})
		expect(elsewhere.body.error).toBe('staff_not_assigned')
		const unsigned = await call('POST', '/shifts', token, {
			shift: shift({ locationId: 'loc_forged' }),
		})
		expect(unsigned.body.error).toBe('unknown_location')
		const zero = await call('POST', '/shifts', token, {
			shift: shift({ endTime: '09:00' }),
		})
		expect(zero.status).toBe(400)
		const far = await call('POST', '/shifts', token, {
			shift: shift({}),
			alsoOn: ['2026-11-30'],
		})
		expect(far.body.error).toBe('invalid_dates')
	})

	it('enforces area, level, organization, and location scoping', async () => {
		const token = await mint()
		const { anaId } = await seed(token)
		const created = await call('POST', '/shifts', token, {
			shift: shift({ staffId: anaId }),
		})
		const shiftId = created.body.shifts[0].id as string

		const readOnly = await mint({ areas: { schedule: 'read' } })
		expect((await schedule(readOnly)).shifts).toHaveLength(1)
		const write = await call('PATCH', `/shifts/${shiftId}`, readOnly, shift({}))
		expect(write.status).toBe(403)
		const publish = await call('POST', '/schedule/publish', readOnly, {
			locationId: 'loc_main',
			weekStart: WEEK,
			locationName: 'Main St',
		})
		expect(publish.status).toBe(403)

		const staffOnly = await mint({ areas: { staff: 'write' } })
		const denied = await call(
			'GET',
			`/schedule?locationId=loc_main&weekStart=${WEEK}`,
			staffOnly,
		)
		expect(denied.status).toBe(403)

		const otherOrg = await mint({ orgId: orgB })
		const crossOrg = await call('DELETE', `/shifts/${shiftId}`, otherOrg)
		expect(crossOrg.status).toBe(404)

		const scoped = await mint({ locationIds: ['loc_second'] })
		const hidden = await call('DELETE', `/shifts/${shiftId}`, scoped)
		expect(hidden.status).toBe(404)
		const view = await call(
			'GET',
			`/schedule?locationId=loc_main&weekStart=${WEEK}`,
			scoped,
		)
		expect(view.body.error).toBe('unknown_location')
	})
})

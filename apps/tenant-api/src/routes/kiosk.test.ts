import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand.ts'
import { localDateOf, localTimeOf, startOfWeek } from '@repo/staffing'
import {
	destroyTenantDb,
	getTenantDb,
	kioskDevices,
	provisionTenantDb,
	timeEntries,
	timeEntryEvents,
} from '@repo/tenant-db'
import { kioskRoutes } from './kiosk.ts'
import { operatorStaffingRoutes } from './operator-staffing.ts'

const orgA = 'clw9x0a12000008l0kiosk01'
const orgB = 'clw9x0a12000008l0kiosk02'
const orgKsa = 'clw9x0a12000008l0kiosk03'
const operatorSecret = 'test-operator-token-kiosk-12345'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(async (id: string) => ({
		id,
		slug: id,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: id === orgKsa ? 'ksa' : 'us',
	})),
}))

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

describe('staff kiosk', () => {
	let tempDir: string
	let app: Hono

	async function call(
		method: string,
		pathname: string,
		token: string | null,
		body?: unknown,
	) {
		const headers: Record<string, string> = {}
		if (token) headers.Authorization = `Bearer ${token}`
		if (body !== undefined) headers['Content-Type'] = 'application/json'
		const response = await app.request(pathname, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		})
		return {
			status: response.status,
			cache: response.headers.get('Cache-Control'),
			body: (await response.json()) as Record<string, any>,
		}
	}

	async function seedStaff(
		operator: string,
		input: { firstName: string; locationId?: string; positions?: string[] },
	) {
		const staff = await call('POST', '/operator/staffing/staff', operator, {
			firstName: input.firstName,
			lastName: 'Lopez',
			assignments: (input.positions ?? []).map((positionId) => ({
				locationId: input.locationId ?? 'loc_main',
				positionId,
			})),
		})
		expect(staff.status).toBe(200)
		return staff.body.staff.id as string
	}

	async function pair(operator: string, locationId = 'loc_main') {
		const code = await call(
			'POST',
			'/operator/staffing/kiosks/pairing-codes',
			operator,
			{ locationId, locationName: 'Main St', name: 'Front tablet' },
		)
		expect(code.status).toBe(200)
		const paired = await call('POST', '/kiosk/pair', null, {
			orgId: orgA,
			code: code.body.pairing.code,
		})
		expect(paired.status).toBe(200)
		return {
			code: code.body.pairing.code as string,
			deviceToken: paired.body.deviceToken as string,
			deviceId: paired.body.device.id as string,
		}
	}

	async function setup() {
		const operator = await mint()
		const position = await call(
			'POST',
			'/operator/staffing/positions',
			operator,
			{
				name: 'Cook',
				colorKey: 'orange',
			},
		)
		const bar = await call('POST', '/operator/staffing/positions', operator, {
			name: 'Bar',
			colorKey: 'blue',
		})
		const cookId = position.body.position.id as string
		const barId = bar.body.position.id as string
		const anaId = await seedStaff(operator, {
			firstName: 'Ana',
			positions: [cookId, barId],
		})
		const pin = await call(
			'POST',
			`/operator/staffing/staff/${anaId}/pin`,
			operator,
			{ pin: '2580' },
		)
		expect(pin.body.result).toEqual({ pin: '2580', generated: false })
		const device = await pair(operator)
		return { operator, cookId, barId, anaId, ...device }
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-kiosk-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.NODE_ENV = 'test'
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-for-kiosk-pins'
		process.env.STAFFING_KIOSK_ENABLED = 'true'
		await provisionTenantDb(orgA)
		await provisionTenantDb(orgB)
		app = new Hono()
		app.route('/operator/staffing', operatorStaffingRoutes)
		app.route('/kiosk', kioskRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgA)
		await destroyTenantDb(orgB)
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('pairs once, identifies by PIN, and clocks in and out idempotently', async () => {
		const { operator, code, deviceToken, barId, anaId } = await setup()
		const reused = await call('POST', '/kiosk/pair', null, {
			orgId: orgA,
			code,
		})
		expect(reused).toMatchObject({
			status: 400,
			body: { error: 'invalid_code' },
		})

		const device = await call('GET', '/kiosk/device', deviceToken)
		expect(device.body.device).toMatchObject({
			name: 'Front tablet',
			locationName: 'Main St',
			timeZone: 'America/New_York',
		})

		const identified = await call('POST', '/kiosk/identify', deviceToken, {
			pin: '2580',
		})
		expect(identified.status).toBe(200)
		expect(identified.cache).toBe('private, no-store')
		expect(identified.body).toMatchObject({
			staff: { firstName: 'Ana', lastInitial: 'L' },
			clockedIn: false,
			// The primary position (the first assignment) comes first.
			positions: [{ name: 'Cook' }, { name: 'Bar' }],
		})
		expect(JSON.stringify(identified.body)).not.toContain('pin')

		const requestId = crypto.randomUUID()
		const clockIn = await call('POST', '/kiosk/punch', deviceToken, {
			punchToken: identified.body.punchToken,
			action: 'in',
			positionId: barId,
			clientRequestId: requestId,
		})
		expect(clockIn.status).toBe(200)
		expect(clockIn.body).toMatchObject({
			action: 'in',
			entry: { positionId: barId, clockOutAt: null },
			person: { clockedIn: true },
		})
		const replay = await call('POST', '/kiosk/punch', deviceToken, {
			punchToken: identified.body.punchToken,
			action: 'in',
			positionId: barId,
			clientRequestId: requestId,
		})
		expect(replay.body.entry.id).toBe(clockIn.body.entry.id)
		const again = await call('POST', '/kiosk/punch', deviceToken, {
			punchToken: identified.body.punchToken,
			action: 'in',
			positionId: barId,
			clientRequestId: crypto.randomUUID(),
		})
		expect(again).toMatchObject({
			status: 409,
			body: { error: 'already_clocked_in' },
		})

		const clockOut = await call('POST', '/kiosk/punch', deviceToken, {
			punchToken: identified.body.punchToken,
			action: 'out',
			clientRequestId: crypto.randomUUID(),
		})
		expect(clockOut.body.entry.clockOutAt).not.toBeNull()
		const outAgain = await call('POST', '/kiosk/punch', deviceToken, {
			punchToken: identified.body.punchToken,
			action: 'out',
			clientRequestId: crypto.randomUUID(),
		})
		expect(outAgain.body.error).toBe('not_clocked_in')

		const db = await getTenantDb(orgA)
		const entries = await db.select().from(timeEntries)
		expect(entries).toHaveLength(1)
		expect(entries[0]).toMatchObject({ staffId: anaId, source: 'kiosk' })
		const events = await db.select().from(timeEntryEvents)
		expect(events.map((event) => event.kind).sort()).toEqual([
			'clock_in',
			'clock_out',
		])

		const roster = await call('GET', '/operator/staffing/staff', operator)
		expect(roster.body.staff[0].hasPin).toBe(true)
		expect(JSON.stringify(roster.body)).not.toContain('pinHash')
		expect(JSON.stringify(roster.body)).not.toContain('2580')
	})

	it('shows the next published shifts and links a clock-in to the shift', async () => {
		const { operator, deviceToken, cookId, anaId } = await setup()
		const zone = 'America/New_York'
		const start = new Date(Date.now() + 30 * 60_000)
		const end = new Date(Date.now() + 4 * 60 * 60_000)
		const localDate = localDateOf(start, zone)
		const created = await call('POST', '/operator/staffing/shifts', operator, {
			shift: {
				locationId: 'loc_main',
				staffId: anaId,
				positionId: cookId,
				localDate,
				startTime: localTimeOf(start, zone),
				endTime: localTimeOf(end, zone),
				unpaidBreakMinutes: 0,
				note: '',
			},
		})
		expect(created.status).toBe(200)
		const draftOnly = await call('POST', '/kiosk/identify', deviceToken, {
			pin: '2580',
		})
		expect(draftOnly.body.nextShifts).toEqual([])
		await call('POST', '/operator/staffing/schedule/publish', operator, {
			locationId: 'loc_main',
			weekStart: startOfWeek(localDate, 'monday'),
			locationName: 'Main St',
		})
		const identified = await call('POST', '/kiosk/identify', deviceToken, {
			pin: '2580',
		})
		expect(identified.body.nextShifts).toHaveLength(1)
		const punched = await call('POST', '/kiosk/punch', deviceToken, {
			punchToken: identified.body.punchToken,
			action: 'in',
			clientRequestId: crypto.randomUUID(),
		})
		expect(punched.body.entry.positionId).toBe(cookId)
		const db = await getTenantDb(orgA)
		const [entry] = await db.select().from(timeEntries)
		expect(entry?.shiftId).toBe(created.body.shifts[0].id)
	})

	it('locks the device after five wrong PINs with backoff', async () => {
		const { deviceToken } = await setup()
		for (let attempt = 1; attempt < 5; attempt++) {
			const wrong = await call('POST', '/kiosk/identify', deviceToken, {
				pin: '9137',
			})
			expect(wrong).toMatchObject({
				status: 401,
				body: { error: 'invalid_pin', remainingAttempts: 5 - attempt },
			})
		}
		const locked = await call('POST', '/kiosk/identify', deviceToken, {
			pin: '9137',
		})
		expect(locked).toMatchObject({
			status: 423,
			body: { error: 'locked', retryAfterSeconds: 300 },
		})
		const correctWhileLocked = await call(
			'POST',
			'/kiosk/identify',
			deviceToken,
			{ pin: '2580' },
		)
		expect(correctWhileLocked.status).toBe(423)
	})

	it('rejects revoked, forged, cross-organization, and wrong-region devices', async () => {
		const { operator, deviceToken, deviceId } = await setup()
		const forged = deviceToken.replace(/.{4}$/, 'AAAA')
		expect((await call('GET', '/kiosk/device', forged)).status).toBe(401)
		const otherOrg = deviceToken.replace(orgA, orgB)
		expect((await call('GET', '/kiosk/device', otherOrg)).status).toBe(401)
		const ksa = deviceToken.replace(orgA, orgKsa)
		expect((await call('GET', '/kiosk/device', ksa)).status).toBe(401)
		expect((await call('GET', '/kiosk/device', null)).status).toBe(401)

		const listed = await call('GET', '/operator/staffing/kiosks', operator)
		expect(listed.body.kiosks[0]).toMatchObject({
			id: deviceId,
			revokedAt: null,
		})
		expect(JSON.stringify(listed.body)).not.toContain('token')
		const readOnly = await mint({ areas: { timeclock: 'read' } })
		expect(
			(
				await call(
					'POST',
					`/operator/staffing/kiosks/${deviceId}/revoke`,
					readOnly,
				)
			).status,
		).toBe(403)
		const revoked = await call(
			'POST',
			`/operator/staffing/kiosks/${deviceId}/revoke`,
			operator,
		)
		expect(revoked.body.kiosk.revokedAt).not.toBeNull()
		const after = await call('POST', '/kiosk/identify', deviceToken, {
			pin: '2580',
		})
		expect(after).toMatchObject({
			status: 401,
			body: { error: 'device_unpaired' },
		})
	})

	it('binds punch tokens to the device and expires them', async () => {
		const { operator, deviceToken } = await setup()
		const second = await pair(operator)
		const identified = await call('POST', '/kiosk/identify', deviceToken, {
			pin: '2580',
		})
		const elsewhere = await call('POST', '/kiosk/punch', second.deviceToken, {
			punchToken: identified.body.punchToken,
			action: 'in',
			clientRequestId: crypto.randomUUID(),
		})
		expect(elsewhere.body.error).toBe('punch_expired')
		const tampered = identified.body.punchToken.replace(
			/\.(\d+)\./,
			(ignoredMatch: string, expires: string) => `.${Number(expires) + 1000}.`,
		)
		const forged = await call('POST', '/kiosk/punch', deviceToken, {
			punchToken: tampered,
			action: 'in',
			clientRequestId: crypto.randomUUID(),
		})
		expect(forged.body.error).toBe('punch_expired')

		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(Date.now() + 61_000)
		try {
			const late = await call('POST', '/kiosk/punch', deviceToken, {
				punchToken: identified.body.punchToken,
				action: 'in',
				clientRequestId: crypto.randomUUID(),
			})
			expect(late.body.error).toBe('punch_expired')
		} finally {
			vi.useRealTimers()
		}
	})

	it('only identifies active people assigned to the device location', async () => {
		const { operator, cookId, anaId } = await setup()
		const benId = await seedStaff(operator, {
			firstName: 'Ben',
			locationId: 'loc_second',
			positions: [cookId],
		})
		await call('POST', `/operator/staffing/staff/${benId}/pin`, operator, {
			pin: '4826',
		})
		const { deviceToken } = await pair(operator)
		const wrongLocation = await call('POST', '/kiosk/identify', deviceToken, {
			pin: '4826',
		})
		expect(wrongLocation.body.error).toBe('invalid_pin')

		await call(
			'POST',
			`/operator/staffing/staff/${anaId}/terminate`,
			operator,
			{
				terminatedOn: '2026-10-01',
				reason: '',
			},
		)
		const terminated = await call('POST', '/kiosk/identify', deviceToken, {
			pin: '2580',
		})
		expect(terminated.body.error).toBe('invalid_pin')
		// The PIN is released on termination so someone else can use it.
		const reuse = await call(
			'POST',
			`/operator/staffing/staff/${benId}/pin`,
			operator,
			{ pin: '2580' },
		)
		expect(reuse.status).toBe(200)
	})

	it('rejects weak and duplicate PINs and generates unique ones', async () => {
		const { operator, cookId, anaId } = await setup()
		const benId = await seedStaff(operator, {
			firstName: 'Ben',
			positions: [cookId],
		})
		const weak = await call(
			'POST',
			`/operator/staffing/staff/${benId}/pin`,
			operator,
			{ pin: '1234' },
		)
		expect(weak.body.error).toBe('pin_sequence')
		const repeated = await call(
			'POST',
			`/operator/staffing/staff/${benId}/pin`,
			operator,
			{ pin: '7777' },
		)
		expect(repeated.body.error).toBe('pin_repeated')
		const taken = await call(
			'POST',
			`/operator/staffing/staff/${benId}/pin`,
			operator,
			{ pin: '2580' },
		)
		expect(taken).toMatchObject({ status: 409, body: { error: 'pin_taken' } })
		const generated = await call(
			'POST',
			`/operator/staffing/staff/${benId}/pin`,
			operator,
			{},
		)
		expect(generated.body.result.generated).toBe(true)
		expect(generated.body.result.pin).toMatch(/^\d{4}$/)
		expect(generated.body.result.pin).not.toBe('2580')
		const scheduleOnly = await mint({ areas: { schedule: 'write' } })
		expect(
			(
				await call(
					'DELETE',
					`/operator/staffing/staff/${anaId}/pin`,
					scheduleOnly,
				)
			).status,
		).toBe(403)
	})

	it('refuses everything when the node kill switch is off', async () => {
		const { deviceToken } = await setup()
		process.env.STAFFING_KIOSK_ENABLED = 'false'
		const blocked = await call('POST', '/kiosk/identify', deviceToken, {
			pin: '2580',
		})
		expect(blocked).toMatchObject({
			status: 503,
			body: { error: 'kiosk_disabled' },
		})
		const operator = await mint()
		const pairing = await call(
			'POST',
			'/operator/staffing/kiosks/pairing-codes',
			operator,
			{ locationId: 'loc_main', name: 'Back' },
		)
		expect(pairing.status).toBe(503)
	})

	it('rejects pairing codes for unsigned locations and expired codes', async () => {
		const operator = await mint()
		const forged = await call(
			'POST',
			'/operator/staffing/kiosks/pairing-codes',
			operator,
			{ locationId: 'loc_forged', name: 'X' },
		)
		expect(forged.body.error).toBe('unknown_location')
		const code = await call(
			'POST',
			'/operator/staffing/kiosks/pairing-codes',
			operator,
			{ locationId: 'loc_main', name: 'Late' },
		)
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(Date.now() + 16 * 60_000)
		try {
			const late = await call('POST', '/kiosk/pair', null, {
				orgId: orgA,
				code: code.body.pairing.code,
			})
			expect(late.body.error).toBe('invalid_code')
		} finally {
			vi.useRealTimers()
		}
		const wrongOrg = await call('POST', '/kiosk/pair', null, {
			orgId: orgB,
			code: code.body.pairing.code,
		})
		expect(wrongOrg.body.error).toBe('invalid_code')
		const db = await getTenantDb(orgA)
		expect(await db.select().from(kioskDevices)).toHaveLength(0)
	})
})

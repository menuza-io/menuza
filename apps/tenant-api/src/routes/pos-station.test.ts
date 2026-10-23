import crypto from 'node:crypto'
import { brand } from '@repo/config/brand'
import { POS_STAFF_SESSION_HEADER } from '@repo/common/pos-orders'
import { type ReservationsContext } from '@repo/reservations'
import { BUILTIN_LABOR_POLICY } from '@repo/staffing'
import {
	getTenantDb,
	laborPolicies,
	posManagers,
	timeBreaks,
	timeEntries,
	timePunches,
	staffAuditLog,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createClockHarness,
	LOC_1,
	ORG_A,
	ORG_B,
	type ClockHarness,
} from '../../tests/timeclock-harness.ts'
import {
	makeOrg,
	OPERATOR_SECRET,
	type TestOrg,
} from '../../tests/staff-harness.ts'
import { verifyReservationsOperatorToken } from '../lib/reservations-auth.ts'
import { policyFieldsToColumns } from '../services/labor-policy-service.ts'
import { defaultPunchDeps } from '../services/punch-service.ts'
import { posReservationsDeps } from './pos-reservations.ts'
import { posTimeclockDeps } from './pos-timeclock.ts'
import { publicContext, PUBLIC_LOC } from './reservations-public-fixture.ts'

/**
 * Station apps on a paired POS terminal: the time clock (`/pos/timeclock`) and
 * the host stand token (`/pos/reservations/token`). Both ride the terminal's
 * own credential; neither accepts a kiosk secret, an operator token, or another
 * organization's or terminal's session.
 */

const facts = vi.hoisted(
	() => new Map<string, { name: string; timeZone: string }>(),
)
const staffingFlags = vi.hoisted(
	() =>
		new Map<
			string,
			{
				enabled: boolean
				timeclock: boolean
				scheduling: boolean
				hiring: boolean
			} | null
		>(),
)
const rsvContexts = vi.hoisted(() => new Map<string, unknown>())
const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/scope-context.ts', () => ({
	getScopeFacts: vi.fn(
		async (_org: string, scope: string) => facts.get(scope) ?? null,
	),
	getStaffingFeatures: vi.fn(async (orgId: string) => {
		const features = staffingFlags.has(orgId)
			? staffingFlags.get(orgId)
			: { enabled: true, timeclock: true, scheduling: false, hiring: false }
		return features ? { features, dataRegion: 'us' } : null
	}),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../lib/reservations-context.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/reservations-context.ts')>()),
	getReservationsContext: vi.fn(
		async (orgId: string) =>
			(rsvContexts.get(orgId) as ReservationsContext | undefined) ?? null,
	),
}))
/** What App's menu says about a location id; unset ids are known. */
const locationAnswers = vi.hoisted(
	() => new Map<string, 'known' | 'unknown' | 'unavailable'>(),
)
vi.mock('../services/pos-service.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../services/pos-service.ts')>()),
	checkLocation: vi.fn(
		async (_org: string, id: string) => locationAnswers.get(id) ?? 'known',
	),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
}))

/** App signs `stationApps` for someone who manages the time clock and reservations. */
const mintOperator = (
	orgId = ORG_A,
	stationApps: Record<string, unknown> | null = {
		timeclock: true,
		reservations: true,
		guestDetails: true,
		locationIds: null,
	},
) =>
	new SignJWT({
		orgId,
		role: 'operator',
		scope: 'orders:write',
		...(stationApps ? { stationApps } : {}),
	})
		.setSubject('user_manager_1')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(OPERATOR_SECRET))

describe('Station apps on a POS terminal', () => {
	let h: ClockHarness
	const originalPunchDeps = posTimeclockDeps.punch

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		facts.clear()
		facts.set(LOC_1, { name: 'Downtown', timeZone: 'America/Chicago' })
		staffingFlags.clear()
		rsvContexts.clear()
		rsvContexts.set(ORG_A, publicContext(ORG_A))
		rsvContexts.set(ORG_B, publicContext(ORG_B))
		vi.stubEnv('POS_ENABLED', '')
		// Pairing checks the location against App's menu; unreachable means "trust it".
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not found', { status: 404 })),
		)
		h = await createClockHarness([ORG_A, ORG_B])
		posTimeclockDeps.punch = { ...defaultPunchDeps, now: () => h.clock.now }
	})
	afterEach(async () => {
		posTimeclockDeps.punch = originalPunchDeps
		posReservationsDeps.nowSeconds = () => Math.floor(Date.now() / 1000)
		vi.unstubAllGlobals()
		await h.cleanup()
	})

	async function request(
		method: string,
		pathname: string,
		options: {
			secret?: string
			session?: string
			body?: unknown
			authorization?: string
			origin?: string
		} = {},
	) {
		const headers: Record<string, string> = {}
		if (options.secret) headers.Authorization = `Bearer ${options.secret}`
		if (options.authorization) headers.Authorization = options.authorization
		if (options.session) headers[POS_STAFF_SESSION_HEADER] = options.session
		if (options.origin) headers.Origin = options.origin
		if (options.body !== undefined) headers['content-type'] = 'application/json'
		const response = await h.app.request(pathname, {
			method,
			headers,
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
		})
		const raw = await response.text()
		let body: any = null
		try {
			body = raw ? JSON.parse(raw) : null
		} catch {}
		return { status: response.status, body, raw, headers: response.headers }
	}

	async function pairTerminal(
		options: {
			orgId?: string
			terminalCode?: string
			timeclockEnabled?: boolean
			reservationsEnabled?: boolean
			locationId?: string | null
			signInRequired?: boolean
		} = {},
	) {
		const orgId = options.orgId ?? ORG_A
		const created = await h.app.request('/operator/pos/pairing-codes', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${await mintOperator(orgId)}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				label: 'Front counter',
				terminalCode: options.terminalCode ?? 'T1',
				scopeId: LOC_1,
				locationId:
					options.locationId === undefined ? PUBLIC_LOC : options.locationId,
				signInRequired: options.signInRequired ?? true,
				timeclockEnabled: options.timeclockEnabled ?? true,
				reservationsEnabled: options.reservationsEnabled ?? true,
			}),
		})
		if (created.status !== 201) {
			throw new Error(
				`pairing code failed: ${created.status} ${await created.text()}`,
			)
		}
		const { code } = (await created.json()) as { code: string }
		const paired = await request('POST', '/pos/pair', { body: { code } })
		expect(paired.status).toBe(201)
		return {
			secret: paired.body.deviceSecret as string,
			deviceId: paired.body.device.id as string,
		}
	}

	async function signIn(secret: string, pin: string) {
		const r = await request('POST', '/pos/sign-in', { secret, body: { pin } })
		expect(r.status).toBe(200)
		return r.body as {
			sessionToken: string
			role: string
			staff: { id: string }
		}
	}

	const punch = (
		secret: string,
		pin: string,
		kind: 'clock_in' | 'clock_out' | 'break_start' | 'break_end',
		id: string = crypto.randomUUID(),
	) =>
		request('POST', '/pos/timeclock/punch', {
			secret,
			body: { id, kind, pin, clientAt: h.clock.now, offline: false },
		})

	// -----------------------------------------------------------------------
	// Time clock
	// -----------------------------------------------------------------------

	describe('time clock', () => {
		it('identifies by PIN and clocks in and out, recorded as a POS punch', async () => {
			const { pin, staffId } = await h.seedStaff(ORG_A, {
				firstName: 'Rana',
				lastName: 'Saleh',
			})
			// The workplace must have someone assigned before a terminal can use it.
			const { secret, deviceId } = await pairTerminal()

			const who = await request('POST', '/pos/timeclock/identify', {
				secret,
				body: { pin },
			})
			expect(who.status).toBe(200)
			expect(who.body).toMatchObject({
				firstName: 'Rana',
				state: 'out',
				allowedEvents: ['clock_in'],
			})
			expect(who.raw).not.toContain('Saleh')
			expect(who.raw).not.toContain(pin)

			const inPunch = await punch(secret, pin, 'clock_in')
			expect(inPunch.status).toBe(200)
			expect(inPunch.body).toMatchObject({ outcome: 'accepted', state: 'in' })

			h.advance(4 * 60 * 60 * 1000)
			const outPunch = await punch(secret, pin, 'clock_out')
			expect(outPunch.status).toBe(200)
			expect(outPunch.body).toMatchObject({ state: 'out' })

			const db = await getTenantDb(ORG_A)
			const punches = await db
				.select()
				.from(timePunches)
				.where(eq(timePunches.staffId, staffId))
			expect(punches.map((p) => [p.source, p.deviceId])).toEqual([
				['pos', deviceId],
				['pos', deviceId],
			])
			const [entry] = await db
				.select()
				.from(timeEntries)
				.where(eq(timeEntries.staffId, staffId))
			expect(entry?.clockOutKind).toBe('pos')
		})

		it('offers meal and rest breaks where the rules have rest breaks', async () => {
			const { pin, staffId } = await h.seedStaff(ORG_A, {})
			const { secret } = await pairTerminal()
			const db = await getTenantDb(ORG_A)
			await db.insert(laborPolicies).values({
				scopeKey: '*',
				scopeId: null,
				...policyFieldsToColumns({
					...BUILTIN_LABOR_POLICY,
					breakRules: {
						rules: [
							{
								kind: 'rest',
								afterMinutes: 240,
								minutes: 10,
								paid: true,
								mandatory: false,
							},
						],
						autoDeduction: null,
					},
				}),
			})
			const out = await request('POST', '/pos/timeclock/identify', {
				secret,
				body: { pin },
			})
			// Known before clocking in too, so a till can offer it offline.
			expect(out.body.breakKinds).toEqual(['meal', 'rest'])
			expect((await punch(secret, pin, 'clock_in')).status).toBe(200)
			const working = await request('POST', '/pos/timeclock/identify', {
				secret,
				body: { pin },
			})
			expect(working.body.breakKinds).toEqual(['meal', 'rest'])
			const rest = await request('POST', '/pos/timeclock/punch', {
				secret,
				body: {
					id: crypto.randomUUID(),
					kind: 'break_start',
					breakKind: 'rest',
					pin,
					clientAt: h.clock.now,
					offline: false,
				},
			})
			expect(rest.status).toBe(200)
			const [entry] = await db
				.select()
				.from(timeEntries)
				.where(eq(timeEntries.staffId, staffId))
			const breaks = await db
				.select()
				.from(timeBreaks)
				.where(eq(timeBreaks.entryId, entry!.id))
			expect(breaks.map((b) => [b.kind, b.paid])).toEqual([['rest', true]])
		})

		it('a saved punch lands only on the person it was made for', async () => {
			const { pin, staffId } = await h.seedStaff(ORG_A, {})
			const { secret } = await pairTerminal()
			const who = await request('POST', '/pos/timeclock/identify', {
				secret,
				body: { pin },
			})
			expect(who.body.staffId).toBe(staffId)
			// The PIN has since been given to someone else: never their punch.
			const wrong = await request('POST', '/pos/timeclock/punch', {
				secret,
				body: {
					id: crypto.randomUUID(),
					kind: 'clock_in',
					pin,
					staffId: 'stf_someone_else',
					clientAt: h.clock.now,
					offline: true,
				},
			})
			expect(wrong.status).toBe(409)
			expect(wrong.body.error).toBe('pin_owner_changed')
			const id = crypto.randomUUID()
			const right = await request('POST', '/pos/timeclock/punch', {
				secret,
				body: {
					id,
					kind: 'clock_in',
					pin,
					staffId,
					clientAt: h.clock.now,
					offline: true,
				},
			})
			expect(right.status).toBe(200)
			// Its answer was lost and the PIN changed since: the retry is still the
			// recorded punch, never "refused".
			const retry = await request('POST', '/pos/timeclock/punch', {
				secret,
				body: {
					id,
					kind: 'clock_in',
					pin: '0000',
					staffId,
					clientAt: h.clock.now,
					offline: true,
				},
			})
			expect(retry.status).toBe(200)
			expect(retry.body).toMatchObject({ outcome: 'accepted', duplicate: true })
		})

		it('replays the same punch id without a second punch', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			const { secret } = await pairTerminal()
			const id = crypto.randomUUID()
			expect((await punch(secret, pin, 'clock_in', id)).status).toBe(200)
			const again = await punch(secret, pin, 'clock_in', id)
			expect(again.status).toBe(200)
			expect(again.body.duplicate).toBe(true)
		})

		it('refuses a wrong PIN and backs off the terminal', async () => {
			await h.seedStaff(ORG_A, { pin: '4321' })
			const { secret } = await pairTerminal()
			const statuses: number[] = []
			for (let i = 0; i < 6; i++) {
				const r = await request('POST', '/pos/timeclock/identify', {
					secret,
					body: { pin: '1111' },
				})
				statuses.push(r.status)
			}
			expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401])
			expect(statuses).toContain(429)
		})

		it('is off unless the terminal offers it', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			const { secret } = await pairTerminal({ timeclockEnabled: false })
			const r = await punch(secret, pin, 'clock_in')
			expect(r.status).toBe(403)
			expect(r.body.error).toBe('timeclock_not_enabled')
		})

		it('is off when the organization turned the time clock off; unknown flags hold a live punch for later', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			const { secret } = await pairTerminal()
			staffingFlags.set(ORG_A, {
				enabled: true,
				timeclock: false,
				scheduling: false,
				hiring: false,
			})
			const off = await punch(secret, pin, 'clock_in')
			expect(off.status).toBe(403)
			expect(off.body.error).toBe('timeclock_disabled')

			// The till keeps a punch the server could not judge and sends it later.
			staffingFlags.set(ORG_A, null)
			const unknown = await punch(secret, pin, 'clock_in')
			expect(unknown.status).toBe(503)
			expect(unknown.body.error).toBe('service_unavailable')
		})

		it('a punch made offline lands even if the clock was switched off since', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			const { secret, deviceId } = await pairTerminal()
			const patch = await h.app.request(`/operator/pos/terminals/${deviceId}`, {
				method: 'PATCH',
				headers: {
					authorization: `Bearer ${await mintOperator()}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ timeclockEnabled: false }),
			})
			expect(patch.status).toBe(200)
			expect((await punch(secret, pin, 'clock_in')).status).toBe(403)
			const replay = await request('POST', '/pos/timeclock/punch', {
				secret,
				body: {
					id: crypto.randomUUID(),
					kind: 'clock_in',
					pin,
					clientAt: h.clock.now - 10 * 60 * 1000,
					offline: true,
				},
			})
			expect(replay.status).toBe(200)
			// The regional pause for tablet clocks holds even offline punches (the till keeps them).
			vi.stubEnv('STAFFING_KIOSK_ENABLED', 'false')
			const paused = await punch(secret, pin, 'clock_out')
			expect(paused.status).toBe(503)
			expect(paused.body.error).toBe('kiosk_disabled')
		})

		it('an offline punch needs the clock to have been on here when it was made', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			const replay = (secret: string, clientAt: number) =>
				request('POST', '/pos/timeclock/punch', {
					secret,
					body: {
						id: crypto.randomUUID(),
						kind: 'clock_in',
						pin,
						clientAt,
						offline: true,
					},
				})
			// A till that never offered the clock cannot punch by calling it offline.
			const never = await pairTerminal({
				terminalCode: 'T7',
				timeclockEnabled: false,
			})
			const sneaky = await replay(never.secret, h.clock.now)
			expect(sneaky.status).toBe(409)
			expect(sneaky.body.error).toBe('timeclock_was_off')

			// Switched off: punches made before still land, ones made after do not.
			const { secret, deviceId } = await pairTerminal({ terminalCode: 'T8' })
			const db = await getTenantDb(ORG_A)
			const { posDevices } = await import('@repo/tenant-db')
			await db
				.update(posDevices)
				.set({ timeclockEnabled: false, timeclockDisabledAt: h.clock.now })
				.where(eq(posDevices.id, deviceId))
			const after = await replay(secret, h.clock.now + 60_000)
			// Final, not a pause: the till sets it aside for a manager.
			expect(after.status).toBe(409)
			expect(after.body.error).toBe('timeclock_was_off')

			// The organization's clock known to be off holds it (the till keeps it, a pause code).
			staffingFlags.set(ORG_A, {
				enabled: true,
				timeclock: false,
				scheduling: false,
				labor: false,
				hiring: false,
			})
			const held = await replay(secret, h.clock.now - 60_000)
			expect(held.status).toBe(403)
			expect(held.body.error).toBe('timeclock_disabled')
			// Not knowing the flag does not: the punch already happened.
			staffingFlags.set(ORG_A, null)
			expect((await replay(secret, h.clock.now - 60_000)).status).toBe(200)
		})

		it('refuses kiosk secrets, operator tokens, missing and revoked credentials', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			const kiosk = await h.pair(ORG_A, LOC_1)
			const body = {
				id: crypto.randomUUID(),
				kind: 'clock_in',
				pin,
				clientAt: h.clock.now,
				offline: false,
			}
			for (const authorization of [
				undefined,
				`Bearer ${kiosk.secret}`,
				`Bearer ${await mintOperator()}`,
				'Bearer pdv1.not.a.secret',
			]) {
				const r = await request('POST', '/pos/timeclock/punch', {
					authorization,
					body,
				})
				expect(r.status).toBe(401)
			}

			const { secret, deviceId } = await pairTerminal()
			const revoked = await h.app.request(
				`/operator/pos/terminals/${deviceId}`,
				{
					method: 'DELETE',
					headers: { authorization: `Bearer ${await mintOperator()}` },
				},
			)
			expect(revoked.status).toBe(200)
			const r = await punch(secret, pin, 'clock_in')
			expect(r.status).toBe(401)
			expect(r.body.error).toBe('device_revoked')
		})

		it('never punches across organizations: a PIN only names people at the terminal workplace', async () => {
			const other = await h.seedStaff(ORG_B, { pin: '5555' })
			await h.seedStaff(ORG_A, { pin: '6666' })
			const { secret } = await pairTerminal()
			const r = await punch(secret, other.pin, 'clock_in')
			expect(r.status).toBe(401)
			expect(r.body.error).toBe('invalid_pin')
		})

		it('records rejected punches against the terminal, not a kiosk', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			const { secret, deviceId } = await pairTerminal()
			const r = await punch(secret, pin, 'clock_out')
			expect(r.status).toBe(409)
			const db = await getTenantDb(ORG_A)
			const audit = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.action, 'pos.punch.rejected'))
			expect(audit.map((a) => [a.actorKind, a.actorId])).toEqual([
				['pos', deviceId],
			])
		})
	})

	// -----------------------------------------------------------------------
	// Apps on /pos/me
	// -----------------------------------------------------------------------

	describe('/pos/me apps', () => {
		it('reports each app as the terminal setting and the organization flag together', async () => {
			await h.seedStaff(ORG_A, {})
			const { secret } = await pairTerminal()
			const me = await request('GET', '/pos/me', { secret })
			expect(me.body.apps).toEqual({ timeclock: true, reservations: true })

			rsvContexts.set(ORG_A, publicContext(ORG_A, { enabled: false }))
			staffingFlags.set(ORG_A, {
				enabled: false,
				timeclock: false,
				scheduling: false,
				hiring: false,
			})
			const off = await request('GET', '/pos/me', { secret })
			expect(off.body.apps).toEqual({ timeclock: false, reservations: false })
		})

		it('a terminal without the apps reports none', async () => {
			await h.seedStaff(ORG_A, {})
			const { secret } = await pairTerminal({
				timeclockEnabled: false,
				reservationsEnabled: false,
			})
			const me = await request('GET', '/pos/me', { secret })
			expect(me.body.apps).toEqual({ timeclock: false, reservations: false })
		})
	})

	// -----------------------------------------------------------------------
	// Manager settings
	// -----------------------------------------------------------------------

	describe('terminal settings', () => {
		const patch = async (deviceId: string, body: unknown) =>
			h.app.request(`/operator/pos/terminals/${deviceId}`, {
				method: 'PATCH',
				headers: {
					authorization: `Bearer ${await mintOperator()}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
			})

		it('reservations need a location and staff sign-in', async () => {
			await h.seedStaff(ORG_A, {})
			const created = await h.app.request('/operator/pos/pairing-codes', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${await mintOperator()}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					label: 'Bar',
					terminalCode: 'B1',
					scopeId: LOC_1,
					locationId: null,
					reservationsEnabled: true,
				}),
			})
			expect(created.status).toBe(422)
			expect(((await created.json()) as { error: string }).error).toBe(
				'reservations_needs_location',
			)

			const { deviceId } = await pairTerminal()
			const r = await patch(deviceId, { signInRequired: false })
			expect(r.status).toBe(422)
			expect(((await r.json()) as { error: string }).error).toBe(
				'reservations_needs_sign_in',
			)
			expect(
				(await patch(deviceId, { reservationsEnabled: false })).status,
			).toBe(200)
			expect((await patch(deviceId, { signInRequired: false })).status).toBe(
				200,
			)
		})

		it('switching an app on needs its own module’s permission; switching off never does', async () => {
			const { staffId } = await h.seedStaff(ORG_A, {})
			const { deviceId } = await pairTerminal()
			const menuOnly = await mintOperator(ORG_A, null)
			const send = (path: string, method: string, body: unknown) =>
				h.app.request(path, {
					method,
					headers: {
						authorization: `Bearer ${menuOnly}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify(body),
				})
			const off = await send(`/operator/pos/terminals/${deviceId}`, 'PATCH', {
				timeclockEnabled: false,
				reservationsEnabled: false,
			})
			expect(off.status).toBe(200)
			for (const [body, error] of [
				[{ timeclockEnabled: true }, 'timeclock_permission_required'],
				[{ reservationsEnabled: true }, 'reservations_permission_required'],
			] as const) {
				const r = await send(
					`/operator/pos/terminals/${deviceId}`,
					'PATCH',
					body,
				)
				expect(r.status).toBe(403)
				expect(((await r.json()) as { error: string }).error).toBe(error)
			}
			const code = await send('/operator/pos/pairing-codes', 'POST', {
				label: 'Bar',
				terminalCode: 'B2',
				scopeId: LOC_1,
				timeclockEnabled: true,
			})
			expect(code.status).toBe(403)
			const host = await send(`/operator/pos/hosts/${staffId}`, 'PUT', {})
			expect(host.status).toBe(403)
		})

		it('a terminal paired without a location can be bound to one later, once', async () => {
			await h.seedStaff(ORG_A, {})
			const { deviceId } = await pairTerminal({
				locationId: null,
				reservationsEnabled: false,
			})
			expect((await patch(deviceId, { locationId: PUBLIC_LOC })).status).toBe(
				200,
			)
			expect(
				(await patch(deviceId, { reservationsEnabled: true })).status,
			).toBe(200)
			const move = await patch(deviceId, { locationId: 'loc_other' })
			expect(move.status).toBe(409)
		})

		it('a member limited to some locations opens the host stand only there', async () => {
			await h.seedStaff(ORG_A, {})
			const scoped = await mintOperator(ORG_A, {
				timeclock: true,
				reservations: true,
				guestDetails: false,
				locationIds: ['loc_elsewhere'],
			})
			const code = await h.app.request('/operator/pos/pairing-codes', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${scoped}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					label: 'Host stand',
					terminalCode: 'T5',
					scopeId: LOC_1,
					locationId: PUBLIC_LOC,
					signInRequired: true,
					reservationsEnabled: true,
				}),
			})
			expect(code.status).toBe(403)
			expect(((await code.json()) as { error: string }).error).toBe(
				'location_not_allowed',
			)
			const { deviceId } = await pairTerminal({ reservationsEnabled: false })
			const flip = await h.app.request(`/operator/pos/terminals/${deviceId}`, {
				method: 'PATCH',
				headers: {
					authorization: `Bearer ${scoped}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ reservationsEnabled: true }),
			})
			expect(flip.status).toBe(403)
			// A claim without locations allows nothing.
			const malformed = await mintOperator(ORG_A, {
				timeclock: true,
				reservations: true,
			})
			const again = await h.app.request(`/operator/pos/terminals/${deviceId}`, {
				method: 'PATCH',
				headers: {
					authorization: `Bearer ${malformed}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ reservationsEnabled: true }),
			})
			expect(again.status).toBe(403)
		})

		it('giving a host guest details needs the guest permission', async () => {
			const { staffId } = await h.seedStaff(ORG_A, {})
			const put = async (token: string, guestDetails: boolean) =>
				h.app.request(`/operator/pos/hosts/${staffId}`, {
					method: 'PUT',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
					},
					body: JSON.stringify({ guestDetails }),
				})
			const noGuest = await mintOperator(ORG_A, {
				timeclock: false,
				reservations: true,
				guestDetails: false,
				locationIds: null,
			})
			const refused = await put(noGuest, true)
			expect(refused.status).toBe(403)
			expect(((await refused.json()) as { error: string }).error).toBe(
				'guest_permission_required',
			)
			// The roster is organization-wide: a member limited to some locations cannot change it.
			const scoped = await mintOperator(ORG_A, {
				timeclock: false,
				reservations: true,
				guestDetails: true,
				locationIds: ['loc_elsewhere'],
			})
			const narrow = await put(scoped, false)
			expect(narrow.status).toBe(403)
			expect(((await narrow.json()) as { error: string }).error).toBe(
				'location_not_allowed',
			)
			expect((await put(noGuest, false)).status).toBe(200)
			expect((await put(await mintOperator(), true)).status).toBe(200)
			// Who granted what, and when, stays on record.
			const db = await getTenantDb(ORG_A)
			const rows = await db
				.select()
				.from(staffAuditLog)
				.where(eq(staffAuditLog.entityId, staffId))
			expect(rows.map((r) => [r.action, r.actorId])).toEqual([
				['pos.host.added', 'user_manager_1'],
				['pos.host.changed', 'user_manager_1'],
			])
			expect(rows[1]!.changes).toEqual({
				guestDetails: { before: false, after: true },
			})
		})

		it('binding waits for App to confirm the location: it is permanent', async () => {
			await h.seedStaff(ORG_A, {})
			const { deviceId } = await pairTerminal({
				locationId: null,
				reservationsEnabled: false,
			})
			locationAnswers.set('loc_down', 'unavailable')
			locationAnswers.set('loc_typo', 'unknown')
			try {
				const down = await patch(deviceId, { locationId: 'loc_down' })
				expect(down.status).toBe(503)
				const typo = await patch(deviceId, { locationId: 'loc_typo' })
				expect(typo.status).toBe(422)
				// Neither bound it.
				expect((await patch(deviceId, { locationId: PUBLIC_LOC })).status).toBe(
					200,
				)
			} finally {
				locationAnswers.clear()
			}
		})

		it('a manager turns the time clock on and off for one terminal', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			const { secret, deviceId } = await pairTerminal({
				timeclockEnabled: false,
			})
			expect((await patch(deviceId, { timeclockEnabled: true })).status).toBe(
				200,
			)
			expect((await punch(secret, pin, 'clock_in')).status).toBe(200)
			const list = await h.app.request('/operator/pos/terminals', {
				headers: { authorization: `Bearer ${await mintOperator()}` },
			})
			const body = (await list.json()) as {
				devices: Array<{ id: string; timeclockEnabled: boolean }>
			}
			expect(
				body.devices.find((d) => d.id === deviceId)?.timeclockEnabled,
			).toBe(true)
		})
	})

	// -----------------------------------------------------------------------
	// Host stand token
	// -----------------------------------------------------------------------

	describe('reservations token', () => {
		const token = (secret: string, session?: string) =>
			request('POST', '/pos/reservations/token', {
				secret,
				session,
				body: { scope: 'book' },
			})
		/** Puts a person on the host roster, as someone who manages reservations does. */
		const makeHost = async (staffId: string, guestDetails = false) => {
			const r = await h.app.request(`/operator/pos/hosts/${staffId}`, {
				method: 'PUT',
				headers: {
					authorization: `Bearer ${await mintOperator()}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({ guestDetails }),
			})
			expect(r.status).toBe(200)
		}

		it('mints a host token for the signed-in person at the terminal location', async () => {
			const { pin, staffId } = await h.seedStaff(ORG_A, {})
			await makeHost(staffId)
			const { secret } = await pairTerminal()
			const { sessionToken } = await signIn(secret, pin)
			const r = await token(secret, sessionToken)
			expect(r.status).toBe(200)
			expect(r.headers.get('Cache-Control')).toContain('no-store')
			expect(r.body).toMatchObject({
				locationId: PUBLIC_LOC,
				canReadGuest: false,
				features: { waitlist: true, online: true },
			})

			const verified = await verifyReservationsOperatorToken(
				`Bearer ${r.body.token}`,
			)
			expect(verified.ok).toBe(true)
			if (!verified.ok) return
			expect(verified.context).toMatchObject({
				orgId: ORG_A,
				userId: `staff:${staffId}`,
				scope: 'book',
				locationIdList: [PUBLIC_LOC],
				impersonated: false,
				channel: 'station',
			})
			expect([...verified.context.grants].sort()).toEqual([
				'read:reservation:any',
				'update:reservation:any',
			])
			// Five minutes at a shared tablet, whatever the grants.
			expect(r.body.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000)
		})

		it('taking orders is not running the host stand: only the host roster gets a token', async () => {
			const { pin, staffId } = await h.seedStaff(ORG_A, {})
			// Even a till manager is not a host until put on the roster.
			const db = await getTenantDb(ORG_A)
			await db.insert(posManagers).values({ staffId, addedBy: 'test' })
			const { secret } = await pairTerminal()
			const { sessionToken } = await signIn(secret, pin)
			const r = await token(secret, sessionToken)
			expect(r.status).toBe(403)
			expect(r.body.error).toBe('not_a_host')
		})

		it('a host with guest details also reads them', async () => {
			const { pin, staffId } = await h.seedStaff(ORG_A, {})
			await makeHost(staffId, true)
			const { secret } = await pairTerminal()
			const { sessionToken } = await signIn(secret, pin)
			const r = await token(secret, sessionToken)
			expect(r.status).toBe(200)
			expect(r.body.canReadGuest).toBe(true)
			expect(r.body.expiresAt - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000)
			const verified = await verifyReservationsOperatorToken(
				`Bearer ${r.body.token}`,
			)
			expect(
				verified.ok &&
					verified.context.grants.has('read:reservation_guest:any'),
			).toBe(true)
			// On record once per sign-in: who, at which till, with guest details.
			expect((await token(secret, sessionToken)).status).toBe(200)
			const db = await getTenantDb(ORG_A)
			const { rsvAuditLog } = await import('@repo/tenant-db')
			const rows = await db
				.select()
				.from(rsvAuditLog)
				.where(eq(rsvAuditLog.action, 'station.host_stand_opened'))
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				actorId: `staff:${staffId}`,
				entityType: 'pos_device',
				changes: { guestDetails: true },
			})
		})

		it('the token works on the day of service at its own location only, and on nothing else', async () => {
			const { pin, staffId } = await h.seedStaff(ORG_A, {})
			await makeHost(staffId)
			const { secret } = await pairTerminal()
			const { sessionToken } = await signIn(secret, pin)
			const minted = (await token(secret, sessionToken)).body.token as string
			const call = (pathname: string) =>
				request('GET', pathname, { authorization: `Bearer ${minted}` })

			const own = await call(
				`/operator/reservations/book/day?locationId=${PUBLIC_LOC}&date=2026-03-02`,
			)
			expect([401, 403]).not.toContain(own.status)
			const other = await call(
				'/operator/reservations/book/day?locationId=loc_other&date=2026-03-02',
			)
			expect(other.status).toBe(403)
			for (const pathname of [
				'/operator/reservations/guests',
				`/operator/reservations/setup/settings?locationId=${PUBLIC_LOC}`,
				// The guestbook stays shut to a till, even under the book routes.
				`/operator/reservations/book/guests/lookup?q=Ma&locationId=${PUBLIC_LOC}`,
				'/operator/reservations/book/guests/g1/summary',
			]) {
				expect((await call(pathname)).status, pathname).toBe(403)
			}
		})

		it('needs a signed-in session from this terminal and organization', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			const t1 = await pairTerminal({ terminalCode: 'T1' })
			const t2 = await pairTerminal({ terminalCode: 'T2' })
			await h.seedStaff(ORG_B, { pin })
			const b = await pairTerminal({ orgId: ORG_B, terminalCode: 'T1' })
			const onT1 = (await signIn(t1.secret, pin)).sessionToken
			const onB = (await signIn(b.secret, pin)).sessionToken

			expect((await token(t1.secret)).body.error).toBe('staff_session_required')
			for (const [secret, session] of [
				[t2.secret, onT1],
				[t1.secret, onB],
				[t1.secret, 'not-a-token'],
				[t1.secret, `${onT1.slice(0, -2)}xx`],
			] as const) {
				const r = await token(secret, session)
				expect(r.status).toBe(401)
				expect(r.body.error).toBe('staff_session_invalid')
			}
			// An operator token is not a staff session.
			const r = await token(t1.secret, await mintOperator())
			expect(r.status).toBe(401)
		})

		it('ends when the person’s PIN changes after they signed in', async () => {
			const { pin, staffId } = await h.seedStaff(ORG_A, {})
			await makeHost(staffId)
			const { secret } = await pairTerminal()
			const { sessionToken } = await signIn(secret, pin)
			const db = await getTenantDb(ORG_A)
			const { staffScopeAssignments } = await import('@repo/tenant-db')
			await db
				.update(staffScopeAssignments)
				.set({ pinSetAt: Date.now() + 60_000 })
				.where(eq(staffScopeAssignments.staffId, staffId))
			const r = await token(secret, sessionToken)
			expect(r.status).toBe(401)
			expect(r.body.error).toBe('staff_session_invalid')
		})

		it('ends when a manager clears the person’s PIN', async () => {
			const { pin, staffId } = await h.seedStaff(ORG_A, {})
			await makeHost(staffId)
			const { secret } = await pairTerminal()
			const { sessionToken } = await signIn(secret, pin)
			const db = await getTenantDb(ORG_A)
			const { staffScopeAssignments } = await import('@repo/tenant-db')
			// What "Clear PIN" in the staff module writes.
			await db
				.update(staffScopeAssignments)
				.set({ pinLookup: null, pinSetAt: null })
				.where(eq(staffScopeAssignments.staffId, staffId))
			const r = await token(secret, sessionToken)
			expect(r.status).toBe(401)
			expect(r.body.error).toBe('staff_session_invalid')
		})

		it('ends when the person is no longer active there', async () => {
			const { pin, staffId } = await h.seedStaff(ORG_A, {})
			const { secret } = await pairTerminal()
			const { sessionToken } = await signIn(secret, pin)
			const db = await getTenantDb(ORG_A)
			const { staffMembers } = await import('@repo/tenant-db')
			await db
				.update(staffMembers)
				.set({ status: 'terminated' })
				.where(eq(staffMembers.id, staffId))
			const r = await token(secret, sessionToken)
			expect(r.status).toBe(401)
			expect(r.body.error).toBe('staff_session_invalid')
		})

		it('is refused when the terminal, location or organization does not offer it', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			const off = await pairTerminal({
				terminalCode: 'T1',
				reservationsEnabled: false,
			})
			const offSession = (await signIn(off.secret, pin)).sessionToken
			expect((await token(off.secret, offSession)).body.error).toBe(
				'reservations_not_enabled',
			)

			const elsewhere = await pairTerminal({
				terminalCode: 'T2',
				locationId: 'loc_closed',
			})
			const elsewhereSession = (await signIn(elsewhere.secret, pin))
				.sessionToken
			expect((await token(elsewhere.secret, elsewhereSession)).body.error).toBe(
				'reservations_needs_location',
			)

			const on = await pairTerminal({ terminalCode: 'T3' })
			const session = (await signIn(on.secret, pin)).sessionToken
			rsvContexts.set(ORG_A, publicContext(ORG_A, { enabled: false }))
			expect((await token(on.secret, session)).body.error).toBe(
				'reservations_disabled',
			)
			rsvContexts.delete(ORG_A)
			const unknown = await token(on.secret, session)
			expect(unknown.status).toBe(503)
		})

		it('a session is never a punch: the time clock still asks for the PIN', async () => {
			const { pin } = await h.seedStaff(ORG_A, {})
			const { secret } = await pairTerminal()
			const { sessionToken } = await signIn(secret, pin)
			const r = await request('POST', '/pos/timeclock/punch', {
				secret,
				session: sessionToken,
				body: {
					id: crypto.randomUUID(),
					kind: 'clock_in',
					clientAt: h.clock.now,
					offline: false,
				},
			})
			expect(r.status).toBe(400)
		})

		it('lets a Station origin call the day-of-service routes, and only those', async () => {
			vi.stubEnv('POS_ORIGINS', 'https://pos.example.test')
			const preflight = (pathname: string) =>
				h.app.request(pathname, {
					method: 'OPTIONS',
					headers: {
						Origin: 'https://pos.example.test',
						'Access-Control-Request-Method': 'GET',
					},
				})
			expect((await preflight('/operator/reservations/book/day')).status).toBe(
				204,
			)
			expect((await preflight('/operator/reservations/guests')).status).toBe(
				403,
			)
			expect((await preflight('/operator/pos/terminals')).status).toBe(403)
		})
	})
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sendSms } from '@repo/sms'
import {
	destroyTenantDb,
	getTenantDb,
	rsvGuests,
	rsvHolds,
	rsvLocationSettings,
	rsvMessages,
	rsvPolicies,
	rsvReservations,
	rsvServices,
	voiceCallActions,
	voiceCalls,
} from '@repo/tenant-db'
import { and, eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import {
	hashHoldToken,
	resetPublicRateLimits,
} from '../lib/reservations-public-auth.ts'
import { clearReservationDayCacheForTest } from '../lib/reservations-write.ts'
import { registerReservationVoiceActions } from '../restaurant/reservations-voice-actions.ts'
import { bookFromHold } from '../services/rsv-public-booking-service.ts'
import { updateLocationSettings } from '../services/rsv-setup-service.ts'
import { clearVoiceActionsForTest } from '../services/voice-actions.ts'
import {
	dateAhead,
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
} from './reservations-public-fixture.ts'
import { reservationsVoiceActionRoutes } from './reservations-internal.ts'
import { voiceSystemRoutes } from './voice.ts'

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true }),
}))

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	resolveOrganizationForBrowserAuth: vi.fn(async () => null),
}))

const ORG = 'org_voice_us'
const ORG_KSA = 'org_voice_ksa'
const VOICE_TOKEN = 'test-voice-agent-token-0123456789abcdef'
const DAY = dateAhead(10)
const CALLER = '+14155550101'

let tempDir: string
const app = new Hono()
app.route('/api/voice/actions', reservationsVoiceActionRoutes)
app.route('/api/voice', voiceSystemRoutes)

function voiceContext(
	features: { voice?: boolean; online?: boolean; payments?: boolean } = {},
) {
	const base = publicContext(ORG, {
		online: features.online ?? true,
		payments: features.payments
			? { processor: 'connect', deposit: true, guarantee: true }
			: undefined,
	})
	return {
		...base,
		features: { ...base.features, voice: features.voice ?? true },
		voice: { enabled: features.voice ?? true },
	}
}

function post(
	route: string,
	body: unknown,
	token: string | null = VOICE_TOKEN,
) {
	return app.request(route, {
		method: 'POST',
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(body),
	})
}

let roomCounter = 0
async function startCall(
	options: {
		channel?: 'phone' | 'web_test'
		callerPhone?: string | null
		orgId?: string
		scopeId?: string | null
	} = {},
) {
	roomCounter += 1
	const res = await post('/api/voice/calls', {
		orgId: options.orgId ?? ORG,
		channel: options.channel ?? 'phone',
		roomName: `room-${roomCounter}-${Math.random().toString(36).slice(2, 8)}`,
		scopeId: options.scopeId === undefined ? PUBLIC_LOC : options.scopeId,
		callerPhone:
			options.callerPhone === undefined ? CALLER : options.callerPhone,
	})
	expect(res.status).toBe(201)
	return ((await res.json()) as { callId: string }).callId
}

async function action(
	name: string,
	callId: string,
	input: unknown,
	extra: Record<string, unknown> = {},
) {
	const res = await post(`/api/voice/actions/${name}`, {
		orgId: ORG,
		callId,
		scopeId: PUBLIC_LOC,
		channel: 'phone',
		input,
		...extra,
	})
	const text = await res.text()
	return { status: res.status, body: JSON.parse(text) as any, text }
}

const availabilityInput = (partySize = 2, time = '19:00') => ({
	date: DAY,
	time,
	partySize,
})
const slotInput = (localTime = '19:00') => ({ date: DAY, localTime })

async function actionRows(callId?: string) {
	const db = await getTenantDb(ORG)
	return callId
		? db
				.select()
				.from(voiceCallActions)
				.where(eq(voiceCallActions.callId, callId))
				.all()
		: db.select().from(voiceCallActions).all()
}

async function holds() {
	return (await getTenantDb(ORG)).select().from(rsvHolds).all()
}

async function setSettings(
	patch: Partial<typeof rsvLocationSettings.$inferInsert>,
) {
	await (
		await getTenantDb(ORG)
	)
		.update(rsvLocationSettings)
		.set(patch)
		.where(eq(rsvLocationSettings.locationId, PUBLIC_LOC))
}

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-actions-test-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.VOICE_AGENT_TOKEN = VOICE_TOKEN
	process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-token-123456789'
	process.env.JWT_SECRET = 'test-public-customer-jwt-secret-123456'
	process.env.AUTH_HMAC_SECRET = 'test-public-auth-hmac-secret-0123456789'
	resetReservationsContextCache()
	clearReservationDayCacheForTest()
	resetPublicRateLimits()
	clearVoiceActionsForTest()
	registerReservationVoiceActions()
	vi.mocked(sendSms).mockClear()
	orgs.set(ORG, {
		id: ORG,
		slug: 'acme',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: 'Acme Bistro',
	})
	orgs.set(ORG_KSA, {
		id: ORG_KSA,
		slug: 'riyadh',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'ksa',
		name: 'Riyadh Grill',
	})
	await seedPublicOrg(ORG, { seedContext: false })
	seedReservationsContextForTest(ORG, voiceContext())
})

afterEach(async () => {
	await destroyTenantDb(ORG).catch(() => undefined)
	fs.rmSync(tempDir, { recursive: true, force: true })
})

describe('POST /api/voice/actions/:name authentication', () => {
	it('refuses a missing, near-miss and garbage voice token with 401 and records nothing (VAL-VOICE-001)', async () => {
		const callId = await startCall()
		const body = {
			orgId: ORG,
			callId,
			input: availabilityInput(),
		}
		const route = '/api/voice/actions/reservations.availability'
		const nearMiss = `${VOICE_TOKEN.slice(0, -1)}${VOICE_TOKEN.endsWith('a') ? 'b' : 'a'}`
		for (const token of [null, nearMiss, 'garbage']) {
			expect((await post(route, body, token)).status).toBe(401)
		}
		expect(await actionRows(callId)).toEqual([])
	})

	it('answers 503 when the voice token is not configured', async () => {
		process.env.VOICE_AGENT_TOKEN = 'short'
		const res = await post('/api/voice/actions/reservations.availability', {
			orgId: ORG,
			callId: '6f1d5e14-5ad5-4c9a-9ff0-6b6c3df9d5a1',
			input: {},
		})
		expect(res.status).toBe(503)
	})

	it('answers an unknown action with 404 and no row, while the call still works (VAL-VOICE-002)', async () => {
		const callId = await startCall()
		for (const name of ['reservations.nonexistent', 'nothing.here']) {
			const res = await post(`/api/voice/actions/${name}`, {
				orgId: ORG,
				callId,
				input: {},
			})
			expect(res.status).toBe(404)
		}
		expect(await actionRows(callId)).toEqual([])
		const ok = await action(
			'reservations.availability',
			callId,
			availabilityInput(),
		)
		expect(ok.status).toBe(200)
		expect(ok.body.ok).toBe(true)
	})

	it('answers 409 for a finished call and records nothing (VAL-VOICE-003)', async () => {
		const callId = await startCall()
		const finish = await post(`/api/voice/calls/${callId}/finish`, {
			orgId: ORG,
			outcome: 'resolved',
			transcript: [],
			durationSeconds: 5,
		})
		expect(finish.status).toBe(200)
		const result = await action(
			'reservations.availability',
			callId,
			availabilityInput(),
		)
		expect(result.status).toBe(409)
		expect(await actionRows(callId)).toEqual([])
	})

	it('answers 404 for an unknown call and 400 for a malformed body', async () => {
		const unknown = await action(
			'reservations.availability',
			'6f1d5e14-5ad5-4c9a-9ff0-6b6c3df9d5a1',
			availabilityInput(),
		)
		expect(unknown.status).toBe(404)
		const malformed = await post(
			'/api/voice/actions/reservations.availability',
			{
				orgId: ORG,
				callId: 'not-a-uuid',
			},
		)
		expect(malformed.status).toBe(400)
	})
})

describe('regions', () => {
	it('refuses a KSA organization with the uniform 404 and writes nothing (VAL-VOICE-013)', async () => {
		const callId = await startCall()
		for (const orgId of [ORG_KSA, 'org_unknown']) {
			const res = await post('/api/voice/actions/reservations.availability', {
				orgId,
				callId,
				input: availabilityInput(),
			})
			expect(res.status).toBe(404)
			expect(await res.json()).toEqual({
				error: 'Organization is not available in this region',
			})
		}
		expect(await actionRows()).toEqual([])
	})

	it('refuses a KSA organization even on a KSA node that finds it locally', async () => {
		process.env.DATA_REGION = 'ksa'
		const res = await post('/api/voice/actions/reservations.availability', {
			orgId: ORG_KSA,
			callId: '6f1d5e14-5ad5-4c9a-9ff0-6b6c3df9d5a1',
			input: availabilityInput(),
		})
		expect(res.status).toBe(404)
	})
})

describe('per-call caps', () => {
	it('allows 10 availability checks and answers the 11th with 429 (VAL-VOICE-004)', async () => {
		const callId = await startCall()
		for (let i = 0; i < 10; i++) {
			const ok = await action(
				'reservations.availability',
				callId,
				availabilityInput(),
			)
			expect(ok.status).toBe(200)
		}
		const over = await action(
			'reservations.availability',
			callId,
			availabilityInput(),
		)
		expect(over.status).toBe(429)
		expect(over.body).toMatchObject({ ok: false, reason: 'rate_limited' })
		// Another call is unaffected.
		const other = await startCall()
		expect(
			(await action('reservations.availability', other, availabilityInput()))
				.status,
		).toBe(200)
		const rows = await actionRows(callId)
		expect(rows).toHaveLength(10)
	})

	it('allows two holds per call and refuses the third', async () => {
		const callId = await startCall()
		const first = await action('reservations.hold', callId, {
			slot: slotInput('17:00'),
			partySize: 2,
			firstName: 'Sam',
		})
		const second = await action('reservations.hold', callId, {
			slot: slotInput('20:00'),
			partySize: 2,
			firstName: 'Sam',
		})
		const third = await action('reservations.hold', callId, {
			slot: slotInput('21:00'),
			partySize: 2,
			firstName: 'Sam',
		})
		expect([first.status, second.status, third.status]).toEqual([200, 200, 429])
		expect(first.body.ok && second.body.ok).toBe(true)
	})

	it('counts concurrent requests against the same cap', async () => {
		const callId = await startCall()
		const results = await Promise.all(
			['17:00', '18:00', '19:00', '20:00', '21:00'].map((time) =>
				action('reservations.hold', callId, {
					slot: slotInput(time),
					partySize: 2,
					firstName: 'Sam',
				}),
			),
		)
		expect(results.filter((r) => r.status === 200)).toHaveLength(2)
		expect(results.filter((r) => r.status === 429)).toHaveLength(3)
		expect(await actionRows(callId)).toHaveLength(2)
		expect((await holds()).filter((h) => h.status === 'active')).toHaveLength(
			results.filter((r) => r.status === 200 && r.body.ok).length,
		)
	})

	it('allows one direct booking per call (VAL-VOICE-004)', async () => {
		await setSettings({ voiceMode: 'confirm_on_call' })
		const callId = await startCall()
		const first = await action('reservations.book', callId, {
			slot: slotInput('18:00'),
			partySize: 2,
			firstName: 'Sam',
		})
		const second = await action('reservations.book', callId, {
			slot: slotInput('18:30'),
			partySize: 2,
			firstName: 'Sam',
		})
		expect([first.status, second.status]).toEqual([200, 429])
		expect(first.body.ok).toBe(true)
	})
})

describe('flags', () => {
	it('refuses every action while reservations.voice is off and writes nothing (VAL-VOICE-010)', async () => {
		seedReservationsContextForTest(ORG, voiceContext({ voice: false }))
		const callId = await startCall()
		const off = await action(
			'reservations.availability',
			callId,
			availabilityInput(),
		)
		expect(off.status).toBe(200)
		expect(off.body).toMatchObject({ ok: false, reason: 'not_enabled' })
		const hold = await action('reservations.hold', callId, {
			slot: slotInput(),
			partySize: 2,
			firstName: 'Sam',
		})
		expect(hold.body).toMatchObject({ ok: false, reason: 'not_enabled' })
		expect(await holds()).toEqual([])

		seedReservationsContextForTest(ORG, voiceContext({ voice: true }))
		const on = await action(
			'reservations.availability',
			callId,
			availabilityInput(),
		)
		expect(on.body.ok).toBe(true)
	})

	it('refuses everything when the module itself is off', async () => {
		const ctx = voiceContext()
		seedReservationsContextForTest(ORG, {
			...ctx,
			features: { ...ctx.features, enabled: false },
		})
		const callId = await startCall()
		const result = await action(
			'reservations.availability',
			callId,
			availabilityInput(),
		)
		expect(result.body).toMatchObject({ ok: false, reason: 'not_enabled' })
	})

	it('needs online booking for the hold link', async () => {
		seedReservationsContextForTest(ORG, voiceContext({ online: false }))
		const callId = await startCall()
		const result = await action('reservations.hold', callId, {
			slot: slotInput(),
			partySize: 2,
			firstName: 'Sam',
		})
		expect(result.body).toMatchObject({ ok: false, reason: 'not_enabled' })
		expect(await holds()).toEqual([])
	})
})

describe('test calls run dry', () => {
	it('answers availability, simulates the hold and still counts the action (VAL-VOICE-005)', async () => {
		const callId = await startCall({ channel: 'web_test', callerPhone: null })
		const slots = await action(
			'reservations.availability',
			callId,
			availabilityInput(),
		)
		expect(slots.body.ok).toBe(true)
		expect(slots.body.data.slots.length).toBeGreaterThan(0)
		expect(slots.body.data.simulated).toBe(true)

		const hold = await action('reservations.hold', callId, {
			slot: slotInput(),
			partySize: 2,
			firstName: 'Sam',
		})
		expect(hold.body).toMatchObject({
			ok: true,
			data: { held: true, simulated: true },
		})
		expect(hold.text).not.toContain('resumeFragment')
		expect(await holds()).toEqual([])
		expect(vi.mocked(sendSms)).not.toHaveBeenCalled()

		const rows = await actionRows(callId)
		expect(rows).toHaveLength(2)
		expect(rows.every((r) => r.dryRun === true)).toBe(true)
		const holdRow = rows.find((r) => r.action === 'reservations.hold')
		expect(holdRow?.outcome).toBe('ok')
	})

	it('simulates a direct booking without creating anything', async () => {
		await setSettings({ voiceMode: 'confirm_on_call' })
		const callId = await startCall({ channel: 'web_test', callerPhone: null })
		const result = await action('reservations.book', callId, {
			slot: slotInput(),
			partySize: 2,
			firstName: 'Sam',
		})
		expect(result.body).toMatchObject({ ok: true, data: { simulated: true } })
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvReservations).all()).toEqual([])
	})
})

describe('reservations.availability', () => {
	it('offers up to three of the slots the public engine offers, with slot fields only (VAL-VOICE-006)', async () => {
		const callId = await startCall()
		const result = await action(
			'reservations.availability',
			callId,
			availabilityInput(2, '19:10'),
		)
		expect(result.body.ok).toBe(true)
		const slots = result.body.data.slots as Array<Record<string, unknown>>
		expect(slots.length).toBeGreaterThan(0)
		expect(slots.length).toBeLessThanOrEqual(3)
		for (const slot of slots) {
			expect(Object.keys(slot).sort()).toEqual([
				'localTime',
				'partySizeFits',
				'requiresPayment',
			])
			expect(slot.partySizeFits).toBe(true)
			expect(slot.requiresPayment).toBe(false)
		}
		// Nearest to 19:10 first by distance, listed in time order.
		expect(slots.map((s) => s.localTime)).toEqual(['19:00', '19:15', '19:30'])

		const { getPublicAvailability, requireBookableLocation } =
			await import('../services/rsv-public-service.ts')
		const db = await getTenantDb(ORG)
		const location = await requireBookableLocation(
			db,
			voiceContext(),
			PUBLIC_LOC,
		)
		const publicDay = await getPublicAvailability(db, {
			locationId: PUBLIC_LOC,
			date: DAY,
			partySize: 2,
			location,
			features: voiceContext().features,
		})
		const offered = new Set(publicDay.slots.map((s) => s.time))
		for (const slot of slots)
			expect(offered.has(slot.localTime as string)).toBe(true)

		// No guest data anywhere in the payload.
		expect(result.text).not.toMatch(/phone|email|firstName|guest|name/i)
	})

	it('returns the earliest slots when no time is given and none when the day is full', async () => {
		const callId = await startCall()
		const open = await action('reservations.availability', callId, {
			date: DAY,
			partySize: 2,
		})
		expect(open.body.data.slots.map((s: any) => s.localTime)).toEqual([
			'17:00',
			'17:15',
			'17:30',
		])
		// No table seats 13.
		const tooBig = await action('reservations.availability', callId, {
			date: DAY,
			partySize: 13,
		})
		expect(tooBig.body).toMatchObject({ ok: false, reason: 'unavailable' })
	})

	it('marks slots that need a deposit', async () => {
		seedReservationsContextForTest(ORG, voiceContext({ payments: true }))
		const db = await getTenantDb(ORG)
		await db.insert(rsvPolicies).values({
			id: 'pol_deposit',
			locationId: PUBLIC_LOC,
			name: 'Deposit',
			kind: 'deposit',
			amountMinor: 1000,
			currency: 'USD',
		})
		await setSettings({ defaultPolicyId: 'pol_deposit' })
		const callId = await startCall()
		const result = await action(
			'reservations.availability',
			callId,
			availabilityInput(),
		)
		expect(result.body.data.slots.every((s: any) => s.requiresPayment)).toBe(
			true,
		)
	})

	it('never names guests in a day full of bookings and reports a full day as no slots', async () => {
		const callId = await startCall()
		const result = await action('reservations.availability', callId, {
			date: DAY,
			partySize: 4,
			time: '19:00',
		})
		expect(result.body.ok).toBe(true)
		expect(result.text).not.toContain('Pat')
	})

	it('never echoes rejected input', async () => {
		const callId = await startCall()
		const result = await action('reservations.availability', callId, {
			date: 'SECRET-DATE',
			partySize: 2,
		})
		expect(result.status).toBe(400)
		expect(result.text).not.toContain('SECRET-DATE')
		expect(result.body).toMatchObject({ ok: false, reason: 'invalid' })
		// Invalid input uses no cap.
		expect(await actionRows(callId)).toEqual([])
	})

	it('keeps the call to its own location', async () => {
		const callId = await startCall()
		const result = await action('reservations.availability', callId, {
			...availabilityInput(),
			locationId: 'loc_other',
		})
		expect(result.body).toMatchObject({ ok: false, reason: 'invalid' })
	})
})

describe('reservations.hold and the texted link', () => {
	async function holdOnce(callId: string, localTime = '19:00', partySize = 2) {
		return action('reservations.hold', callId, {
			slot: slotInput(localTime),
			partySize,
			firstName: 'Sam',
		})
	}

	it('takes a voice hold for the configured minutes and returns the link fragment only to the worker (VAL-VOICE-007)', async () => {
		await setSettings({ voiceHoldMinutes: 20 })
		const callId = await startCall()
		const before = Date.now()
		const result = await holdOnce(callId)
		expect(result.body.ok).toBe(true)
		expect(result.body.data.resumeFragment).toMatch(/^h=rsv_h_[\w-]+$/)
		expect(result.body.data.holdMinutes).toBe(20)
		const [hold] = await holds()
		expect(hold).toMatchObject({
			source: 'voice_agent',
			voiceCallId: callId,
			status: 'active',
			locationId: PUBLIC_LOC,
			partySize: 2,
		})
		expect(hold!.expiresAt - before).toBeGreaterThan(19 * 60_000)
		expect(hold!.expiresAt - before).toBeLessThan(21 * 60_000)
		// Only the hash is stored.
		expect(hold!.tokenHash).toBe(
			hashHoldToken(result.body.data.resumeFragment.slice(2)),
		)
		// No guest data in the response.
		expect(result.text).not.toContain(CALLER)
	})

	it('texts /reserve#h=<token> to the caller through the handoff route and refuses foreign fragments (VAL-VOICE-007)', async () => {
		const callId = await startCall()
		const result = await holdOnce(callId)
		const fragment = result.body.data.resumeFragment as string
		const send = (id: string, fragmentValue: string) =>
			post('/api/voice/handoffs', {
				orgId: ORG,
				callId: id,
				scopeId: PUBLIC_LOC,
				path: '/reserve',
				payload: {},
				fragment: fragmentValue,
				message: '{business}: confirm your table: {url}',
				sendTo: null,
			})
		const sent = await send(callId, fragment)
		expect(sent.status).toBe(201)
		const body = (await sent.json()) as { url: string; smsSent: boolean }
		expect(body.smsSent).toBe(true)
		expect(body.url).toMatch(/\/reserve#h=rsv_h_[\w-]+$/)
		const [call] = vi.mocked(sendSms).mock.calls
		expect(call![0]).toMatchObject({ to: CALLER })
		expect(call![0].message).toContain('/reserve#h=rsv_h_')

		// Another call cannot text this call's hold; made-up tokens are refused.
		const otherCall = await startCall()
		expect((await send(otherCall, fragment)).status).toBe(400)
		expect((await send(callId, 'h=rsv_h_notarealtoken0123456')).status).toBe(
			400,
		)
		expect((await send(callId, 'x=1')).status).toBe(400)
		expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(1)
	})

	it('lets the guest book the held slot once, as a voice-agent booking (VAL-VOICE-008)', async () => {
		const callId = await startCall()
		const held = await holdOnce(callId)
		const token = (held.body.data.resumeFragment as string).slice(2)
		const book = () =>
			bookFromHold({
				orgId: ORG,
				holdTokenHash: hashHoldToken(token),
				input: {
					guest: {
						firstName: 'Pat',
						lastName: 'Guest',
						phone: '+14155550999',
						email: 'pat@example.com',
						locale: 'en',
					},
					smsOptIn: false,
					marketing: false,
				},
				client: 'web',
				channel: 'online',
				customerId: null,
				ipHash: 'ip',
				idempotencyKey: 'key-1',
				requestHash: 'hash-1',
				context: voiceContext(),
			})
		const { reservationId } = await book()
		const db = await getTenantDb(ORG)
		const [reservation] = await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, reservationId))
		expect(reservation).toMatchObject({
			channel: 'voice_agent',
			voiceCallId: callId,
			status: 'booked',
		})
		expect(reservation!.holdId).toBeTruthy()
		const [hold] = await holds()
		expect(hold).toMatchObject({ status: 'converted', reservationId })
		// A second booking from the same hold is refused.
		await expect(
			bookFromHold({
				orgId: ORG,
				holdTokenHash: hashHoldToken(token),
				input: {
					guest: {
						firstName: 'Pat',
						lastName: 'Guest',
						phone: '+14155550998',
						email: null,
						locale: 'en',
					},
					smsOptIn: false,
					marketing: false,
				},
				client: 'web',
				channel: 'online',
				customerId: null,
				ipHash: 'ip',
				idempotencyKey: 'key-2',
				requestHash: 'hash-2',
				context: voiceContext(),
			}),
		).rejects.toMatchObject({ status: expect.any(Number) })
		expect(await db.select().from(rsvReservations).all()).toHaveLength(1)
	})

	it('lets exactly one of two calls hold the last table (VAL-VOICE-016)', async () => {
		const [first, second] = await Promise.all([startCall(), startCall()])
		// Only the 4-top seats a party of 4 (the 12-top starts at 5).
		const results = await Promise.all([
			holdOnce(first, '19:00', 4),
			holdOnce(second, '19:00', 4),
		])
		const ok = results.filter((r) => r.body.ok)
		const taken = results.filter((r) => !r.body.ok)
		expect(ok).toHaveLength(1)
		expect(taken).toHaveLength(1)
		expect(taken[0]!.body).toMatchObject({ ok: false, reason: 'conflict' })
		expect((await holds()).filter((h) => h.status === 'active')).toHaveLength(1)
	})

	it('refuses a time the engine does not offer', async () => {
		const callId = await startCall()
		const result = await holdOnce(callId, '03:00')
		expect(result.body).toMatchObject({ ok: false, reason: 'conflict' })
		expect(await holds()).toEqual([])
	})
})

describe('reservations.book (confirm on call)', () => {
	const bookInput = (extra: Record<string, unknown> = {}) => ({
		slot: slotInput(),
		partySize: 2,
		firstName: 'Sam',
		lastName: 'Lee',
		...extra,
	})

	it('is not enabled in the default hold-and-link mode (VAL-VOICE-009)', async () => {
		const callId = await startCall()
		const result = await action('reservations.book', callId, bookInput())
		expect(result.body).toMatchObject({ ok: false, reason: 'not_enabled' })
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvReservations).all()).toEqual([])
		expect(await holds()).toEqual([])
	})

	it('books with the caller number as an unverified contact and queues the confirmation (VAL-VOICE-009)', async () => {
		await setSettings({ voiceMode: 'confirm_on_call' })
		const callId = await startCall()
		const result = await action('reservations.book', callId, bookInput())
		expect(result.body).toMatchObject({ ok: true, data: { booked: true } })
		const db = await getTenantDb(ORG)
		const [reservation] = await db.select().from(rsvReservations).all()
		expect(reservation).toMatchObject({
			channel: 'voice_agent',
			voiceCallId: callId,
			status: 'booked',
			smsOptIn: true,
		})
		const [guest] = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, reservation!.guestId))
		expect(guest).toMatchObject({
			phoneE164: CALLER,
			customerId: null,
			marketingCustomerId: null,
		})
		const confirmations = await db
			.select()
			.from(rsvMessages)
			.where(
				and(
					eq(rsvMessages.reservationId, reservation!.id),
					eq(rsvMessages.kind, 'confirmation'),
				),
			)
			.all()
		expect(confirmations.length).toBeGreaterThan(0)
		expect(result.text).not.toContain(CALLER)
	})

	it('never takes a phone number from the model and needs a US caller number', async () => {
		await setSettings({ voiceMode: 'confirm_on_call' })
		const noNumber = await startCall({ callerPhone: null })
		const refused = await action(
			'reservations.book',
			noNumber,
			bookInput({ phone: '+14155550123' }),
		)
		expect(refused.body).toMatchObject({ ok: false, reason: 'invalid' })
		const foreign = await startCall({ callerPhone: '+442071234567' })
		expect(
			(await action('reservations.book', foreign, bookInput())).body,
		).toMatchObject({ ok: false, reason: 'invalid' })
		const db = await getTenantDb(ORG)
		expect(await db.select().from(rsvReservations).all()).toEqual([])
		expect(await holds()).toEqual([])
	})

	it('is refused while a payment policy applies, whatever the mode says', async () => {
		seedReservationsContextForTest(ORG, voiceContext({ payments: true }))
		await setSettings({ voiceMode: 'confirm_on_call' })
		const db = await getTenantDb(ORG)
		await db.insert(rsvPolicies).values({
			id: 'pol_dep2',
			locationId: PUBLIC_LOC,
			name: 'Deposit',
			kind: 'deposit',
			amountMinor: 1000,
			currency: 'USD',
		})
		await setSettings({ defaultPolicyId: 'pol_dep2' })
		const callId = await startCall()
		const result = await action('reservations.book', callId, bookInput())
		expect(result.body).toMatchObject({ ok: false, reason: 'not_enabled' })
		expect(await db.select().from(rsvReservations).all()).toEqual([])
		expect(await holds()).toEqual([])
	})

	it('releases the table when the booking is refused', async () => {
		await setSettings({ voiceMode: 'confirm_on_call', maxActivePerPhone: 1 })
		const first = await startCall()
		expect(
			(
				await action(
					'reservations.book',
					first,
					bookInput({ slot: slotInput('17:00') }),
				)
			).body.ok,
		).toBe(true)
		const second = await startCall()
		const again = await action(
			'reservations.book',
			second,
			bookInput({ slot: slotInput('20:00') }),
		)
		expect(again.body).toMatchObject({ ok: false, reason: 'rate_limited' })
		expect((await holds()).filter((h) => h.status === 'active')).toEqual([])
	})
})

describe('voice mode setting', () => {
	it('refuses confirm-on-call while a deposit or prepay policy applies and allows it otherwise (VAL-VOICE-009)', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvPolicies).values({
			id: 'pol_prepay',
			locationId: PUBLIC_LOC,
			name: 'Prepay',
			kind: 'prepay',
			amountMinor: 2500,
			currency: 'USD',
		})
		await db
			.update(rsvServices)
			.set({ policyId: 'pol_prepay' })
			.where(eq(rsvServices.id, 'svc_pub_dinner'))
		await expect(
			updateLocationSettings(db, ORG, PUBLIC_LOC, 'usr_1', {
				voiceMode: 'confirm_on_call',
			}),
		).rejects.toMatchObject({
			status: 400,
			details: { fields: ['voiceMode'] },
		})
		const [settings] = await db.select().from(rsvLocationSettings).all()
		expect(settings!.voiceMode).toBe('hold_link')

		await db
			.update(rsvServices)
			.set({ policyId: null })
			.where(eq(rsvServices.id, 'svc_pub_dinner'))
		await updateLocationSettings(db, ORG, PUBLIC_LOC, 'usr_1', {
			voiceMode: 'confirm_on_call',
		})
		const [after] = await db.select().from(rsvLocationSettings).all()
		expect(after!.voiceMode).toBe('confirm_on_call')
	})

	it('allows confirm-on-call with a policy that takes no money', async () => {
		const db = await getTenantDb(ORG)
		await db.insert(rsvPolicies).values({
			id: 'pol_none',
			locationId: PUBLIC_LOC,
			name: 'Terms only',
			kind: 'none',
			amountMinor: 0,
			currency: 'USD',
		})
		await setSettings({ defaultPolicyId: 'pol_none' })
		await updateLocationSettings(db, ORG, PUBLIC_LOC, 'usr_1', {
			voiceMode: 'confirm_on_call',
		})
		expect(
			(await db.select().from(rsvLocationSettings).all())[0]!.voiceMode,
		).toBe('confirm_on_call')
	})
})

describe('call cleanup', () => {
	it('removes the action log with the call', async () => {
		const callId = await startCall()
		await action('reservations.availability', callId, availabilityInput())
		const db = await getTenantDb(ORG)
		await db.run(sql`PRAGMA foreign_keys = ON`)
		await db.delete(voiceCalls).where(eq(voiceCalls.id, callId))
		expect(await actionRows(callId)).toEqual([])
	})
})

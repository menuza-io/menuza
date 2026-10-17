import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	type ReservationsScope,
} from '@repo/reservations'
import {
	destroyTenantDb,
	rsvAuditLog,
	rsvMessages,
	rsvMessageTexts,
	rsvReservationEvents,
	rsvReservations,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'

const sent = vi.hoisted(() => ({
	email: vi.fn(),
	sms: vi.fn(),
	orgs: new Map<string, unknown>(),
}))

vi.mock('../lib/tenant-email.ts', () => ({ sendTenantEmail: sent.email }))
vi.mock('@repo/sms', () => ({ sendSms: sent.sms }))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(
		async (id: string) => sent.orgs.get(id) ?? null,
	),
}))

import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import { TOGGLEABLE_MESSAGE_KINDS } from '../lib/reservations-messaging-settings.ts'
import { MESSAGE_NOTE_MAX_LENGTH } from '../services/rsv-message-settings-service.ts'
import {
	HOUR,
	insertGuest,
	insertReservation,
	messagesFor,
	setMessaging,
} from '../services/rsv-message-fixture.ts'
import {
	dateAhead,
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
} from './reservations-public-fixture.ts'
import { reservationsOperatorRoutes } from './reservations-operator.ts'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-msg-routes-'))
const OPERATOR_SECRET = 'test-messages-operator-secret-key-32-chars-minimum!!'
process.env.TENANT_DB_DIR = TEST_DIR
process.env.DATA_REGION = 'us'
process.env.TENANT_OPERATOR_TOKEN = OPERATOR_SECRET
process.env.AUTH_HMAC_SECRET = 'test-msg-routes-auth-hmac-secret-0123456789'
process.env.JWT_SECRET = 'test-msg-routes-customer-jwt-secret-123456'

const ORG = 'org_msg_routes'
const OTHER_LOC = 'loc_pub_second'
const USER = 'usr_msg_operator'
const SETUP = '/operator/reservations/setup'
const BOOK = '/operator/reservations/book'

const READ = RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS
const WRITE = RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION_SETTINGS

let db: TenantDatabase

function buildApp() {
	const app = new Hono()
	app.route('/operator/reservations', reservationsOperatorRoutes)
	return app
}

async function mint(
	options: {
		scope?: ReservationsScope
		grants?: string[]
		locationIds?: string[] | null
		impersonated?: boolean
	} = {},
) {
	const now = Math.floor(Date.now() / 1000)
	const scope = options.scope ?? 'setup'
	const defaults =
		scope === 'setup'
			? [READ, WRITE]
			: [
					RESERVATIONS_PERMISSIONS.READ_RESERVATION,
					RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
				]
	return new jose.SignJWT({
		role: 'operator',
		orgId: ORG,
		region: 'us',
		scope,
		grants: options.grants ?? defaults,
		locationIds: options.locationIds ?? null,
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			experiences: false,
			payments: false,
			voice: false,
		},
		impersonated: options.impersonated ?? false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })
		.setSubject(USER)
		.setIssuer(brand.shortName)
		.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 300)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

type Json = Record<string, any>

async function call(
	method: 'GET' | 'PUT' | 'POST',
	url: string,
	options: { token?: string | null; body?: unknown } = {},
) {
	const token = options.token === undefined ? await mint() : options.token
	const res = await buildApp().request(url, {
		method,
		headers: {
			...(token ? { Authorization: `Bearer ${token}` } : {}),
			...(options.body !== undefined
				? { 'Content-Type': 'application/json' }
				: {}),
		},
		body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
	})
	const text = await res.text()
	let json: Json = {}
	try {
		json = text ? (JSON.parse(text) as Json) : {}
	} catch {
		json = { raw: text }
	}
	return { status: res.status, json, text }
}

const getTexts = (options: Parameters<typeof call>[2] = {}, loc = PUBLIC_LOC) =>
	call('GET', `${SETUP}/message-texts?locationId=${loc}`, options)
const putTexts = (body: unknown, options: Parameters<typeof call>[2] = {}) =>
	call('PUT', `${SETUP}/message-texts`, { ...options, body })
const preview = (
	query: string,
	options: Parameters<typeof call>[2] = {},
	loc = PUBLIC_LOC,
) =>
	call(
		'GET',
		`${SETUP}/message-texts/preview?locationId=${loc}&${query}`,
		options,
	)

beforeEach(async () => {
	vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', 'true')
	vi.stubEnv('RESERVATIONS_SMS_ENABLED', 'true')
	sent.email.mockReset()
	sent.sms.mockReset()
	sent.email.mockResolvedValue({ status: 'success', data: { messageId: 'm' } })
	sent.sms.mockResolvedValue({ success: true, mock: true })
	sent.orgs.set(ORG, {
		id: ORG,
		slug: 'acme',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: 'Acme Bistro',
	})
	await destroyTenantDb(ORG).catch(() => undefined)
	resetReservationsContextCache()
	db = await seedPublicOrg(ORG, { seedContext: false })
	const base = publicContext(ORG)
	seedReservationsContextForTest(ORG, {
		...base,
		locations: [
			...base.locations,
			{
				...base.locations[0]!,
				id: OTHER_LOC,
				name: 'Acme Uptown',
				slug: 'uptown',
			},
		],
	})
})
afterEach(() => {
	vi.unstubAllEnvs()
})
afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('GET /setup/message-texts', () => {
	it('returns defaults for a location that never configured messages', async () => {
		const { status, json } = await getTexts()
		expect(status).toBe(200)
		expect(json).toMatchObject({
			ok: true,
			orgId: ORG,
			locationId: PUBLIC_LOC,
			version: 1,
			noteMaxLength: MESSAGE_NOTE_MAX_LENGTH,
			texts: [],
		})
		expect(json.messaging).toEqual({
			kinds: expect.any(Object),
			reminderHours: 24,
			reconfirmEnabled: false,
			reconfirmHours: 48,
			quietHours: { startMin: 21 * 60, endMin: 8 * 60 },
			smsEnabled: true,
		})
	})

	it('lists every toggleable kind in order with its switch and empty notes', async () => {
		const { json } = await getTexts()
		expect(json.kinds.map((k: Json) => k.kind)).toEqual([
			...TOGGLEABLE_MESSAGE_KINDS,
		])
		for (const entry of json.kinds as Json[]) {
			expect(entry.notes).toEqual({ en: '', ar: '' })
			expect(entry.enabled).toBe(entry.kind !== 'reconfirm_request')
		}
	})

	it('marks the waitlist kinds', async () => {
		const { json } = await getTexts()
		const waitlist = (json.kinds as Json[])
			.filter((k) => k.waitlist)
			.map((k) => k.kind)
		expect(waitlist.sort()).toEqual([
			'notify_available',
			'waitlist_joined',
			'waitlist_ready',
		])
	})

	it('reflects stored switches and notes', async () => {
		await setMessaging(db, { kinds: { reminder: false }, reminderHours: 36 })
		await db.insert(rsvMessageTexts).values({
			id: 'mt_1',
			locationId: PUBLIC_LOC,
			kind: 'confirmation',
			locale: 'ar',
			customNote: 'أهلاً بكم',
			updatedBy: USER,
			updatedAt: Date.now(),
		})
		const { json } = await getTexts()
		expect(json.messaging.reminderHours).toBe(36)
		const reminder = (json.kinds as Json[]).find((k) => k.kind === 'reminder')
		expect(reminder?.enabled).toBe(false)
		const confirmation = (json.kinds as Json[]).find(
			(k) => k.kind === 'confirmation',
		)
		expect(confirmation?.notes).toEqual({ en: '', ar: 'أهلاً بكم' })
		expect(json.texts).toEqual([
			expect.objectContaining({
				kind: 'confirmation',
				locale: 'ar',
				customNote: 'أهلاً بكم',
			}),
		])
	})

	it('keeps notes per location', async () => {
		await putTexts({
			locationId: PUBLIC_LOC,
			texts: [
				{ kind: 'confirmation', locale: 'en', customNote: 'Downtown note' },
			],
		})
		const other = await getTexts({}, OTHER_LOC)
		expect(other.status).toBe(200)
		expect(other.json.texts).toEqual([])
		expect(other.json.version).toBe(1)
	})

	it('accepts the snake_case location_id query', async () => {
		const res = await call(
			'GET',
			`${SETUP}/message-texts?location_id=${PUBLIC_LOC}`,
		)
		expect(res.status).toBe(200)
		expect(res.json.locationId).toBe(PUBLIC_LOC)
	})

	it('answers 400 when the location is missing', async () => {
		const res = await call('GET', `${SETUP}/message-texts`)
		expect(res.status).toBe(400)
		expect(res.json.error).toBe('invalid')
	})
})

describe('PUT /setup/message-texts: switches and timing', () => {
	it('stores a switch under its snake_case kind key and bumps the version', async () => {
		const { status, json } = await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { kinds: { cancellation_guest: false } },
		})
		expect(status).toBe(200)
		expect(json.version).toBe(2)
		const entry = (json.kinds as Json[]).find(
			(k) => k.kind === 'cancellation_guest',
		)
		expect(entry?.enabled).toBe(false)
		expect(json.messaging.kinds.cancellation_guest).toBe(false)
		expect(json.messaging.kinds.confirmation).toBe(true)
		const again = await getTexts()
		expect(again.json.messaging.kinds.cancellation_guest).toBe(false)
	})

	it('keeps every snake_case kind key intact through key normalization', async () => {
		const kinds = Object.fromEntries(
			TOGGLEABLE_MESSAGE_KINDS.map((k) => [k, false]),
		)
		const { status, json } = await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { kinds },
		})
		expect(status).toBe(200)
		for (const kind of TOGGLEABLE_MESSAGE_KINDS) {
			expect(json.messaging.kinds[kind]).toBe(false)
		}
	})

	it('merges switches with the ones already stored', async () => {
		await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { kinds: { confirmation: false } },
		})
		const { json } = await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { kinds: { modification: false } },
		})
		expect(json.messaging.kinds.confirmation).toBe(false)
		expect(json.messaging.kinds.modification).toBe(false)
	})

	it('accepts snake_case field names for timing and quiet hours', async () => {
		const { status, json } = await putTexts({
			location_id: PUBLIC_LOC,
			messaging: {
				reminder_hours: 48,
				quiet_hours: { start_min: 22 * 60, end_min: 7 * 60 },
				sms_enabled: false,
			},
		})
		expect(status).toBe(200)
		expect(json.messaging).toMatchObject({
			reminderHours: 48,
			quietHours: { startMin: 22 * 60, endMin: 7 * 60 },
			smsEnabled: false,
		})
	})

	it('turning reconfirmation on keeps the flag and its kind switch in agreement', async () => {
		const { json } = await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { reconfirmEnabled: true, reconfirmHours: 72 },
		})
		expect(json.messaging.reconfirmEnabled).toBe(true)
		expect(json.messaging.kinds.reconfirm_request).toBe(true)
		expect(json.messaging.reconfirmHours).toBe(72)
	})

	it('switching the reconfirm kind alone updates the flag too', async () => {
		await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { reconfirmEnabled: true },
		})
		const { json } = await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { kinds: { reconfirm_request: false } },
		})
		expect(json.messaging.reconfirmEnabled).toBe(false)
		expect(json.messaging.kinds.reconfirm_request).toBe(false)
	})

	it.each([
		['reminderHours 0', { reminderHours: 0 }],
		['reminderHours 169', { reminderHours: 169 }],
		['fractional reminderHours', { reminderHours: 1.5 }],
		['string reminderHours', { reminderHours: '24' }],
		['reconfirmHours 0', { reconfirmHours: 0 }],
		['quiet start 1440', { quietHours: { startMin: 1440, endMin: 480 } }],
		['quiet end negative', { quietHours: { startMin: 1260, endMin: -1 } }],
		['quiet hours missing end', { quietHours: { startMin: 1260 } }],
		['unknown kind', { kinds: { guest_complaint: true } }],
		['non-boolean switch', { kinds: { confirmation: 'yes' } }],
		['unknown messaging key', { surprise: true }],
	])('rejects %s with 400 and stores nothing', async (_name, messaging) => {
		const { status, json } = await putTexts({
			locationId: PUBLIC_LOC,
			messaging,
		})
		expect(status).toBe(400)
		expect(json.error).toBe('invalid')
		expect((await getTexts()).json.version).toBe(1)
	})

	it('rejects an unknown top-level key', async () => {
		const { status } = await putTexts({ locationId: PUBLIC_LOC, owner: 'x' })
		expect(status).toBe(400)
	})

	it('rejects a body that is not an object', async () => {
		const res = await call('PUT', `${SETUP}/message-texts`, { body: [1, 2] })
		expect(res.status).toBe(400)
	})

	it('rejects malformed JSON', async () => {
		const token = await mint()
		const res = await buildApp().request(`${SETUP}/message-texts`, {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: '{not json',
		})
		expect(res.status).toBe(400)
	})

	it('answers 400 when the location is missing', async () => {
		const { status } = await putTexts({ messaging: { reminderHours: 12 } })
		expect(status).toBe(400)
	})

	it('does not echo rejected input in the error', async () => {
		const { text } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [
				{ kind: 'confirmation', locale: 'en', customNote: 'x'.repeat(501) },
			],
		})
		expect(text).not.toContain('x'.repeat(50))
	})
})

describe('PUT /setup/message-texts: version check', () => {
	it('answers 409 stale_version with the current settings', async () => {
		await putTexts({ locationId: PUBLIC_LOC, messaging: { reminderHours: 12 } })
		const { status, json } = await putTexts({
			locationId: PUBLIC_LOC,
			expectedVersion: 1,
			messaging: { reminderHours: 99 },
		})
		expect(status).toBe(409)
		expect(json.error).toBe('stale_version')
		expect(json.version).toBe(2)
		expect(json.current.messaging.reminderHours).toBe(12)
		expect((await getTexts()).json.messaging.reminderHours).toBe(12)
	})

	it('applies the write when the version matches', async () => {
		const { status, json } = await putTexts({
			locationId: PUBLIC_LOC,
			expectedVersion: 1,
			messaging: { reminderHours: 12 },
		})
		expect(status).toBe(200)
		expect(json.version).toBe(2)
	})

	it('refuses an expectedVersion below 1', async () => {
		const { status } = await putTexts({
			locationId: PUBLIC_LOC,
			expectedVersion: 0,
		})
		expect(status).toBe(400)
	})

	it('a stale write leaves the notes alone too', async () => {
		await putTexts({ locationId: PUBLIC_LOC, messaging: { reminderHours: 12 } })
		await putTexts({
			locationId: PUBLIC_LOC,
			expectedVersion: 1,
			texts: [{ kind: 'confirmation', locale: 'en', customNote: 'lost' }],
		})
		expect((await getTexts()).json.texts).toEqual([])
	})

	it('an empty patch still succeeds and bumps the version', async () => {
		const { status, json } = await putTexts({ locationId: PUBLIC_LOC })
		expect(status).toBe(200)
		expect(json.version).toBe(2)
	})
})

describe('PUT /setup/message-texts: notes', () => {
	const note = (kind: string, locale: string, customNote: string) => ({
		kind,
		locale,
		customNote,
	})

	it('stores a note per kind and language', async () => {
		const { status, json } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [
				note('confirmation', 'en', 'See you soon'),
				note('confirmation', 'ar', 'نراكم قريباً'),
				note('reminder', 'en', 'Please bring ID'),
			],
		})
		expect(status).toBe(200)
		const confirmation = (json.kinds as Json[]).find(
			(k) => k.kind === 'confirmation',
		)
		expect(confirmation?.notes).toEqual({
			en: 'See you soon',
			ar: 'نراكم قريباً',
		})
		const reminder = (json.kinds as Json[]).find((k) => k.kind === 'reminder')
		expect(reminder?.notes).toEqual({ en: 'Please bring ID', ar: '' })
		expect(json.texts).toHaveLength(3)
	})

	it('replaces an existing note instead of adding a second row', async () => {
		await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'en', 'one')],
		})
		await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'en', 'two')],
		})
		const rows = await db.select().from(rsvMessageTexts).all()
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ customNote: 'two', updatedBy: USER })
	})

	it('trims the note', async () => {
		const { json } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'en', '   padded   ')],
		})
		expect(json.texts[0].customNote).toBe('padded')
	})

	it('an empty or blank note removes the stored one', async () => {
		await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'en', 'one'), note('reminder', 'en', 'two')],
		})
		const { status, json } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'en', ''), note('reminder', 'en', '   ')],
		})
		expect(status).toBe(200)
		expect(json.texts).toEqual([])
		expect(await db.select().from(rsvMessageTexts).all()).toHaveLength(0)
	})

	it('removing a note that does not exist is not an error', async () => {
		const { status } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'en', '')],
		})
		expect(status).toBe(200)
	})

	it('accepts a note of exactly the maximum length', async () => {
		const value = 'a'.repeat(MESSAGE_NOTE_MAX_LENGTH)
		const { status, json } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'en', value)],
		})
		expect(status).toBe(200)
		expect(json.texts[0].customNote).toBe(value)
	})

	it('rejects a note one character over the maximum', async () => {
		const { status } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [
				note('confirmation', 'en', 'a'.repeat(MESSAGE_NOTE_MAX_LENGTH + 1)),
			],
		})
		expect(status).toBe(400)
	})

	it('accepts new lines and tabs', async () => {
		const { status, json } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'en', 'Line one\nLine two\tend')],
		})
		expect(status).toBe(200)
		expect(json.texts[0].customNote).toBe('Line one\nLine two\tend')
	})

	it.each([
		['null byte', 'bad\u0000note'],
		['bell', 'bad\u0007note'],
		['escape', 'bad\u001bnote'],
		['vertical tab', 'bad\u000bnote'],
		['form feed', 'bad\u000cnote'],
		['delete', 'bad\u007fnote'],
	])('rejects a note with a %s control character', async (_name, value) => {
		const { status } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'en', value)],
		})
		expect(status).toBe(400)
		expect(await db.select().from(rsvMessageTexts).all()).toHaveLength(0)
	})

	it('rejects a kind that is not a guest message setting', async () => {
		for (const kind of ['payment_required', 'refund_issued', 'nonsense']) {
			const { status } = await putTexts({
				locationId: PUBLIC_LOC,
				texts: [note(kind, 'en', 'x')],
			})
			expect(status).toBe(400)
		}
	})

	it('rejects a language other than English or Arabic', async () => {
		const { status } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'fr', 'x')],
		})
		expect(status).toBe(400)
	})

	it('rejects extra keys on a note', async () => {
		const { status } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [{ ...note('confirmation', 'en', 'x'), html: true }],
		})
		expect(status).toBe(400)
	})

	it('rejects a non-string note', async () => {
		const { status } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [{ kind: 'confirmation', locale: 'en', customNote: 5 }],
		})
		expect(status).toBe(400)
	})

	it('rejects more notes than there are kind and language slots', async () => {
		const texts = Array.from(
			{ length: TOGGLEABLE_MESSAGE_KINDS.length * 2 + 1 },
			() => note('confirmation', 'en', 'x'),
		)
		const { status } = await putTexts({ locationId: PUBLIC_LOC, texts })
		expect(status).toBe(400)
	})

	it('applies nothing when one note in the batch is invalid', async () => {
		const { status } = await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { reminderHours: 12 },
			texts: [
				note('confirmation', 'en', 'fine'),
				note('reminder', 'en', 'bad\u0000'),
			],
		})
		expect(status).toBe(400)
		const after = await getTexts()
		expect(after.json.texts).toEqual([])
		expect(after.json.messaging.reminderHours).toBe(24)
		expect(after.json.version).toBe(1)
	})

	it('writes markup as plain text', async () => {
		const { status, json } = await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'en', '<script>alert(1)</script>')],
		})
		expect(status).toBe(200)
		expect(json.texts[0].customNote).toBe('<script>alert(1)</script>')
	})

	it('records which slots changed in the audit log, never the text', async () => {
		await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { reminderHours: 12 },
			texts: [note('confirmation', 'en', 'SECRET-NOTE-TEXT')],
		})
		const rows = await db
			.select()
			.from(rsvAuditLog)
			.where(eq(rsvAuditLog.action, 'messaging.update'))
			.all()
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			actorId: USER,
			locationId: PUBLIC_LOC,
			entityType: 'location_settings',
			entityId: PUBLIC_LOC,
		})
		expect(rows[0]!.changes).toMatchObject({
			version: 2,
			messaging: ['reminderHours'],
			texts: ['confirmation:en'],
		})
		expect(JSON.stringify(rows[0])).not.toContain('SECRET-NOTE-TEXT')
	})

	it('a note on one location does not appear on another', async () => {
		await putTexts({
			locationId: PUBLIC_LOC,
			texts: [note('confirmation', 'en', 'Downtown only')],
		})
		await putTexts({
			locationId: OTHER_LOC,
			texts: [note('confirmation', 'en', 'Uptown only')],
		})
		expect((await getTexts()).json.texts[0].customNote).toBe('Downtown only')
		expect((await getTexts({}, OTHER_LOC)).json.texts[0].customNote).toBe(
			'Uptown only',
		)
	})
})

describe('PUT /setup/message-texts: effect on upcoming reminders', () => {
	async function upcomingBooking() {
		const guest = await insertGuest(db, { emailNorm: 'rana@example.com' })
		const startAt = Date.parse(`${dateAhead(6)}T19:00:00Z`)
		const rsv = await insertReservation(db, { guestId: guest.id, startAt })
		return { rsv, startAt }
	}
	const reminders = async (id: string) =>
		(await messagesFor(db, id, 'reminder')).filter(
			(m) => m.status === 'pending',
		)

	it('creates the reminder when timing is saved', async () => {
		const { rsv, startAt } = await upcomingBooking()
		await putTexts({ locationId: PUBLIC_LOC, messaging: { reminderHours: 48 } })
		const live = await reminders(rsv.id)
		expect(live).toHaveLength(1)
		expect(live[0]!.sendAt).toBe(startAt - 48 * HOUR)
	})

	it('moves the reminder when the lead time changes', async () => {
		const { rsv, startAt } = await upcomingBooking()
		await putTexts({ locationId: PUBLIC_LOC, messaging: { reminderHours: 48 } })
		await putTexts({ locationId: PUBLIC_LOC, messaging: { reminderHours: 30 } })
		const live = await reminders(rsv.id)
		expect(live).toHaveLength(1)
		expect(live[0]!.sendAt).toBe(startAt - 30 * HOUR)
	})

	it('cancels the reminder when its kind is switched off', async () => {
		const { rsv } = await upcomingBooking()
		await putTexts({ locationId: PUBLIC_LOC, messaging: { reminderHours: 48 } })
		expect(await reminders(rsv.id)).toHaveLength(1)
		await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { kinds: { reminder: false } },
		})
		expect(await reminders(rsv.id)).toHaveLength(0)
	})

	it('adds reconfirmation requests when reconfirmation is turned on', async () => {
		const { rsv } = await upcomingBooking()
		await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { reconfirmEnabled: true, reconfirmHours: 72 },
		})
		expect(await messagesFor(db, rsv.id, 'reconfirm_request')).toHaveLength(1)
	})

	it('changing only a note does not touch reminders', async () => {
		const { rsv } = await upcomingBooking()
		await putTexts({
			locationId: PUBLIC_LOC,
			texts: [{ kind: 'reminder', locale: 'en', customNote: 'hello' }],
		})
		expect(await messagesFor(db, rsv.id)).toHaveLength(0)
	})

	it('leaves a booking at another location alone', async () => {
		const guest = await insertGuest(db, { emailNorm: 'rana@example.com' })
		const rsv = await insertReservation(db, {
			guestId: guest.id,
			locationId: OTHER_LOC,
			startAt: Date.parse(`${dateAhead(6)}T19:00:00Z`),
		})
		await putTexts({ locationId: PUBLIC_LOC, messaging: { reminderHours: 48 } })
		expect(await messagesFor(db, rsv.id)).toHaveLength(0)
	})

	it('does not send anything while saving', async () => {
		await upcomingBooking()
		await putTexts({ locationId: PUBLIC_LOC, messaging: { reminderHours: 48 } })
		expect(sent.email).not.toHaveBeenCalled()
		expect(sent.sms).not.toHaveBeenCalled()
	})
})

describe('GET /setup/message-texts/preview', () => {
	it('renders a sample email and SMS for a kind', async () => {
		const { status, json } = await preview('kind=confirmation&locale=en')
		expect(status).toBe(200)
		expect(json).toMatchObject({
			ok: true,
			orgId: ORG,
			sample: true,
			kind: 'confirmation',
			locale: 'en',
		})
		expect(json.subject).toContain('Acme Downtown')
		expect(json.html).toContain('Sam')
		expect(json.html).toContain('Acme Downtown')
		expect(typeof json.text).toBe('string')
		expect(json.sms).toContain('Acme Downtown')
	})

	it('renders Arabic right to left with the Arabic sample name', async () => {
		const { json } = await preview('kind=confirmation&locale=ar')
		expect(json.locale).toBe('ar')
		expect(json.html).toContain('dir="rtl"')
		expect(json.html).toContain('سارة')
	})

	it('falls back to English for an unknown language', async () => {
		const { status, json } = await preview('kind=confirmation&locale=fr')
		expect(status).toBe(200)
		expect(json.locale).toBe('en')
		expect(json.html).toContain('dir="ltr"')
	})

	it('defaults the language to English', async () => {
		const { json } = await preview('kind=confirmation')
		expect(json.locale).toBe('en')
	})

	it.each(TOGGLEABLE_MESSAGE_KINDS)(
		'renders %s in both languages',
		async (kind) => {
			for (const locale of ['en', 'ar']) {
				const { status, json } = await preview(`kind=${kind}&locale=${locale}`)
				expect(status).toBe(200)
				expect(json.subject.length).toBeGreaterThan(0)
				expect(json.html).toContain('<html')
				expect(json.sms.length).toBeGreaterThan(0)
			}
		},
	)

	it('shows only sample links, never a real manage token', async () => {
		const { json } = await preview('kind=confirmation&locale=en')
		expect(json.html).toContain('https://example.com/manage#sample')
		expect(json.html).not.toContain('rsv_m_')
		expect(json.sms).not.toContain('rsv_m_')
	})

	it('uses the same fixed sample time on every call', async () => {
		const a = await preview('kind=confirmation&locale=en')
		const b = await preview('kind=confirmation&locale=en')
		expect(a.json.html).toBe(b.json.html)
		expect(a.json.html).toContain('2031')
	})

	it('includes the saved note for that kind and language', async () => {
		await putTexts({
			locationId: PUBLIC_LOC,
			texts: [
				{
					kind: 'confirmation',
					locale: 'en',
					customNote: 'Valet parking is free',
				},
				{ kind: 'confirmation', locale: 'ar', customNote: 'الصف الأمامي' },
			],
		})
		const en = await preview('kind=confirmation&locale=en')
		expect(en.json.html).toContain('Valet parking is free')
		expect(en.json.text).toContain('Valet parking is free')
		expect(en.json.html).not.toContain('الصف الأمامي')
		const ar = await preview('kind=confirmation&locale=ar')
		expect(ar.json.html).toContain('الصف الأمامي')
		expect(ar.json.html).toContain('dir="rtl"')
		expect(ar.json.html).not.toContain('Valet parking is free')
	})

	it('does not show a note saved for a different kind', async () => {
		await putTexts({
			locationId: PUBLIC_LOC,
			texts: [{ kind: 'reminder', locale: 'en', customNote: 'Reminder only' }],
		})
		const { json } = await preview('kind=confirmation&locale=en')
		expect(json.html).not.toContain('Reminder only')
	})

	it('escapes a note that contains markup', async () => {
		await putTexts({
			locationId: PUBLIC_LOC,
			texts: [
				{
					kind: 'confirmation',
					locale: 'en',
					customNote: '<b>bold</b> & <img src=x>',
				},
			],
		})
		const { json } = await preview('kind=confirmation&locale=en')
		expect(json.html).not.toContain('<b>bold</b>')
		expect(json.html).not.toContain('<img src=x>')
		expect(json.html).toContain('&lt;b&gt;bold&lt;/b&gt;')
	})

	it('falls back to an organization-wide note when the location has none', async () => {
		await db.insert(rsvMessageTexts).values({
			id: 'mt_org',
			locationId: null,
			kind: 'confirmation',
			locale: 'en',
			customNote: 'Organization wide note',
			updatedBy: USER,
			updatedAt: Date.now(),
		})
		const { json } = await preview('kind=confirmation&locale=en')
		expect(json.html).toContain('Organization wide note')
	})

	it('prefers the location note over the organization-wide one', async () => {
		await db.insert(rsvMessageTexts).values({
			id: 'mt_org',
			locationId: null,
			kind: 'confirmation',
			locale: 'en',
			customNote: 'Organization wide note',
			updatedBy: USER,
			updatedAt: Date.now(),
		})
		await putTexts({
			locationId: PUBLIC_LOC,
			texts: [
				{ kind: 'confirmation', locale: 'en', customNote: 'Location note' },
			],
		})
		const { json } = await preview('kind=confirmation&locale=en')
		expect(json.html).toContain('Location note')
		expect(json.html).not.toContain('Organization wide note')
	})

	it("uses the location's own name", async () => {
		const { json } = await preview('kind=confirmation&locale=en', {}, OTHER_LOC)
		expect(json.subject).toContain('Acme Uptown')
	})

	it('previews a kind even when it is switched off', async () => {
		await putTexts({
			locationId: PUBLIC_LOC,
			messaging: { kinds: { confirmation: false } },
		})
		const { status } = await preview('kind=confirmation&locale=en')
		expect(status).toBe(200)
	})

	it.each([
		['missing kind', 'locale=en'],
		['empty kind', 'kind=&locale=en'],
		['unknown kind', 'kind=nonsense'],
		['a payment kind', 'kind=payment_required'],
		['a legacy kind', 'kind=reminder_24h'],
	])('answers 400 for %s', async (_name, query) => {
		const { status, json } = await preview(query)
		expect(status).toBe(400)
		expect(json.error).toBe('invalid')
		expect(json.fields).toContain('kind')
	})

	it('answers 400 when the location is missing', async () => {
		const res = await call(
			'GET',
			`${SETUP}/message-texts/preview?kind=confirmation`,
		)
		expect(res.status).toBe(400)
	})

	it('sends nothing and queues nothing', async () => {
		await preview('kind=confirmation&locale=en')
		expect(sent.email).not.toHaveBeenCalled()
		expect(sent.sms).not.toHaveBeenCalled()
		expect(await db.select().from(rsvMessages).all()).toHaveLength(0)
	})

	it('is not shadowed by the message-texts route', async () => {
		const res = await preview('kind=confirmation&locale=en')
		expect(res.json.settings).toBeUndefined()
		expect(res.json.html).toBeDefined()
	})
})

describe('message-texts access control', () => {
	const readOnly = () => mint({ grants: [READ] })

	it('refuses a missing token on every route', async () => {
		for (const res of [
			await getTexts({ token: null }),
			await putTexts({ locationId: PUBLIC_LOC }, { token: null }),
			await preview('kind=confirmation', { token: null }),
		]) {
			expect(res.status).toBe(401)
		}
	})

	it('refuses a forged token on every route', async () => {
		const forged = await new jose.SignJWT({
			role: 'operator',
			orgId: ORG,
			region: 'us',
			scope: 'setup',
			grants: [READ, WRITE],
			locationIds: null,
			features: { enabled: true },
			impersonated: false,
		})
			.setProtectedHeader({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })
			.setSubject(USER)
			.setIssuer(brand.shortName)
			.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(
				new TextEncoder().encode(
					'some-other-secret-that-is-long-enough-0123456789',
				),
			)
		for (const res of [
			await getTexts({ token: forged }),
			await putTexts({ locationId: PUBLIC_LOC }, { token: forged }),
			await preview('kind=confirmation', { token: forged }),
		]) {
			expect(res.status).toBe(401)
		}
	})

	it('refuses a token for a different scope', async () => {
		const token = await mint({
			scope: 'guests',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST],
		})
		for (const res of [
			await getTexts({ token }),
			await putTexts({ locationId: PUBLIC_LOC }, { token }),
			await preview('kind=confirmation', { token }),
		]) {
			expect(res.status).toBe(403)
		}
	})

	it('refuses a token with no settings grant', async () => {
		const token = await mint({ grants: [] })
		for (const res of [
			await getTexts({ token }),
			await putTexts({ locationId: PUBLIC_LOC }, { token }),
			await preview('kind=confirmation', { token }),
		]) {
			expect(res.status).toBe(403)
		}
	})

	it('lets a read-only grant read and preview but not write', async () => {
		const token = await readOnly()
		expect((await getTexts({ token })).status).toBe(200)
		expect((await preview('kind=confirmation', { token })).status).toBe(200)
		const put = await putTexts(
			{ locationId: PUBLIC_LOC, messaging: { reminderHours: 5 } },
			{ token },
		)
		expect(put.status).toBe(403)
		expect((await getTexts()).json.messaging.reminderHours).toBe(24)
	})

	it('treats the write grant as implying the read grant', async () => {
		const token = await mint({ grants: [WRITE] })
		expect((await getTexts({ token })).status).toBe(200)
		expect((await preview('kind=confirmation', { token })).status).toBe(200)
		expect((await putTexts({ locationId: PUBLIC_LOC }, { token })).status).toBe(
			200,
		)
	})

	it('lets an impersonating session read and preview but never write', async () => {
		const token = await mint({ impersonated: true, grants: [READ] })
		expect((await getTexts({ token })).status).toBe(200)
		expect((await preview('kind=confirmation', { token })).status).toBe(200)
		const put = await putTexts(
			{ locationId: PUBLIC_LOC, messaging: { reminderHours: 5 } },
			{ token },
		)
		expect(put.status).toBe(403)
		expect(put.json.error).toBe('impersonated_read_only')
		expect((await getTexts()).json.version).toBe(1)
	})

	it('keeps a location-limited token to its own locations', async () => {
		const token = await mint({ locationIds: [OTHER_LOC] })
		expect((await getTexts({ token }, OTHER_LOC)).status).toBe(200)
		expect((await getTexts({ token }, PUBLIC_LOC)).status).toBe(403)
		expect(
			(await preview('kind=confirmation', { token }, PUBLIC_LOC)).status,
		).toBe(403)
		expect(
			(await preview('kind=confirmation', { token }, OTHER_LOC)).status,
		).toBe(200)
	})

	it('refuses a write to another location named in the body, before validating the rest', async () => {
		const token = await mint({ locationIds: [OTHER_LOC] })
		const res = await putTexts(
			{ locationId: PUBLIC_LOC, messaging: { reminderHours: 999 } },
			{ token },
		)
		expect(res.status).toBe(403)
		expect((await getTexts()).json.version).toBe(1)
	})

	it('lets a location-limited token write to its own location', async () => {
		const token = await mint({ locationIds: [OTHER_LOC] })
		const res = await putTexts(
			{ locationId: OTHER_LOC, messaging: { reminderHours: 12 } },
			{ token },
		)
		expect(res.status).toBe(200)
		expect((await getTexts({}, OTHER_LOC)).json.messaging.reminderHours).toBe(
			12,
		)
		expect((await getTexts()).json.messaging.reminderHours).toBe(24)
	})

	it('refuses a request that names another organization', async () => {
		const token = await mint()
		const res = await buildApp().request(
			`${SETUP}/message-texts?locationId=${PUBLIC_LOC}&orgId=org_someone_else`,
			{ headers: { Authorization: `Bearer ${token}` } },
		)
		expect(res.status).toBe(403)
	})
})

describe('POST /book/reservations/:id/resend', () => {
	const BOOK_GRANTS = [
		RESERVATIONS_PERMISSIONS.READ_RESERVATION,
		RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
	]
	const bookToken = (options: Parameters<typeof mint>[0] = {}) =>
		mint({ scope: 'book', grants: BOOK_GRANTS, ...options })
	const resend = async (
		id: string,
		body?: unknown,
		options: Parameters<typeof call>[2] = {},
		query = '',
	) =>
		call('POST', `${BOOK}/reservations/${id}/resend${query}`, {
			token: options.token === undefined ? await bookToken() : options.token,
			body: body ?? {},
		})

	async function booking(
		guest: Parameters<typeof insertGuest>[1] = {},
		reservation: Partial<Parameters<typeof insertReservation>[1]> = {},
	) {
		const g = await insertGuest(db, { emailNorm: 'rana@example.com', ...guest })
		return insertReservation(db, {
			guestId: g.id,
			startAt: Date.parse(`${dateAhead(4)}T19:00:00Z`),
			...reservation,
		})
	}

	it('queues a confirmation, sends it and returns the booking', async () => {
		const rsv = await booking()
		const { status, json } = await resend(rsv.id)
		expect(status).toBe(200)
		expect(json).toMatchObject({
			ok: true,
			orgId: ORG,
			queued: 1,
			rotated: false,
			reservation: { id: rsv.id },
		})
		expect(sent.email).toHaveBeenCalledTimes(1)
		expect(sent.email.mock.calls[0]![0]).toMatchObject({
			to: 'rana@example.com',
		})
		const [row] = await messagesFor(db, rsv.id, 'confirmation')
		expect(row).toMatchObject({ status: 'sent', channel: 'email' })
	})

	it('rotating invalidates the old link and reports it', async () => {
		const rsv = await booking()
		const { status, json } = await resend(rsv.id, { rotate: true })
		expect(status).toBe(200)
		expect(json.rotated).toBe(true)
		const after = (await db
			.select()
			.from(rsvReservations)
			.where(eq(rsvReservations.id, rsv.id))
			.get())!
		expect(after.manageTokenVersion).toBe(rsv.manageTokenVersion + 1)
		const event = (
			await db
				.select()
				.from(rsvReservationEvents)
				.where(eq(rsvReservationEvents.reservationId, rsv.id))
				.all()
		).find((e) => e.type === 'confirmation_resent')
		expect(event).toMatchObject({
			actorId: USER,
			data: { rotated: true, messages: 1 },
		})
	})

	it('treats a missing body as no rotation', async () => {
		const rsv = await booking()
		const token = await bookToken()
		const res = await buildApp().request(
			`${BOOK}/reservations/${rsv.id}/resend`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: '{}',
			},
		)
		expect(res.status).toBe(200)
		expect((await res.json()) as Json).toMatchObject({ rotated: false })
	})

	it('rejects a non-boolean rotate', async () => {
		const rsv = await booking()
		const { status } = await resend(rsv.id, { rotate: 'yes' })
		expect(status).toBe(400)
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('answers 409 invalid_state_for_resend for a cancelled booking', async () => {
		const rsv = await booking({}, { status: 'cancelled' })
		const { status, json } = await resend(rsv.id)
		expect(status).toBe(409)
		expect(json.error).toBe('invalid_state_for_resend')
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('answers 409 no_destination for a guest with no contact', async () => {
		const rsv = await booking({ emailNorm: null, phoneE164: null })
		const { status, json } = await resend(rsv.id)
		expect(status).toBe(409)
		expect(json.error).toBe('no_destination')
	})

	it('answers 404 for an unknown reservation', async () => {
		const { status } = await resend('rsv_missing')
		expect(status).toBe(404)
	})

	it('sends even when confirmations are switched off', async () => {
		await setMessaging(db, { kinds: { confirmation: false } })
		const rsv = await booking()
		const { status, json } = await resend(rsv.id)
		expect(status).toBe(200)
		expect(json.queued).toBe(1)
	})

	it('also texts a guest who opted in', async () => {
		const rsv = await booking({ phoneE164: '+12125550123' }, { smsOptIn: true })
		const { json } = await resend(rsv.id)
		expect(json.queued).toBe(2)
		expect(sent.sms).toHaveBeenCalledTimes(1)
	})

	it('refuses a missing token', async () => {
		const rsv = await booking()
		expect((await resend(rsv.id, {}, { token: null })).status).toBe(401)
	})

	it('refuses the wrong scope', async () => {
		const rsv = await booking()
		const token = await mint({
			scope: 'guests',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST],
		})
		const { status, json } = await resend(rsv.id, {}, { token })
		expect(status).toBe(403)
		expect(json.error).toBe('invalid_scope')
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('refuses a read-only grant', async () => {
		const rsv = await booking()
		const token = await bookToken({
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION],
		})
		expect((await resend(rsv.id, {}, { token })).status).toBe(403)
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('refuses an impersonating session', async () => {
		const rsv = await booking()
		const token = await bookToken({
			impersonated: true,
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION],
		})
		const { status, json } = await resend(rsv.id, {}, { token })
		expect(status).toBe(403)
		expect(json.error).toBe('impersonated_read_only')
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('refuses a token limited to another location', async () => {
		const rsv = await booking()
		const token = await bookToken({ locationIds: [OTHER_LOC] })
		const { status } = await resend(rsv.id, {}, { token })
		expect(status).toBe(403)
		expect(sent.email).not.toHaveBeenCalled()
		expect(await messagesFor(db, rsv.id)).toHaveLength(0)
	})

	it("judges access by the booking's own location, not by one named in the body", async () => {
		const rsv = await booking()
		const token = await bookToken({ locationIds: [OTHER_LOC] })
		const { status } = await resend(
			rsv.id,
			{ locationId: OTHER_LOC },
			{ token },
		)
		expect(status).toBe(403)
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('ignores a body location that differs from the booking for a token that may see both', async () => {
		const rsv = await booking()
		const { status } = await resend(rsv.id, { locationId: OTHER_LOC })
		expect(status).toBe(200)
	})

	it('a resend moments apart queues two separate messages', async () => {
		const rsv = await booking()
		await resend(rsv.id)
		await new Promise((resolve) => setTimeout(resolve, 5))
		await resend(rsv.id)
		expect(await messagesFor(db, rsv.id, 'confirmation')).toHaveLength(2)
		expect(sent.email).toHaveBeenCalledTimes(2)
	})
})

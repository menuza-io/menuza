import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	rsvMessages,
	rsvMessageTexts,
	rsvOutbox,
	rsvReservations,
	rsvWaitlistEntries,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
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
}))

vi.mock('../lib/tenant-email.ts', () => ({ sendTenantEmail: sent.email }))
vi.mock('@repo/sms', () => ({ sendSms: sent.sms }))

import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../lib/reservations-context.ts'
import {
	deriveManageToken,
	deriveNotifyToken,
	deriveWaitlistToken,
} from '../lib/reservations-public-auth.ts'
import {
	PUBLIC_LOC,
	publicContext,
	seedPublicOrg,
} from '../routes/reservations-public-fixture.ts'
import {
	BULK_FAILURE_THRESHOLD,
	BULK_FAILURE_WINDOW_MS,
	DELIVER_BATCH_LIMIT,
	deliverDueMessages,
	deliverMessagesByIds,
	nextMessageDueAt,
	RETRY_BACKOFF_MIN,
} from './rsv-message-service.ts'
import {
	getMessage,
	HOUR,
	insertGuest,
	insertMessageRow,
	insertNotifyRequest,
	insertReservation,
	insertWaitlistEntry,
	MINUTE,
	NOW,
} from './rsv-message-fixture.ts'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-msg-service-'))
process.env.TENANT_DB_DIR = TEST_DIR
process.env.AUTH_HMAC_SECRET = 'test-msg-service-auth-hmac-secret-0123456789'
process.env.JWT_SECRET = 'test-msg-service-customer-jwt-secret-123456'

const ORG = 'org_msg_service'
const SITE = 'https://acme.menuza.test'

let db: TenantDatabase

function region(value: 'us' | 'ksa') {
	process.env.DATA_REGION = value
}

function setContext(
	patch: {
		enabled?: boolean
		online?: boolean
		waitlist?: boolean
		locales?: string[]
	} = {},
) {
	const base = publicContext(ORG)
	seedReservationsContextForTest(ORG, {
		...base,
		features: {
			...base.features,
			enabled: patch.enabled ?? true,
			online: patch.online ?? true,
			waitlist: patch.waitlist ?? true,
		},
		organization: {
			...base.organization,
			locales: patch.locales ?? base.organization.locales,
		},
	})
}

const deliver = (now = NOW, limit?: number) =>
	deliverDueMessages(ORG, { db, now, limit })

async function booking(
	patch: Parameters<typeof insertReservation>[1] extends infer P
		? Partial<Omit<P & object, 'guestId'>>
		: never = {},
	guestPatch: Parameters<typeof insertGuest>[1] = {},
) {
	const guest = await insertGuest(db, guestPatch)
	const rsv = await insertReservation(db, { guestId: guest.id, ...patch })
	return { guest, rsv }
}

function emailRow(
	reservationId: string,
	kind: Parameters<typeof insertMessageRow>[1]['kind'] = 'confirmation',
	patch: Partial<typeof rsvMessages.$inferInsert> = {},
	milestone: string | number = 1,
) {
	return insertMessageRow(db, {
		kind,
		reservationId,
		dedupeKey: `res:${reservationId}:${kind}:${patch.channel ?? 'email'}:${milestone}:${Math.random()}`,
		...patch,
	})
}

/** A scheduled row keyed the way the queue keys it, so the schedule-version check can match. */
function scheduledRow(
	reservationId: string,
	kind: 'reminder' | 'reconfirm_request',
	version = 1,
	patch: Partial<typeof rsvMessages.$inferInsert> = {},
) {
	return insertMessageRow(db, {
		kind,
		reservationId,
		dedupeKey: `res:${reservationId}:${kind}:${patch.channel ?? 'email'}:${version}`,
		...patch,
	})
}

async function outboxRows() {
	return db.select().from(rsvOutbox).all()
}

beforeEach(async () => {
	region('us')
	vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', 'true')
	vi.stubEnv('RESERVATIONS_SMS_ENABLED', 'true')
	sent.email.mockReset()
	sent.sms.mockReset()
	sent.email.mockResolvedValue({ status: 'success', data: { messageId: 'm' } })
	sent.sms.mockResolvedValue({ success: true, mock: true })
	await destroyTenantDb(ORG).catch(() => undefined)
	resetReservationsContextCache()
	db = await seedPublicOrg(ORG)
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('sending an email', () => {
	it('renders with the organization theme, location facts and a manage link carrying its token in the fragment', async () => {
		const { rsv } = await booking(
			{ guestLocale: 'en' },
			{ emailNorm: 'rana@example.com' },
		)
		const row = await emailRow(rsv.id, 'confirmation')
		const totals = await deliver()
		expect(totals).toMatchObject({ sent: 1, failed: 0, retried: 0 })
		expect(sent.email).toHaveBeenCalledTimes(1)
		const mail = sent.email.mock.calls[0]![0]
		expect(mail.to).toBe('rana@example.com')
		expect(mail.subject).toBe('Your reservation at Acme Downtown is confirmed')
		const token = deriveManageToken(ORG, rsv.id, rsv.manageTokenVersion)
		expect(mail.html).toContain(`href="${SITE}/reserve/manage#t=${token}"`)
		expect(mail.html).not.toContain(`?t=${token}`)
		expect(mail.html).not.toContain(`/${token}`)
		expect(mail.html).toContain('100 Main St, New York')
		expect(mail.html).toContain('Add to calendar')
		expect(mail.html).toContain('background:#f9fafb')
		expect(mail.text).toContain('Acme Downtown')
		expect(mail.capture).toEqual({
			orgId: ORG,
			messageKind: 'confirmation',
			messageId: row.id,
		})
		expect(await getMessage(db, row.id)).toMatchObject({
			status: 'sent',
			attempts: 1,
			sentAt: NOW,
			lastErrorCode: null,
		})
	})

	it('renders Arabic right to left from the row locale and prefixes the site path when the organization has the locale', async () => {
		setContext({ locales: ['en', 'ar'] })
		const { rsv } = await booking()
		await emailRow(rsv.id, 'confirmation', { locale: 'ar' })
		await deliver()
		const mail = sent.email.mock.calls[0]![0]
		expect(mail.html).toContain('<html lang="ar" dir="rtl">')
		const token = deriveManageToken(ORG, rsv.id, rsv.manageTokenVersion)
		expect(mail.html).toContain(`href="${SITE}/ar/reserve/manage#t=${token}"`)
	})

	it('uses the unprefixed site for a locale the organization does not publish', async () => {
		const { rsv } = await booking()
		await emailRow(rsv.id, 'confirmation', { locale: 'ar' })
		await deliver()
		const mail = sent.email.mock.calls[0]![0]
		expect(mail.html).toContain('dir="rtl"')
		expect(mail.html).toContain(`href="${SITE}/reserve/manage#t=`)
	})

	it('shows the time in the reservation time zone', async () => {
		const start = Date.UTC(2031, 5, 13, 19, 0)
		const { rsv } = await booking({
			startAt: start,
			timeZone: 'America/New_York',
		})
		await emailRow(rsv.id, 'confirmation')
		await deliver()
		expect(sent.email.mock.calls[0]![0].html).toMatch(/3:00\s?PM/)
	})

	it('includes the location custom note, escaped, in the guest language only', async () => {
		const { rsv } = await booking()
		await db.insert(rsvMessageTexts).values([
			{
				id: 'txt_en',
				locationId: PUBLIC_LOC,
				kind: 'confirmation',
				locale: 'en',
				customNote: 'Park behind <b>the</b> building',
			},
			{
				id: 'txt_ar',
				locationId: PUBLIC_LOC,
				kind: 'confirmation',
				locale: 'ar',
				customNote: 'اركن خلف المبنى',
			},
		])
		await emailRow(rsv.id, 'confirmation')
		await deliver()
		const html = sent.email.mock.calls[0]![0].html as string
		expect(html).toContain('Park behind &lt;b&gt;the&lt;/b&gt; building')
		expect(html).not.toContain('<b>the</b>')
		expect(html).not.toContain('اركن')
	})

	it('prefers the location note over an organization-wide one and ignores a blank note', async () => {
		const { rsv } = await booking()
		await db.insert(rsvMessageTexts).values([
			{
				id: 'org_note',
				locationId: null,
				kind: 'confirmation',
				locale: 'en',
				customNote: 'Org wide note',
			},
			{
				id: 'loc_note',
				locationId: PUBLIC_LOC,
				kind: 'confirmation',
				locale: 'en',
				customNote: 'Location note',
			},
		])
		await emailRow(rsv.id, 'confirmation')
		await deliver()
		const html = sent.email.mock.calls[0]![0].html as string
		expect(html).toContain('Location note')
		expect(html).not.toContain('Org wide note')

		await db
			.update(rsvMessageTexts)
			.set({ customNote: '   ' })
			.where(eq(rsvMessageTexts.id, 'loc_note'))
		await emailRow(rsv.id, 'modification')
		await deliver()
		// A blank location note falls through to the organization-wide note for that kind only.
		expect(sent.email.mock.calls[1]![0].html).not.toContain('Org wide note')
		await emailRow(rsv.id, 'cancellation_guest')
		await db.insert(rsvMessageTexts).values({
			id: 'org_cg',
			locationId: null,
			kind: 'cancellation_guest',
			locale: 'en',
			customNote: 'Org cancellation note',
		})
		await db
			.update(rsvReservations)
			.set({ status: 'cancelled' })
			.where(eq(rsvReservations.id, rsv.id))
		await deliver()
		expect(sent.email.mock.calls[2]![0].html).toContain('Org cancellation note')
	})

	it('treats a failed provider result as a retryable error with a plain code', async () => {
		const { rsv } = await booking()
		const row = await emailRow(rsv.id, 'confirmation')
		sent.email.mockResolvedValue({
			status: 'error',
			error: {
				message: 'smtp auth failed for user@example.com',
				statusCode: 535,
			},
		})
		const totals = await deliver()
		expect(totals.retried).toBe(1)
		const after = await getMessage(db, row.id)
		expect(after).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastErrorCode: 'email_failed',
			nextAttemptAt: NOW + MINUTE,
		})
		expect(JSON.stringify(after)).not.toContain('smtp auth')
		expect(JSON.stringify(after)).not.toContain('user@example.com')
	})
})

describe('sending an SMS', () => {
	it('texts the guest phone with the restaurant name and the manage link, and sends no email', async () => {
		const { rsv } = await booking(
			{ smsOptIn: true },
			{ phoneE164: '+14155550101' },
		)
		const row = await emailRow(rsv.id, 'confirmation', { channel: 'sms' })
		const totals = await deliver()
		expect(totals.sent).toBe(1)
		expect(sent.email).not.toHaveBeenCalled()
		expect(sent.sms).toHaveBeenCalledTimes(1)
		const call = sent.sms.mock.calls[0]![0]
		expect(call.to).toBe('+14155550101')
		expect(call.message).toContain('Acme Downtown')
		const token = deriveManageToken(ORG, rsv.id, rsv.manageTokenVersion)
		expect(call.message).toContain(`${SITE}/reserve/manage#t=${token}`)
		expect((await getMessage(db, row.id)).status).toBe('sent')
	})

	it('leaves the link out of a restaurant-side cancellation text', async () => {
		const { rsv } = await booking(
			{ smsOptIn: true },
			{ phoneE164: '+14155550101' },
		)
		await emailRow(rsv.id, 'cancellation_restaurant', { channel: 'sms' })
		await deliver()
		expect(sent.sms.mock.calls[0]![0].message).not.toContain('https://')
	})

	it('suppresses an SMS row when consent is gone, without sending', async () => {
		const { rsv } = await booking(
			{ smsOptIn: false },
			{ phoneE164: '+14155550102' },
		)
		const row = await emailRow(rsv.id, 'confirmation', { channel: 'sms' })
		const totals = await deliver()
		expect(totals.suppressed).toBe(1)
		expect(sent.sms).not.toHaveBeenCalled()
		expect(await getMessage(db, row.id)).toMatchObject({
			status: 'suppressed',
			lastErrorCode: 'no_sms_consent',
		})
	})

	it('suppresses an SMS row when the guest has no phone any more', async () => {
		const { rsv } = await booking({ smsOptIn: true }, { phoneE164: null })
		const row = await emailRow(rsv.id, 'confirmation', { channel: 'sms' })
		await deliver()
		expect(sent.sms).not.toHaveBeenCalled()
		expect((await getMessage(db, row.id)).lastErrorCode).toBe('no_sms_consent')
	})

	it('suppresses every SMS row on the KSA node and never reaches the provider', async () => {
		region('ksa')
		const { rsv } = await booking(
			{ smsOptIn: true },
			{ phoneE164: '+966555000111' },
		)
		const row = await emailRow(rsv.id, 'confirmation', { channel: 'sms' })
		await deliver()
		expect(sent.sms).not.toHaveBeenCalled()
		expect(await getMessage(db, row.id)).toMatchObject({
			status: 'suppressed',
			lastErrorCode: 'sms_not_allowed',
		})
	})

	it('retries an SMS provider failure like an email failure', async () => {
		const { rsv } = await booking(
			{ smsOptIn: true },
			{ phoneE164: '+14155550103' },
		)
		const row = await emailRow(rsv.id, 'confirmation', { channel: 'sms' })
		sent.sms.mockRejectedValue(new Error('twilio 500 for +14155550103'))
		await deliver()
		const after = await getMessage(db, row.id)
		expect(after).toMatchObject({
			status: 'pending',
			attempts: 1,
			lastErrorCode: 'send_failed',
		})
		expect(JSON.stringify(after)).not.toContain('4155550103')
	})
})

describe('send-time eligibility', () => {
	it('cancels a reminder for a booking that was cancelled, with no send', async () => {
		const { rsv } = await booking({ status: 'cancelled' })
		const row = await scheduledRow(rsv.id, 'reminder')
		const totals = await deliver()
		expect(totals.cancelled).toBe(1)
		expect(sent.email).not.toHaveBeenCalled()
		expect(await getMessage(db, row.id)).toMatchObject({
			status: 'cancelled',
			lastErrorCode: 'not_eligible',
		})
	})

	it('cancels a reminder for a booking whose start has passed', async () => {
		const { rsv } = await booking({ startAt: NOW - HOUR })
		const row = await scheduledRow(rsv.id, 'reminder')
		await deliver()
		expect(sent.email).not.toHaveBeenCalled()
		expect((await getMessage(db, row.id)).lastErrorCode).toBe('not_eligible')
	})

	it('cancels a stale reminder after the schedule version moved on', async () => {
		const { rsv } = await booking({ scheduleVersion: 2 })
		const stale = await scheduledRow(rsv.id, 'reminder', 1)
		const fresh = await scheduledRow(rsv.id, 'reminder', 2, {
			channel: 'email',
		})
		const totals = await deliver()
		expect(totals).toMatchObject({ cancelled: 1, sent: 1 })
		expect(await getMessage(db, stale.id)).toMatchObject({
			status: 'cancelled',
			lastErrorCode: 'stale_schedule',
		})
		expect((await getMessage(db, fresh.id)).status).toBe('sent')
		expect(sent.email).toHaveBeenCalledTimes(1)
	})

	it('sends a reminder for a confirmed booking but cancels a reconfirmation for it', async () => {
		const { rsv } = await booking({ status: 'confirmed' })
		const reminder = await scheduledRow(rsv.id, 'reminder')
		const reconfirm = await scheduledRow(rsv.id, 'reconfirm_request')
		await deliver()
		expect((await getMessage(db, reminder.id)).status).toBe('sent')
		expect(await getMessage(db, reconfirm.id)).toMatchObject({
			status: 'cancelled',
			lastErrorCode: 'not_eligible',
		})
	})

	it('suppresses a late confirmation or modification for a dead booking but still sends the cancellation notices', async () => {
		for (const status of [
			'cancelled',
			'declined',
			'expired',
			'no_show',
		] as const) {
			const { rsv } = await booking({ status })
			const confirmation = await emailRow(rsv.id, 'confirmation')
			const modification = await emailRow(rsv.id, 'modification')
			const cancellation = await emailRow(rsv.id, 'cancellation_guest')
			const declined = await emailRow(rsv.id, 'request_declined')
			await deliver()
			for (const row of [confirmation, modification]) {
				expect(await getMessage(db, row.id), status).toMatchObject({
					status: 'suppressed',
					lastErrorCode: 'not_eligible',
				})
			}
			expect((await getMessage(db, cancellation.id)).status, status).toBe(
				'sent',
			)
			expect((await getMessage(db, declined.id)).status, status).toBe('sent')
		}
	})

	it('suppresses a message for an erased guest, with only a code stored', async () => {
		const { rsv } = await booking({}, { erasedAt: NOW - HOUR, emailNorm: null })
		const row = await emailRow(rsv.id, 'confirmation')
		await deliver()
		expect(sent.email).not.toHaveBeenCalled()
		expect(await getMessage(db, row.id)).toMatchObject({
			status: 'suppressed',
			lastErrorCode: 'guest_erased',
		})
	})

	it('suppresses an email row when the guest no longer has an address', async () => {
		const { rsv } = await booking(
			{},
			{ emailNorm: null, phoneE164: '+14155550104' },
		)
		const row = await emailRow(rsv.id, 'confirmation')
		await deliver()
		expect(sent.email).not.toHaveBeenCalled()
		expect(await getMessage(db, row.id)).toMatchObject({
			status: 'suppressed',
			lastErrorCode: 'no_destination',
		})
	})

	it('cancels a row whose subject is gone', async () => {
		const row = await insertMessageRow(db, { kind: 'confirmation' })
		const totals = await deliver()
		expect(totals.cancelled).toBe(1)
		expect(await getMessage(db, row.id)).toMatchObject({
			status: 'cancelled',
			lastErrorCode: 'no_subject',
		})
	})

	it('sends waitlist-ready only to an entry that was notified and suppresses it otherwise', async () => {
		const waiting = await insertWaitlistEntry(db, { status: 'waiting' })
		const notified = await insertWaitlistEntry(db, { status: 'notified' })
		const onTheWay = await insertWaitlistEntry(db, { status: 'on_the_way' })
		const rows = [] as Array<{ id: string }>
		for (const entry of [waiting, notified, onTheWay]) {
			rows.push(
				await insertMessageRow(db, {
					kind: 'waitlist_ready',
					waitlistEntryId: entry.id,
					dedupeKey: `wl:${entry.id}:waitlist_ready:email:1`,
				}),
			)
		}
		await deliver()
		expect((await getMessage(db, rows[0]!.id)).lastErrorCode).toBe(
			'not_eligible',
		)
		expect((await getMessage(db, rows[0]!.id)).status).toBe('suppressed')
		expect((await getMessage(db, rows[1]!.id)).status).toBe('sent')
		expect((await getMessage(db, rows[2]!.id)).status).toBe('sent')
		expect(sent.email).toHaveBeenCalledTimes(2)
		const token = deriveWaitlistToken(
			ORG,
			notified.id,
			notified.statusTokenVersion,
		)
		const urls = sent.email.mock.calls.map((c) => c[0].html as string)
		expect(
			urls.some((html) => html.includes(`${SITE}/reserve/waitlist#t=${token}`)),
		).toBe(true)
	})

	it('suppresses a waitlist-joined message for an entry that already left', async () => {
		const entries = await Promise.all(
			(['cancelled', 'left', 'seated'] as const).map((status) =>
				insertWaitlistEntry(db, { status }),
			),
		)
		const live = await insertWaitlistEntry(db, {
			status: 'waiting',
			quotedMin: 35,
		})
		const rows = []
		for (const entry of [...entries, live]) {
			rows.push(
				await insertMessageRow(db, {
					kind: 'waitlist_joined',
					waitlistEntryId: entry.id,
					dedupeKey: `wl:${entry.id}:waitlist_joined:email:1`,
				}),
			)
		}
		await deliver()
		for (const row of rows.slice(0, 3)) {
			expect((await getMessage(db, row.id)).status).toBe('suppressed')
		}
		expect((await getMessage(db, rows[3]!.id)).status).toBe('sent')
		expect(sent.email.mock.calls[0]![0].html).toContain(
			'Estimated wait: 35 min.',
		)
	})

	it('cancels a waitlist or notify row whose entry vanished', async () => {
		await db.insert(rsvWaitlistEntries).values({
			id: 'wle_gone',
			locationId: PUBLIC_LOC,
			businessDate: '2031-06-10',
			displayName: 'Gone',
			partySize: 2,
		})
		const waitRow = await insertMessageRow(db, {
			kind: 'waitlist_joined',
			waitlistEntryId: 'wle_gone',
		})
		await db
			.delete(rsvWaitlistEntries)
			.where(eq(rsvWaitlistEntries.id, 'wle_gone'))
		await deliver()
		// The FK sets the reference to null when the entry is deleted.
		expect(await getMessage(db, waitRow.id)).toMatchObject({
			status: 'cancelled',
			lastErrorCode: 'no_subject',
		})
	})

	it('sends notify-available naming the offered date and time with a link to that slot', async () => {
		const request = await insertNotifyRequest(db, {
			contactEmailNorm: 'nfy@example.com',
			lastNotifiedSlotMin: 18 * 60 + 15,
		})
		const row = await insertMessageRow(db, {
			kind: 'notify_available',
			notifyRequestId: request.id,
			dedupeKey: `notify:${request.id}:notify_available:email:1`,
		})
		await deliver()
		const mail = sent.email.mock.calls[0]![0]
		expect(mail.to).toBe('nfy@example.com')
		const query = new URLSearchParams({
			location: PUBLIC_LOC,
			party: '2',
			date: '2031-06-14',
			time: '18:15',
		}).toString()
		expect(mail.html).toContain(
			`href="${SITE}/reserve?${query.replace(/&/g, '&amp;')}"`,
		)
		expect(mail.html).toContain('Saturday, June 14, 2031')
		expect(mail.html).toContain('6:15')
		expect(mail.text).toContain('June 14, 2031 at 6:15')
		expect(mail.html).not.toContain('#t=')
		expect(
			deriveNotifyToken(ORG, request.id, request.tokenVersion),
		).toBeTruthy()
		expect((await getMessage(db, row.id)).status).toBe('sent')
	})

	it('texts notify-available with the booking page link when the request has a phone', async () => {
		const request = await insertNotifyRequest(db, {
			contactEmailNorm: null,
			contactPhoneE164: '+14155550105',
		})
		await insertMessageRow(db, {
			kind: 'notify_available',
			channel: 'sms',
			notifyRequestId: request.id,
			dedupeKey: `notify:${request.id}:notify_available:sms:1`,
		})
		await deliver()
		const call = sent.sms.mock.calls[0]![0]
		expect(call.to).toBe('+14155550105')
		expect(call.message).toContain(`${SITE}/reserve?location=${PUBLIC_LOC}`)
		expect(call.message).toContain('June 14, 2031')
		expect(call.message).not.toContain('for .')
	})
})

describe('retry and failure', () => {
	it('backs off 1, 5 and 30 minutes, then ends failed after the fourth attempt', async () => {
		const { rsv } = await booking()
		const row = await emailRow(rsv.id, 'confirmation')
		sent.email.mockRejectedValue(new Error('network down'))
		expect(RETRY_BACKOFF_MIN).toEqual([1, 5, 30])

		let now = NOW
		const outcomes = []
		for (const expectedDelay of [1, 5, 30]) {
			const totals = await deliver(now)
			expect(totals.retried).toBe(1)
			const after = await getMessage(db, row.id)
			outcomes.push(after.attempts)
			expect(after.status).toBe('pending')
			expect(after.nextAttemptAt).toBe(now + expectedDelay * MINUTE)
			// Not due again before its time.
			expect((await deliver(now + expectedDelay * MINUTE - 1)).retried).toBe(0)
			now += expectedDelay * MINUTE
		}
		const last = await deliver(now)
		expect(last).toMatchObject({ failed: 1, retried: 0 })
		const final = await getMessage(db, row.id)
		expect(final).toMatchObject({
			status: 'failed',
			attempts: 4,
			lastErrorCode: 'send_failed',
		})
		expect(outcomes).toEqual([1, 2, 3])
		expect(sent.email).toHaveBeenCalledTimes(4)
		// A failed row is final.
		expect(await deliver(now + 24 * HOUR)).toMatchObject({
			sent: 0,
			failed: 0,
			retried: 0,
		})
		expect(sent.email).toHaveBeenCalledTimes(4)
	})

	it('succeeds on a retry and records the attempt', async () => {
		const { rsv } = await booking()
		const row = await emailRow(rsv.id, 'confirmation')
		sent.email.mockRejectedValueOnce(new Error('blip'))
		await deliver(NOW)
		await deliver(NOW + MINUTE)
		expect(await getMessage(db, row.id)).toMatchObject({
			status: 'sent',
			attempts: 2,
			sentAt: NOW + MINUTE,
			lastErrorCode: null,
		})
	})

	it('stores only an error code, never provider text or the destination', async () => {
		const { rsv } = await booking({}, { emailNorm: 'hidden@example.com' })
		const row = await emailRow(rsv.id, 'confirmation')
		sent.email.mockRejectedValue(
			new Error('550 hidden@example.com password=hunter2'),
		)
		await deliver()
		const after = await getMessage(db, row.id)
		expect(after.lastErrorCode).toBe('send_failed')
		const dump = JSON.stringify(after)
		expect(dump).not.toContain('hunter2')
		expect(dump).not.toContain('hidden@example.com')
	})
})

describe('batching and claiming', () => {
	it('delivers at most 100 rows per pass, oldest first, and the rest on the next pass', async () => {
		expect(DELIVER_BATCH_LIMIT).toBe(100)
		const { rsv } = await booking()
		for (let i = 0; i < 105; i++) {
			await insertMessageRow(db, {
				kind: 'modification',
				reservationId: rsv.id,
				dedupeKey: `bulk:${i}`,
				sendAt: NOW - 200 + i,
			})
		}
		const first = await deliver()
		expect(first.sent).toBe(100)
		expect(sent.email).toHaveBeenCalledTimes(100)
		const rows = await db.select().from(rsvMessages).all()
		const pending = rows.filter((r) => r.status === 'pending')
		expect(pending).toHaveLength(5)
		expect(pending.map((r) => r.dedupeKey).sort()).toEqual([
			'bulk:100',
			'bulk:101',
			'bulk:102',
			'bulk:103',
			'bulk:104',
		])
		const second = await deliver()
		expect(second.sent).toBe(5)
		expect(sent.email).toHaveBeenCalledTimes(105)
	})

	it('honors an explicit limit', async () => {
		const { rsv } = await booking()
		for (let i = 0; i < 4; i++) {
			await insertMessageRow(db, {
				kind: 'modification',
				reservationId: rsv.id,
				dedupeKey: `lim:${i}`,
				sendAt: NOW - 10 + i,
			})
		}
		expect((await deliver(NOW, 3)).sent).toBe(3)
	})

	it('leaves rows that are not yet due alone', async () => {
		const { rsv } = await booking()
		const future = await emailRow(rsv.id, 'confirmation', {
			sendAt: NOW + HOUR,
			nextAttemptAt: NOW + HOUR,
		})
		const backoff = await emailRow(rsv.id, 'modification', {
			nextAttemptAt: NOW + MINUTE,
		})
		const totals = await deliver()
		expect(totals.sent).toBe(0)
		expect((await getMessage(db, future.id)).status).toBe('pending')
		expect((await getMessage(db, backoff.id)).status).toBe('pending')
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('sends a row once even when two passes race for it', async () => {
		const { rsv } = await booking()
		const row = await emailRow(rsv.id, 'confirmation')
		const [a, b] = await Promise.all([deliver(), deliver()])
		expect(a.sent + b.sent).toBe(1)
		expect(sent.email).toHaveBeenCalledTimes(1)
		expect((await getMessage(db, row.id)).status).toBe('sent')
	})

	it('picks up a row whose claim lease expired and ignores one that is still leased', async () => {
		const { rsv } = await booking()
		const leased = await emailRow(rsv.id, 'confirmation', {
			status: 'sending',
			nextAttemptAt: NOW + 2 * MINUTE,
		})
		const orphaned = await emailRow(rsv.id, 'modification', {
			status: 'sending',
			nextAttemptAt: NOW - MINUTE,
		})
		await deliver()
		expect((await getMessage(db, leased.id)).status).toBe('sending')
		expect((await getMessage(db, orphaned.id)).status).toBe('sent')
	})

	it('never touches a row in a final state', async () => {
		const { rsv } = await booking()
		for (const status of [
			'sent',
			'failed',
			'cancelled',
			'suppressed',
			'dropped',
		] as const) {
			await emailRow(rsv.id, 'confirmation', { status })
		}
		expect(await deliver()).toMatchObject({
			sent: 0,
			cancelled: 0,
			suppressed: 0,
		})
		expect(sent.email).not.toHaveBeenCalled()
	})
})

describe('kill switches', () => {
	it('drops email while RESERVATIONS_EMAIL_ENABLED is off and sends no backlog when it is turned back on', async () => {
		const { rsv } = await booking()
		const row = await emailRow(rsv.id, 'confirmation')
		vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', 'false')
		const totals = await deliver()
		expect(totals.dropped).toBe(1)
		expect(sent.email).not.toHaveBeenCalled()
		expect(await getMessage(db, row.id)).toMatchObject({
			status: 'dropped',
			lastErrorCode: 'switch_off',
			attempts: 0,
		})
		vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', 'true')
		expect(await deliver(NOW + HOUR)).toMatchObject({ sent: 0, dropped: 0 })
		expect(sent.email).not.toHaveBeenCalled()
		expect((await getMessage(db, row.id)).status).toBe('dropped')
		// Mail queued after the switch came back goes out.
		const fresh = await emailRow(rsv.id, 'modification', {
			sendAt: NOW + HOUR,
			nextAttemptAt: NOW + HOUR,
		})
		await deliver(NOW + HOUR)
		expect((await getMessage(db, fresh.id)).status).toBe('sent')
	})

	it('drops only SMS when the SMS switch is off', async () => {
		const { rsv } = await booking(
			{ smsOptIn: true },
			{ phoneE164: '+14155550106' },
		)
		const email = await emailRow(rsv.id, 'confirmation')
		const text = await emailRow(rsv.id, 'confirmation', { channel: 'sms' })
		vi.stubEnv('RESERVATIONS_SMS_ENABLED', 'false')
		const totals = await deliver()
		expect(totals).toMatchObject({ sent: 1, dropped: 1 })
		expect((await getMessage(db, email.id)).status).toBe('sent')
		expect(await getMessage(db, text.id)).toMatchObject({
			status: 'dropped',
			lastErrorCode: 'switch_off',
		})
		expect(sent.sms).not.toHaveBeenCalled()
	})

	it('drops only email when the email switch is off and SMS still goes out', async () => {
		const { rsv } = await booking(
			{ smsOptIn: true },
			{ phoneE164: '+14155550107' },
		)
		const email = await emailRow(rsv.id, 'confirmation')
		const text = await emailRow(rsv.id, 'confirmation', { channel: 'sms' })
		vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', 'false')
		await deliver()
		expect((await getMessage(db, email.id)).status).toBe('dropped')
		expect((await getMessage(db, text.id)).status).toBe('sent')
	})

	it('does not drop a scheduled message that is not eligible: eligibility cancels it first only when the switch is on', async () => {
		const { rsv } = await booking({ status: 'cancelled' })
		const row = await scheduledRow(rsv.id, 'reminder')
		vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', 'false')
		await deliver()
		expect((await getMessage(db, row.id)).status).toBe('dropped')
	})
})

describe('feature flags', () => {
	it('holds every row, still pending, while the master flag is off, and sends when it is back on', async () => {
		setContext({ enabled: false })
		const { rsv } = await booking()
		const row = await emailRow(rsv.id, 'confirmation')
		const totals = await deliver()
		expect(totals).toMatchObject({ held: 1, sent: 0, dropped: 0 })
		expect(sent.email).not.toHaveBeenCalled()
		const held = await getMessage(db, row.id)
		expect(held.status).toBe('pending')
		expect(held.attempts).toBe(0)
		expect(held.nextAttemptAt).toBe(NOW + 10 * MINUTE)

		setContext({ enabled: true })
		expect((await deliver(NOW + 5 * MINUTE)).held).toBe(0)
		expect((await deliver(NOW + 10 * MINUTE)).sent).toBe(1)
		expect((await getMessage(db, row.id)).status).toBe('sent')
	})

	it('holds every row when the organization context cannot be loaded', async () => {
		resetReservationsContextCache()
		vi.stubEnv('APP_URL', 'http://127.0.0.1:1')
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
		const { rsv } = await booking()
		const row = await emailRow(rsv.id, 'confirmation')
		expect(await deliver()).toMatchObject({ held: 1, sent: 0 })
		expect((await getMessage(db, row.id)).status).toBe('pending')
	})

	it('still delivers while online booking is off', async () => {
		setContext({ online: false })
		const { rsv } = await booking()
		const row = await emailRow(rsv.id, 'confirmation')
		expect((await deliver()).sent).toBe(1)
		expect((await getMessage(db, row.id)).status).toBe('sent')
	})

	it('holds waitlist and notify kinds while the waitlist flag is off but delivers booking kinds', async () => {
		setContext({ waitlist: false })
		const { rsv } = await booking()
		const booked = await emailRow(rsv.id, 'confirmation')
		const entry = await insertWaitlistEntry(db, { status: 'notified' })
		const joined = await insertMessageRow(db, {
			kind: 'waitlist_joined',
			waitlistEntryId: entry.id,
			dedupeKey: `wl:${entry.id}:waitlist_joined:email:1`,
		})
		const ready = await insertMessageRow(db, {
			kind: 'waitlist_ready',
			waitlistEntryId: entry.id,
			dedupeKey: `wl:${entry.id}:waitlist_ready:email:1`,
		})
		const request = await insertNotifyRequest(db)
		const notify = await insertMessageRow(db, {
			kind: 'notify_available',
			notifyRequestId: request.id,
			dedupeKey: `notify:${request.id}:notify_available:email:1`,
		})
		const totals = await deliver()
		expect(totals).toMatchObject({ sent: 1, held: 3 })
		expect((await getMessage(db, booked.id)).status).toBe('sent')
		for (const row of [joined, ready, notify]) {
			expect((await getMessage(db, row.id)).status).toBe('pending')
		}
	})
})

describe('deliverMessagesByIds', () => {
	it('delivers only the named rows that are due', async () => {
		const { rsv } = await booking()
		const a = await emailRow(rsv.id, 'confirmation')
		const b = await emailRow(rsv.id, 'modification')
		const later = await emailRow(rsv.id, 'cancellation_guest', {
			sendAt: NOW + HOUR,
			nextAttemptAt: NOW + HOUR,
		})
		const totals = await deliverMessagesByIds(ORG, [a.id, later.id], {
			db,
			now: NOW,
		})
		expect(totals.sent).toBe(1)
		expect((await getMessage(db, a.id)).status).toBe('sent')
		expect((await getMessage(db, b.id)).status).toBe('pending')
		expect((await getMessage(db, later.id)).status).toBe('pending')
	})

	it('does nothing for an empty list', async () => {
		expect(await deliverMessagesByIds(ORG, [], { db, now: NOW })).toEqual({
			sent: 0,
			failed: 0,
			retried: 0,
			suppressed: 0,
			dropped: 0,
			cancelled: 0,
			held: 0,
		})
	})

	it('applies the same send-time checks as the tick', async () => {
		const { rsv } = await booking({ status: 'cancelled' })
		const row = await emailRow(rsv.id, 'confirmation')
		const totals = await deliverMessagesByIds(ORG, [row.id], { db, now: NOW })
		expect(totals.suppressed).toBe(1)
		expect(sent.email).not.toHaveBeenCalled()
	})
})

describe('nextMessageDueAt', () => {
	it('is null when nothing is pending', async () => {
		expect(await nextMessageDueAt(db)).toBeNull()
		const { rsv } = await booking()
		await emailRow(rsv.id, 'confirmation', { status: 'sent' })
		await emailRow(rsv.id, 'modification', { status: 'failed' })
		expect(await nextMessageDueAt(db)).toBeNull()
	})

	it('returns when the earliest pending row can next be tried', async () => {
		const { rsv } = await booking()
		await emailRow(rsv.id, 'confirmation', {
			sendAt: NOW + 2 * HOUR,
			nextAttemptAt: NOW + 2 * HOUR,
		})
		await emailRow(rsv.id, 'modification', {
			sendAt: NOW + HOUR,
			nextAttemptAt: NOW + HOUR + 5 * MINUTE,
		})
		expect(await nextMessageDueAt(db)).toBe(NOW + HOUR + 5 * MINUTE)
	})
})

describe('bulk failure alert', () => {
	async function failures(count: number, locationId = PUBLIC_LOC, now = NOW) {
		const { rsv } = await booking({ locationId })
		sent.email.mockRejectedValue(new Error('down'))
		for (let i = 0; i < count; i++) {
			await insertMessageRow(db, {
				kind: 'modification',
				reservationId: rsv.id,
				locationId,
				// The next failure is the fourth attempt, which ends the row.
				attempts: RETRY_BACKOFF_MIN.length,
				sendAt: now - MINUTE,
				nextAttemptAt: now - MINUTE,
				dedupeKey: `fail:${locationId}:${now}:${i}:${Math.random()}`,
			})
		}
		return deliver(now)
	}

	it('stays quiet below the threshold', async () => {
		expect(BULK_FAILURE_THRESHOLD).toBe(10)
		const totals = await failures(9)
		expect(totals.failed).toBe(9)
		expect(await outboxRows()).toEqual([])
	})

	it('enqueues exactly one alert with ids and counts only when ten rows fail for one location in 15 minutes', async () => {
		const totals = await failures(12)
		expect(totals.failed).toBe(12)
		const rows = await outboxRows()
		expect(rows).toHaveLength(1)
		const [row] = rows
		expect(row).toMatchObject({
			kind: 'manager_alert',
			status: 'pending',
			attempts: 0,
			nextAttemptAt: NOW,
		})
		const bucket = Math.floor(NOW / BULK_FAILURE_WINDOW_MS)
		expect(row!.dedupeKey).toBe(
			`alert:message_failed_bulk:${PUBLIC_LOC}:${bucket}`,
		)
		const payload = row!.payload as Record<string, unknown>
		expect(Object.keys(payload).sort()).toEqual([
			'count',
			'eventId',
			'kind',
			'locationId',
			'orgId',
		])
		expect(payload).toMatchObject({
			orgId: ORG,
			kind: 'message_failed_bulk',
			locationId: PUBLIC_LOC,
			count: 10,
		})
		expect(JSON.stringify(payload)).not.toMatch(/@|example\.com|Rana/)
	})

	it('does not alert again for a later burst in the same window', async () => {
		await failures(10)
		await failures(5)
		expect(await outboxRows()).toHaveLength(1)
	})

	it('counts failures per location', async () => {
		await db
			.insert((await import('@repo/tenant-db')).rsvLocationSettings)
			.values({ locationId: 'loc_other', enabled: true, timeZone: 'UTC' })
		await failures(6, PUBLIC_LOC)
		await failures(6, 'loc_other')
		expect(await outboxRows()).toEqual([])
		await failures(4, PUBLIC_LOC)
		const rows = await outboxRows()
		expect(rows).toHaveLength(1)
		expect((rows[0]!.payload as { locationId: string }).locationId).toBe(
			PUBLIC_LOC,
		)
	})

	it('ignores failures older than the window', async () => {
		await failures(9, PUBLIC_LOC, NOW - 2 * BULK_FAILURE_WINDOW_MS)
		await failures(1, PUBLIC_LOC, NOW)
		expect(await outboxRows()).toEqual([])
	})

	it('alerts again in a later window', async () => {
		await failures(10)
		const later = NOW + 3 * BULK_FAILURE_WINDOW_MS
		await failures(10, PUBLIC_LOC, later)
		const rows = await outboxRows()
		expect(rows).toHaveLength(2)
		expect(new Set(rows.map((r) => r.dedupeKey)).size).toBe(2)
	})

	it('does not alert for retries that have not ended the row', async () => {
		const { rsv } = await booking()
		sent.email.mockRejectedValue(new Error('down'))
		for (let i = 0; i < 12; i++) {
			await insertMessageRow(db, {
				kind: 'modification',
				reservationId: rsv.id,
				dedupeKey: `retry:${i}`,
			})
		}
		const totals = await deliver()
		expect(totals).toMatchObject({ retried: 12, failed: 0 })
		expect(await outboxRows()).toEqual([])
	})
})

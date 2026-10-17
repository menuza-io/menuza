import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	rsvDayVersions,
	rsvGuests,
	rsvMessages,
	rsvOutbox,
	rsvReservationEvents,
	rsvReservations,
	rsvTables,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq } from 'drizzle-orm'
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

import { resetReservationsContextCache } from '../lib/reservations-context.ts'
import {
	deriveManageToken,
	hashHoldToken,
	newHoldToken,
	verifyManageToken,
} from '../lib/reservations-public-auth.ts'
import { withReservationWrite } from '../lib/reservations-write.ts'
import {
	dateAhead,
	PUBLIC_LOC,
	seedPublicOrg,
} from '../routes/reservations-public-fixture.ts'
import {
	createOperatorReservation,
	createWalkIn,
	resendReservationConfirmation,
	transitionReservationStatus,
	updateReservation,
} from './rsv-booking-service.ts'
import { eraseGuestProfile } from './rsv-guest-service.ts'
import { createHold } from './rsv-hold-service.ts'
import {
	getMessage,
	HOUR,
	insertGuest,
	insertNotifyRequest,
	insertReservation,
	MINUTE,
	messagesFor,
	setMessaging,
} from './rsv-message-fixture.ts'
import {
	bookFromHold,
	createLargePartyRequest,
	guestCancelReservation,
	guestModifyReservation,
} from './rsv-public-booking-service.ts'
import {
	approveReservationRequest,
	declineReservationRequest,
} from './rsv-request-service.ts'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-msg-hooks-'))
process.env.TENANT_DB_DIR = TEST_DIR
process.env.AUTH_HMAC_SECRET = 'test-msg-hooks-auth-hmac-secret-0123456789'
process.env.JWT_SECRET = 'test-msg-hooks-customer-jwt-secret-123456'
process.env.DATA_REGION = 'us'

const ORG = 'org_msg_hooks'
const OPERATOR = 'usr_operator'
const EMAIL = 'rana@example.com'
const PHONE = '+12125550123'

let db: TenantDatabase
let idem = 0

beforeEach(async () => {
	vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', 'true')
	vi.stubEnv('RESERVATIONS_SMS_ENABLED', 'true')
	sent.email.mockReset()
	sent.sms.mockReset()
	sent.email.mockResolvedValue({ status: 'success', data: { messageId: 'm' } })
	sent.sms.mockResolvedValue({ success: true, mock: true })
	await destroyTenantDb(ORG).catch(() => undefined)
	resetReservationsContextCache()
	db = await seedPublicOrg(ORG)
	await db.insert(rsvTables).values({
		id: 'tbl_hook_2b',
		locationId: PUBLIC_LOC,
		areaId: 'area_pub_main',
		label: 'T2b',
		minCovers: 1,
		maxCovers: 2,
		onlineBookable: true,
		resetBufferMin: 0,
	})
})
afterEach(() => {
	vi.unstubAllEnvs()
})
afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const mails = () =>
	sent.email.mock.calls.map(
		(call) => call[0] as { to: string; subject: string; html: string },
	)
const msgs = (reservationId: string, kind?: string) =>
	messagesFor(db, reservationId, kind)
const kinds = async (reservationId: string) =>
	(await msgs(reservationId)).map((m) => `${m.kind}:${m.channel}:${m.status}`)

function atHour(daysAhead: number, hour: number) {
	return Date.parse(
		`${dateAhead(daysAhead)}T${String(hour).padStart(2, '0')}:00:00Z`,
	)
}

type Guest = NonNullable<
	Parameters<typeof createOperatorReservation>[0]['input']['guest']
>

function operatorBooking(
	input: Partial<Parameters<typeof createOperatorReservation>[0]['input']> = {},
	guest: Guest | null = {},
) {
	return createOperatorReservation({
		orgId: ORG,
		locationId: PUBLIC_LOC,
		actorId: OPERATOR,
		idempotencyKey: `idem-${++idem}`,
		input: {
			locationId: PUBLIC_LOC,
			date: dateAhead(3),
			localStartMin: 19 * 60,
			partySize: 2,
			guest: guest
				? {
						firstName: 'Rana',
						lastName: 'Haddad',
						email: EMAIL,
						phone: PHONE,
						locale: 'en',
						...guest,
					}
				: null,
			...input,
		},
	})
}

async function reload(id: string) {
	return (await db
		.select()
		.from(rsvReservations)
		.where(eq(rsvReservations.id, id))
		.get())!
}

async function events(id: string) {
	return db
		.select()
		.from(rsvReservationEvents)
		.where(eq(rsvReservationEvents.reservationId, id))
		.all()
}

describe('operator booking', () => {
	it('queues a confirmation and sends it once the booking commits', async () => {
		const { reservation } = await operatorBooking()
		const [confirmation] = await msgs(reservation.id, 'confirmation')
		expect(confirmation).toMatchObject({
			channel: 'email',
			status: 'sent',
			locale: 'en',
			category: 'transactional',
		})
		expect(mails()).toHaveLength(1)
		expect(mails()[0]).toMatchObject({ to: EMAIL })
		expect(mails()[0]!.subject).toContain('Acme Downtown')
		expect(sent.sms).not.toHaveBeenCalled()
	})

	it('schedules the pre-arrival reminder for 24 hours before the start', async () => {
		const { reservation } = await operatorBooking()
		const [reminder] = await msgs(reservation.id, 'reminder')
		expect(reminder).toMatchObject({
			channel: 'email',
			status: 'pending',
			sendAt: atHour(3, 19) - 24 * HOUR,
		})
		expect(
			mails().every((m) => !m.subject.toLowerCase().includes('reminder')),
		).toBe(true)
	})

	it("uses the guest's own language for the confirmation", async () => {
		const { reservation } = await operatorBooking({}, { locale: 'ar' })
		expect((await reload(reservation.id)).guestLocale).toBe('ar')
		const [confirmation] = await msgs(reservation.id, 'confirmation')
		expect(confirmation!.locale).toBe('ar')
		expect(mails()[0]!.html).toContain('dir="rtl"')
		expect(mails()[0]!.html).toContain('lang="ar"')
	})

	it('uses the saved language of an existing guest picked by id', async () => {
		const guest = await insertGuest(db, { locale: 'ar', emailNorm: EMAIL })
		const { reservation } = await operatorBooking({ guestId: guest.id }, null)
		expect((await reload(reservation.id)).guestLocale).toBe('ar')
		const [confirmation] = await msgs(reservation.id, 'confirmation')
		expect(confirmation!.locale).toBe('ar')
		expect(mails()[0]!.html).toContain('dir="rtl"')
	})

	it('defaults to English when the guest has no language', async () => {
		const { reservation } = await operatorBooking({}, { locale: undefined })
		expect((await reload(reservation.id)).guestLocale).toBe('en')
		expect((await msgs(reservation.id, 'confirmation'))[0]!.locale).toBe('en')
		expect(mails()[0]!.html).toContain('dir="ltr"')
	})

	it('sends no confirmation when the kind is switched off', async () => {
		await setMessaging(db, { kinds: { confirmation: false } })
		const { reservation } = await operatorBooking()
		expect(await msgs(reservation.id, 'confirmation')).toHaveLength(0)
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('still books a guest with no email or phone, and sends nothing', async () => {
		const { reservation } = await operatorBooking(
			{},
			{ email: null, phone: null, firstName: 'Walk', lastName: 'Up' },
		)
		expect(reservation.id).toBeTruthy()
		expect(await msgs(reservation.id)).toHaveLength(0)
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('replaying the same idempotency key does not send a second confirmation', async () => {
		const params = {
			orgId: ORG,
			locationId: PUBLIC_LOC,
			actorId: OPERATOR,
			idempotencyKey: 'idem-replay',
			input: {
				locationId: PUBLIC_LOC,
				date: dateAhead(3),
				localStartMin: 19 * 60,
				partySize: 2,
				guest: {
					firstName: 'Rana',
					lastName: 'Haddad',
					email: EMAIL,
					phone: PHONE,
				},
			},
		}
		const first = await createOperatorReservation(params)
		const second = await createOperatorReservation(params)
		expect(second.reservation.id).toBe(first.reservation.id)
		expect(await msgs(first.reservation.id, 'confirmation')).toHaveLength(1)
		expect(mails()).toHaveLength(1)
	})

	it('a failed email send leaves the booking in place and the message for the tick to retry', async () => {
		sent.email.mockResolvedValue({ status: 'error', error: 'provider down' })
		const { reservation } = await operatorBooking()
		expect((await reload(reservation.id)).status).toBe('booked')
		const [confirmation] = await msgs(reservation.id, 'confirmation')
		expect(confirmation!.status).toBe('pending')
		expect(confirmation!.attempts).toBe(1)
	})

	it('a throwing email provider does not fail the booking', async () => {
		sent.email.mockRejectedValue(new Error('socket hang up'))
		const { reservation } = await operatorBooking()
		expect((await reload(reservation.id)).status).toBe('booked')
		expect((await msgs(reservation.id, 'confirmation'))[0]!.status).toBe(
			'pending',
		)
	})

	it('a walk-in is seated at once and gets no confirmation or reminder', async () => {
		const guest = await insertGuest(db, { locale: 'ar', emailNorm: EMAIL })
		const { reservation } = await createWalkIn({
			orgId: ORG,
			locationId: PUBLIC_LOC,
			actorId: OPERATOR,
			idempotencyKey: `idem-walk-${++idem}`,
			input: {
				date: dateAhead(0),
				localStartMin: 12 * 60,
				partySize: 2,
				guestId: guest.id,
			},
		})
		expect(await msgs(reservation.id)).toHaveLength(0)
		expect((await reload(reservation.id)).guestLocale).toBe('ar')
	})
})

describe('operator changes', () => {
	async function booked() {
		const { reservation } = await operatorBooking()
		sent.email.mockClear()
		return reservation.id
	}

	it('moving the time sends a modification and retimes the reminder', async () => {
		const id = await booked()
		const before = await reload(id)
		await updateReservation({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { localStartMin: 20 * 60 },
		})
		const after = await reload(id)
		expect(after.scheduleVersion).toBe(before.scheduleVersion + 1)
		const [modification] = await msgs(id, 'modification')
		expect(modification).toMatchObject({ channel: 'email', status: 'sent' })
		expect(mails()).toHaveLength(1)
		const reminders = await msgs(id, 'reminder')
		const live = reminders.filter((r) => r.status === 'pending')
		expect(live).toHaveLength(1)
		expect(live[0]!.sendAt).toBe(atHour(3, 20) - 24 * HOUR)
		expect(
			reminders
				.filter((r) => r.status !== 'pending')
				.every((r) => r.status === 'cancelled'),
		).toBe(true)
	})

	it('moving the date sends a modification', async () => {
		const id = await booked()
		await updateReservation({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { date: dateAhead(4) },
		})
		expect(await msgs(id, 'modification')).toHaveLength(1)
		const live = (await msgs(id, 'reminder')).filter(
			(r) => r.status === 'pending',
		)
		expect(live.map((r) => r.sendAt)).toEqual([atHour(4, 19) - 24 * HOUR])
	})

	it('changing the party size sends a modification', async () => {
		const id = await booked()
		await updateReservation({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { partySize: 4 },
		})
		expect(await msgs(id, 'modification')).toHaveLength(1)
		expect(mails()).toHaveLength(1)
	})

	it('swapping only the table sends nothing', async () => {
		const id = await booked()
		await updateReservation({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { tableIds: ['tbl_hook_2b'] },
		})
		expect(await msgs(id, 'modification')).toHaveLength(0)
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('changing only the notes sends nothing and keeps the reminder', async () => {
		const id = await booked()
		await updateReservation({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { internalNotes: 'window seat', guestRequests: 'high chair' },
		})
		expect(await msgs(id, 'modification')).toHaveLength(0)
		expect(
			(await msgs(id, 'reminder')).filter((r) => r.status === 'pending'),
		).toHaveLength(1)
	})

	it('changing only the duration sends nothing', async () => {
		const id = await booked()
		await updateReservation({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { durationMin: 120 },
		})
		expect(await msgs(id, 'modification')).toHaveLength(0)
	})

	it('each distinct change sends its own modification', async () => {
		const id = await booked()
		await updateReservation({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { localStartMin: 20 * 60 },
		})
		await updateReservation({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { localStartMin: 19 * 60 + 30 },
		})
		expect(await msgs(id, 'modification')).toHaveLength(2)
		expect(mails()).toHaveLength(2)
	})

	it('sends no modification when the kind is switched off', async () => {
		const id = await booked()
		await setMessaging(db, { kinds: { modification: false } })
		await updateReservation({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { localStartMin: 20 * 60 },
		})
		expect(await msgs(id, 'modification')).toHaveLength(0)
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('cancelling sends the restaurant cancellation and cancels the pending reminder', async () => {
		const id = await booked()
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { status: 'cancelled', cancelReason: 'kitchen closed' },
		})
		const [cancellation] = await msgs(id, 'cancellation_restaurant')
		expect(cancellation).toMatchObject({ channel: 'email', status: 'sent' })
		expect(mails()).toHaveLength(1)
		expect(mails()[0]!.to).toBe(EMAIL)
		const reminders = await msgs(id, 'reminder')
		expect(reminders.length).toBeGreaterThan(0)
		expect(reminders.every((r) => r.status === 'cancelled')).toBe(true)
	})

	it('cancelling sends nothing when the kind is switched off, but still cancels reminders', async () => {
		const id = await booked()
		await setMessaging(db, { kinds: { cancellation_restaurant: false } })
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { status: 'cancelled' },
		})
		expect(await msgs(id, 'cancellation_restaurant')).toHaveLength(0)
		expect(
			(await msgs(id, 'reminder')).every((r) => r.status === 'cancelled'),
		).toBe(true)
	})

	it.each(['confirmed', 'arrived', 'seated'])(
		'moving to %s sends nothing',
		async (status) => {
			const id = await booked()
			const before = (await msgs(id)).map((m) => m.id)
			await transitionReservationStatus({
				orgId: ORG,
				reservationId: id,
				actorId: OPERATOR,
				input: { status },
			})
			expect(sent.email).not.toHaveBeenCalled()
			const created = (await msgs(id)).filter((m) => !before.includes(m.id))
			expect(created.filter((m) => m.kind !== 'reminder')).toHaveLength(0)
		},
	)

	it('the system marking a no-show sends nothing and cancels the pending reminder', async () => {
		const id = await booked()
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: id,
			actorId: 'system',
			actorKind: 'system',
			input: { status: 'no_show', reason: 'auto_no_show' },
		})
		expect((await reload(id)).status).toBe('no_show')
		expect(sent.email).not.toHaveBeenCalled()
		expect(
			(await msgs(id, 'reminder')).every((r) => r.status === 'cancelled'),
		).toBe(true)
		const event = (await events(id)).find((e) => e.type === 'no_show')
		expect(event).toMatchObject({ actorKind: 'system', actorId: null })
	})

	it('the system cancelling sends the restaurant cancellation like an operator would', async () => {
		const id = await booked()
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: id,
			actorId: 'system',
			actorKind: 'system',
			input: { status: 'cancelled', reason: 'auto_cancel' },
		})
		expect(await msgs(id, 'cancellation_restaurant')).toHaveLength(1)
	})

	it('an invalid transition sends nothing', async () => {
		const id = await booked()
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { status: 'cancelled' },
		})
		sent.email.mockClear()
		await expect(
			transitionReservationStatus({
				orgId: ORG,
				reservationId: id,
				actorId: OPERATOR,
				input: { status: 'cancelled' },
			}),
		).rejects.toMatchObject({ status: 409 })
		expect(sent.email).not.toHaveBeenCalled()
		expect(await msgs(id, 'cancellation_restaurant')).toHaveLength(1)
	})
})

describe('resending a confirmation', () => {
	async function booked(guest: Guest | null = {}) {
		const { reservation } = await operatorBooking({}, guest)
		sent.email.mockClear()
		return reservation.id
	}
	const resend = (id: string, rotate?: boolean) =>
		resendReservationConfirmation({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { rotate },
		})

	it('queues and sends a fresh confirmation without touching the first', async () => {
		const id = await booked()
		await sleep(5)
		const result = await resend(id)
		expect(result).toMatchObject({ queued: 1, rotated: false })
		expect(result.reservation.id).toBe(id)
		const confirmations = await msgs(id, 'confirmation')
		expect(confirmations).toHaveLength(2)
		expect(confirmations.every((m) => m.status === 'sent')).toBe(true)
		expect(mails()).toHaveLength(1)
	})

	it('each resend is its own message', async () => {
		const id = await booked()
		await sleep(5)
		await resend(id)
		await sleep(5)
		await resend(id)
		expect(await msgs(id, 'confirmation')).toHaveLength(3)
		expect(mails()).toHaveLength(2)
	})

	it('works for a confirmed booking', async () => {
		const id = await booked()
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: id,
			actorId: OPERATOR,
			input: { status: 'confirmed' },
		})
		await sleep(5)
		expect((await resend(id)).queued).toBe(1)
	})

	it('goes out even when confirmations are switched off', async () => {
		const id = await booked()
		await setMessaging(db, { kinds: { confirmation: false } })
		await sleep(5)
		expect((await resend(id)).queued).toBe(1)
		expect(mails()).toHaveLength(1)
	})

	it('keeps the manage link working when it is not rotated', async () => {
		const id = await booked()
		const before = await reload(id)
		await sleep(5)
		await resend(id)
		const after = await reload(id)
		expect(after.manageTokenVersion).toBe(before.manageTokenVersion)
		expect(mails()[0]!.html).toContain(
			deriveManageToken(ORG, id, before.manageTokenVersion),
		)
	})

	it('rotating bumps the token version so the old link stops working and the new email carries the new one', async () => {
		const id = await booked()
		const before = await reload(id)
		const oldToken = deriveManageToken(ORG, id, before.manageTokenVersion)
		await sleep(5)
		const result = await resend(id, true)
		expect(result.rotated).toBe(true)
		const after = await reload(id)
		expect(after.manageTokenVersion).toBe(before.manageTokenVersion + 1)
		expect(after.version).toBe(before.version + 1)
		expect(verifyManageToken(ORG, id, after.manageTokenVersion, oldToken)).toBe(
			false,
		)
		const newToken = deriveManageToken(ORG, id, after.manageTokenVersion)
		expect(verifyManageToken(ORG, id, after.manageTokenVersion, newToken)).toBe(
			true,
		)
		const html = mails()[0]!.html
		expect(html).toContain(newToken)
		expect(html).not.toContain(oldToken)
	})

	it('records a confirmation_resent event with the rotation flag and message count only', async () => {
		const id = await booked()
		await sleep(5)
		await resend(id, true)
		const event = (await events(id)).find(
			(e) => e.type === 'confirmation_resent',
		)
		expect(event).toMatchObject({
			actorKind: 'operator',
			actorId: OPERATOR,
			data: { rotated: true, messages: 1 },
		})
	})

	it.each([
		'cancelled',
		'no_show',
		'seated',
		'finished',
		'declined',
		'expired',
	] as const)(
		'refuses a %s booking with 409 invalid_state_for_resend',
		async (status) => {
			const id = await booked()
			await db
				.update(rsvReservations)
				.set({ status })
				.where(eq(rsvReservations.id, id))
			await expect(resend(id)).rejects.toMatchObject({
				status: 409,
				code: 'invalid_state_for_resend',
			})
			expect(sent.email).not.toHaveBeenCalled()
			expect(await msgs(id, 'confirmation')).toHaveLength(1)
		},
	)

	it('refuses a guest with no contact with 409 no_destination and rolls the rotation back', async () => {
		const id = await booked({
			email: null,
			phone: null,
			firstName: 'Walk',
			lastName: 'Up',
		})
		const before = await reload(id)
		await expect(resend(id, true)).rejects.toMatchObject({
			status: 409,
			code: 'no_destination',
		})
		const after = await reload(id)
		expect(after.manageTokenVersion).toBe(before.manageTokenVersion)
		expect(after.version).toBe(before.version)
		expect(
			(await events(id)).some((e) => e.type === 'confirmation_resent'),
		).toBe(false)
	})

	it('answers 404 for an unknown reservation', async () => {
		await expect(resend('rsv_missing')).rejects.toMatchObject({ status: 404 })
	})

	it('uses the saved language of the reservation', async () => {
		const id = await booked({ locale: 'ar' })
		await sleep(5)
		await resend(id)
		expect(mails()[0]!.html).toContain('dir="rtl"')
	})
})

describe('large-party requests', () => {
	const guest = {
		firstName: 'Rana',
		lastName: 'Haddad',
		phone: PHONE,
		email: EMAIL,
		locale: 'en',
	}
	function request(locale = 'en') {
		return createLargePartyRequest({
			orgId: ORG,
			locationId: PUBLIC_LOC,
			client: 'web',
			channel: 'online',
			customerId: null,
			ipHash: 'iphash',
			idempotencyKey: `idem-req-${++idem}`,
			requestHash: `hash-${idem}`,
			input: {
				guest: { ...guest, locale },
				smsOptIn: false,
				marketing: false,
				slot: { date: dateAhead(5), localMin: 19 * 60, partySize: 8 },
			},
		})
	}

	it('acknowledges the request to the guest and alerts the managers with ids and a count only', async () => {
		const { reservationId } = await request()
		expect((await reload(reservationId)).status).toBe('pending_approval')
		expect(await msgs(reservationId, 'request_received')).toHaveLength(1)
		expect(mails()).toHaveLength(1)
		expect(mails()[0]).toMatchObject({ to: EMAIL })

		const rows = await db.select().from(rsvOutbox).all()
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			kind: 'manager_alert',
			status: 'pending',
			dedupeKey: `large_party_request:${reservationId}`,
		})
		expect(rows[0]!.payload).toEqual({
			orgId: ORG,
			eventId: expect.stringMatching(/^evt_/),
			kind: 'large_party_request',
			locationId: PUBLIC_LOC,
			count: 1,
		})
		expect(JSON.stringify(rows[0]!.payload)).not.toContain('Rana')
		expect(JSON.stringify(rows[0]!.payload)).not.toContain(reservationId)
	})

	it('does not schedule reminders for a request that is still pending', async () => {
		const { reservationId } = await request()
		expect(
			(await msgs(reservationId)).filter((m) => m.kind === 'reminder'),
		).toHaveLength(0)
	})

	it('writes the acknowledgement in the guest language', async () => {
		await request('ar')
		expect(mails()[0]!.html).toContain('dir="rtl"')
	})

	it('approving books it, sends the approval and schedules the reminder', async () => {
		const { reservationId } = await request()
		sent.email.mockClear()
		await approveReservationRequest({
			orgId: ORG,
			reservationId,
			actorId: OPERATOR,
		})
		expect((await reload(reservationId)).status).toBe('booked')
		expect(await msgs(reservationId, 'request_approved')).toHaveLength(1)
		expect(mails()).toHaveLength(1)
		const reminders = await msgs(reservationId, 'reminder')
		expect(reminders).toHaveLength(1)
		expect(reminders[0]!.status).toBe('pending')
	})

	it('approving twice answers 409 and sends one approval', async () => {
		const { reservationId } = await request()
		await approveReservationRequest({
			orgId: ORG,
			reservationId,
			actorId: OPERATOR,
		})
		await expect(
			approveReservationRequest({
				orgId: ORG,
				reservationId,
				actorId: OPERATOR,
			}),
		).rejects.toMatchObject({ status: 409 })
		expect(await msgs(reservationId, 'request_approved')).toHaveLength(1)
	})

	it('declining sends the decline and never schedules a reminder', async () => {
		const { reservationId } = await request()
		sent.email.mockClear()
		await declineReservationRequest({
			orgId: ORG,
			reservationId,
			actorId: OPERATOR,
			reason: 'fully booked',
		})
		expect((await reload(reservationId)).status).toBe('declined')
		expect(await msgs(reservationId, 'request_declined')).toHaveLength(1)
		expect(mails()).toHaveLength(1)
		expect((await msgs(reservationId)).some((m) => m.kind === 'reminder')).toBe(
			false,
		)
	})

	it('does not put the operator reason in the guest email', async () => {
		const { reservationId } = await request()
		sent.email.mockClear()
		await declineReservationRequest({
			orgId: ORG,
			reservationId,
			actorId: OPERATOR,
			reason: 'VIP-INTERNAL-REASON',
		})
		expect(mails()[0]!.html).not.toContain('VIP-INTERNAL-REASON')
	})

	it('declining a request that was already approved answers 409 and sends nothing more', async () => {
		const { reservationId } = await request()
		await approveReservationRequest({
			orgId: ORG,
			reservationId,
			actorId: OPERATOR,
		})
		sent.email.mockClear()
		await expect(
			declineReservationRequest({
				orgId: ORG,
				reservationId,
				actorId: OPERATOR,
			}),
		).rejects.toMatchObject({ status: 409 })
		expect(sent.email).not.toHaveBeenCalled()
	})
})

describe('expiry sweep', () => {
	async function expiredRequest(deadlineOffsetMs: number) {
		const guest = await insertGuest(db, { emailNorm: EMAIL })
		const startAt = atHour(5, 19)
		return insertReservation(db, {
			guestId: guest.id,
			status: 'pending_approval',
			startAt,
			requestDeadlineAt: Date.now() + deadlineOffsetMs,
		})
	}
	const touch = (date: string) =>
		withReservationWrite(
			{ orgId: ORG, locationId: PUBLIC_LOC, dates: date, now: Date.now() },
			async () => 'ok',
		)

	it('declines an expired request to the guest in the same write that sweeps it', async () => {
		const rsv = await expiredRequest(-MINUTE)
		await touch(rsv.businessDate)
		expect((await reload(rsv.id)).status).toBe('expired')
		const declined = await msgs(rsv.id, 'request_declined')
		expect(declined).toHaveLength(1)
		expect(declined[0]!.status).toBe('sent')
		expect(mails()).toHaveLength(1)
		expect(mails()[0]!.to).toBe(EMAIL)
	})

	it('sweeps from a write on an unrelated day too', async () => {
		const rsv = await expiredRequest(-MINUTE)
		await touch(dateAhead(20))
		expect((await reload(rsv.id)).status).toBe('expired')
		expect(await msgs(rsv.id, 'request_declined')).toHaveLength(1)
	})

	it('leaves a request whose deadline is still ahead alone', async () => {
		const rsv = await expiredRequest(HOUR)
		await touch(rsv.businessDate)
		expect((await reload(rsv.id)).status).toBe('pending_approval')
		expect(await msgs(rsv.id)).toHaveLength(0)
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('declines each expired request once, however many writes follow', async () => {
		const rsv = await expiredRequest(-MINUTE)
		await touch(rsv.businessDate)
		await touch(rsv.businessDate)
		await touch(rsv.businessDate)
		expect(await msgs(rsv.id, 'request_declined')).toHaveLength(1)
		expect(mails()).toHaveLength(1)
	})

	it('sweeping with the decline switched off still expires the request quietly', async () => {
		await setMessaging(db, { kinds: { request_declined: false } })
		const rsv = await expiredRequest(-MINUTE)
		await touch(rsv.businessDate)
		expect((await reload(rsv.id)).status).toBe('expired')
		expect(await msgs(rsv.id)).toHaveLength(0)
	})
})

describe('reminders follow every write', () => {
	it('a write on the day creates the reminder for a booking that was inserted directly', async () => {
		const guest = await insertGuest(db, { emailNorm: EMAIL })
		const startAt = atHour(4, 19)
		const rsv = await insertReservation(db, { guestId: guest.id, startAt })
		expect(await msgs(rsv.id)).toHaveLength(0)
		await withReservationWrite(
			{
				orgId: ORG,
				locationId: PUBLIC_LOC,
				dates: rsv.businessDate,
				now: Date.now(),
			},
			async () => undefined,
		)
		const [reminder] = await msgs(rsv.id, 'reminder')
		expect(reminder).toMatchObject({
			status: 'pending',
			sendAt: startAt - 24 * HOUR,
		})
	})

	it('a write on another day leaves it untouched', async () => {
		const guest = await insertGuest(db, { emailNorm: EMAIL })
		const rsv = await insertReservation(db, {
			guestId: guest.id,
			startAt: atHour(4, 19),
		})
		await withReservationWrite(
			{
				orgId: ORG,
				locationId: PUBLIC_LOC,
				dates: dateAhead(9),
				now: Date.now(),
			},
			async () => undefined,
		)
		expect(await msgs(rsv.id)).toHaveLength(0)
	})

	it('a write that fails rolls the queued messages back with it', async () => {
		const guest = await insertGuest(db, { emailNorm: EMAIL })
		const rsv = await insertReservation(db, {
			guestId: guest.id,
			startAt: atHour(4, 19),
		})
		await expect(
			withReservationWrite(
				{
					orgId: ORG,
					locationId: PUBLIC_LOC,
					dates: rsv.businessDate,
					now: Date.now(),
				},
				async () => {
					throw new Error('boom')
				},
			),
		).rejects.toThrow('boom')
		expect(await msgs(rsv.id)).toHaveLength(0)
	})
})

describe('availability increased marker', () => {
	async function dayVersion(date: string) {
		return db
			.select()
			.from(rsvDayVersions)
			.where(
				and(
					eq(rsvDayVersions.locationId, PUBLIC_LOC),
					eq(rsvDayVersions.businessDate, date),
				),
			)
			.get()
	}

	it('is stamped when a write touches a day someone is waiting on', async () => {
		const { reservation } = await operatorBooking()
		await insertNotifyRequest(db, {
			businessDate: reservation.date ?? dateAhead(3),
		})
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: reservation.id,
			actorId: OPERATOR,
			input: { status: 'cancelled' },
		})
		const row = await dayVersion(dateAhead(3))
		expect(row?.availabilityIncreasedAt).toEqual(expect.any(Number))
	})

	it('stays empty when nobody is waiting on that day', async () => {
		const { reservation } = await operatorBooking()
		await insertNotifyRequest(db, { businessDate: dateAhead(8) })
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: reservation.id,
			actorId: OPERATOR,
			input: { status: 'cancelled' },
		})
		const row = await dayVersion(dateAhead(3))
		expect(row?.availabilityIncreasedAt ?? null).toBeNull()
	})

	it('ignores a notify request that is already booked or expired', async () => {
		const { reservation } = await operatorBooking()
		await insertNotifyRequest(db, {
			businessDate: dateAhead(3),
			status: 'booked',
		})
		await insertNotifyRequest(db, {
			businessDate: dateAhead(3),
			status: 'expired',
		})
		await transitionReservationStatus({
			orgId: ORG,
			reservationId: reservation.id,
			actorId: OPERATOR,
			input: { status: 'cancelled' },
		})
		expect(
			(await dayVersion(dateAhead(3)))?.availabilityIncreasedAt ?? null,
		).toBeNull()
	})
})

describe('public guest actions', () => {
	const guest = {
		firstName: 'Rana',
		lastName: 'Haddad',
		phone: PHONE,
		email: EMAIL,
		locale: 'en',
	}

	async function holdAndBook(
		options: { locale?: string; smsOptIn?: boolean; partySize?: number } = {},
	) {
		const token = newHoldToken()
		await createHold({
			orgId: ORG,
			locationId: PUBLIC_LOC,
			slot: {
				date: dateAhead(3),
				localMin: 19 * 60,
				partySize: options.partySize ?? 2,
			},
			tokenHash: hashHoldToken(token),
			source: 'web',
			ipHash: 'iphash',
		})
		const { reservationId } = await bookFromHold({
			orgId: ORG,
			holdTokenHash: hashHoldToken(token),
			input: {
				guest: { ...guest, locale: options.locale ?? 'en' },
				smsOptIn: options.smsOptIn ?? false,
				marketing: false,
			},
			client: 'web',
			channel: 'online',
			customerId: null,
			ipHash: 'iphash',
			idempotencyKey: `idem-hold-${++idem}`,
			requestHash: `hash-${idem}`,
		})
		return reservationId
	}

	it('booking from a hold sends the confirmation and schedules the reminder', async () => {
		const id = await holdAndBook()
		expect(await msgs(id, 'confirmation')).toHaveLength(1)
		expect(mails()).toHaveLength(1)
		expect(mails()[0]).toMatchObject({ to: EMAIL })
		expect(await msgs(id, 'reminder')).toHaveLength(1)
	})

	it('writes the confirmation in the language the guest chose', async () => {
		const id = await holdAndBook({ locale: 'ar' })
		expect((await msgs(id, 'confirmation'))[0]!.locale).toBe('ar')
		expect(mails()[0]!.html).toContain('dir="rtl"')
	})

	it('also texts a guest who opted in to SMS', async () => {
		const id = await holdAndBook({ smsOptIn: true })
		expect(await kinds(id)).toEqual(
			expect.arrayContaining([
				'confirmation:email:sent',
				'confirmation:sms:sent',
			]),
		)
		expect(sent.sms).toHaveBeenCalledTimes(1)
		expect(sent.sms.mock.calls[0]![0]).toMatchObject({ to: PHONE })
	})

	it('the guest cancelling sends the guest cancellation and stops the reminder', async () => {
		const id = await holdAndBook()
		sent.email.mockClear()
		await guestCancelReservation({ orgId: ORG, reservationId: id })
		expect((await reload(id)).status).toBe('cancelled')
		expect(await msgs(id, 'cancellation_guest')).toHaveLength(1)
		expect(await msgs(id, 'cancellation_restaurant')).toHaveLength(0)
		expect(mails()).toHaveLength(1)
		expect(
			(await msgs(id, 'reminder')).every((m) => m.status === 'cancelled'),
		).toBe(true)
	})

	it('cancelling twice sends one cancellation', async () => {
		const id = await holdAndBook()
		await guestCancelReservation({ orgId: ORG, reservationId: id })
		await guestCancelReservation({ orgId: ORG, reservationId: id })
		expect(await msgs(id, 'cancellation_guest')).toHaveLength(1)
	})

	it('the guest changing the time sends a modification, bumps the schedule and retimes the reminder', async () => {
		const id = await holdAndBook()
		sent.email.mockClear()
		const before = await reload(id)
		await guestModifyReservation({
			orgId: ORG,
			reservationId: id,
			input: { localMin: 20 * 60 },
		})
		const after = await reload(id)
		expect(after.scheduleVersion).toBe(before.scheduleVersion + 1)
		expect(after.localStartMin).toBe(20 * 60)
		expect(await msgs(id, 'modification')).toHaveLength(1)
		expect(mails()).toHaveLength(1)
		const live = (await msgs(id, 'reminder')).filter(
			(m) => m.status === 'pending',
		)
		expect(live).toHaveLength(1)
		expect(live[0]!.sendAt).toBe(atHour(3, 20) - 24 * HOUR)
	})

	it('a refused change sends nothing', async () => {
		const id = await holdAndBook()
		sent.email.mockClear()
		await expect(
			guestModifyReservation({
				orgId: ORG,
				reservationId: id,
				input: { localMin: 3 * 60 },
			}),
		).rejects.toBeTruthy()
		expect(sent.email).not.toHaveBeenCalled()
		expect(await msgs(id, 'modification')).toHaveLength(0)
	})
})

describe('erasing a guest', () => {
	async function guestWithBookings() {
		const guest = await insertGuest(db, {
			firstName: 'Rana',
			lastName: 'Haddad',
			emailNorm: EMAIL,
			phoneE164: PHONE,
		})
		const upcoming = await insertReservation(db, {
			guestId: guest.id,
			startAt: Date.now() + 3 * 24 * HOUR,
			guestRequests: 'allergic to sesame',
		})
		const past = await insertReservation(db, {
			guestId: guest.id,
			status: 'finished',
			startAt: Date.now() - 10 * 24 * HOUR,
			guestRequests: 'birthday',
		})
		return { guest, upcoming, past }
	}
	const erase = (guestId: string) =>
		eraseGuestProfile({ db, orgId: ORG, guestId, actorId: OPERATOR })

	it('tells the guest their upcoming booking is cancelled, using the real address and name, before anonymizing', async () => {
		const { guest, upcoming } = await guestWithBookings()
		const result = await erase(guest.id)
		expect(result).toMatchObject({
			erased: true,
			cancelledFutureReservations: 1,
		})
		expect(mails()).toHaveLength(1)
		expect(mails()[0]!.to).toBe(EMAIL)
		expect(mails()[0]!.html).toContain('Rana')
		const [notice] = await msgs(upcoming.id, 'cancellation_restaurant')
		expect(notice).toMatchObject({ status: 'sent', channel: 'email' })
		const after = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, guest.id))
			.get()
		expect(after).toMatchObject({
			firstName: 'Erased',
			emailNorm: null,
			phoneE164: null,
		})
		expect(after!.erasedAt).toEqual(expect.any(Number))
	})

	it('cancels the upcoming booking and its pending reminders', async () => {
		const { guest, upcoming } = await guestWithBookings()
		await withReservationWrite(
			{
				orgId: ORG,
				locationId: PUBLIC_LOC,
				dates: upcoming.businessDate,
				now: Date.now(),
			},
			async () => undefined,
		)
		expect(
			(await msgs(upcoming.id, 'reminder')).some((m) => m.status === 'pending'),
		).toBe(true)
		await erase(guest.id)
		const row = await reload(upcoming.id)
		expect(row).toMatchObject({
			status: 'cancelled',
			cancelReason: 'guest_erased',
			guestRequests: null,
		})
		expect(
			(await msgs(upcoming.id, 'reminder')).every(
				(m) => m.status === 'cancelled',
			),
		).toBe(true)
	})

	it('keeps the history of past bookings but scrubs their notes', async () => {
		const { guest, past } = await guestWithBookings()
		await erase(guest.id)
		const row = await reload(past.id)
		expect(row.status).toBe('finished')
		expect(row.guestRequests).toBeNull()
		expect(await msgs(past.id)).toHaveLength(0)
	})

	it('a failing send does not block the erasure', async () => {
		sent.email.mockRejectedValue(new Error('provider down'))
		const { guest, upcoming } = await guestWithBookings()
		const result = await erase(guest.id)
		expect(result.erased).toBe(true)
		expect((await reload(upcoming.id)).status).toBe('cancelled')
		const after = await db
			.select()
			.from(rsvGuests)
			.where(eq(rsvGuests.id, guest.id))
			.get()
		expect(after!.emailNorm).toBeNull()
	})

	it('a provider error result does not block the erasure either', async () => {
		sent.email.mockResolvedValue({ status: 'error', error: 'rejected' })
		const { guest } = await guestWithBookings()
		expect((await erase(guest.id)).erased).toBe(true)
	})

	it('sends nothing for a guest with only past bookings', async () => {
		const guest = await insertGuest(db, { emailNorm: EMAIL })
		await insertReservation(db, {
			guestId: guest.id,
			status: 'finished',
			startAt: Date.now() - 5 * 24 * HOUR,
		})
		expect((await erase(guest.id)).cancelledFutureReservations).toBe(0)
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('sends nothing when the cancellation notice is switched off, and still erases', async () => {
		await setMessaging(db, { kinds: { cancellation_restaurant: false } })
		const { guest, upcoming } = await guestWithBookings()
		expect((await erase(guest.id)).erased).toBe(true)
		expect(sent.email).not.toHaveBeenCalled()
		expect(await msgs(upcoming.id, 'cancellation_restaurant')).toHaveLength(0)
	})

	it('sends one notice per upcoming booking', async () => {
		const { guest } = await guestWithBookings()
		const second = await insertReservation(db, {
			guestId: guest.id,
			startAt: Date.now() + 6 * 24 * HOUR,
		})
		await erase(guest.id)
		expect(mails()).toHaveLength(2)
		expect(await msgs(second.id, 'cancellation_restaurant')).toHaveLength(1)
	})

	it('erasing twice does not notify again', async () => {
		const { guest } = await guestWithBookings()
		await erase(guest.id)
		sent.email.mockClear()
		await erase(guest.id)
		expect(sent.email).not.toHaveBeenCalled()
	})

	it('leaves no message row carrying the guest name or address', async () => {
		const { guest } = await guestWithBookings()
		await erase(guest.id)
		const rows = await db.select().from(rsvMessages).all()
		const text = JSON.stringify(rows)
		expect(text).not.toContain(EMAIL)
		expect(text).not.toContain('Haddad')
		expect(text).not.toContain(PHONE)
		await getMessage(db, rows[0]!.id)
	})
})

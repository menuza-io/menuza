import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	rsvMessages,
	rsvReservations,
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

import { resetReservationsContextCache } from '../lib/reservations-context.ts'
import {
	PUBLIC_LOC,
	seedPublicOrg,
} from '../routes/reservations-public-fixture.ts'
import {
	cancelPendingReservationMessages,
	deliverAfterCommit,
	enqueueNotifyMessage,
	enqueueReservationMessage,
	enqueueWaitlistMessage,
	reconcileScheduledMessages,
} from './rsv-message-queue.ts'
import {
	HOUR,
	insertGuest,
	insertNotifyRequest,
	insertReservation,
	insertWaitlistEntry,
	messagesFor,
	NOW,
	setMessaging,
} from './rsv-message-fixture.ts'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-msg-queue-'))
process.env.TENANT_DB_DIR = TEST_DIR
process.env.AUTH_HMAC_SECRET = 'test-msg-queue-auth-hmac-secret-0123456789'
process.env.JWT_SECRET = 'test-msg-queue-customer-jwt-secret-123456'

const ORG = 'org_msg_queue'
const CTX = { orgId: ORG, now: NOW }
const BOOKING_DATE = '2031-06-13'

let db: TenantDatabase

function region(value: 'us' | 'ksa') {
	process.env.DATA_REGION = value
}

async function reconcile(now = NOW, dates: string[] = [BOOKING_DATE]) {
	await reconcileScheduledMessages(
		db,
		{ orgId: ORG, now },
		{ locationId: PUBLIC_LOC, dates },
	)
}

async function scheduled(reservationId: string) {
	const rows = await messagesFor(db, reservationId)
	return rows.filter(
		(r) => r.kind === 'reminder' || r.kind === 'reconfirm_request',
	)
}

beforeEach(async () => {
	region('us')
	sent.email.mockReset()
	sent.sms.mockReset()
	sent.email.mockResolvedValue({ status: 'success', data: { messageId: 'm' } })
	sent.sms.mockResolvedValue({ success: true, mock: true })
	await destroyTenantDb(ORG).catch(() => undefined)
	resetReservationsContextCache()
	db = await seedPublicOrg(ORG)
})

afterEach(() => {
	vi.useRealTimers()
})

afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('enqueueReservationMessage', () => {
	it('queues one pending email row due now, keyed by reservation, kind, channel and schedule version', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, {
			guestId: guest.id,
			guestLocale: 'ar',
		})
		const ids = await enqueueReservationMessage(db, CTX, {
			reservationId: rsv.id,
			kind: 'confirmation',
		})
		expect(ids).toHaveLength(1)
		const rows = await messagesFor(db, rsv.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			id: ids[0],
			kind: 'confirmation',
			channel: 'email',
			category: 'transactional',
			locale: 'ar',
			locationId: PUBLIC_LOC,
			status: 'pending',
			attempts: 0,
			sendAt: NOW,
			nextAttemptAt: NOW,
			dedupeKey: `res:${rsv.id}:confirmation:email:1`,
		})
	})

	it('never copies the guest destination onto the row', async () => {
		const guest = await insertGuest(db, {
			emailNorm: 'secret.person@example.com',
			phoneE164: '+14155550177',
		})
		const rsv = await insertReservation(db, {
			guestId: guest.id,
			smsOptIn: true,
		})
		await enqueueReservationMessage(db, CTX, {
			reservationId: rsv.id,
			kind: 'confirmation',
		})
		const dump = JSON.stringify(await messagesFor(db, rsv.id))
		expect(dump).not.toContain('secret.person')
		expect(dump).not.toContain('4155550177')
	})

	it('is idempotent per schedule version and starts a new key when the version moves', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		const first = await enqueueReservationMessage(db, CTX, {
			reservationId: rsv.id,
			kind: 'modification',
		})
		const again = await enqueueReservationMessage(db, CTX, {
			reservationId: rsv.id,
			kind: 'modification',
		})
		expect(first).toHaveLength(1)
		expect(again).toEqual([])
		expect(await messagesFor(db, rsv.id, 'modification')).toHaveLength(1)

		await db
			.update(rsvReservations)
			.set({ scheduleVersion: 2 })
			.where(eq(rsvReservations.id, rsv.id))
		const next = await enqueueReservationMessage(db, CTX, {
			reservationId: rsv.id,
			kind: 'modification',
		})
		expect(next).toHaveLength(1)
		const keys = (await messagesFor(db, rsv.id, 'modification')).map(
			(r) => r.dedupeKey,
		)
		expect(keys).toEqual([
			`res:${rsv.id}:modification:email:1`,
			`res:${rsv.id}:modification:email:2`,
		])
	})

	it('treats each variant as a separate deliberate send', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		const a = await enqueueReservationMessage(db, CTX, {
			reservationId: rsv.id,
			kind: 'confirmation',
			variant: 'r1',
			force: true,
		})
		const b = await enqueueReservationMessage(db, CTX, {
			reservationId: rsv.id,
			kind: 'confirmation',
			variant: 'r2',
			force: true,
		})
		const repeat = await enqueueReservationMessage(db, CTX, {
			reservationId: rsv.id,
			kind: 'confirmation',
			variant: 'r2',
			force: true,
		})
		expect(a).toHaveLength(1)
		expect(b).toHaveLength(1)
		expect(repeat).toEqual([])
		const keys = (await messagesFor(db, rsv.id)).map((r) => r.dedupeKey)
		expect(keys).toEqual([
			`res:${rsv.id}:confirmation:email:1.r1`,
			`res:${rsv.id}:confirmation:email:1.r2`,
		])
	})

	it('queues nothing when the kind is switched off, unless the operator forces it', async () => {
		await setMessaging(db, { kinds: { confirmation: false } })
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		expect(
			await enqueueReservationMessage(db, CTX, {
				reservationId: rsv.id,
				kind: 'confirmation',
			}),
		).toEqual([])
		expect(
			await enqueueReservationMessage(db, CTX, {
				reservationId: rsv.id,
				kind: 'confirmation',
				force: true,
			}),
		).toHaveLength(1)
		// Other kinds are unaffected by one switch.
		expect(
			await enqueueReservationMessage(db, CTX, {
				reservationId: rsv.id,
				kind: 'cancellation_guest',
			}),
		).toHaveLength(1)
	})

	it('queues nothing for a missing reservation or an erased guest', async () => {
		expect(
			await enqueueReservationMessage(db, CTX, {
				reservationId: 'rsv_missing',
				kind: 'confirmation',
			}),
		).toEqual([])
		const guest = await insertGuest(db, {
			erasedAt: NOW - HOUR,
			emailNorm: null,
		})
		const rsv = await insertReservation(db, { guestId: guest.id })
		expect(
			await enqueueReservationMessage(db, CTX, {
				reservationId: rsv.id,
				kind: 'confirmation',
				force: true,
			}),
		).toEqual([])
	})

	it('queues nothing when the guest has no way to be reached', async () => {
		const guest = await insertGuest(db, { emailNorm: null, phoneE164: null })
		const rsv = await insertReservation(db, {
			guestId: guest.id,
			smsOptIn: true,
		})
		expect(
			await enqueueReservationMessage(db, CTX, {
				reservationId: rsv.id,
				kind: 'confirmation',
			}),
		).toEqual([])
	})

	describe('channels', () => {
		it('adds an SMS row on the US node only for an opted-in guest with a phone', async () => {
			const guest = await insertGuest(db, { phoneE164: '+14155550101' })
			const rsv = await insertReservation(db, {
				guestId: guest.id,
				smsOptIn: true,
			})
			await enqueueReservationMessage(db, CTX, {
				reservationId: rsv.id,
				kind: 'confirmation',
			})
			const rows = await messagesFor(db, rsv.id)
			expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'sms'])
			expect(rows.map((r) => r.dedupeKey).sort()).toEqual([
				`res:${rsv.id}:confirmation:email:1`,
				`res:${rsv.id}:confirmation:sms:1`,
			])
		})

		it('stays email only without opt-in, without a phone, or with SMS switched off for the location', async () => {
			const phoneGuest = await insertGuest(db, { phoneE164: '+14155550102' })
			const noOptIn = await insertReservation(db, { guestId: phoneGuest.id })
			const noPhoneGuest = await insertGuest(db)
			const noPhone = await insertReservation(db, {
				guestId: noPhoneGuest.id,
				smsOptIn: true,
			})
			const smsOff = await insertReservation(db, {
				guestId: phoneGuest.id,
				smsOptIn: true,
			})
			for (const rsv of [noOptIn, noPhone]) {
				await enqueueReservationMessage(db, CTX, {
					reservationId: rsv.id,
					kind: 'confirmation',
				})
			}
			await setMessaging(db, { smsEnabled: false })
			await enqueueReservationMessage(db, CTX, {
				reservationId: smsOff.id,
				kind: 'confirmation',
			})
			for (const rsv of [noOptIn, noPhone, smsOff]) {
				const rows = await messagesFor(db, rsv.id)
				expect(rows.map((r) => r.channel)).toEqual(['email'])
			}
		})

		it('sends SMS only for a guest with a phone and no email on the US node', async () => {
			const guest = await insertGuest(db, {
				emailNorm: null,
				phoneE164: '+14155550103',
			})
			const rsv = await insertReservation(db, {
				guestId: guest.id,
				smsOptIn: true,
			})
			await enqueueReservationMessage(db, CTX, {
				reservationId: rsv.id,
				kind: 'confirmation',
			})
			expect((await messagesFor(db, rsv.id)).map((r) => r.channel)).toEqual([
				'sms',
			])
		})

		it('uses email only on the KSA node, even with opt-in and a phone', async () => {
			region('ksa')
			const guest = await insertGuest(db, { phoneE164: '+966555000111' })
			const rsv = await insertReservation(db, {
				guestId: guest.id,
				smsOptIn: true,
			})
			await enqueueReservationMessage(db, CTX, {
				reservationId: rsv.id,
				kind: 'confirmation',
			})
			expect((await messagesFor(db, rsv.id)).map((r) => r.channel)).toEqual([
				'email',
			])

			const smsOnly = await insertGuest(db, {
				emailNorm: null,
				phoneE164: '+966555000222',
			})
			const rsv2 = await insertReservation(db, {
				guestId: smsOnly.id,
				smsOptIn: true,
			})
			expect(
				await enqueueReservationMessage(db, CTX, {
					reservationId: rsv2.id,
					kind: 'confirmation',
				}),
			).toEqual([])
			expect(await messagesFor(db, rsv2.id)).toEqual([])
		})
	})

	it('never delays an immediate kind for quiet hours', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		const lateNight = Date.UTC(2031, 5, 10, 23, 45)
		const ids = await enqueueReservationMessage(
			db,
			{ orgId: ORG, now: lateNight },
			{ reservationId: rsv.id, kind: 'cancellation_restaurant' },
		)
		expect(ids).toHaveLength(1)
		const rows = await messagesFor(db, rsv.id, 'cancellation_restaurant')
		expect(rows[0]!.sendAt).toBe(lateNight)
		expect(rows[0]!.nextAttemptAt).toBe(lateNight)
	})

	it('falls back to the guest locale when the reservation has none', async () => {
		const guest = await insertGuest(db, { locale: 'ar' })
		const rsv = await insertReservation(db, {
			guestId: guest.id,
			guestLocale: '',
		})
		await enqueueReservationMessage(db, CTX, {
			reservationId: rsv.id,
			kind: 'confirmation',
		})
		expect((await messagesFor(db, rsv.id))[0]!.locale).toBe('ar')
	})
})

describe('deliverAfterCommit', () => {
	it('registers a hook only when some row is already due and a hook sink exists', () => {
		const afterCommit = vi.fn()
		deliverAfterCommit({ orgId: ORG, now: NOW, afterCommit }, [
			{ id: 'later', sendAt: NOW + HOUR },
		])
		expect(afterCommit).not.toHaveBeenCalled()
		deliverAfterCommit({ orgId: ORG, now: NOW }, [{ id: 'due', sendAt: NOW }])
		deliverAfterCommit({ orgId: ORG, now: NOW, afterCommit }, [])
		expect(afterCommit).not.toHaveBeenCalled()
		deliverAfterCommit({ orgId: ORG, now: NOW, afterCommit }, [
			{ id: 'due', sendAt: NOW },
			{ id: 'later', sendAt: NOW + HOUR },
		])
		expect(afterCommit).toHaveBeenCalledTimes(1)
	})

	it('sends the queued row once the hook runs, and the write itself never sends', async () => {
		const guest = await insertGuest(db, { emailNorm: 'hook@example.com' })
		const rsv = await insertReservation(db, { guestId: guest.id })
		const now = Date.now() - 1000
		const hooks: Array<() => void | Promise<void>> = []
		const ids = await enqueueReservationMessage(
			db,
			{ orgId: ORG, now, afterCommit: (hook) => hooks.push(hook) },
			{ reservationId: rsv.id, kind: 'confirmation' },
		)
		expect(ids).toHaveLength(1)
		expect(hooks).toHaveLength(1)
		expect(sent.email).not.toHaveBeenCalled()
		await hooks[0]!()
		expect(sent.email).toHaveBeenCalledTimes(1)
		expect(sent.email.mock.calls[0]![0].to).toBe('hook@example.com')
		expect((await messagesFor(db, rsv.id))[0]!.status).toBe('sent')
	})

	it('swallows a delivery failure so the write is not failed', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		const now = Date.now() - 1000
		const hooks: Array<() => void | Promise<void>> = []
		await enqueueReservationMessage(
			db,
			{ orgId: ORG, now, afterCommit: (hook) => hooks.push(hook) },
			{ reservationId: rsv.id, kind: 'confirmation' },
		)
		sent.email.mockRejectedValue(new Error('boom'))
		await expect(hooks[0]!()).resolves.toBeUndefined()
		const [row] = await messagesFor(db, rsv.id)
		expect(row!.status).toBe('pending')
		expect(row!.attempts).toBe(1)
	})
})

describe('cancelPendingReservationMessages', () => {
	it('cancels pending scheduled rows only, and honors keepVersion', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		await setMessaging(db, { reconfirmEnabled: true })
		await reconcile()
		const rows = await scheduled(rsv.id)
		expect(rows.map((r) => r.kind).sort()).toEqual([
			'reconfirm_request',
			'reminder',
		])
		await enqueueReservationMessage(db, CTX, {
			reservationId: rsv.id,
			kind: 'confirmation',
		})

		expect(
			await cancelPendingReservationMessages(db, rsv.id, ['reminder'], {
				keepVersion: 1,
			}),
		).toBe(0)
		expect(
			await cancelPendingReservationMessages(db, rsv.id, ['reminder']),
		).toBe(1)
		const after = await messagesFor(db, rsv.id)
		expect(after.find((r) => r.kind === 'reminder')!.status).toBe('cancelled')
		expect(after.find((r) => r.kind === 'reconfirm_request')!.status).toBe(
			'pending',
		)
		expect(after.find((r) => r.kind === 'confirmation')!.status).toBe('pending')

		expect(await cancelPendingReservationMessages(db, rsv.id)).toBe(1)
		expect(await cancelPendingReservationMessages(db, rsv.id)).toBe(0)
		expect((await messagesFor(db, rsv.id, 'confirmation'))[0]!.status).toBe(
			'pending',
		)
	})
})

describe('reconcileScheduledMessages', () => {
	it('creates the reminder 24 hours ahead and no reconfirmation by default', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		await reconcile()
		const rows = await scheduled(rsv.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			kind: 'reminder',
			channel: 'email',
			status: 'pending',
			sendAt: rsv.startAt - 24 * HOUR,
			nextAttemptAt: rsv.startAt - 24 * HOUR,
			dedupeKey: `res:${rsv.id}:reminder:email:1`,
		})
	})

	it('creates a reconfirmation 48 hours ahead only for booked reservations when enabled', async () => {
		await setMessaging(db, { reconfirmEnabled: true })
		const guest = await insertGuest(db)
		const booked = await insertReservation(db, { guestId: guest.id })
		const confirmed = await insertReservation(db, {
			guestId: guest.id,
			status: 'confirmed',
		})
		await reconcile()
		const bookedRows = await scheduled(booked.id)
		expect(bookedRows.map((r) => r.kind).sort()).toEqual([
			'reconfirm_request',
			'reminder',
		])
		expect(bookedRows.find((r) => r.kind === 'reconfirm_request')!.sendAt).toBe(
			booked.startAt - 48 * HOUR,
		)
		expect((await scheduled(confirmed.id)).map((r) => r.kind)).toEqual([
			'reminder',
		])
	})

	it('honors the configured lead times', async () => {
		await setMessaging(db, {
			reminderHours: 72,
			reconfirmEnabled: true,
			reconfirmHours: 96,
		})
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, {
			guestId: guest.id,
			startAt: NOW + 6 * 24 * HOUR + 7 * HOUR,
		})
		await reconcile(NOW, [rsv.businessDate])
		const rows = await scheduled(rsv.id)
		expect(rows.find((r) => r.kind === 'reminder')!.sendAt).toBe(
			rsv.startAt - 72 * HOUR,
		)
		expect(rows.find((r) => r.kind === 'reconfirm_request')!.sendAt).toBe(
			rsv.startAt - 96 * HOUR,
		)
	})

	it('is idempotent', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		await reconcile()
		const first = await scheduled(rsv.id)
		await reconcile()
		await reconcile()
		expect(await scheduled(rsv.id)).toEqual(first)
	})

	it('does nothing for an empty date list or other days', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		await reconcile(NOW, [])
		await reconcile(NOW, ['2031-06-20'])
		expect(await scheduled(rsv.id)).toEqual([])
	})

	it('retimes an untouched pending row when the lead time changes', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		await reconcile()
		await setMessaging(db, { reminderHours: 30 })
		await reconcile()
		const rows = await scheduled(rsv.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.sendAt).toBe(rsv.startAt - 30 * HOUR)
		expect(rows[0]!.nextAttemptAt).toBe(rsv.startAt - 30 * HOUR)
		expect(rows[0]!.status).toBe('pending')
	})

	it('leaves a pending row that already began retrying alone', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		await reconcile()
		const [row] = await scheduled(rsv.id)
		await db
			.update(rsvMessages)
			.set({ attempts: 1, nextAttemptAt: row!.sendAt + 5 * 60_000 })
			.where(eq(rsvMessages.id, row!.id))
		await setMessaging(db, { reminderHours: 30 })
		await reconcile()
		const [after] = await scheduled(rsv.id)
		expect(after).toMatchObject({
			sendAt: row!.sendAt,
			attempts: 1,
			nextAttemptAt: row!.sendAt + 5 * 60_000,
		})
	})

	it('never touches a row that was already sent', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		await reconcile()
		const [row] = await scheduled(rsv.id)
		await db
			.update(rsvMessages)
			.set({ status: 'sent', sentAt: NOW })
			.where(eq(rsvMessages.id, row!.id))
		await setMessaging(db, { reminderHours: 30 })
		await reconcile()
		const rows = await scheduled(rsv.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ status: 'sent', sendAt: row!.sendAt })
	})

	it('cancels the old version and creates a new row when the schedule version moves', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		await reconcile()
		const newStart = rsv.startAt + HOUR
		await db
			.update(rsvReservations)
			.set({
				startAt: newStart,
				endAt: newStart + 90 * 60_000,
				scheduleVersion: 2,
			})
			.where(eq(rsvReservations.id, rsv.id))
		await reconcile()
		const rows = await scheduled(rsv.id)
		expect(
			rows.map((r) => [r.dedupeKey.split(':').pop(), r.status, r.sendAt]),
		).toEqual([
			['1', 'cancelled', rsv.startAt - 24 * HOUR],
			['2', 'pending', newStart - 24 * HOUR],
		])
	})

	it('cancels pending rows once the booking is no longer upcoming', async () => {
		await setMessaging(db, { reconfirmEnabled: true })
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		await reconcile()
		expect((await scheduled(rsv.id)).every((r) => r.status === 'pending')).toBe(
			true,
		)
		await db
			.update(rsvReservations)
			.set({ status: 'cancelled' })
			.where(eq(rsvReservations.id, rsv.id))
		await reconcile()
		const rows = await scheduled(rsv.id)
		expect(rows).toHaveLength(2)
		expect(rows.every((r) => r.status === 'cancelled')).toBe(true)
	})

	it('drops the reconfirmation but keeps the reminder when a booking becomes confirmed', async () => {
		await setMessaging(db, { reconfirmEnabled: true })
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		await reconcile()
		await db
			.update(rsvReservations)
			.set({ status: 'confirmed' })
			.where(eq(rsvReservations.id, rsv.id))
		await reconcile()
		const rows = await scheduled(rsv.id)
		expect(rows.find((r) => r.kind === 'reminder')!.status).toBe('pending')
		expect(rows.find((r) => r.kind === 'reconfirm_request')!.status).toBe(
			'cancelled',
		)
	})

	it('cancels when the kind is switched off and revives the row when it is switched back on', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, { guestId: guest.id })
		await reconcile()
		await setMessaging(db, { kinds: { reminder: false } })
		await reconcile()
		expect((await scheduled(rsv.id))[0]!.status).toBe('cancelled')
		await setMessaging(db, { kinds: { reminder: true } })
		await reconcile()
		const rows = await scheduled(rsv.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			status: 'pending',
			attempts: 0,
			sendAt: rsv.startAt - 24 * HOUR,
		})
	})

	it('skips a booking that has already started or is about to', async () => {
		const guest = await insertGuest(db)
		const past = await insertReservation(db, {
			guestId: guest.id,
			startAt: NOW - 2 * HOUR,
			businessDate: '2031-06-10',
		})
		const soon = await insertReservation(db, {
			guestId: guest.id,
			startAt: NOW + 4 * HOUR,
			businessDate: '2031-06-10',
		})
		await reconcile(NOW, ['2031-06-10'])
		expect(await scheduled(past.id)).toEqual([])
		expect(await scheduled(soon.id)).toEqual([])
	})

	it('sends a late booking its reminder right away when the visit is still six hours out', async () => {
		const guest = await insertGuest(db)
		const rsv = await insertReservation(db, {
			guestId: guest.id,
			startAt: NOW + 10 * HOUR,
			businessDate: '2031-06-10',
		})
		await reconcile(NOW, ['2031-06-10'])
		const rows = await scheduled(rsv.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.sendAt).toBe(NOW)
	})

	describe('quiet hours', () => {
		it('moves a reminder that falls in quiet hours out of them, to the start of the window', async () => {
			// 23:00 in Riyadh (UTC+3) the day before is quiet time: 21:00 local = 18:00 UTC.
			const guest = await insertGuest(db)
			const start = Date.UTC(2031, 5, 13, 20, 0)
			const rsv = await insertReservation(db, {
				guestId: guest.id,
				startAt: start,
				timeZone: 'Asia/Riyadh',
				businessDate: '2031-06-13',
			})
			await reconcile()
			const [row] = await scheduled(rsv.id)
			expect(row!.sendAt).toBe(Date.UTC(2031, 5, 12, 18, 0))
			expect(row!.sendAt).toBeLessThan(start - 24 * HOUR)
		})

		it('uses the previous evening for a small-hours target', async () => {
			// 03:00 Riyadh target: moved back to 21:00 Riyadh of the day before.
			const guest = await insertGuest(db)
			const start = Date.UTC(2031, 5, 13, 0, 0)
			const rsv = await insertReservation(db, {
				guestId: guest.id,
				startAt: start,
				timeZone: 'Asia/Riyadh',
				businessDate: '2031-06-13',
			})
			await reconcile()
			const [row] = await scheduled(rsv.id)
			expect(row!.sendAt).toBe(Date.UTC(2031, 5, 11, 18, 0))
		})

		it('leaves a reminder outside quiet hours where it is', async () => {
			const guest = await insertGuest(db)
			const start = Date.UTC(2031, 5, 13, 12, 0)
			const rsv = await insertReservation(db, {
				guestId: guest.id,
				startAt: start,
				timeZone: 'Asia/Riyadh',
				businessDate: '2031-06-13',
			})
			await reconcile()
			expect((await scheduled(rsv.id))[0]!.sendAt).toBe(start - 24 * HOUR)
		})

		it('respects the location quiet-hours setting', async () => {
			const guest = await insertGuest(db)
			// Target 21:30 UTC: inside the default 21:00-08:00 window, outside 23:00-06:00.
			const start = Date.UTC(2031, 5, 13, 21, 30)
			const rsv = await insertReservation(db, {
				guestId: guest.id,
				startAt: start,
				businessDate: '2031-06-13',
			})
			await reconcile()
			expect((await scheduled(rsv.id))[0]!.sendAt).toBe(
				Date.UTC(2031, 5, 12, 21, 0),
			)
			await setMessaging(db, {
				quietHours: { startMin: 23 * 60, endMin: 6 * 60 },
			})
			await reconcile()
			const rows = await scheduled(rsv.id)
			expect(rows).toHaveLength(1)
			expect(rows[0]!.sendAt).toBe(start - 24 * HOUR)
		})
	})

	describe('channels', () => {
		it('adds an SMS reminder only on the US node for an opted-in guest with a phone', async () => {
			const guest = await insertGuest(db, { phoneE164: '+14155550104' })
			const rsv = await insertReservation(db, {
				guestId: guest.id,
				smsOptIn: true,
			})
			await reconcile()
			expect((await scheduled(rsv.id)).map((r) => r.channel).sort()).toEqual([
				'email',
				'sms',
			])
		})

		it('uses email only on the KSA node', async () => {
			region('ksa')
			const guest = await insertGuest(db, { phoneE164: '+966555000333' })
			const rsv = await insertReservation(db, {
				guestId: guest.id,
				smsOptIn: true,
			})
			await reconcile()
			expect((await scheduled(rsv.id)).map((r) => r.channel)).toEqual(['email'])
		})

		it('creates no SMS row when SMS is switched off for the location', async () => {
			await setMessaging(db, { smsEnabled: false })
			const guest = await insertGuest(db, { phoneE164: '+14155550105' })
			const rsv = await insertReservation(db, {
				guestId: guest.id,
				smsOptIn: true,
			})
			await reconcile()
			expect((await scheduled(rsv.id)).map((r) => r.channel)).toEqual(['email'])
		})
	})

	it('creates nothing for an erased guest', async () => {
		const guest = await insertGuest(db, {
			erasedAt: NOW - HOUR,
			emailNorm: null,
		})
		const rsv = await insertReservation(db, { guestId: guest.id })
		await reconcile()
		expect(await scheduled(rsv.id)).toEqual([])
	})
})

describe('enqueueWaitlistMessage', () => {
	it('queues an email row keyed by waitlist entry, kind, channel and milestone', async () => {
		const entry = await insertWaitlistEntry(db, { locale: 'ar' })
		const ids = await enqueueWaitlistMessage(db, CTX, {
			entryId: entry.id,
			kind: 'waitlist_joined',
		})
		expect(ids).toHaveLength(1)
		const [row] = await db.select().from(rsvMessages).all()
		expect(row).toMatchObject({
			waitlistEntryId: entry.id,
			reservationId: null,
			kind: 'waitlist_joined',
			channel: 'email',
			locale: 'ar',
			status: 'pending',
			sendAt: NOW,
			dedupeKey: `wl:${entry.id}:waitlist_joined:email:1`,
		})
		expect(
			await enqueueWaitlistMessage(db, CTX, {
				entryId: entry.id,
				kind: 'waitlist_joined',
			}),
		).toEqual([])
		expect(
			await enqueueWaitlistMessage(db, CTX, {
				entryId: entry.id,
				kind: 'waitlist_ready',
				milestone: 2,
			}),
		).toHaveLength(1)
		expect(await db.select().from(rsvMessages).all()).toHaveLength(2)
	})

	it('respects the kind switch and a missing entry', async () => {
		await setMessaging(db, { kinds: { waitlist_ready: false } })
		const entry = await insertWaitlistEntry(db)
		expect(
			await enqueueWaitlistMessage(db, CTX, {
				entryId: entry.id,
				kind: 'waitlist_ready',
			}),
		).toEqual([])
		expect(
			await enqueueWaitlistMessage(db, CTX, {
				entryId: 'wle_missing',
				kind: 'waitlist_joined',
			}),
		).toEqual([])
	})

	it('adds SMS on the US node for an opted-in entry with a phone, and never on KSA', async () => {
		const entry = await insertWaitlistEntry(db, {
			phoneE164: '+14155550106',
			smsOptIn: true,
		})
		await enqueueWaitlistMessage(db, CTX, {
			entryId: entry.id,
			kind: 'waitlist_joined',
		})
		expect(
			(await db.select().from(rsvMessages).all()).map((r) => r.channel).sort(),
		).toEqual(['email', 'sms'])
		region('ksa')
		const ksa = await insertWaitlistEntry(db, {
			phoneE164: '+966555000444',
			smsOptIn: true,
		})
		await enqueueWaitlistMessage(db, CTX, {
			entryId: ksa.id,
			kind: 'waitlist_joined',
		})
		const ksaRows = (await db.select().from(rsvMessages).all()).filter(
			(r) => r.waitlistEntryId === ksa.id,
		)
		expect(ksaRows.map((r) => r.channel)).toEqual(['email'])
	})

	it('queues nothing for an entry with no contact', async () => {
		const entry = await insertWaitlistEntry(db, {
			emailNorm: null,
			phoneE164: null,
		})
		expect(
			await enqueueWaitlistMessage(db, CTX, {
				entryId: entry.id,
				kind: 'waitlist_joined',
			}),
		).toEqual([])
	})
})

describe('enqueueNotifyMessage', () => {
	it('queues one row per notification milestone', async () => {
		const request = await insertNotifyRequest(db, { locale: 'ar' })
		const first = await enqueueNotifyMessage(db, CTX, {
			requestId: request.id,
			milestone: 1,
		})
		const repeat = await enqueueNotifyMessage(db, CTX, {
			requestId: request.id,
			milestone: 1,
		})
		const second = await enqueueNotifyMessage(db, CTX, {
			requestId: request.id,
			milestone: 2,
		})
		expect(first).toHaveLength(1)
		expect(repeat).toEqual([])
		expect(second).toHaveLength(1)
		const rows = (await db.select().from(rsvMessages).all()).sort((a, b) =>
			a.dedupeKey.localeCompare(b.dedupeKey),
		)
		expect(rows.map((r) => r.dedupeKey)).toEqual([
			`notify:${request.id}:notify_available:email:1`,
			`notify:${request.id}:notify_available:email:2`,
		])
		expect(rows[0]).toMatchObject({
			notifyRequestId: request.id,
			kind: 'notify_available',
			locale: 'ar',
			status: 'pending',
		})
	})

	it('adds SMS for a phone on the US node when SMS is on, and never on KSA', async () => {
		const request = await insertNotifyRequest(db, {
			contactPhoneE164: '+14155550107',
		})
		await enqueueNotifyMessage(db, CTX, { requestId: request.id, milestone: 1 })
		expect(
			(await db.select().from(rsvMessages).all()).map((r) => r.channel).sort(),
		).toEqual(['email', 'sms'])

		await setMessaging(db, { smsEnabled: false })
		await enqueueNotifyMessage(db, CTX, { requestId: request.id, milestone: 2 })
		expect(
			(await db.select().from(rsvMessages).all())
				.filter((r) => r.dedupeKey.endsWith(':2'))
				.map((r) => r.channel),
		).toEqual(['email'])

		await setMessaging(db, {})
		region('ksa')
		await enqueueNotifyMessage(db, CTX, { requestId: request.id, milestone: 3 })
		expect(
			(await db.select().from(rsvMessages).all())
				.filter((r) => r.dedupeKey.endsWith(':3'))
				.map((r) => r.channel),
		).toEqual(['email'])
	})

	it('respects the kind switch and a missing request', async () => {
		await setMessaging(db, { kinds: { notify_available: false } })
		const request = await insertNotifyRequest(db)
		expect(
			await enqueueNotifyMessage(db, CTX, {
				requestId: request.id,
				milestone: 1,
			}),
		).toEqual([])
		expect(
			await enqueueNotifyMessage(db, CTX, {
				requestId: 'nfy_missing',
				milestone: 1,
			}),
		).toEqual([])
	})
})

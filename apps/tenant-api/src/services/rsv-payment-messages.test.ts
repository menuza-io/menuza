import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	destroyTenantDb,
	rsvMessages,
	rsvPayments,
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

const sent = vi.hoisted(() => ({ email: vi.fn(), sms: vi.fn() }))
vi.mock('../lib/tenant-email.ts', () => ({ sendTenantEmail: sent.email }))
vi.mock('@repo/sms', () => ({ sendSms: sent.sms }))

import { resetReservationsContextCache } from '../lib/reservations-context.ts'
import { deriveFeePayToken } from '../lib/reservations-public-auth.ts'
import { withReservationWrite } from '../lib/reservations-write.ts'
import { seedPublicOrg } from '../routes/reservations-public-fixture.ts'
import { deliverDueMessages } from './rsv-message-service.ts'
import { enqueuePaymentMessage } from './rsv-message-queue.ts'
import { insertGuest, insertReservation, NOW } from './rsv-message-fixture.ts'

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-pay-msg-'))
process.env.TENANT_DB_DIR = TEST_DIR
process.env.AUTH_HMAC_SECRET = 'test-pay-msg-auth-hmac-secret-0123456789'
process.env.JWT_SECRET = 'test-pay-msg-customer-jwt-secret-123456'

const ORG = 'org_pay_msg'
let db: TenantDatabase

async function paymentMessage(
	kind: Parameters<typeof enqueuePaymentMessage>[2]['kind'],
	options: {
		smsOptIn?: boolean
		phone?: string | null
		locale?: string
		paymentKind?: 'deposit_charge' | 'no_show_fee_charge' | 'refund'
	} = {},
) {
	const guest = await insertGuest(db, {
		emailNorm: 'rana@example.com',
		phoneE164: options.phone ?? '+14155551234',
		locale: options.locale ?? 'en',
	})
	const reservation = await insertReservation(db, {
		guestId: guest.id,
		smsOptIn: options.smsOptIn ?? false,
		guestLocale: options.locale ?? 'en',
	})
	const paymentId = `pay_msg_${Math.random().toString(36).slice(2, 8)}`
	await db.insert(rsvPayments).values({
		id: paymentId,
		locationId: reservation.locationId,
		reservationId: reservation.id,
		provider: 'stripe',
		kind: options.paymentKind ?? 'deposit_charge',
		amountMinor: 10_000,
		currency: options.locale === 'ar' ? 'SAR' : 'USD',
		status: 'succeeded',
		idempotencyKey: `rsv:${reservation.id}:${paymentId}`,
	})
	const enqueue = () =>
		withReservationWrite({ orgId: ORG, db, now: NOW }, async (tx, helpers) =>
			enqueuePaymentMessage(
				tx,
				{ orgId: ORG, now: NOW, afterCommit: helpers.afterCommit },
				{ reservationId: reservation.id, kind, paymentId },
			),
		)
	await enqueue()
	return { reservation, paymentId, enqueue }
}

beforeEach(async () => {
	process.env.DATA_REGION = 'us'
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
})

afterAll(() => {
	fs.rmSync(TEST_DIR, { recursive: true, force: true })
})

describe('payment messages', () => {
	it('sends payment_received with the amount and the manage link (VAL-PAY-021)', async () => {
		const { reservation } = await paymentMessage('payment_received')
		await deliverDueMessages(ORG, { db, now: NOW })
		expect(sent.email).toHaveBeenCalledTimes(1)
		const mail = sent.email.mock.calls[0]![0]
		expect(mail.subject).toBe(
			'Payment received for your reservation at Acme Downtown',
		)
		expect(mail.html).toContain('$100.00')
		expect(mail.html).toContain('/reserve/manage#t=')
		expect(mail.capture.messageKind).toBe('payment_received')
		expect(reservation.id).toBeTruthy()
	})

	it('queues one message per payment however often the event repeats (VAL-PAY-031)', async () => {
		const { reservation, enqueue } = await paymentMessage('payment_received')
		await enqueue()
		await enqueue()
		const rows = await db
			.select()
			.from(rsvMessages)
			.where(eq(rsvMessages.reservationId, reservation.id))
		expect(rows.filter((r) => r.kind === 'payment_received')).toHaveLength(1)
	})

	it('adds an SMS on the US node only for an opted-in guest', async () => {
		await paymentMessage('refund_issued', {
			smsOptIn: true,
			paymentKind: 'refund',
		})
		await deliverDueMessages(ORG, { db, now: NOW })
		expect(sent.email).toHaveBeenCalledTimes(1)
		expect(sent.sms).toHaveBeenCalledTimes(1)
		expect(sent.sms.mock.calls[0]![0].message).toContain('$100.00')
	})

	it('is email-only and Arabic right-to-left on the KSA node (VAL-PAY-047)', async () => {
		process.env.DATA_REGION = 'ksa'
		await paymentMessage('payment_received', { smsOptIn: true, locale: 'ar' })
		await deliverDueMessages(ORG, { db, now: NOW })
		expect(sent.sms).not.toHaveBeenCalled()
		expect(sent.email).toHaveBeenCalledTimes(1)
		const mail = sent.email.mock.calls[0]![0]
		expect(mail.html).toContain('dir="rtl"')
		expect(mail.html).toContain('تم استلام الدفعة')
		expect(mail.html).toMatch(/100\.00/)
	})

	it('carries the pay link for fee_action_required', async () => {
		const { paymentId } = await paymentMessage('fee_action_required', {
			paymentKind: 'no_show_fee_charge',
		})
		await deliverDueMessages(ORG, { db, now: NOW })
		const mail = sent.email.mock.calls[0]![0]
		expect(mail.html).toContain(
			`/reserve/pay#f=${paymentId}&amp;t=${deriveFeePayToken(ORG, paymentId)}`,
		)
		expect(mail.text).toContain(
			`/reserve/pay#f=${paymentId}&t=${deriveFeePayToken(ORG, paymentId)}`,
		)
	})

	it('respects the kill switches', async () => {
		vi.stubEnv('RESERVATIONS_EMAIL_ENABLED', 'false')
		await paymentMessage('fee_charged', { paymentKind: 'no_show_fee_charge' })
		const totals = await deliverDueMessages(ORG, { db, now: NOW })
		expect(sent.email).not.toHaveBeenCalled()
		expect(totals.dropped).toBe(1)
	})

	it('sends nothing to an erased guest', async () => {
		const { reservation } = await paymentMessage('payment_received')
		await db
			.update(rsvMessages)
			.set({ status: 'pending' })
			.where(eq(rsvMessages.reservationId, reservation.id))
		const { rsvGuests } = await import('@repo/tenant-db')
		await db
			.update(rsvGuests)
			.set({ erasedAt: NOW })
			.where(eq(rsvGuests.id, reservation.guestId))
		const totals = await deliverDueMessages(ORG, { db, now: NOW })
		expect(sent.email).not.toHaveBeenCalled()
		expect(totals.suppressed).toBe(1)
	})
})

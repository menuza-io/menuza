import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	rsvGuests,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import {
	confirmCustomerSubscription,
	emailConsentHash,
	hasDeliverableSubscription,
} from './marketing-audience.ts'
import {
	queueConsentConfirmation,
	recordReservationMarketingConsent,
} from './rsv-marketing-consent.ts'
import {
	RESEND_INTERVAL_MS,
	requestSubscriptionConfirmation,
} from './subscription-confirmation.ts'

vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const ORG = 'org_consent_confirmation'
const EMAIL = 'guest@example.com'
let tempDir: string
let db: TenantDatabase

beforeEach(async () => {
	tempDir = mkdtempSync(path.join(tmpdir(), 'rsv-consent-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.TENANT_API_URL = 'https://tenant.example.test'
	process.env.AUTH_HMAC_SECRET = 'test-consent-confirmation-hmac-secret-0123'
	vi.mocked(sendTenantEmail).mockClear()
	await provisionTenantDb(ORG)
	db = await getTenantDb(ORG)
})

afterEach(async () => {
	await destroyTenantDb(ORG)
	rmSync(tempDir, { recursive: true, force: true })
})

async function consentingGuest() {
	await db.insert(rsvGuests).values({
		id: 'g1',
		firstName: 'Gus',
		lastName: 'Guest',
		phoneE164: '+14155550101',
		emailNorm: EMAIL,
	})
	const guest = (await db.select().from(rsvGuests).get())!
	const customerId = await recordReservationMarketingConsent(db, {
		guest,
		email: EMAIL,
		channels: ['email'],
		now: Date.now(),
	})
	return { customerId: customerId!, guest }
}

const subscriptionRow = async (customerId: string) =>
	(await db
		.select()
		.from(customerSubscriptions)
		.where(eq(customerSubscriptions.customerId, customerId))
		.get())!

describe('booking-form email consent is a double opt-in', () => {
	it('records a pending subscription that is not deliverable yet', async () => {
		const { customerId } = await consentingGuest()
		const row = await subscriptionRow(customerId)
		expect(row).toMatchObject({
			topic: 'reservations',
			channel: 'email',
			source: 'reservation_booking',
			confirmedEmailHash: null,
		})
		expect(
			await hasDeliverableSubscription(db, {
				customerId,
				topic: 'reservations',
				channel: 'email',
			}),
		).toBe(false)
	})

	it('becomes deliverable when the owner confirms, and stops when they opt out', async () => {
		const { customerId } = await consentingGuest()
		expect(
			await confirmCustomerSubscription(db, {
				customerId,
				topic: 'reservations',
				email: EMAIL,
			}),
		).toBe(true)
		const deliverable = () =>
			hasDeliverableSubscription(db, {
				customerId,
				topic: 'reservations',
				channel: 'email',
			})
		expect(await deliverable()).toBe(true)
		await db
			.update(customerSubscriptions)
			.set({ unsubscribedAt: new Date() })
			.where(eq(customerSubscriptions.customerId, customerId))
		expect(await deliverable()).toBe(false)
	})

	it('ticking the box again keeps an address that was already confirmed', async () => {
		const { customerId, guest } = await consentingGuest()
		await confirmCustomerSubscription(db, {
			customerId,
			topic: 'reservations',
			email: EMAIL,
		})
		await recordReservationMarketingConsent(db, {
			guest: (await db
				.select()
				.from(rsvGuests)
				.where(eq(rsvGuests.id, guest.id))
				.get())!,
			email: EMAIL,
			channels: ['email'],
			now: Date.now(),
		})
		expect((await subscriptionRow(customerId)).confirmedEmailHash).toBe(
			emailConsentHash(EMAIL),
		)
	})

	it('a changed address is not deliverable until it is confirmed again', async () => {
		const { customerId } = await consentingGuest()
		await confirmCustomerSubscription(db, {
			customerId,
			topic: 'reservations',
			email: EMAIL,
		})
		await db
			.update(customers)
			.set({ email: 'someone-else@example.com' })
			.where(eq(customers.id, customerId))
		expect(
			await hasDeliverableSubscription(db, {
				customerId,
				topic: 'reservations',
				channel: 'email',
			}),
		).toBe(false)
	})
})

describe('the confirmation email', () => {
	it('is sent once after the booking commits, with a confirm link and no booking details', async () => {
		const { customerId } = await consentingGuest()
		const hooks: Array<() => void | Promise<void>> = []
		queueConsentConfirmation((hook) => hooks.push(hook), {
			orgId: ORG,
			customerId,
			email: EMAIL,
			name: 'Gus Guest',
		})
		// Nothing goes out before the commit.
		expect(sendTenantEmail).not.toHaveBeenCalled()
		await hooks[0]!()
		expect(sendTenantEmail).toHaveBeenCalledTimes(1)
		const sent = vi.mocked(sendTenantEmail).mock.calls[0]![0]
		expect(sent.to).toBe(EMAIL)
		expect(sent.text).toContain(
			'https://tenant.example.test/subscriptions/confirm?token=',
		)
		expect(sent.capture).toMatchObject({
			orgId: ORG,
			messageKind: 'email-confirmation',
		})
		const row = await subscriptionRow(customerId)
		expect(row.confirmationSentHash).toBe(emailConsentHash(EMAIL))
		expect(row.confirmationSentAt).not.toBeNull()
	})

	it('is throttled per address, and sent again after the resend interval', async () => {
		const { customerId } = await consentingGuest()
		const params = {
			orgId: ORG,
			customerId,
			topic: 'reservations' as const,
			email: EMAIL,
			name: 'Gus Guest',
		}
		const start = Date.now()
		expect(
			await requestSubscriptionConfirmation(db, { ...params, now: start }),
		).toBe(true)
		expect(
			await requestSubscriptionConfirmation(db, {
				...params,
				now: start + 1000,
			}),
		).toBe(false)
		expect(
			await requestSubscriptionConfirmation(db, {
				...params,
				now: start + RESEND_INTERVAL_MS + 1000,
			}),
		).toBe(true)
		expect(sendTenantEmail).toHaveBeenCalledTimes(2)
	})

	it('is not sent for a confirmed or withdrawn subscription, or to another address', async () => {
		const { customerId } = await consentingGuest()
		const params = {
			orgId: ORG,
			customerId,
			topic: 'reservations' as const,
			name: 'Gus Guest',
		}
		// The link confirms the address on file, so it goes only there.
		expect(
			await requestSubscriptionConfirmation(db, {
				...params,
				email: 'typo@example.com',
			}),
		).toBe(false)
		await confirmCustomerSubscription(db, {
			customerId,
			topic: 'reservations',
			email: EMAIL,
		})
		expect(
			await requestSubscriptionConfirmation(db, { ...params, email: EMAIL }),
		).toBe(false)
		await db
			.update(customerSubscriptions)
			.set({ unsubscribedAt: new Date(), confirmedEmailHash: null })
			.where(eq(customerSubscriptions.customerId, customerId))
		expect(
			await requestSubscriptionConfirmation(db, { ...params, email: EMAIL }),
		).toBe(false)
		expect(sendTenantEmail).not.toHaveBeenCalled()
	})

	it('queues nothing without a customer or an address', () => {
		const hooks: Array<() => void | Promise<void>> = []
		queueConsentConfirmation((hook) => hooks.push(hook), {
			orgId: ORG,
			customerId: null,
			email: EMAIL,
			name: 'x',
		})
		queueConsentConfirmation((hook) => hooks.push(hook), {
			orgId: ORG,
			customerId: 'c',
			email: null,
			name: 'x',
		})
		expect(hooks).toEqual([])
	})
})

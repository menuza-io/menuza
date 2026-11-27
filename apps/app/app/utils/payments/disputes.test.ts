import { db, eq, PaymentDispute } from '@repo/database'
import {
	mapCheckoutDisputeToControlPlane,
	mapStripeDisputeToControlPlane,
} from '@repo/payments'
import type Stripe from 'stripe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
	process.env.SESSION_SECRET = 'test-session-secret'
	process.env.JWT_SECRET = 'test-jwt-secret-key'
	process.env.PAYMENTS_MOCK = 'true'
	process.env.BASE_URL = 'https://app.menuza.test:2999'
	const workerId =
		process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? '0'
	process.env.DATABASE_URL = `file:./tests/database/data.${workerId}.db`
	process.env.AWS_ENDPOINT_URL_S3 = 'http://localhost:9000'
	process.env.AWS_REGION = 'us-east-1'
	process.env.AWS_ACCESS_KEY_ID = 'test'
	process.env.AWS_SECRET_ACCESS_KEY = 'test'
	process.env.BUCKET_NAME = 'test'
})

const sendEmailMock = vi.fn().mockResolvedValue({ status: 'success' })

vi.mock('@repo/email', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@repo/email')>()
	return {
		...actual,
		sendEmail: (...args: unknown[]) => sendEmailMock(...args),
	}
})

import {
	action as disputeDetailAction,
	loader as disputeDetailLoader,
} from '#app/routes/_app+/$orgSlug_+/orders_.disputes.$disputeId.tsx'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import {
	acceptDisputeForOrg,
	runDailyDisputeDeadlineReminders,
	submitDisputeEvidenceForOrg,
	summarizeDisputesForPeriod,
	upsertPaymentDisputeAndNotify,
} from './disputes.server.ts'

describe('payment disputes (#187)', () => {
	beforeEach(() => {
		sendEmailMock.mockClear()
	})

	it('maps Stripe and Checkout.com dispute payloads accurately', () => {
		const stripeMapped = mapStripeDisputeToControlPlane({
			id: 'dp_stripe_1',
			payment_intent: 'pi_123',
			amount: 4500,
			currency: 'usd',
			reason: 'fraudulent',
			status: 'needs_response',
			evidence_details: { due_by: 1800000000 },
			balance_transactions: [{ fee: 1500 }],
			charge: { refunded: true },
		} as unknown as Stripe.Dispute)

		expect(stripeMapped).toMatchObject({
			provider: 'connect',
			providerDisputeId: 'dp_stripe_1',
			providerPaymentId: 'pi_123',
			amountMinor: 4500,
			feeMinor: 1500,
			currency: 'USD',
			reason: 'fraudulent',
			status: 'needs_response',
			alreadyRefunded: true,
		})
		expect(stripeMapped?.dueAt).toEqual(new Date(1800000000 * 1000))

		const ckoMapped = mapCheckoutDisputeToControlPlane({
			type: 'dispute_evidence_required',
			data: {
				id: 'dsp_cko_1',
				payment_id: 'pay_999',
				amount: 12000,
				currency: 'SAR',
				reason_code: 'product_not_received',
				evidence_required_by: '2027-02-01T00:00:00Z',
				fee: 500,
			},
		})
		expect(ckoMapped).toMatchObject({
			provider: 'checkout',
			providerDisputeId: 'dsp_cko_1',
			providerPaymentId: 'pay_999',
			amountMinor: 12000,
			feeMinor: 500,
			currency: 'SAR',
			reason: 'product_not_received',
			status: 'needs_response',
		})
	})

	it('deduplicates webhooks, sends 3-day deadline reminder once, enforces single submit and update:settings:any, and summarizes fees', async () => {
		const { organization, cookie } = await setupTestOrgWithUser()
		const now = new Date('2027-01-10T12:00:00Z')
		const dueAt = new Date('2027-01-15T12:00:00Z')

		// 1. Open webhook creates dispute & notifies once
		const first = await upsertPaymentDisputeAndNotify({
			organizationId: organization.id,
			provider: 'connect',
			providerDisputeId: `dp_mock_${organization.id}_1`,
			providerPaymentId: 'pi_mock_1',
			orderKind: 'restaurant_order',
			orderRef: 'ord_dispute_1',
			amountMinor: 5000,
			feeMinor: 1500,
			currency: 'USD',
			reason: 'fraudulent',
			status: 'needs_response',
			dueAt,
			alreadyRefunded: true,
			now,
		})
		expect(first.created).toBe(true)
		expect(first.notified).toBe(1)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)

		// 2. Duplicate webhook is idempotent (0 new emails)
		const dup = await upsertPaymentDisputeAndNotify({
			organizationId: organization.id,
			provider: 'connect',
			providerDisputeId: `dp_mock_${organization.id}_1`,
			providerPaymentId: 'pi_mock_1',
			orderKind: 'restaurant_order',
			orderRef: 'ord_dispute_1',
			amountMinor: 5000,
			feeMinor: 1500,
			currency: 'USD',
			reason: 'fraudulent',
			status: 'needs_response',
			dueAt,
			now,
		})
		expect(dup.created).toBe(false)
		expect(dup.id).toBe(first.id)
		expect(sendEmailMock).toHaveBeenCalledTimes(1)

		// 3. 3-day deadline reminder fires once at 2 days before dueAt
		const twoDaysBefore = dueAt.getTime() - 2 * 86_400_000
		const rem1 = await runDailyDisputeDeadlineReminders(twoDaysBefore)
		expect(rem1.reminded).toBeGreaterThanOrEqual(1)
		const callsAfterRem1 = sendEmailMock.mock.calls.length
		await runDailyDisputeDeadlineReminders(dueAt.getTime() - 86_400_000)
		expect(sendEmailMock).toHaveBeenCalledTimes(callsAfterRem1)

		// 4. Member without update:settings:any gets 403 when trying to answer
		const member = await createTestUser()
		await addOrganizationMember(member.id, organization.id, 'org_role_member')
		const { cookie: memberCookie } = await createTestSession(member.id)
		const fd = new FormData()
		fd.append('intent', 'submit-evidence')
		fd.append('explanation', 'Guest picked up the order.')
		await expect(
			disputeDetailAction({
				request: createAuthenticatedRequest(
					`https://app.menuza.test:2999/${organization.slug}/orders/disputes/${first.id}`,
					{ method: 'POST', body: fd },
					memberCookie,
				),
				params: { orgSlug: organization.slug, disputeId: first.id },
				context: {},
			} as never),
		).rejects.toSatisfy(
			(res: unknown) => res instanceof Response && res.status === 403,
		)

		// 5. Submit evidence once succeeds and makes dispute read-only (2nd submit -> 409)
		const submitted = await submitDisputeEvidenceForOrg({
			organizationId: organization.id,
			disputeId: first.id,
			evidence: {
				explanation: 'Order was already refunded in full.',
				attachmentNames: ['receipt.pdf'],
			},
		})
		expect(submitted.status).toBe('under_review')

		await expect(
			submitDisputeEvidenceForOrg({
				organizationId: organization.id,
				disputeId: first.id,
				evidence: { explanation: 'Second try should fail.' },
			}),
		).rejects.toSatisfy(
			(res: unknown) => res instanceof Response && res.status === 409,
		)

		// 6. Second dispute accepted -> closed as accepted
		const second = await upsertPaymentDisputeAndNotify({
			organizationId: organization.id,
			provider: 'checkout',
			providerDisputeId: `dp_mock_${organization.id}_2`,
			providerPaymentId: 'pay_mock_2',
			orderKind: 'reservation',
			orderRef: 'rsv_99',
			amountMinor: 3000,
			feeMinor: 1000,
			currency: 'USD',
			reason: 'general',
			status: 'needs_response',
			dueAt,
			now,
		})
		const accepted = await acceptDisputeForOrg({
			organizationId: organization.id,
			disputeId: second.id,
		})
		expect(accepted.status).toBe('accepted')

		// 7. Period report summary reports disputed amount & dispute fees
		const summary = await summarizeDisputesForPeriod({
			organizationId: organization.id,
		})
		expect(summary).toEqual([
			{
				currency: 'USD',
				disputeCount: 2,
				disputedAmountMinor: 8000,
				disputeFeesMinor: 2500,
				lostAmountMinor: 3000,
				openCount: 1,
				wonCount: 0,
				lostCount: 1,
			},
		])

		// 8. Detail loader returns read-only dispute state
		const loaded = await disputeDetailLoader({
			request: createAuthenticatedRequest(
				`https://app.menuza.test:2999/${organization.slug}/orders/disputes/${first.id}`,
				{},
				cookie,
			),
			params: { orgSlug: organization.slug, disputeId: first.id },
			context: {},
		} as never)
		expect(loaded.dispute.status).toBe('under_review')
		expect(loaded.dispute.alreadyRefunded).toBe(true)

		await db
			.delete(PaymentDispute)
			.where(eq(PaymentDispute.organizationId, organization.id))
	})
})

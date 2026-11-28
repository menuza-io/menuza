import { db, eq, Organization } from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __setMockLaunchStatus } from '#app/utils/env.server.ts'
import type * as payments from '#app/utils/payments.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action, loader } from './billing.tsx'

const billingMocks = vi.hoisted(() => ({
	loadBillingIssue: vi.fn(),
	retryBillingPayment: vi.fn(),
}))

vi.mock('#app/utils/payments.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof payments>()
	return {
		...actual,
		stripe: {
			subscriptions: {
				retrieve: vi
					.fn()
					.mockResolvedValue({
						items: { data: [{ price: { id: 'price_1' } }] },
					}),
			},
		},
		getPlansAndPrices: vi.fn().mockResolvedValue(null),
		getOrganizationInvoices: vi.fn().mockResolvedValue([]),
		loadBillingIssue: billingMocks.loadBillingIssue,
		retryBillingPayment: billingMocks.retryBillingPayment,
	}
})

async function setupPastDue() {
	const { organization, cookie, user } = await setupTestOrgWithUser('admin')
	await db
		.update(Organization)
		.set({
			stripeCustomerId: 'cus_1',
			stripeSubscriptionId: 'sub_1',
			subscriptionStatus: 'past_due',
			pastDueSince: new Date(Date.now() - 5 * 86_400_000),
		})
		.where(eq(Organization.id, organization.id))
	return { organization, cookie, user }
}

function args(
	organization: { slug: string },
	cookie: string,
	init: RequestInit = {},
) {
	const url = new URL(
		`http://localhost:3001/${organization.slug}/settings/billing`,
	)
	return {
		request: createAuthenticatedRequest(url.toString(), init, cookie),
		params: { orgSlug: organization.slug },
		context: new RouterContextProvider(),
		url,
		pattern: '/:orgSlug/settings/billing',
	} as never
}

describe('billing page while past due (#237)', () => {
	beforeEach(() => {
		__setMockLaunchStatus('LAUNCHED')
		billingMocks.loadBillingIssue.mockReset()
		billingMocks.retryBillingPayment.mockReset()
	})
	afterEach(() => {
		__setMockLaunchStatus(null)
	})

	it('shows the unpaid invoice, the failed attempts and the next try to a billing manager', async () => {
		const { organization, cookie } = await setupPastDue()
		billingMocks.loadBillingIssue.mockResolvedValue({
			invoice: {
				id: 'in_1',
				amountDue: 4999,
				currency: 'usd',
				attemptCount: 2,
				nextPaymentAttempt: 1_700_300_000,
				hostedInvoiceUrl: null,
			},
			attempts: [
				{
					at: 1_700_200_000,
					brand: 'visa',
					last4: '1234',
					reason: 'card_declined',
				},
			],
		})
		const data = (await loader(args(organization, cookie))) as any
		expect(data.pastDue).toMatchObject({
			daysOverdue: 5,
			issue: {
				invoice: { id: 'in_1', nextPaymentAttempt: 1_700_300_000 },
				attempts: [{ brand: 'visa', last4: '1234' }],
			},
		})
	})

	it('has no past-due card while the subscription is paying', async () => {
		const { organization, cookie } = await setupTestOrgWithUser('admin')
		await db
			.update(Organization)
			.set({
				stripeCustomerId: 'cus_1',
				stripeSubscriptionId: 'sub_1',
				subscriptionStatus: 'active',
			})
			.where(eq(Organization.id, organization.id))
		const data = (await loader(args(organization, cookie))) as any
		expect(data.pastDue).toBeNull()
		expect(billingMocks.loadBillingIssue).not.toHaveBeenCalled()
	})

	it('retries the payment for a billing manager and returns the outcome', async () => {
		const { organization, cookie } = await setupPastDue()
		billingMocks.retryBillingPayment.mockResolvedValue({ status: 'paid' })
		const response = (await action(
			args(organization, cookie, {
				method: 'POST',
				body: new URLSearchParams({ intent: 'retry-payment' }),
			}),
		)) as Response
		expect(await response.json()).toEqual({ retry: { status: 'paid' } })
		expect(billingMocks.retryBillingPayment).toHaveBeenCalledTimes(1)
		expect(billingMocks.retryBillingPayment).toHaveBeenCalledWith(
			expect.objectContaining({
				id: organization.id,
				subscriptionStatus: 'past_due',
			}),
		)
	})

	it('refuses the retry for a member who cannot manage billing', async () => {
		const { organization } = await setupPastDue()
		const viewer = await createTestUser()
		await addOrganizationMember(viewer.id, organization.id, 'org_role_viewer')
		const { cookie } = await createTestSession(viewer.id)
		await expect(
			action(
				args(organization, cookie, {
					method: 'POST',
					body: new URLSearchParams({ intent: 'retry-payment' }),
				}),
			),
		).rejects.toMatchObject({ status: 403 })
		expect(billingMocks.retryBillingPayment).not.toHaveBeenCalled()
	})
})

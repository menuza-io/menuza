import Stripe from 'stripe'
import { describe, expect, it } from 'vitest'
import { MOCK_STRIPE_WEBHOOK_SECRET } from '../env'
import { createTestHarness, verifyStripeDelivery } from '../test-helpers'

async function newAccount(harness: ReturnType<typeof createTestHarness>) {
	return harness.stripe.accounts.create({
		type: 'express',
		country: 'US',
		capabilities: {
			card_payments: { requested: true },
			transfers: { requested: true },
		},
		metadata: { organizationId: 'org_a', organizationName: 'Org A' },
	})
}

describe('Stripe Connect onboarding', () => {
	it('starts disabled and the onboarding outcomes flip charges and payouts', async () => {
		const harness = createTestHarness()
		const account = await newAccount(harness)
		expect(account.charges_enabled).toBe(false)
		expect(account.id).toMatch(/^acct_/)

		await harness.emulator.testing.completeOnboarding(
			account.id,
			'requirements_due',
		)
		let current = await harness.stripe.accounts.retrieve(account.id)
		expect(current).toMatchObject({
			charges_enabled: false,
			payouts_enabled: false,
			details_submitted: true,
		})

		await harness.emulator.testing.completeOnboarding(
			account.id,
			'payouts_restricted',
		)
		current = await harness.stripe.accounts.retrieve(account.id)
		expect(current).toMatchObject({
			charges_enabled: true,
			payouts_enabled: false,
		})

		await harness.emulator.testing.completeOnboarding(account.id, 'complete')
		current = await harness.stripe.accounts.retrieve(account.id)
		expect(current).toMatchObject({
			charges_enabled: true,
			payouts_enabled: true,
		})
		expect(current.capabilities).toMatchObject({
			card_payments: 'active',
			transfers: 'active',
		})
	})

	it('account links point at the mock onboarding page and keep return_url', async () => {
		const harness = createTestHarness()
		const account = await newAccount(harness)
		const link = await harness.stripe.accountLinks.create({
			account: account.id,
			refresh_url: 'http://localhost:3001/acme/settings/shop?connect=refresh',
			return_url: 'http://localhost:3001/acme/settings/shop?connect=return',
			type: 'account_onboarding',
		})
		expect(link.url).toMatch(
			/^http:\/\/localhost:3001\/mock-payments\/stripe\/connect\/onboard\/alink_/,
		)
		const linkId = link.url.split('/').pop()!
		const described =
			await harness.emulator.pages.stripe.describeOnboarding(linkId)
		expect(described?.account.id).toBe(account.id)
		const done = await harness.emulator.pages.stripe.completeOnboarding(
			linkId,
			'complete',
		)
		expect(done?.returnUrl).toBe(
			'http://localhost:3001/acme/settings/shop?connect=return',
		)
		expect(
			(await harness.stripe.accounts.retrieve(account.id)).charges_enabled,
		).toBe(true)
	})

	it('login links need a finished onboarding', async () => {
		const harness = createTestHarness()
		const account = await newAccount(harness)
		await expect(
			harness.stripe.accounts.createLoginLink(account.id),
		).rejects.toBeInstanceOf(Stripe.errors.StripeInvalidRequestError)
		await harness.emulator.testing.completeOnboarding(account.id, 'complete')
		const login = await harness.stripe.accounts.createLoginLink(account.id)
		expect(login.url).toBe(
			`http://localhost:3001/mock-payments/stripe/connect/dashboard/${account.id}`,
		)
	})

	it('account.updated is a Connect event signed with the Connect secret, verified by the SDK', async () => {
		const harness = createTestHarness({
			secrets: {
				stripePlatform: 'whsec_platform',
				stripeConnect: 'whsec_connect',
			},
		})
		const account = await newAccount(harness)
		await harness.emulator.testing.completeOnboarding(account.id, 'complete')
		const delivery = harness.deliveries.find((entry) =>
			entry.body.includes('account.updated'),
		)!
		expect(delivery.path).toBe('/api/stripe/webhook')
		expect(() => verifyStripeDelivery(delivery, 'whsec_platform')).toThrow()
		const event = verifyStripeDelivery(delivery, 'whsec_connect')
		expect(event.type).toBe('account.updated')
		expect((event as { account?: string }).account).toBe(account.id)
		expect((event.data.object as Stripe.Account).metadata?.organizationId).toBe(
			'org_a',
		)
	})

	it('falls back to the platform secret when no Connect secret is set', async () => {
		const harness = createTestHarness()
		const account = await newAccount(harness)
		await harness.emulator.testing.completeOnboarding(account.id, 'complete')
		const delivery = harness.deliveries[0]!
		expect(
			verifyStripeDelivery(delivery, MOCK_STRIPE_WEBHOOK_SECRET).type,
		).toBe('account.updated')
	})
})

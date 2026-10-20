import {
	createMockProviders,
	MockCheckoutHppPage,
	MockCheckoutThreeDSPage,
	MockConnectOnboardingPage,
	MockPaymentsDashboardPage,
	MockStripeCheckoutPage,
	MockStripeThreeDSPage,
	PaymentsMockApi,
	sessionIdFromUrl,
} from '#tests/playwright-payments-mock.ts'
import { expect, test } from '#tests/playwright-utils.ts'

/**
 * The local payment mock end to end through its hosted pages. The spec starts
 * hosted sessions with the real SDKs on the App's database (see
 * `playwright-payments-mock.ts`), pays in the browser, and asserts through the
 * dev API: never on the redirect alone.
 *
 * Needs the App to run with mocks (Playwright sets `MOCKS=true`) and to share
 * its database with this process (the CI Node server; local LibSQL runs).
 */
test.describe.configure({ mode: 'serial' })

const SUCCESS_URL = 'http://localhost:3101/mock-payments/dashboard?paid=1'
const CANCEL_URL = 'http://localhost:3101/mock-payments/dashboard?cancelled=1'

function stripePaymentParams(
	destination: string,
	extra: Record<string, string> = {},
) {
	return {
		mode: 'payment' as const,
		line_items: [
			{
				price_data: {
					currency: 'usd',
					product_data: { name: 'Mock order' },
					unit_amount: 2500,
				},
				quantity: 1,
			},
		],
		payment_intent_data: {
			application_fee_amount: 500,
			transfer_data: { destination },
			metadata: extra,
		},
		success_url: SUCCESS_URL,
		cancel_url: CANCEL_URL,
		metadata: extra,
	}
}

async function onboardedAccount(
	providers: Awaited<ReturnType<typeof createMockProviders>>,
) {
	const account = await providers.stripe.accounts.create({
		type: 'express',
		country: 'US',
		capabilities: {
			card_payments: { requested: true },
			transfers: { requested: true },
		},
		metadata: { organizationId: 'org_e2e', organizationName: 'E2E Org' },
	})
	await providers.emulator.testing.completeOnboarding(account.id, 'complete')
	return account.id
}

test.beforeEach(async ({ request, baseURL }) => {
	await new PaymentsMockApi(request, baseURL!).reset()
})

test('the dashboard is reachable under mocks and shows the mock banner', async ({
	page,
}) => {
	const dashboard = new MockPaymentsDashboardPage(page)
	await dashboard.open()
	await expect(page.getByTestId('mock-payments-dashboard')).toBeVisible()
	await expect(page.getByTestId('mock-webhook-mode')).toBeVisible()
})

test('Stripe Checkout: a 4242 card pays and the dev API shows a complete, paid session', async ({
	page,
	request,
	baseURL,
}) => {
	const api = new PaymentsMockApi(request, baseURL!)
	const providers = await createMockProviders(baseURL!)
	const destination = await onboardedAccount(providers)
	const session = await providers.stripe.checkout.sessions.create(
		stripePaymentParams(destination, { type: 'e2e' }),
	)
	const checkout = new MockStripeCheckoutPage(page)
	await checkout.open(session.url!)
	await expect(checkout.amount()).toContainText('25.00')
	await checkout.pay('4242 4242 4242 4242')
	await expect(page).toHaveURL(SUCCESS_URL)

	const stored = await api.object('stripe', sessionIdFromUrl(session.url!))
	expect(stored).toMatchObject({ status: 'complete', payment_status: 'paid' })
	const events = await api.events({ provider: 'stripe' })
	const completed = events.find(
		(event) => event.type === 'checkout.session.completed',
	)
	expect(completed).toBeTruthy()
})

test('Stripe Checkout: a declined card shows an inline error and the session stays open', async ({
	page,
	request,
	baseURL,
}) => {
	const api = new PaymentsMockApi(request, baseURL!)
	const providers = await createMockProviders(baseURL!)
	const destination = await onboardedAccount(providers)
	const session = await providers.stripe.checkout.sessions.create(
		stripePaymentParams(destination),
	)
	const checkout = new MockStripeCheckoutPage(page)
	await checkout.open(session.url!)
	await checkout.pay('4000 0000 0000 0002')
	await expect(checkout.error()).toBeVisible()
	expect(await api.object('stripe', session.id)).toMatchObject({
		status: 'open',
	})
})

test('Stripe Checkout: a 3DS challenge can be completed or failed', async ({
	page,
	request,
	baseURL,
}) => {
	const api = new PaymentsMockApi(request, baseURL!)
	const providers = await createMockProviders(baseURL!)
	const destination = await onboardedAccount(providers)
	const failing = await providers.stripe.checkout.sessions.create(
		stripePaymentParams(destination),
	)
	const checkout = new MockStripeCheckoutPage(page)
	await checkout.open(failing.url!)
	await checkout.pay('4000 0025 0000 3155')
	await expect(page).toHaveURL(/\/mock-payments\/stripe\/3ds\//)
	await new MockStripeThreeDSPage(page).fail()
	await expect(checkout.error()).toBeVisible()
	expect(await api.object('stripe', failing.id)).toMatchObject({
		status: 'open',
	})

	await checkout.pay('4000 0025 0000 3155')
	await new MockStripeThreeDSPage(page).complete()
	await expect(page).toHaveURL(SUCCESS_URL)
	expect(await api.object('stripe', failing.id)).toMatchObject({
		payment_status: 'paid',
	})
})

test('Stripe Checkout: Back lands on the cancel url and an expired session is inactive', async ({
	page,
	request,
	baseURL,
}) => {
	const api = new PaymentsMockApi(request, baseURL!)
	const providers = await createMockProviders(baseURL!)
	const destination = await onboardedAccount(providers)
	const session = await providers.stripe.checkout.sessions.create(
		stripePaymentParams(destination),
	)
	const checkout = new MockStripeCheckoutPage(page)
	await checkout.open(session.url!)
	await checkout.back()
	await expect(page).toHaveURL(CANCEL_URL)
	expect(await api.object('stripe', session.id)).toMatchObject({
		payment_status: 'unpaid',
	})

	expect((await api.expireSession(session.id)).status()).toBe(200)
	await checkout.open(session.url!)
	await expect(checkout.inactive()).toBeVisible()
})

test('Connect onboarding: requirements due keeps charges off, Complete turns them on', async ({
	page,
	request,
	baseURL,
}) => {
	const api = new PaymentsMockApi(request, baseURL!)
	const providers = await createMockProviders(baseURL!)
	const account = await providers.stripe.accounts.create({
		type: 'express',
		country: 'US',
		metadata: { organizationId: 'org_e2e', organizationName: 'E2E Org' },
	})
	const link = () =>
		providers.stripe.accountLinks.create({
			account: account.id,
			refresh_url: CANCEL_URL,
			return_url: SUCCESS_URL,
			type: 'account_onboarding',
		})
	const onboarding = new MockConnectOnboardingPage(page)

	await page.goto((await link()).url)
	await onboarding.submitWithRequirementsDue()
	await expect(page).toHaveURL(SUCCESS_URL)
	expect(await api.object('stripe', account.id)).toMatchObject({
		charges_enabled: false,
		details_submitted: true,
	})

	await page.goto((await link()).url)
	await onboarding.complete()
	await expect(page).toHaveURL(SUCCESS_URL)
	expect(await api.object('stripe', account.id)).toMatchObject({
		charges_enabled: true,
		payouts_enabled: true,
	})
})

test('the event log redelivers an event and counts the attempt', async ({
	page,
	request,
	baseURL,
}) => {
	const api = new PaymentsMockApi(request, baseURL!)
	const providers = await createMockProviders(baseURL!)
	await onboardedAccount(providers)
	// `account.updated` was queued by the spec's emulator; deliver it through the App.
	await api.flush()
	const [event] = await api.events({
		provider: 'stripe',
		type: 'account.updated',
	})
	expect(event).toBeTruthy()
	const before = event!.attempts

	const dashboard = new MockPaymentsDashboardPage(page)
	await dashboard.open()
	await dashboard.redeliver(event!.id)
	await expect(
		dashboard.eventRow(event!.id).getByTestId('mock-event-attempts'),
	).toHaveText(String(before + 1))
})

test('Checkout.com hosted page: success, amount decline, 3DS password, and Back', async ({
	page,
	request,
	baseURL,
}) => {
	const api = new PaymentsMockApi(request, baseURL!)
	const providers = await createMockProviders(baseURL!)
	const entity = (await providers.checkout.platforms.onboardSubEntity({
		reference: 'org_e2e',
		contact_details: { invitee: { email: 'owner@example.test' } },
		is_draft: true,
	} as never)) as { id: string }
	await providers.emulator.testing.activateEntity(entity.id)

	const create = async (amount: number, reference: string) =>
		(await providers.checkout.hostedPayments.create({
			amount,
			currency: 'SAR',
			reference,
			processing_channel_id: 'pc_mockmockmockmockmockm',
			billing: { address: { country: 'SA' } },
			success_url: SUCCESS_URL,
			failure_url: CANCEL_URL,
			cancel_url: CANCEL_URL,
			metadata: { type: 'e2e' },
			amount_allocations: [
				{
					id: entity.id,
					amount,
					commission: { amount: Math.round(amount / 5) },
				},
			],
		} as never)) as { id: string; _links: { redirect: { href: string } } }

	const hpp = new MockCheckoutHppPage(page)

	const paid = await create(12_000, 'e2e:paid')
	await hpp.open(paid._links.redirect.href)
	await hpp.pay('4242 4242 4242 4242')
	await expect(page).toHaveURL(
		/mock-payments\/dashboard\?paid=1&cko-session-id=sid_/,
	)
	const sid = new URL(page.url()).searchParams.get('cko-session-id')!
	expect(await api.object('checkout', sid)).toMatchObject({
		approved: true,
		status: 'Captured',
	})

	const declined = await create(1005, 'e2e:declined')
	await hpp.open(declined._links.redirect.href)
	await hpp.pay('4242 4242 4242 4242')
	await expect(page).toHaveURL(/cancelled=1&cko-session-id=sid_/)
	expect(
		await api.object(
			'checkout',
			new URL(page.url()).searchParams.get('cko-session-id')!,
		),
	).toMatchObject({
		approved: false,
		status: 'Declined',
		response_code: '20005',
	})

	const wrong = await create(12_000, 'e2e:3ds-wrong')
	await hpp.open(wrong._links.redirect.href)
	await hpp.pay('4543 4740 0224 9996')
	await new MockCheckoutThreeDSPage(page).submit('wrong')
	await expect(page).toHaveURL(/cancelled=1&cko-session-id=sid_/)

	const right = await create(12_000, 'e2e:3ds-right')
	await hpp.open(right._links.redirect.href)
	await hpp.pay('4543 4740 0224 9996')
	await new MockCheckoutThreeDSPage(page).submit('Checkout1!')
	await expect(page).toHaveURL(/paid=1&cko-session-id=sid_/)

	const cancelled = await create(12_000, 'e2e:back')
	await hpp.open(cancelled._links.redirect.href)
	await hpp.back()
	await expect(page).toHaveURL(CANCEL_URL)
	expect(await api.object('checkout', cancelled.id)).toMatchObject({
		status: 'Payment Pending',
		payment_id: null,
	})
})

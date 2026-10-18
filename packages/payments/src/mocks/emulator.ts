import {
	CHECKOUT_3DS_PASSWORD,
	checkoutProfileForDigits,
	stripeProfileForDigits,
} from './cards'
import { activateEntity } from './checkout-com/entities'
import {
	dashboardSnapshot,
	describeHostedAttempt,
	describeHostedPayment,
	forceRefundDecline,
	resolveHostedThreeDS,
	settleRefundAction,
	submitHostedPayment,
	type HostedSubmission,
} from './checkout-com/payments'
import { handleCheckoutRequest } from './checkout-com/router'
import {
	publicObject as checkoutPublic,
	findCheckoutObject,
} from './checkout-com/state'
import { createSystemClock, type MockClock } from './clock'
import {
	type EmulatorContext,
	type EmulatorSecrets,
	type WebhookTransport,
} from './context'
import {
	MOCK_CHECKOUT_WEBHOOK_SECRET,
	MOCK_STRIPE_WEBHOOK_SECRET,
	type MockWebhookMode,
} from './env'
import { deliverDue, flushEvents, redeliverEvent } from './events'
import { type MockProvider, type MockStore } from './store'
import {
	completeAccountOnboarding,
	type OnboardingOutcome,
} from './stripe/accounts'
import {
	accountLedger,
	closeDispute,
	createDispute,
	settleRefund,
} from './stripe/ledger'
import { handleStripeRequest } from './stripe/router'
import {
	describeAttempt as describeStripeAttempt,
	describeCheckoutSession,
	expireCheckoutSession,
	markSessionExpired,
	resolveThreeDSChallenge,
	submitCheckoutCard,
	type CheckoutSubmission,
} from './stripe/sessions'
import { publicObject as stripePublic, findStripeObject } from './stripe/state'

/**
 * Lives in the emulator module only (never in `env.ts`, which production code
 * imports). The CI bundle check greps the Worker bundle for it.
 */
export const PAYMENTS_MOCK_SENTINEL = '__MENUZA_PAYMENTS_MOCK__'

export type EmulatorOptions = {
	store: MockStore
	clock?: MockClock
	origin?: string
	secrets?: Partial<EmulatorSecrets>
	webhookMode?: MockWebhookMode | (() => MockWebhookMode)
	transport?: WebhookTransport | null
	schedule?: (work: Promise<unknown>) => void
	fidelity?: Partial<EmulatorContext['fidelity']>
	log?: (message: string) => void
}

export const DEFAULT_TEST_EXPIRY = '12/34'
export const DEFAULT_TEST_CVC = '123'

function toNumber(card: string) {
	return card.replace(/\D/g, '')
}

export function createPaymentsEmulator(options: EmulatorOptions) {
	const mode = options.webhookMode ?? 'inline'
	const ctx: EmulatorContext = {
		store: options.store,
		clock: options.clock ?? createSystemClock(),
		origin: (options.origin ?? 'http://localhost:3001').replace(/\/$/, ''),
		secrets: {
			stripePlatform: MOCK_STRIPE_WEBHOOK_SECRET,
			stripeConnect:
				options.secrets?.stripePlatform ?? MOCK_STRIPE_WEBHOOK_SECRET,
			checkout: MOCK_CHECKOUT_WEBHOOK_SECRET,
			...options.secrets,
		},
		webhookMode: typeof mode === 'function' ? mode : () => mode,
		transport: options.transport ?? null,
		schedule:
			options.schedule ??
			((work) => {
				void work.catch(() => undefined)
			}),
		fidelity: {
			checkoutSessionIdOnWebhooks: false,
			...options.fidelity,
		},
		log:
			options.log ?? ((message) => console.warn(`[PAYMENTS MOCK] ${message}`)),
	}

	let sweeping = false

	/** Run time-based transitions and due deferred deliveries. */
	async function sweep() {
		if (sweeping) return
		sweeping = true
		try {
			const due = await ctx.store.dueObjects(ctx.clock.now(), 25)
			for (const row of due) {
				try {
					if (row.provider === 'stripe' && row.type === 'checkout.session') {
						await markSessionExpired(ctx, row.id)
					} else if (row.provider === 'stripe' && row.type === 'refund') {
						await settleRefund(ctx, row.id)
					} else if (row.provider === 'checkout' && row.type === 'action') {
						await settleRefundAction(ctx, row.id)
					}
				} catch (error) {
					ctx.log(
						`transition for ${row.provider}/${row.id} failed: ${
							error instanceof Error ? error.message : String(error)
						}`,
					)
				}
			}
			await deliverDue(ctx)
		} finally {
			sweeping = false
		}
	}

	async function enter() {
		await ctx.clock.refresh()
		await sweep()
	}

	async function resolveObject(provider: MockProvider, id: string) {
		let target = id
		if (provider === 'checkout' && id.startsWith('sid_')) {
			const session = await findCheckoutObject(ctx, id, 'session')
			if (session) target = String(session.json.payment_id)
		}
		const row = await ctx.store.getObject(provider, target)
		if (!row) return null
		return {
			type: row.type,
			...(provider === 'stripe'
				? stripePublic(row.json)
				: checkoutPublic(row.json)),
		}
	}

	const emulator = {
		sentinel: PAYMENTS_MOCK_SENTINEL,
		ctx,
		sweep,
		stripe: {
			fetch: async (request: Request) => {
				await enter()
				return handleStripeRequest(ctx, request)
			},
		},
		checkout: {
			fetch: async (request: Request) => {
				await enter()
				return handleCheckoutRequest(ctx, request)
			},
		},
		/** Hosted-page logic (the App routes render and post to these). */
		pages: {
			stripe: {
				describeSession: async (id: string) => (
					await enter(),
					describeCheckoutSession(ctx, id)
				),
				submit: async (id: string, submission: CheckoutSubmission) => (
					await enter(),
					submitCheckoutCard(ctx, id, submission)
				),
				describeAttempt: async (id: string) => (
					await enter(),
					describeStripeAttempt(ctx, id)
				),
				resolveThreeDS: async (id: string, decision: 'complete' | 'fail') => (
					await enter(),
					resolveThreeDSChallenge(ctx, id, decision)
				),
				describeOnboarding: async (linkId: string) => {
					await enter()
					const link = await findStripeObject(ctx, linkId, 'account_link')
					if (!link) return null
					const account = await findStripeObject(
						ctx,
						String(link.json.account),
						'account',
					)
					return account
						? {
								link: stripePublic(link.json),
								account: stripePublic(account.json),
							}
						: null
				},
				completeOnboarding: async (
					linkId: string,
					outcome: OnboardingOutcome,
				) => {
					await enter()
					const link = await findStripeObject(ctx, linkId, 'account_link')
					if (!link) return null
					await completeAccountOnboarding(
						ctx,
						String(link.json.account),
						outcome,
					)
					return { returnUrl: String(link.json.return_url) }
				},
				describeAccount: async (id: string) => {
					await enter()
					const account = await findStripeObject(ctx, id, 'account')
					return account ? stripePublic(account.json) : null
				},
				ledger: async (accountId: string) => (
					await enter(),
					accountLedger(ctx, accountId)
				),
			},
			checkout: {
				describeHpp: async (id: string) => (
					await enter(),
					describeHostedPayment(ctx, id)
				),
				submit: async (id: string, submission: HostedSubmission) => (
					await enter(),
					submitHostedPayment(ctx, id, submission)
				),
				describeAttempt: async (id: string) => (
					await enter(),
					describeHostedAttempt(ctx, id)
				),
				resolveThreeDS: async (id: string, password: string) => (
					await enter(),
					resolveHostedThreeDS(ctx, id, password)
				),
				dashboard: async () => (await enter(), dashboardSnapshot(ctx)),
				activate: async (
					id: string,
					capabilities: { payments?: boolean; payouts?: boolean },
				) => (await enter(), activateEntity(ctx, id, capabilities)),
			},
		},
		events: {
			list: async (
				filter: { provider?: MockProvider; type?: string; limit?: number } = {},
			) => {
				await enter()
				return ctx.store.listEvents(filter)
			},
			flush: async (filter: { provider?: MockProvider } = {}) => (
				await enter(),
				flushEvents(ctx, filter)
			),
			redeliver: async (provider: MockProvider, id: string) => (
				await enter(),
				redeliverEvent(ctx, provider, id)
			),
		},
		object: async (provider: MockProvider, id: string) => (
			await enter(),
			resolveObject(provider, id)
		),
		reset: async () => {
			await ctx.store.reset()
		},
		/** Helpers shared by Vitest and the dev control API. */
		testing: {
			async completeCheckout(
				sessionId: string,
				input: Partial<CheckoutSubmission> & { card?: string } = {},
			) {
				await enter()
				const number = toNumber(
					input.card ?? input.number ?? '4242424242424242',
				)
				return submitCheckoutCard(ctx, sessionId, {
					number,
					expiry: input.expiry ?? DEFAULT_TEST_EXPIRY,
					cvc: input.cvc ?? DEFAULT_TEST_CVC,
					email: input.email ?? 'buyer@example.test',
					name: input.name,
					postalCode: input.postalCode ?? '94103',
					threeDS:
						input.threeDS ??
						(stripeProfileForDigits(number)?.threeDS ? 'complete' : undefined),
				})
			},
			async completeHostedPayment(
				hppId: string,
				input: Partial<HostedSubmission> & { card?: string } = {},
			) {
				await enter()
				const number = toNumber(
					input.card ?? input.number ?? '4242424242424242',
				)
				return submitHostedPayment(ctx, hppId, {
					number,
					expiry: input.expiry ?? DEFAULT_TEST_EXPIRY,
					cvc: input.cvc ?? DEFAULT_TEST_CVC,
					email: input.email ?? 'buyer@example.test',
					name: input.name,
					password:
						input.password ??
						(checkoutProfileForDigits(number)?.threeDS
							? CHECKOUT_3DS_PASSWORD
							: undefined),
				})
			},
			async expireSession(sessionId: string) {
				await enter()
				return expireCheckoutSession(ctx, sessionId)
			},
			async settleRefund(refundId: string, outcome?: 'succeeded' | 'failed') {
				await enter()
				return settleRefund(ctx, refundId, outcome)
			},
			async settleCheckoutRefund(
				actionId: string,
				outcome?: 'approved' | 'declined',
			) {
				await enter()
				return settleRefundAction(ctx, actionId, outcome)
			},
			async forceCheckoutRefundDecline(actionId: string) {
				await enter()
				return forceRefundDecline(ctx, actionId)
			},
			async createDispute(paymentIntent: string) {
				await enter()
				return createDispute(ctx, { paymentIntent })
			},
			async closeDispute(disputeId: string, outcome: 'won' | 'lost') {
				await enter()
				return closeDispute(ctx, disputeId, outcome)
			},
			async completeOnboarding(
				accountId: string,
				outcome: OnboardingOutcome = 'complete',
			) {
				await enter()
				return completeAccountOnboarding(ctx, accountId, outcome)
			},
			async activateEntity(
				entityId: string,
				capabilities = { payments: true, payouts: true },
			) {
				await enter()
				return activateEntity(ctx, entityId, capabilities)
			},
			async advanceClock(seconds: number) {
				const offset = await ctx.clock.advance(seconds * 1000)
				await enter()
				return offset
			},
		},
	}
	return emulator
}

export type PaymentsEmulator = ReturnType<typeof createPaymentsEmulator>

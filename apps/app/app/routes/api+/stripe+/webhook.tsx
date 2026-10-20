import { getStripeWebhookSecrets } from '@repo/payments'
import { type ActionFunctionArgs } from 'react-router'
import type Stripe from 'stripe'
import {
	stripe,
	handleSubscriptionChange,
	handleTrialEnd,
} from '#app/utils/payments.server.ts'
import {
	handleConnectAccountUpdated,
	recordShopOrderFromConnectWebhook,
} from '#app/utils/shop.server.ts'

/**
 * Helper function to process subscription events and extract the relevant data
 * for handleSubscriptionChange. Reduces code duplication across multiple event types.
 */
function processSubscriptionEvent(subscription: Stripe.Subscription) {
	return handleSubscriptionChange({
		id: subscription.id,
		status: subscription.status,
		customer: subscription.customer as string,
		items: subscription.items.data.map((item) => ({
			price: {
				id: item.price.id,
				product: item.price.product as string,
			},
		})),
	})
}

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 })
	}

	const payload = await request.text()
	const signature = request.headers.get('stripe-signature')

	if (!signature) {
		console.error('Missing Stripe signature')
		return new Response('Missing signature', { status: 400 })
	}

	// The platform secret and, when set, the Connect secret: Connect events
	// (`account.updated`) are signed by a second endpoint secret. Stripe's
	// verifier compares in constant time.
	const secrets = getStripeWebhookSecrets(process.env)
	if (secrets.length === 0) {
		console.error('Stripe webhook secret is not configured')
		return new Response('Webhook not configured', { status: 500 })
	}

	let event: Stripe.Event | null = null
	let verificationError: unknown = null
	for (const secret of secrets) {
		try {
			event = stripe.webhooks.constructEvent(payload, signature, secret)
			break
		} catch (error) {
			verificationError = error
		}
	}
	if (!event) {
		console.error('Webhook signature verification failed:', verificationError)
		return new Response('Invalid signature', { status: 400 })
	}

	try {
		switch (event.type) {
			case 'customer.subscription.created':
			case 'customer.subscription.updated':
			case 'customer.subscription.deleted': {
				const subscription = event.data.object as Stripe.Subscription
				await processSubscriptionEvent(subscription)
				break
			}

			case 'customer.subscription.trial_will_end': {
				const subscription = event.data.object as Stripe.Subscription
				await handleTrialEnd({
					id: subscription.id,
					customer: subscription.customer as string,
					trial_end: subscription.trial_end,
				})
				break
			}

			case 'invoice.payment_succeeded': {
				const ignoredInvoice = event.data.object as Stripe.Invoice
				// You can add additional logic here for successful payments
				break
			}

			case 'invoice.payment_failed': {
				const ignoredInvoice = event.data.object as Stripe.Invoice
				// You can add additional logic here for failed payments
				// Such as sending notifications to admins
				break
			}

			case 'customer.subscription.paused': {
				const subscription = event.data.object as Stripe.Subscription
				await processSubscriptionEvent(subscription)
				break
			}

			case 'customer.subscription.resumed': {
				const subscription = event.data.object as Stripe.Subscription
				await processSubscriptionEvent(subscription)
				break
			}

			case 'checkout.session.completed': {
				const session = event.data.object as Stripe.Checkout.Session
				await recordShopOrderFromConnectWebhook(session, event.type)
				break
			}

			case 'payment_intent.succeeded': {
				const paymentIntent = event.data.object as Stripe.PaymentIntent
				await recordShopOrderFromConnectWebhook(paymentIntent, event.type)
				break
			}

			case 'account.updated': {
				const account = event.data.object as Stripe.Account
				await handleConnectAccountUpdated(account)
				break
			}

			default: {
				// Unhandled webhook event type
			}
		}

		return new Response('Webhook processed successfully', { status: 200 })
	} catch (error) {
		console.error(`Error processing webhook ${event.type}:`, error)
		return new Response('Webhook processing failed', { status: 500 })
	}
}

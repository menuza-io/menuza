import { getStripeWebhookSecrets } from '@repo/payments'
import { type ActionFunctionArgs } from 'react-router'
import type Stripe from 'stripe'
import {
	stripe,
	handleSubscriptionChange,
	handleTrialEnd,
} from '#app/utils/payments.server.ts'
import {
	handlePrintStripeSession,
	isPrintStripeMetadata,
} from '#app/utils/print/orders.server.ts'
import {
	handleReservationStripeDisputeEvent,
	handleReservationStripeRefundEvent,
	handleReservationStripeSessionEvent,
	isReservationStripeMetadata,
} from '#app/utils/reservations/payment-webhooks.server.ts'
import {
	handleRestaurantOrderStripeSessionEvent,
	isRestaurantStripeMetadata,
} from '#app/utils/restaurant-orders/payment-webhooks.server.ts'
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
	const secrets = getStripeWebhookSecrets(process.env, request)
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

	// Every checkout session and payment intent this App creates lives on the
	// platform account (destination charges). The same objects from a
	// connected account are that account's own, whatever their metadata
	// claims: never act on them. Connected accounts only report
	// `account.updated` here.
	if (
		event.account &&
		(event.type.startsWith('checkout.session.') ||
			event.type.startsWith('payment_intent.'))
	) {
		return new Response('Ignored', { status: 200 })
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

			case 'checkout.session.completed':
			case 'checkout.session.async_payment_succeeded':
			case 'checkout.session.async_payment_failed':
			case 'checkout.session.expired': {
				const session = event.data.object as Stripe.Checkout.Session
				if (isReservationStripeMetadata(session.metadata)) {
					// Reservation payments: ids and amounts go to the org's region;
					// a regional failure throws so Stripe retries.
					await handleReservationStripeSessionEvent(session, event.type)
					break
				}
				if (isPrintStripeMetadata(session.metadata)) {
					// Print shop orders (platform account): a paid session submits
					// the order to its vendors.
					await handlePrintStripeSession(session, event.type)
					break
				}
				if (isRestaurantStripeMetadata(session.metadata)) {
					// Restaurant orders: forward the non-PII payment facts to the
					// org's regional tenant service. A regional failure throws so
					// this handler returns non-2xx and Stripe retries.
					await handleRestaurantOrderStripeSessionEvent(session, event.type)
					break
				}
				if (event.type === 'checkout.session.completed') {
					await recordShopOrderFromConnectWebhook(session, event.type)
				}
				break
			}

			case 'payment_intent.succeeded': {
				const paymentIntent = event.data.object as Stripe.PaymentIntent
				if (isReservationStripeMetadata(paymentIntent.metadata)) {
					// Reservation payments settle on the session (or, for staff fee
					// charges, synchronously); the intent event adds nothing.
					break
				}
				if (isPrintStripeMetadata(paymentIntent.metadata)) {
					// Print orders settle on the session event.
					break
				}
				if (isRestaurantStripeMetadata(paymentIntent.metadata)) {
					// Restaurant order payment intents carry no checkout session
					// reference, so they cannot be verified against the regionally
					// bound session. Session-level events are authoritative instead.
					break
				}
				await recordShopOrderFromConnectWebhook(paymentIntent, event.type)
				break
			}

			case 'refund.updated':
			case 'refund.failed':
			case 'charge.refund.updated': {
				await handleReservationStripeRefundEvent(
					event.data.object as Stripe.Refund,
				)
				break
			}

			case 'charge.dispute.created':
			case 'charge.dispute.closed': {
				await handleReservationStripeDisputeEvent(
					event.data.object as Stripe.Dispute,
					event.type,
				)
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

import {
	checkoutWebhookSignatureFromRequest,
	createShopCommerce,
	createShopCommerceConfigFromEnv,
	hostedWebhookHeadersFromRequest,
	parseHostedShopWebhook,
} from '@repo/payments'
import { type ActionFunctionArgs } from 'react-router'
import { handleRestaurantOrderCheckoutWebhookEvent } from '#app/utils/restaurant-orders/payment-webhooks.server.ts'
import { recordShopOrder } from '#app/utils/shop.server.ts'

const shopCommerce = createShopCommerce(
	createShopCommerceConfigFromEnv(process.env),
)

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 })
	}

	const payload = await request.text()
	const checkoutSignature = checkoutWebhookSignatureFromRequest(request)
	const hostedHeaders = hostedWebhookHeadersFromRequest(request)

	if (checkoutSignature) {
		if (!shopCommerce.isProcessorConfigured('checkout')) {
			return new Response('Checkout.com webhooks are not configured', {
				status: 503,
			})
		}

		let verifiedEvent: { type: string; data: unknown }
		try {
			verifiedEvent = shopCommerce.verifyCheckoutWebhook(
				payload,
				checkoutSignature,
			)
		} catch (error) {
			console.error('Checkout.com shop webhook processing failed:', error)
			const status =
				error instanceof Error && error.message.includes('signature')
					? 400
					: 500
			return new Response(
				status === 400 ? 'Invalid signature' : 'Webhook processing failed',
				{ status },
			)
		}

		try {
			// Restaurant orders first: forward the non-PII payment facts to the
			// org's regional tenant service. A regional failure throws so this
			// handler returns non-2xx and Checkout.com retries.
			await handleRestaurantOrderCheckoutWebhookEvent(verifiedEvent)

			const event = shopCommerce.parseCheckoutWebhookEvent(verifiedEvent)
			if (event) {
				await recordShopOrder(event.order)
			}

			return new Response('Webhook processed successfully', { status: 200 })
		} catch (error) {
			console.error('Checkout.com shop webhook processing failed:', error)
			return new Response('Webhook processing failed', { status: 500 })
		}
	}

	if (!hostedHeaders['webhook-signature']) {
		return new Response('Missing webhook signature', { status: 400 })
	}

	if (!shopCommerce.isProcessorConfigured('mor')) {
		return new Response('Hosted checkout webhooks are not configured', {
			status: 503,
		})
	}

	try {
		const event = parseHostedShopWebhook(shopCommerce, payload, hostedHeaders)
		if (event) {
			await recordShopOrder(event.order)
		}

		return new Response('Webhook processed successfully', { status: 200 })
	} catch (error) {
		console.error('Hosted shop webhook processing failed:', error)
		const status =
			error instanceof Error && error.message.includes('signature') ? 400 : 500
		return new Response(
			status === 400 ? 'Invalid signature' : 'Webhook processing failed',
			{ status },
		)
	}
}

import {
	checkoutWebhookSignatureFromRequest,
	hostedWebhookHeadersFromRequest,
	parseHostedShopWebhook,
} from '@repo/payments'
import { type ActionFunctionArgs } from 'react-router'
import {
	getShopCommerce,
	recordShopOrder,
	recordShopOrderFromCheckoutWebhook,
} from '#app/utils/shop.server.ts'

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 })
	}

	// The App-wide commerce, so the payment mock's synthetic Checkout.com
	// settings (and webhook secret) apply here exactly as they do for orders.
	const shopCommerce = getShopCommerce()
	const payload = await request.text()
	const checkoutSignature = checkoutWebhookSignatureFromRequest(request)
	const hostedHeaders = hostedWebhookHeadersFromRequest(request)

	if (checkoutSignature) {
		if (!shopCommerce.isProcessorConfigured('checkout')) {
			return new Response('Checkout.com webhooks are not configured', {
				status: 503,
			})
		}

		try {
			await recordShopOrderFromCheckoutWebhook(payload, checkoutSignature)
			return new Response('Webhook processed successfully', { status: 200 })
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

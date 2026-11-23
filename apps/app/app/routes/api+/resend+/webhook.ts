import { applyResendDeliveryEvent } from '@repo/auth'
import { verifyResendWebhook } from '@repo/email'
import { handlePlatformResendWebhook } from '@repo/marketing/server/platform-resend-webhook'
import { type ActionFunctionArgs } from 'react-router'

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 })
	}

	const webhookSecret = process.env.RESEND_WEBHOOK_SECRET
	if (!webhookSecret) {
		console.error('RESEND_WEBHOOK_SECRET is not configured')
		return new Response('Webhook not configured', { status: 503 })
	}

	const payload = await request.text()
	let event: unknown

	try {
		event = verifyResendWebhook({
			payload,
			webhookSecret,
			headers: {
				id: request.headers.get('svix-id'),
				timestamp: request.headers.get('svix-timestamp'),
				signature: request.headers.get('svix-signature'),
			},
		})
	} catch (error) {
		console.error('Resend webhook signature verification failed:', error)
		return new Response('Invalid signature', { status: 400 })
	}

	try {
		// Delivered, bounced, delayed and so on for a sign-in code email (#246):
		// updates the Sign-in help log. Ignored when the id is not one of ours.
		const signInDelivery = await applyResendDeliveryEvent(event)
		const result = await handlePlatformResendWebhook(event)
		return Response.json({ ok: true, ...result, signInDelivery })
	} catch (error) {
		console.error('Resend webhook processing failed:', error)
		return new Response('Webhook processing failed', { status: 500 })
	}
}

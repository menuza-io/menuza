import { Hono } from 'hono'
import { consentBaseUrl } from '../lib/email-consent.ts'
import { readCappedRequestText } from '../lib/http.ts'
import { forwardSmsStatus } from '../lib/sms-status-forward.ts'
import {
	isInboundProvider,
	verifySmsStatus,
} from '../lib/sms-inbound-provider.ts'
import { smsRouteAvailable } from '../lib/sms-route.ts'

/**
 * `POST /webhooks/sms-status/:provider`: the carrier's delivery report for a
 * text this node sent (#246). The provider's signature is checked first; the
 * report is then handed to the App by message id, status and error code only.
 * The account's number and the text never travel here.
 */
export const smsStatusWebhookRoutes = new Hono()

const MAX_BODY_BYTES = 16 * 1024

smsStatusWebhookRoutes.post('/:provider', async (c) => {
	const provider = c.req.param('provider')
	if (!smsRouteAvailable() || !isInboundProvider(provider)) {
		return c.json({ error: 'not_found' }, 404)
	}
	const rawBody = await readCappedRequestText(c.req.raw, MAX_BODY_BYTES)
	if (rawBody === null) return c.json({ error: 'too_large' }, 413)

	const origin = consentBaseUrl()
	const publicUrl = origin
		? `${origin}/webhooks/sms-status/${provider}`
		: c.req.url.split('?')[0]!
	const verified = verifySmsStatus(provider, {
		publicUrl,
		rawBody,
		signature:
			provider === 'twilio'
				? c.req.header('X-Twilio-Signature')
				: c.req.header('X-Mock-Signature'),
	})
	if (!verified.ok) {
		if (verified.reason === 'unconfigured') {
			return c.json({ error: 'not_configured' }, 503)
		}
		return c.json(
			{
				error: verified.reason === 'bad_payload' ? 'bad_request' : 'forbidden',
			},
			verified.reason === 'bad_payload' ? 400 : 401,
		)
	}
	const forwarded = await forwardSmsStatus(verified.event)
	// The provider retries a 5xx: the App could not be told, so ask again later.
	return forwarded ? c.json({ ok: true }) : c.json({ error: 'try_again' }, 502)
})

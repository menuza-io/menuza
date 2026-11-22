import { matchSmsKeyword } from '@repo/common/sms-compliance'
import { forwardAlertKeyword } from '../lib/alert-keyword.ts'
import { runInBackground } from '../lib/background.ts'
import { consentBaseUrl } from '../lib/email-consent.ts'
import { readCappedRequestText } from '../lib/http.ts'
import {
	isInboundProvider,
	twimlReply,
	verifyInboundSms,
} from '../lib/sms-inbound-provider.ts'
import { smsRouteAvailable } from '../lib/sms-route.ts'
import { isValidPhone, normalizePhone } from '../lib/phone.ts'
import { applyInboundSms, type InboundFanOut } from './sms-inbound.ts'

/** Longest webhook body read. A reply is a few hundred bytes. */
const MAX_BODY_BYTES = 16 * 1024

const XML = {
	'Content-Type': 'text/xml; charset=utf-8',
	'Cache-Control': 'no-store',
}

function reply(text: string | null, status = 200) {
	return new Response(twimlReply(text), { status, headers: XML })
}

/**
 * `POST /webhooks/sms/:provider` for the Node runtime and the Workers edge
 * alike (#75). Verifies the provider's signature first, then reads the reply:
 * a keyword is applied to every organization on the node that has texted the
 * phone, and the single answer goes back as TwiML. The body is read only to
 * match a keyword and is never stored; nothing but ids is logged.
 *
 * - A forged or missing signature is 401 before the fields are looked at.
 * - A provider retry is processed once (event rows are unique per message id).
 * - Only the US node handles texts; a KSA number is answered with nothing.
 */
export async function handleInboundSmsWebhook(
	request: Request,
	provider: string,
	fanOut: () => Promise<InboundFanOut>,
): Promise<Response> {
	if (!smsRouteAvailable() || !isInboundProvider(provider)) {
		return Response.json({ error: 'not_found' }, { status: 404 })
	}
	// The stream is counted and cancelled at the cap: a chunked body has no
	// content-length, and this runs before the signature is checked.
	const rawBody = await readCappedRequestText(request, MAX_BODY_BYTES)
	if (rawBody === null) {
		return Response.json({ error: 'too_large' }, { status: 413 })
	}

	const origin = consentBaseUrl()
	const publicUrl = origin
		? `${origin}/webhooks/sms/${provider}`
		: request.url.split('?')[0]!
	const verified = verifyInboundSms(provider, {
		publicUrl,
		rawBody,
		signature:
			provider === 'twilio'
				? request.headers.get('X-Twilio-Signature')
				: request.headers.get('X-Mock-Signature'),
	})
	if (!verified.ok) {
		if (verified.reason === 'unconfigured') {
			return Response.json({ error: 'not_configured' }, { status: 503 })
		}
		return Response.json(
			{
				error: verified.reason === 'bad_payload' ? 'bad_request' : 'forbidden',
			},
			{ status: verified.reason === 'bad_payload' ? 400 : 401 },
		)
	}
	const { message } = verified

	const keyword = matchSmsKeyword(message.body)
	if (!keyword) return reply(null)

	// The US node never handles a KSA number: those belong to the in-kingdom
	// provider (#78). Answered with nothing, logged by message id only.
	const phone = normalizePhone(message.from)
	if (!isValidPhone(phone) || phone.startsWith('+966')) {
		console.info('Inbound text ignored: number not handled on this node', {
			providerMessageId: message.providerMessageId,
		})
		return reply(null)
	}

	// The same reply may be a text recipient of order alerts (#241) stopping or
	// restarting them: the App matches a hash of the sender, never the number.
	if (keyword === 'stop' || keyword === 'start') {
		runInBackground(
			forwardAlertKeyword({
				keyword,
				from: message.from,
				providerMessageId: message.providerMessageId,
			}),
		)
	}

	const result = await applyInboundSms(await fanOut(), {
		providerMessageId: message.providerMessageId,
		from: message.from,
		keyword,
	})
	if (result.failed > 0) {
		// The provider retries a 5xx; organizations already done answer
		// `duplicate`, so only the ones that failed are tried again.
		return Response.json({ error: 'try_again' }, { status: 500 })
	}
	if (result.matched === 0 && result.duplicates === 0) {
		console.info('Inbound text matched no organization', {
			providerMessageId: message.providerMessageId,
		})
	}
	return reply(result.reply)
}

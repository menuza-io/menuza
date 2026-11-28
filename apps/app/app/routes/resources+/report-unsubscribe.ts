import { getClientIp } from '@repo/security'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import {
	checkRateLimit,
	createRateLimitResponse,
	type RateLimitConfig,
} from '#app/utils/rate-limit.server.ts'
import {
	applyReportUnsubscribe,
	isValidReportUnsubscribeToken,
} from '#app/utils/reports/report-unsubscribe.server.ts'

/**
 * Unsubscribe from a report email (#121, #221), with no login: the link in the
 * email carries a signed token that names one recipient and one thing to
 * switch off.
 *
 * - GET (the link) changes nothing. Mail scanners, link previewers and
 *   prefetchers open links, so it answers a page with a button that POSTs.
 * - POST does the write: that button, and a mail client's one-click
 *   (`List-Unsubscribe-Post`, RFC 8058, which posts to the same URL).
 *
 * A forged or edited token changes nothing and answers 400. The only thing the
 * page repeats from the request is a token that has just verified (it is made
 * of URL-safe characters) and is escaped anyway. Rate limited per address.
 */
const RATE_LIMIT: RateLimitConfig = {
	scope: 'report-unsubscribe',
	maxRequests: process.env.NODE_ENV === 'development' ? 1000 : 30,
	windowMs: 60 * 1000,
}

const PAGE = (title: string, body: string) =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;"><h1 style="font-size:1.25rem;">${title}</h1>${body}</body></html>`

const HEADERS = {
	'Cache-Control': 'private, no-store',
	'Content-Type': 'text/html; charset=utf-8',
	'Referrer-Policy': 'no-referrer',
}

const escapeHtml = (value: string) =>
	value.replace(
		/[&<>"']/gu,
		(c) =>
			({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
				c
			]!,
	)

function invalid() {
	return new Response(
		PAGE(
			'This link is not valid',
			'<p>It may have been edited or cut short.</p>',
		),
		{ status: 400, headers: HEADERS },
	)
}

async function limited(request: Request) {
	const result = await checkRateLimit(
		{ type: 'ip', value: getClientIp(request) },
		RATE_LIMIT,
	)
	return result.allowed ? null : createRateLimitResponse(result.resetAt)
}

function tokenOf(request: Request) {
	const token = new URL(request.url).searchParams.get('token')
	return token && token.length <= 600 ? token : null
}

export async function loader({ request }: LoaderFunctionArgs) {
	const tooMany = await limited(request)
	if (tooMany) return tooMany
	const token = tokenOf(request)
	if (!token || !isValidReportUnsubscribeToken(token)) return invalid()
	const action = `/resources/report-unsubscribe?token=${encodeURIComponent(token)}`
	return new Response(
		PAGE(
			'Unsubscribe from this email?',
			`<p>You will stop getting this email. You can turn it back on in Settings, Notifications.</p><form method="post" action="${escapeHtml(action)}"><button type="submit" style="font:inherit;padding:.5rem 1rem;cursor:pointer;">Unsubscribe</button></form>`,
		),
		{ status: 200, headers: HEADERS },
	)
}

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	const tooMany = await limited(request)
	if (tooMany) return tooMany
	const token = tokenOf(request)
	if (!token) return invalid()
	const result = await applyReportUnsubscribe(token)
	if (!result.ok) return invalid()
	return new Response(
		PAGE(
			'You are unsubscribed',
			'<p>You will not get this email again. You can turn it back on in Settings, Notifications.</p>',
		),
		{ status: 200, headers: HEADERS },
	)
}

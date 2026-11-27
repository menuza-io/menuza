import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { applyReportUnsubscribe } from '#app/utils/reports/report-unsubscribe.server.ts'

/**
 * One-click unsubscribe from a report email (#121, #221), with no login: the
 * link in the email carries a signed token that names one recipient and one
 * thing to switch off. GET (the link) answers a small page; POST is the mail
 * client's one-click (`List-Unsubscribe-Post`, RFC 8058). A forged or edited
 * token changes nothing and answers 400. The page holds nothing from the
 * request, so nothing can be reflected into it.
 */
const PAGE = (title: string, body: string) =>
	`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;"><h1 style="font-size:1.25rem;">${title}</h1><p>${body}</p></body></html>`

const NO_STORE = {
	'Cache-Control': 'private, no-store',
	'Content-Type': 'text/html; charset=utf-8',
}

async function handle(token: string | null) {
	if (!token || token.length > 600) {
		return new Response(
			PAGE('This link is not valid', 'It may have been edited or cut short.'),
			{ status: 400, headers: NO_STORE },
		)
	}
	const result = await applyReportUnsubscribe(token)
	if (!result.ok) {
		return new Response(
			PAGE('This link is not valid', 'It may have been edited or cut short.'),
			{ status: 400, headers: NO_STORE },
		)
	}
	return new Response(
		PAGE(
			'You are unsubscribed',
			'You will not get this email again. You can turn it back on in Settings, Notifications.',
		),
		{ status: 200, headers: NO_STORE },
	)
}

export async function loader({ request }: LoaderFunctionArgs) {
	return handle(new URL(request.url).searchParams.get('token'))
}

export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	return handle(new URL(request.url).searchParams.get('token'))
}

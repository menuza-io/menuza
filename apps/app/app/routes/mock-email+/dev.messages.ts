import { type LoaderFunctionArgs } from 'react-router'
import {
	listCapturedEmails,
	requireMockEmailEnabled,
} from '#app/utils/dev-email-capture.server.ts'
import { parseSince } from '#app/utils/dev-email-capture.shared.ts'

/**
 * Dev only: `GET /mock-email/dev/messages?to=&since=&limit=`, newest first.
 * `since` is epoch milliseconds or an ISO date. 404 without `MOCKS=true`.
 */
export async function loader({ request }: LoaderFunctionArgs) {
	requireMockEmailEnabled()
	const params = new URL(request.url).searchParams
	const sinceParam = params.get('since')
	const since = sinceParam === null ? null : parseSince(sinceParam)
	if (sinceParam !== null && since === null) {
		return Response.json({ error: 'invalid_since' }, { status: 400 })
	}
	const limit = Number(params.get('limit') ?? '')
	const messages = await listCapturedEmails({
		to: params.get('to'),
		since,
		limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
	})
	return Response.json(messages, { headers: { 'Cache-Control': 'no-store' } })
}

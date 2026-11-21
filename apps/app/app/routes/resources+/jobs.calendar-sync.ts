import { type ActionFunctionArgs } from 'react-router'
import {
	syncCalendarSource,
	syncDueCalendars,
} from '#app/utils/events/calendar-sync.server.ts'
import { requireInternalCommandAuth } from '#app/utils/internal-command-auth.server.ts'

/**
 * Reads connected Google Calendars into the website's events (#319).
 * - `{ sourceId }`: the Workflow's wake-up (`CalendarSyncWorkflow`, which
 *   sleeps until the source is due). The source is read now only when it is due;
 *   the next wake-up is scheduled by the sync itself.
 * - An empty body (the hourly `0 * * * *` sweep): every source that is due.
 * Never touches the calendar: read-only.
 */
export async function action({ request }: ActionFunctionArgs) {
	if (request.method !== 'POST') {
		return new Response('Method Not Allowed', { status: 405 })
	}
	await requireInternalCommandAuth(request)
	const text = await request.text().catch(() => '')
	let sourceId = ''
	if (text.trim()) {
		try {
			const body = JSON.parse(text) as { sourceId?: unknown }
			sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim() : ''
		} catch {
			return Response.json({ success: false }, { status: 400 })
		}
	}
	if (!sourceId) {
		return Response.json({ success: true, ...(await syncDueCalendars()) })
	}
	if (!/^[a-z0-9]{8,64}$/iu.test(sourceId)) {
		return Response.json({ success: false }, { status: 400 })
	}
	const outcome = await syncCalendarSource(sourceId, {}, { onlyIfDue: true })
	return Response.json({
		success: outcome.ok,
		sourceId,
		...(outcome.ok ? { report: outcome.report } : { error: outcome.error }),
	})
}

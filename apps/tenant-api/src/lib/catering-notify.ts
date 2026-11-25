import {
	CATERING_NOTIFY_PATH,
	cateringNotifyEventSchema,
	type CateringNotifyEvent,
} from '@repo/common/catering'
import { ENV } from 'varlock/env'
import { fetchApp } from './app-service.ts'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Posts one catering notice to the US App (`POST /resources/catering/notify`,
 * internal token): a new quote request or order, a paid quote or balance, an
 * event tomorrow, a balance overdue. The event is ids and a count only (the
 * schema is strict, so a name, phone, email, note or line cannot ride along);
 * the App owns who is told and how. Best effort, never throws: the request,
 * order or payment itself is already recorded.
 */
export async function postCateringNotify(
	event: CateringNotifyEvent,
): Promise<'delivered' | 'retry' | 'rejected'> {
	const parsed = cateringNotifyEventSchema.safeParse(event)
	if (!parsed.success) return 'rejected'
	syncEnvFromProcess()
	const base = (ENV.APP_URL || '').replace(/\/$/, '')
	const token = getInternalCommandToken()
	if (!base || token.length < 16) return 'retry'
	try {
		const response = await fetchApp(`${base}${CATERING_NOTIFY_PATH}`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(parsed.data),
			signal: AbortSignal.timeout(8_000),
		})
		void response.body?.cancel().catch(() => undefined)
		if (response.ok) return 'delivered'
		return [401, 408, 425, 429, 500, 502, 503, 504].includes(response.status)
			? 'retry'
			: 'rejected'
	} catch {
		return 'retry'
	}
}

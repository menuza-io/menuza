import {
	FORM_NOTIFY_PATH,
	formResponseEventSchema,
	formResponseResultSchema,
	type FormResponseEvent,
	type FormResponseResult,
} from '@repo/common/form-alerts'
import { ENV } from 'varlock/env'
import { fetchApp } from './app-service.ts'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Posts one "new form response" event to the US App (`POST
 * /resources/forms/notify`, internal token). The event is validated against a
 * strict schema first: an organization id, a form id and name, a count, who is
 * notified. No answer, name or contact can leave the region (#142).
 */
export type FormNotifyOutcome =
	| { status: 'delivered'; result: FormResponseResult }
	| { status: 'retry'; code: string }
	| { status: 'rejected'; code: string }

const RETRYABLE = new Set([401, 408, 425, 429, 500, 502, 503, 504])

export async function postFormResponseEvent(
	event: FormResponseEvent,
): Promise<FormNotifyOutcome> {
	const parsed = formResponseEventSchema.safeParse(event)
	if (!parsed.success) return { status: 'rejected', code: 'invalid_event' }
	syncEnvFromProcess()
	const base = (ENV.APP_URL || '').replace(/\/$/, '')
	const token = getInternalCommandToken()
	if (!base || token.length < 16) {
		return { status: 'retry', code: 'not_configured' }
	}
	try {
		const response = await fetchApp(`${base}${FORM_NOTIFY_PATH}`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(parsed.data),
			signal: AbortSignal.timeout(8_000),
		})
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined)
			return {
				status: RETRYABLE.has(response.status) ? 'retry' : 'rejected',
				code: `http_${response.status}`,
			}
		}
		const body = formResponseResultSchema.safeParse(
			await response.json().catch(() => null),
		)
		return {
			status: 'delivered',
			result: body.success ? body.data : { inApp: 0, emailed: 0 },
		}
	} catch {
		return { status: 'retry', code: 'network_error' }
	}
}

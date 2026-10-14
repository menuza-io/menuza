import { ENV } from 'varlock/env'
import {
	managerAlertEventSchema,
	managerAlertResultSchema,
	STAFFING_NOTIFY_PATH,
	type ManagerAlertEvent,
	type ManagerAlertResult,
} from '@repo/staffing'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Sends a manager alert to the App, which owns operators' email addresses and
 * notification preferences. The event is validated against the strict contract
 * before it leaves (an organization id, a kind, a scope id and a count; no
 * staff id, name, time or pay), so a bug upstream cannot leak a person across
 * the plane boundary.
 */

export type ManagerAlertOutcome =
	| { status: 'delivered'; result: ManagerAlertResult }
	/** The App cannot take it now; try again later. */
	| { status: 'retry'; code: string }
	/** The App will never take it (bad request, unknown organization). */
	| { status: 'rejected'; code: string }

/** Statuses worth retrying: the App or the network may recover. */
const RETRYABLE = new Set([401, 408, 425, 429, 500, 502, 503, 504])

function appUrl() {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

export async function sendManagerAlert(
	event: ManagerAlertEvent,
): Promise<ManagerAlertOutcome> {
	const parsed = managerAlertEventSchema.safeParse(event)
	// A malformed event is a bug here, not something the App can fix by retrying.
	if (!parsed.success) return { status: 'rejected', code: 'invalid_event' }

	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16)
		return { status: 'retry', code: 'not_configured' }

	try {
		const response = await fetch(`${base}${STAFFING_NOTIFY_PATH}`, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(parsed.data),
			redirect: 'error',
			signal: AbortSignal.timeout(8_000),
		})
		if (!response.ok) {
			return {
				status: RETRYABLE.has(response.status) ? 'retry' : 'rejected',
				code: `http_${response.status}`,
			}
		}
		const body = managerAlertResultSchema.safeParse(
			await response.json().catch(() => null),
		)
		// A 200 the App sent is delivered even if the body is unfamiliar: the App
		// has the event, and sending it again would only duplicate it.
		return {
			status: 'delivered',
			result: body.success ? body.data : { inApp: 0, emailed: 0 },
		}
	} catch {
		return { status: 'retry', code: 'network_error' }
	}
}

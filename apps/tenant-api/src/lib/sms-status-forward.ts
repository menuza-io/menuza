import { fetchApp } from './app-service.ts'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'
import { type SmsStatusEvent } from './sms-inbound-provider.ts'
import { ENV } from 'varlock/env'

/** The App route that records a delivery status for a sign-in code text (#246). */
export const SMS_STATUS_APP_PATH = '/resources/support/sms-status'

/**
 * Tells the App what the carrier did with a text this node sent: the message
 * id, a status word and an error code. No number, no text. Best effort: a
 * failure never changes the answer the provider gets.
 */
export async function forwardSmsStatus(
	event: SmsStatusEvent,
): Promise<boolean> {
	syncEnvFromProcess()
	const token = getInternalCommandToken()
	const base = (
		ENV.APP_URL ||
		(ENV as { BASE_URL?: string }).BASE_URL ||
		''
	).replace(/\/$/, '')
	if (token.length < 16 || !base) return false
	try {
		const response = await fetchApp(`${base}${SMS_STATUS_APP_PATH}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(event),
			signal: AbortSignal.timeout(8_000),
		})
		void response.body?.cancel().catch(() => undefined)
		return response.ok
	} catch {
		return false
	}
}

import {
	alertPhoneHash,
	ORDERS_ALERT_KEYWORD_PATH,
	type AlertKeywordEvent,
} from '@repo/common/operator-alerts'
import { type SmsKeyword } from '@repo/common/sms-compliance'
import { fetchApp } from './app-service.ts'
import { isValidPhone, normalizePhone } from './phone.ts'
import {
	getInternalCommandToken,
	getOrderAlertHashSecret,
	syncEnvFromProcess,
} from './secrets.ts'
import { ENV } from 'varlock/env'

/**
 * A STOP or START reply to the shared texting number may also be from a person a
 * location chose for order alerts (#241). Those recipients live in the App, so
 * this forwards the keyword with an HMAC (keyed by `ORDER_ALERT_HASH_SECRET`, not the command token) of the sender, never the number: the
 * App matches it against the hash it stored for each text recipient and changes
 * only those. A reply from anyone else changes nothing there. Best effort: a
 * failure never changes the answer the provider gets, and the App's STOP also
 * stops at the carrier.
 */
export async function forwardAlertKeyword(input: {
	keyword: SmsKeyword
	from: string
	providerMessageId: string
}): Promise<boolean> {
	if (input.keyword === 'help') return false
	syncEnvFromProcess()
	const secret = getInternalCommandToken()
	const hashSecret = getOrderAlertHashSecret()
	const base = (
		ENV.APP_URL ||
		(ENV as { BASE_URL?: string }).BASE_URL ||
		''
	).replace(/\/$/, '')
	if (secret.length < 16 || !hashSecret || !base) return false
	const phone = normalizePhone(input.from)
	if (!isValidPhone(phone)) return false
	const event: AlertKeywordEvent = {
		keyword: input.keyword,
		phoneHash: await alertPhoneHash(phone, hashSecret),
		providerMessageId: input.providerMessageId.slice(0, 120),
	}
	try {
		const response = await fetchApp(`${base}${ORDERS_ALERT_KEYWORD_PATH}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${secret}`,
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

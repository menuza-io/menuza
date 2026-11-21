import {
	SMS_ALLOWANCE_PATH,
	smsAllowanceEventSchema,
	smsAllowanceResultSchema,
	type SmsAllowanceEvent,
	type SmsAllowanceResult,
} from '@repo/common/marketing-allowance'
import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Asks the US App to spend, confirm or give back one send of the monthly text
 * allowance (#247). Ids only (the schema is strict). `unavailable` means the
 * App could not answer: a caller that is about to send holds the send back and
 * asks again later; a caller giving a send back may try again on the next tick.
 * `not_configured` is a bare local run, where nothing is counted.
 */
export type SmsAllowanceOutcome =
	SmsAllowanceResult | { ok: 'unavailable' } | { ok: 'not_configured' }

function appUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

export async function postSmsAllowance(
	event: SmsAllowanceEvent,
): Promise<SmsAllowanceOutcome> {
	const parsed = smsAllowanceEventSchema.safeParse(event)
	if (!parsed.success) return { ok: 'unavailable' }
	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) return { ok: 'not_configured' }
	try {
		const response = await fetch(`${base}${SMS_ALLOWANCE_PATH}`, {
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
			void response.body?.cancel().catch(() => undefined)
			return { ok: 'unavailable' }
		}
		const body = smsAllowanceResultSchema.safeParse(await response.json())
		return body.success ? body.data : { ok: 'unavailable' }
	} catch {
		return { ok: 'unavailable' }
	}
}

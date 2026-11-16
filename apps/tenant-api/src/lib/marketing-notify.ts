import {
	MARKETING_NOTIFY_PATH,
	marketingNotifyEventSchema,
	type MarketingNotifyEvent,
} from '@repo/common/marketing-notify'
import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Posts one broadcast notice to the US App (`POST /resources/marketing/notify`,
 * internal token): a scheduled broadcast that could not start in time. Ids only
 * (the schema is strict). Best effort: the campaign itself is marked
 * `SkippedLate` first, so the list still says "Not sent: too late" if the App
 * cannot be reached now. Never throws.
 */
export type MarketingNotifyOutcome =
	| { status: 'delivered' }
	| { status: 'retry'; code: string }
	| { status: 'rejected'; code: string }

const RETRYABLE = new Set([401, 408, 425, 429, 500, 502, 503, 504])

function appUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

export async function postMarketingNotify(
	event: MarketingNotifyEvent,
): Promise<MarketingNotifyOutcome> {
	const parsed = marketingNotifyEventSchema.safeParse(event)
	if (!parsed.success) return { status: 'rejected', code: 'invalid_event' }
	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) {
		return { status: 'retry', code: 'not_configured' }
	}
	try {
		const response = await fetch(`${base}${MARKETING_NOTIFY_PATH}`, {
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
		void response.body?.cancel().catch(() => undefined)
		if (!response.ok) {
			return {
				status: RETRYABLE.has(response.status) ? 'retry' : 'rejected',
				code: `http_${response.status}`,
			}
		}
		return { status: 'delivered' }
	} catch {
		return { status: 'retry', code: 'network_error' }
	}
}

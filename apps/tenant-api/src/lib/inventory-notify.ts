import {
	INVENTORY_NOTIFY_PATH,
	inventoryNotifyEventSchema,
	type InventoryNotifyEvent,
} from '@repo/inventory'
import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Posts one inventory alert to the US App (`POST /resources/inventory/notify`,
 * internal token). The event is ids and a count only (the schema is strict).
 * The outcome tells the tick what to do: `delivered` (also an App answer that
 * skipped the event, so a retry is never asked of what cannot succeed),
 * `retry` (401, 408, 425, 429, 5xx, no network, App not configured) or
 * `rejected` (any other refusal: the event is wrong, retrying cannot help).
 */
export type InventoryNotifyOutcome =
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

export async function postInventoryNotify(
	event: InventoryNotifyEvent,
): Promise<InventoryNotifyOutcome> {
	const parsed = inventoryNotifyEventSchema.safeParse(event)
	if (!parsed.success) return { status: 'rejected', code: 'invalid_event' }
	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) {
		return { status: 'retry', code: 'not_configured' }
	}
	try {
		const response = await fetch(`${base}${INVENTORY_NOTIFY_PATH}`, {
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

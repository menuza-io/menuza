import {
	INVENTORY_AVAILABILITY_PATH,
	inventoryAvailabilityRequestSchema,
	inventoryAvailabilityResultSchema,
	type InventoryAvailabilityRequest,
} from '@repo/inventory'
import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Tells the US App to take dishes off the menu (or give them back) because of
 * stock (`POST /resources/inventory/availability`, internal token). Ids only
 * (the schema is strict). The outcome tells the sync what to record:
 * `applied` carries the entity ids the App actually changed; `retry` (401,
 * 408, 425, 429, 5xx, no network, App not configured) means nothing happened
 * and the sync will ask again; `rejected` means the request itself is wrong
 * and asking again cannot help.
 */
export type InventoryAvailabilityOutcome =
	| { status: 'applied'; applied: string[] }
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

export async function postInventoryAvailability(
	request: InventoryAvailabilityRequest,
): Promise<InventoryAvailabilityOutcome> {
	const parsed = inventoryAvailabilityRequestSchema.safeParse(request)
	if (!parsed.success) return { status: 'rejected', code: 'invalid_request' }
	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) {
		return { status: 'retry', code: 'not_configured' }
	}
	try {
		const response = await fetch(`${base}${INVENTORY_AVAILABILITY_PATH}`, {
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
			return {
				status: RETRYABLE.has(response.status) ? 'retry' : 'rejected',
				code: `http_${response.status}`,
			}
		}
		const answer = inventoryAvailabilityResultSchema.safeParse(
			await response.json().catch(() => null),
		)
		if (!answer.success) return { status: 'rejected', code: 'invalid_answer' }
		// A skipped answer (flag off, unknown location) applied nothing.
		return { status: 'applied', applied: answer.data.applied }
	} catch {
		return { status: 'retry', code: 'network_error' }
	}
}

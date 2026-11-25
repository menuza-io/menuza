import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Own-driver deliveries (#287) are behind the organization flag
 * `delivery.in_house` (default off, only a literal `true`), read from the US App
 * (`GET /resources/pos/flags?orgId=`, internal token). The answer is kept for 5
 * minutes; when the App cannot be asked the flag reads as off (Station's driver
 * routes answer "not enabled") and is not asked again for 30 seconds. The
 * App's own operator routes read the flag from the orders token instead.
 */
const FRESH_MS = 5 * 60_000
const FAILURE_COOLDOWN_MS = 30_000
const TIMEOUT_MS = 2_000

const cache = new Map<string, { at: number; on: boolean; failed: boolean }>()

function appUrl() {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

/** True when this organization uses own-driver deliveries. */
export async function inHouseDeliveryEnabled(orgId: string): Promise<boolean> {
	const now = Date.now()
	const hit = cache.get(orgId)
	if (hit && now - hit.at < (hit.failed ? FAILURE_COOLDOWN_MS : FRESH_MS)) {
		return hit.on
	}
	const base = appUrl()
	const token = getInternalCommandToken()
	let on = false
	let failed = true
	if (base && token.length >= 16) {
		try {
			const response = await fetch(
				`${base}/resources/pos/flags?${new URLSearchParams({ orgId }).toString()}`,
				{
					headers: {
						Accept: 'application/json',
						Authorization: `Bearer ${token}`,
					},
					redirect: 'error',
					signal: AbortSignal.timeout(TIMEOUT_MS),
				},
			)
			if (response.ok) {
				const body = (await response.json()) as { inHouseDelivery?: unknown }
				on = body.inHouseDelivery === true
				failed = false
			}
		} catch {
			/* fail closed */
		}
	}
	if (cache.size > 500) cache.clear()
	cache.set(orgId, { at: now, on, failed })
	return on
}

export function clearInHouseDeliveryFlagCache() {
	cache.clear()
}

/** Tests: set the answer without asking App. */
export function seedInHouseDeliveryFlagForTest(orgId: string, on: boolean) {
	cache.set(orgId, { at: Date.now(), on, failed: false })
}

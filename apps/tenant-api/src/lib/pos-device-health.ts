import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Station connection history (#356) is behind the organization flag
 * `pos.device_health` (default off, only a literal `true`), read from the US
 * App (`GET /resources/pos/flags?orgId=`, internal token). The node kill switch
 * `POS_DEVICE_HEALTH_ENABLED=false` stops collecting at once.
 *
 * The answer is kept for 5 minutes. When App cannot be asked, `off` is assumed
 * and not repeated for 30 seconds: no history is collected during an outage,
 * and nothing else about the till depends on it.
 */
const FRESH_MS = 5 * 60_000
const FAILURE_COOLDOWN_MS = 30_000
const TIMEOUT_MS = 2_000

const cache = new Map<string, { at: number; on: boolean; failed: boolean }>()

export function isDeviceHealthKillSwitchOn(): boolean {
	syncEnvFromProcess()
	const live =
		typeof process !== 'undefined' && process.env
			? process.env.POS_DEVICE_HEALTH_ENABLED
			: (ENV as { POS_DEVICE_HEALTH_ENABLED?: unknown })
					.POS_DEVICE_HEALTH_ENABLED
	return ['false', '0', 'off', 'no', 'disabled'].includes(
		String(live ?? '')
			.trim()
			.toLowerCase(),
	)
}

function appUrl() {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

/** True when this organization collects and shows connection history. */
export async function deviceHealthEnabled(orgId: string): Promise<boolean> {
	if (isDeviceHealthKillSwitchOn()) return false
	const now = Date.now()
	const hit = cache.get(orgId)
	if (hit && now - hit.at < (hit.failed ? FAILURE_COOLDOWN_MS : FRESH_MS))
		return hit.on
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
				const body = (await response.json()) as { deviceHealth?: unknown }
				on = body.deviceHealth === true
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

export function clearDeviceHealthFlagCache() {
	cache.clear()
}

/** Tests: set the answer without asking App. */
export function seedDeviceHealthFlagForTest(orgId: string, on: boolean) {
	cache.set(orgId, { at: Date.now(), on, failed: false })
}

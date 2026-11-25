import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Cloud printers (#117) are behind the organization flag `kitchen.printers`
 * (default off, only a literal `true`), read from the US App
 * (`GET /resources/pos/flags?orgId=`, internal token), and the node kill switch
 * `PRINTING_ENABLED=false`. The answer is kept for 5 minutes; when the App
 * cannot be asked the flag reads as off (nothing is queued, polls answer "no
 * job") and is not asked again for 30 seconds.
 */
const FRESH_MS = 5 * 60_000
const FAILURE_COOLDOWN_MS = 30_000
const TIMEOUT_MS = 2_000

const cache = new Map<string, { at: number; on: boolean; failed: boolean }>()

/** True when `PRINTING_ENABLED` is false, 0, off, no or disabled. */
export function isPrintingKillSwitchOn(): boolean {
	syncEnvFromProcess()
	const live =
		typeof process !== 'undefined' && process.env
			? process.env.PRINTING_ENABLED
			: (ENV as { PRINTING_ENABLED?: unknown }).PRINTING_ENABLED
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

/** True when this organization may queue and serve cloud print jobs on this node. */
export async function printingEnabled(orgId: string): Promise<boolean> {
	if (isPrintingKillSwitchOn()) return false
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
				const body = (await response.json()) as { printers?: unknown }
				on = body.printers === true
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

export function clearPrintingFlagCache() {
	cache.clear()
}

/** Tests: set the answer without asking App. */
export function seedPrintingFlagForTest(orgId: string, on: boolean) {
	cache.set(orgId, { at: Date.now(), on, failed: false })
}

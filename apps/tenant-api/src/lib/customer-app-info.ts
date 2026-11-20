import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { fetchApp } from './app-service.ts'
import { getInternalCommandToken } from './secrets.ts'
import { ENV } from 'varlock/env'

/**
 * What this node knows about an organization's branded app, read from the App
 * (`/resources/customer-app/summary`, internal token) and cached for a minute:
 * the live stores (the receipt email's "Track this order in the app" block) and
 * whether push can be sent. Public facts and booleans only. A lookup that
 * fails answers "no app", so a message goes out without the block and push is
 * skipped; it is never a reason to hold a guest message.
 */
export type CustomerAppInfo = {
	app: null | {
		id: string
		displayName: string
		iosBundleId: string
		androidPackage: string
		stores: { app_store?: string; play_store?: string }
		inviteEmail: boolean
	}
	push: {
		enabled: boolean
		marketing: boolean
		credentials: { ios: boolean; android: boolean }
	}
}

const NONE: CustomerAppInfo = {
	app: null,
	push: {
		enabled: false,
		marketing: false,
		credentials: { ios: false, android: false },
	},
}

const TTL_MS = 60_000
const TIMEOUT_MS = 4_000
const cache = new Map<string, { at: number; value: CustomerAppInfo }>()

export function clearCustomerAppInfoCache() {
	cache.clear()
}

function appBase(): string {
	return String(
		(ENV as { APP_URL?: string; BASE_URL?: string }).APP_URL ||
			(ENV as { BASE_URL?: string }).BASE_URL ||
			'',
	).replace(/\/$/, '')
}

export async function getCustomerAppInfo(
	orgId: string,
): Promise<CustomerAppInfo> {
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return NONE
	const hit = cache.get(orgId)
	if (hit && Date.now() - hit.at < TTL_MS) return hit.value
	const base = appBase()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) return hit?.value ?? NONE
	try {
		const response = await fetchApp(
			`${base}/resources/customer-app/summary?${new URLSearchParams({ orgId })}`,
			{
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${token}`,
				},
				signal: AbortSignal.timeout(TIMEOUT_MS),
			},
		)
		if (!response.ok) return hit?.value ?? NONE
		const body = (await response.json()) as Partial<CustomerAppInfo>
		const value: CustomerAppInfo = {
			app: body.app ?? null,
			push: body.push ?? NONE.push,
		}
		cache.set(orgId, { at: Date.now(), value })
		return value
	} catch {
		return hit?.value ?? NONE
	}
}

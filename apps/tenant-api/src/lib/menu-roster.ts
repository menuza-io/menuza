import { menuRosterSchema, type MenuRoster } from '@repo/common/slow-sellers'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { LRUCache } from 'lru-cache'
import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * The organization's dishes by id (`GET /resources/report/menu-roster`,
 * internal token), for the Slow sellers report (#261): sales rows hold only
 * dishes that sold, so the menu is what lets one that sold nothing appear.
 * Menu data only (what a public menu shows). Kept for a minute; `null` when
 * the control plane cannot be asked, and the report says so instead of
 * quietly leaving unsold dishes out.
 */

export const MENU_ROSTER_TTL_MS = 60_000
export const MENU_ROSTER_TIMEOUT_MS = 4_000

const cache = new LRUCache<string, MenuRoster>({
	max: 200,
	ttl: MENU_ROSTER_TTL_MS,
})

function appUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || '').replace(/\/$/, '')
}

export function clearMenuRosterCache(): void {
	cache.clear()
}

export async function getMenuRoster(orgId: string): Promise<MenuRoster | null> {
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return null
	const hit = cache.get(orgId)
	if (hit) return hit
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), MENU_ROSTER_TIMEOUT_MS)
	try {
		const base = appUrl()
		const token = getInternalCommandToken()
		if (!base || token.length < 16) return null
		const response = await fetch(
			`${base}/resources/report/menu-roster?${new URLSearchParams({ orgId })}`,
			{
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${token}`,
				},
				redirect: 'error',
				signal: controller.signal,
			},
		)
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined)
			return null
		}
		const parsed = menuRosterSchema.safeParse(
			await response.json().catch(() => null),
		)
		if (!parsed.success || parsed.data.orgId !== orgId) return null
		cache.set(orgId, parsed.data)
		return parsed.data
	} catch {
		return null
	} finally {
		clearTimeout(timer)
	}
}

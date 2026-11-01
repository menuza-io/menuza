import { DISCOUNTS_FLAG_KEYS } from '@repo/common/discounts-flags'
import { ENV } from 'varlock/env'

/**
 * What App should purge from the public site KV cache: one organization's
 * cached site data, or every organization's cached menu (a new menu
 * generation, for a system-level flag). See App's
 * `routes/resources+/sites.cache-purge.ts`.
 */
export type SiteCachePurgeTarget =
	{ organizationId: string } | { scope: 'all-menus' }

const DISCOUNT_FLAG_KEYS = new Set<string>(Object.values(DISCOUNTS_FLAG_KEYS))

/** Where a config flag sits: its key, level and organization. */
export type FlagPlacement = {
	key: string
	level: string
	organizationId?: string | null
}

/**
 * The public site cache discount flags show through, once each: the
 * organization's own for an organization-level flag, every organization's
 * menu for a system-level one (menus carry promotions and promoted codes).
 * Other flags, and user-level flags, change nothing public.
 */
export function discountSiteCacheTargets(
	flags: readonly (FlagPlacement | undefined)[],
): SiteCachePurgeTarget[] {
	const targets = new Map<string, SiteCachePurgeTarget>()
	for (const flag of flags) {
		if (!flag || !DISCOUNT_FLAG_KEYS.has(flag.key)) continue
		const target: SiteCachePurgeTarget | null =
			flag.level === 'system'
				? { scope: 'all-menus' }
				: flag.level === 'organization' && flag.organizationId
					? { organizationId: flag.organizationId }
					: null
		if (target) targets.set(JSON.stringify(target), target)
	}
	return [...targets.values()]
}

/**
 * Asks App to purge public site KV cache. Fire-and-forget: callers must not
 * fail their own work when App is down or misconfigured.
 */
export function requestSiteCachePurge(target: SiteCachePurgeTarget) {
	void purgeViaApp(target).catch((error) => {
		console.error(
			'Failed to request site cache purge for',
			describe(target),
			error instanceof Error ? error.message : 'unknown error',
		)
	})
}

function describe(target: SiteCachePurgeTarget) {
	return 'scope' in target
		? 'every organization'
		: `organization ${target.organizationId}`
}

async function purgeViaApp(target: SiteCachePurgeTarget) {
	const base = ENV.APP_URL?.replace(/\/$/, '')
	const token = ENV.INTERNAL_COMMAND_TOKEN
	if (!base || !token) {
		console.error(
			'Skipping site cache purge: APP_URL or INTERNAL_COMMAND_TOKEN is not set.',
		)
		return
	}
	const response = await fetch(`${base}/resources/sites/cache-purge`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(target),
		signal: AbortSignal.timeout(15_000),
	})
	if (!response.ok) {
		console.error(
			'Site cache purge request failed for',
			describe(target),
			response.status,
		)
	}
}

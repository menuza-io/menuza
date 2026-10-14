import { LRUCache } from 'lru-cache'
import { ENV } from 'varlock/env'
import { z } from 'zod'
import { isValidTimeZone } from '@repo/staffing'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * Scope facts (time zone, name) live in the US control plane; tenant-api
 * cannot read it, so it pulls them from an App resource route guarded by
 * `INTERNAL_COMMAND_TOKEN`, the same pattern as the order context. Only
 * scope facts cross: no staff data ever goes this way.
 *
 * Callers must have a fallback (the policy or device snapshot): a punch is never
 * refused because the App was slow. Results are cached for a short time, and a
 * stale value is preferred to none when the App cannot be reached.
 */

const featuresSchema = z.object({
	enabled: z.boolean(),
	timeclock: z.boolean(),
	scheduling: z.boolean(),
	hiring: z.boolean(),
})

/**
 * The organization's effective staffing flags (the master switch already folded
 * into each). tenant-api honors only tokens the App minted, so requests need no
 * flag lookup; the regional tick has no token, so it asks here instead.
 */
export type StaffingFeatures = z.infer<typeof featuresSchema>

const responseSchema = z.object({
	orgId: z.string().regex(TENANT_ORG_ID_PATTERN),
	features: featuresSchema.optional(),
	dataRegion: z.string().max(16).optional(),
	scopes: z
		.array(
			z.object({
				id: z.string().min(1).max(64),
				name: z.string().max(200),
				timeZone: z.string().min(1).max(64),
				isActive: z.boolean().optional(),
			}),
		)
		.max(500),
})

export type ScopeFacts = { name: string; timeZone: string }

const FRESH_MS = 5 * 60 * 1000
const STALE_MS = 24 * 60 * 60 * 1000
/** How old a flag value may be when the App cannot be reached. */
const FEATURES_MAX_STALE_MS = 30 * 60 * 1000

type CacheEntry = {
	fetchedAt: number
	scopes: Map<string, ScopeFacts>
	/** `null` when the App did not say (an older App), which counts as off. */
	features: StaffingFeatures | null
	dataRegion: string | null
}

const cache = new LRUCache<string, CacheEntry>({ max: 500, ttl: STALE_MS })

/**
 * After a failed lookup the App is not asked again for this long. Every kiosk
 * request resolves the scope time zone, so without a cooldown an App outage
 * would add the full request timeout to every punch.
 */
const FAILURE_COOLDOWN_MS = 30 * 1000
const lastFailureAt = new LRUCache<string, number>({
	max: 500,
	ttl: FAILURE_COOLDOWN_MS,
})

export function resetScopeContextCache() {
	cache.clear()
	lastFailureAt.clear()
}

function appUrl() {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

async function fetchContext(
	orgId: string,
): Promise<Omit<CacheEntry, 'fetchedAt'> | null> {
	const base = appUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) return null
	try {
		const response = await fetch(
			`${base}/resources/staffing/scope-context?${new URLSearchParams({ orgId })}`,
			{
				headers: {
					Accept: 'application/json',
					Authorization: `Bearer ${token}`,
				},
				redirect: 'error',
				signal: AbortSignal.timeout(3_000),
			},
		)
		if (!response.ok) return null
		const parsed = responseSchema.safeParse(await response.json())
		if (!parsed.success || parsed.data.orgId !== orgId) return null
		const map = new Map<string, ScopeFacts>()
		for (const scope of parsed.data.scopes) {
			if (!isValidTimeZone(scope.timeZone)) continue
			map.set(scope.id, {
				name: scope.name,
				timeZone: scope.timeZone,
			})
		}
		return {
			scopes: map,
			features: parsed.data.features ?? null,
			dataRegion: parsed.data.dataRegion ?? null,
		}
	} catch {
		return null
	}
}

/**
 * The cached context for an organization: fresh when possible, stale when the
 * App cannot be reached, `null` when there is nothing at all. The cooldown
 * keeps an App outage from adding its timeout to every request.
 */
async function loadContext(
	orgId: string,
	now: number,
): Promise<CacheEntry | null> {
	const cached = cache.get(orgId)
	if (cached && now - cached.fetchedAt < FRESH_MS) return cached
	const failedAt = lastFailureAt.get(orgId)
	if (failedAt === undefined || now - failedAt >= FAILURE_COOLDOWN_MS) {
		const fresh = await fetchContext(orgId)
		if (fresh) {
			lastFailureAt.delete(orgId)
			const entry = { ...fresh, fetchedAt: now }
			cache.set(orgId, entry)
			return entry
		}
		lastFailureAt.set(orgId, now)
	}
	return cached ?? null
}

/**
 * Seeds the cache with scope facts the caller already has, so a local seed
 * script (which reads the control plane directly) does not need the App
 * running. Seed scripts only; request handlers never call this.
 */
export function primeScopeFacts(
	orgId: string,
	scopes: ReadonlyArray<{ id: string; name: string; timeZone: string }>,
	now = Date.now(),
) {
	const map = new Map<string, ScopeFacts>()
	for (const scope of scopes) {
		if (!isValidTimeZone(scope.timeZone)) continue
		map.set(scope.id, { name: scope.name, timeZone: scope.timeZone })
	}
	cache.set(orgId, {
		fetchedAt: now,
		scopes: map,
		features: null,
		dataRegion: null,
	})
}

/**
 * The control plane's facts for one scope, or `null` when unknown or the
 * App cannot be reached and nothing is cached.
 */
export async function getScopeFacts(
	orgId: string,
	scopeId: string,
	now = Date.now(),
): Promise<ScopeFacts | null> {
	const context = await loadContext(orgId, now)
	return context?.scopes.get(scopeId) ?? null
}

/**
 * The organization's staffing flags, or `null` when unknown. Callers fail
 * closed on `null`: a tick that cannot confirm the flags does nothing and the
 * next one tries again. A flag turned off takes effect within the cache window
 * (five minutes).
 */
export async function getStaffingFeatures(
	orgId: string,
	now = Date.now(),
): Promise<{ features: StaffingFeatures; dataRegion: string | null } | null> {
	const context = await loadContext(orgId, now)
	if (!context?.features) return null
	// A time zone that is a day old is still right; a flag that is a day old may
	// have been turned off since, so it is not trusted for long.
	if (now - context.fetchedAt > FEATURES_MAX_STALE_MS) return null
	return { features: context.features, dataRegion: context.dataRegion }
}

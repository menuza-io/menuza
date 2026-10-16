import {
	reservationsContextSchema,
	type ReservationsContext,
} from '@repo/reservations'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { LRUCache } from 'lru-cache'
import { ENV } from 'varlock/env'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

export const RESERVATIONS_CONTEXT_FRESH_TTL_MS = 5 * 60 * 1000
export const RESERVATIONS_CONTEXT_STALE_TTL_MS = 24 * 60 * 60 * 1000
export const RESERVATIONS_CONTEXT_FAILURE_COOLDOWN_MS = 30 * 1000

type CacheEntry = {
	fetchedAt: number
	context: ReservationsContext
}

const cache = new LRUCache<string, CacheEntry>({
	max: 500,
	ttl: RESERVATIONS_CONTEXT_STALE_TTL_MS,
})

const lastFailureAt = new LRUCache<string, number>({
	max: 500,
	ttl: RESERVATIONS_CONTEXT_FAILURE_COOLDOWN_MS,
})

function resolveAppUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

async function fetchReservationsContext(
	orgId: string,
): Promise<ReservationsContext | null> {
	const base = resolveAppUrl()
	const token = getInternalCommandToken()
	if (!base || token.length < 16) return null

	try {
		const response = await fetch(
			`${base}/resources/reservations/context?${new URLSearchParams({ orgId })}`,
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
		const parsed = reservationsContextSchema.safeParse(await response.json())
		if (!parsed.success || parsed.data.orgId !== orgId) return null
		return parsed.data
	} catch {
		return null
	}
}

/**
 * Resolve non-PII organization context for the Reservations module from the US
 * control plane (`GET /resources/reservations/context?orgId=<id>`).
 *
 * - Caches per `orgId` in memory with a 5-minute fresh TTL (`300_000` ms).
 * - Serves up to 24-hour stale entries (`86_400_000` ms) when the control-plane
 *   fetch fails, with a 30-second (`30_000` ms) failure cooldown before retrying.
 * - Immediately invalidated when `invalidateReservationsContext(orgId)` is called
 *   (e.g., via `POST /internal/reservations/context-changed`).
 */
export async function getReservationsContext(
	orgId: string,
	options?: {
		now?: number
		forceRefresh?: boolean
	},
): Promise<ReservationsContext | null> {
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return null
	const now = options?.now ?? Date.now()
	const cached = cache.get(orgId)

	if (
		!options?.forceRefresh &&
		cached &&
		now - cached.fetchedAt < RESERVATIONS_CONTEXT_FRESH_TTL_MS
	) {
		return cached.context
	}

	const failedAt = lastFailureAt.get(orgId)
	if (
		!options?.forceRefresh &&
		failedAt !== undefined &&
		now - failedAt < RESERVATIONS_CONTEXT_FAILURE_COOLDOWN_MS &&
		cached &&
		now - cached.fetchedAt < RESERVATIONS_CONTEXT_STALE_TTL_MS
	) {
		return cached.context
	}

	const fresh = await fetchReservationsContext(orgId)
	if (fresh) {
		lastFailureAt.delete(orgId)
		cache.set(orgId, { fetchedAt: now, context: fresh })
		return fresh
	}

	lastFailureAt.set(orgId, now)
	if (cached && now - cached.fetchedAt < RESERVATIONS_CONTEXT_STALE_TTL_MS) {
		return cached.context
	}

	cache.delete(orgId)
	return null
}

/**
 * Invalidate the cached reservations context for a single organization (or all
 * organizations when `orgId` is omitted).
 */
export function invalidateReservationsContext(orgId?: string): void {
	if (orgId) {
		cache.delete(orgId)
		lastFailureAt.delete(orgId)
		return
	}
	cache.clear()
	lastFailureAt.clear()
}

export function resetReservationsContextCache(): void {
	cache.clear()
	lastFailureAt.clear()
}

export function seedReservationsContextForTest(
	orgId: string,
	context: ReservationsContext,
	fetchedAt = Date.now(),
): void {
	cache.set(orgId, { fetchedAt, context })
	lastFailureAt.delete(orgId)
}

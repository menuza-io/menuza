import {
	LOYALTY_FEATURES_OFF,
	loyaltyContextSchema,
	readLoyaltyFeatures,
	type LoyaltyErrorCode,
	type LoyaltyFeatures,
} from '@repo/loyalty'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { LRUCache } from 'lru-cache'
import { ENV } from 'varlock/env'
import { isLoyaltyKillSwitchOn } from './loyalty-switches.ts'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * The organization's loyalty flags, from the US control plane
 * (`GET /resources/loyalty/context?orgId=`). Flags only, never member data.
 * Operator routes read the flags from their token instead.
 *
 * App's answer (`on` or `off`) is kept for 5 minutes. When App cannot be
 * asked, does not answer in time or answers badly, the last `off` is used for
 * up to a day but the last `on` for only 15 minutes, so switching loyalty off
 * in App takes effect within 15 minutes even then (the node kill switch is the
 * immediate stop). Past that, or with nothing cached, the flags are `unknown`.
 * One request per organization is in flight at a time and a failed one is not
 * repeated for 30 seconds, so an outage costs an organization one timeout
 * every 30 seconds, not one per order.
 */

export const LOYALTY_CONTEXT_FRESH_TTL_MS = 5 * 60 * 1000
export const LOYALTY_CONTEXT_STALE_ON_TTL_MS = 15 * 60 * 1000
export const LOYALTY_CONTEXT_STALE_OFF_TTL_MS = 24 * 60 * 60 * 1000
export const LOYALTY_CONTEXT_FAILURE_COOLDOWN_MS = 30 * 1000
export const LOYALTY_CONTEXT_TIMEOUT_MS = 2_000

export type LoyaltyFlagStatus =
	/** App says loyalty is on. */
	| 'on'
	/** App says loyalty is off. */
	| 'off'
	/** The flags cannot be read: App is unreachable and nothing usable is cached. */
	| 'unknown'
	/** The node's kill switch (`LOYALTY_ENABLED=false`) is on. */
	| 'stopped'

export type LoyaltyFlagState = {
	status: LoyaltyFlagStatus
	/** All off unless `status` is `on`. */
	features: LoyaltyFeatures
}

type CacheEntry = { fetchedAt: number; features: LoyaltyFeatures }

type FetchOutcome =
	{ ok: true; features: LoyaltyFeatures } | { ok: false; reason: string }

const cache = new LRUCache<string, CacheEntry>({
	max: 500,
	ttl: LOYALTY_CONTEXT_STALE_OFF_TTL_MS,
})

const lastFailureAt = new LRUCache<string, number>({
	max: 500,
	ttl: LOYALTY_CONTEXT_FAILURE_COOLDOWN_MS,
})

const inFlight = new Map<string, Promise<FetchOutcome>>()

/** Bumped on invalidation so a request already running cannot refill the cache. */
let generation = 0

function resolveAppUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || '').replace(/\/$/, '')
}

async function fetchLoyaltyFeatures(orgId: string): Promise<FetchOutcome> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), LOYALTY_CONTEXT_TIMEOUT_MS)
	try {
		const base = resolveAppUrl()
		const token = getInternalCommandToken()
		if (!base || token.length < 16)
			return { ok: false, reason: 'not_configured' }
		const response = await fetch(
			`${base}/resources/loyalty/context?${new URLSearchParams({ orgId })}`,
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
			return { ok: false, reason: `http_${response.status}` }
		}
		const parsed = loyaltyContextSchema.safeParse(
			await response.json().catch(() => null),
		)
		if (!parsed.success || parsed.data.orgId !== orgId) {
			return { ok: false, reason: 'invalid_response' }
		}
		return { ok: true, features: readLoyaltyFeatures(parsed.data.features) }
	} catch {
		return {
			ok: false,
			reason: controller.signal.aborted ? 'timeout' : 'unreachable',
		}
	} finally {
		clearTimeout(timer)
	}
}

function stateOf(features: LoyaltyFeatures): LoyaltyFlagState {
	return features.enabled
		? { status: 'on', features: { ...features } }
		: { status: 'off', features: { ...LOYALTY_FEATURES_OFF } }
}

function notOn(status: Exclude<LoyaltyFlagStatus, 'on'>): LoyaltyFlagState {
	return { status, features: { ...LOYALTY_FEATURES_OFF } }
}

/** The cached answer, when it may stand in for App while App cannot be read. */
function standIn(orgId: string, now: number): CacheEntry | null {
	const entry = cache.get(orgId)
	if (!entry) return null
	const ttl = entry.features.enabled
		? LOYALTY_CONTEXT_STALE_ON_TTL_MS
		: LOYALTY_CONTEXT_STALE_OFF_TTL_MS
	return now - entry.fetchedAt < ttl ? entry : null
}

function refresh(orgId: string, now: number): Promise<FetchOutcome> {
	const running = inFlight.get(orgId)
	if (running) return running
	const startedIn = generation
	const request = fetchLoyaltyFeatures(orgId)
		.then((outcome) => {
			if (startedIn !== generation) return outcome
			if (outcome.ok) {
				cache.set(orgId, { fetchedAt: now, features: outcome.features })
				lastFailureAt.delete(orgId)
				return outcome
			}
			lastFailureAt.set(orgId, now)
			const stale = standIn(orgId, now)
			console.error('Loyalty flags could not be read', {
				orgId,
				reason: outcome.reason,
				status: stale ? stateOf(stale.features).status : 'unknown',
				stale: stale !== null,
			})
			return outcome
		})
		.finally(() => {
			if (inFlight.get(orgId) === request) inFlight.delete(orgId)
		})
	inFlight.set(orgId, request)
	return request
}

/**
 * The organization's loyalty flags now. Never throws: anything that goes wrong
 * reading them makes them `unknown`.
 */
export async function getLoyaltyFlagState(
	orgId: string,
	options?: { now?: number },
): Promise<LoyaltyFlagState> {
	if (isLoyaltyKillSwitchOn()) return notOn('stopped')
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return notOn('off')
	const now = options?.now ?? Date.now()
	try {
		const cached = cache.get(orgId)
		if (cached && now - cached.fetchedAt < LOYALTY_CONTEXT_FRESH_TTL_MS) {
			return stateOf(cached.features)
		}
		const failedAt = lastFailureAt.get(orgId)
		const coolingDown =
			failedAt !== undefined &&
			now - failedAt < LOYALTY_CONTEXT_FAILURE_COOLDOWN_MS
		if (!coolingDown) {
			const outcome = await refresh(orgId, now)
			if (outcome.ok) return stateOf(outcome.features)
		}
		const stale = standIn(orgId, now)
		return stale ? stateOf(stale.features) : notOn('unknown')
	} catch (error) {
		console.error('Loyalty flags could not be read', {
			orgId,
			reason: error instanceof Error ? error.name : 'unknown',
			status: 'unknown',
			stale: false,
		})
		return notOn('unknown')
	}
}

/**
 * What customers, tills and order placement may do now: the organization's
 * flags, all off unless they are known to be on.
 */
export async function getLoyaltyFeatures(
	orgId: string,
	options?: { now?: number },
): Promise<LoyaltyFeatures> {
	return (await getLoyaltyFlagState(orgId, options)).features
}

/**
 * Whether a signed-in member's sale is credited to them. It still is while
 * the flags cannot be read: crediting a sale minutes after loyalty was
 * switched off is better than losing a member's points without a trace.
 * Spending is not (`features` is all off then).
 */
export function loyaltyCreditsSales(state: LoyaltyFlagState): boolean {
	return state.status === 'on' || state.status === 'unknown'
}

/** Why customers and tills cannot use loyalty now; null when they can. */
export function loyaltyRefusal(
	state: LoyaltyFlagState,
): Extract<
	LoyaltyErrorCode,
	'loyalty_unavailable' | 'loyalty_disabled'
> | null {
	if (state.status === 'on') return null
	return state.status === 'off' ? 'loyalty_disabled' : 'loyalty_unavailable'
}

/** Why a reward cannot be spent now; null when it can. */
export function rewardRefusal(
	state: LoyaltyFlagState,
): Extract<
	LoyaltyErrorCode,
	'loyalty_unavailable' | 'loyalty_disabled' | 'redemption_disabled'
> | null {
	return (
		loyaltyRefusal(state) ??
		(state.features.redemption ? null : 'redemption_disabled')
	)
}

export function invalidateLoyaltyContext(orgId?: string): void {
	generation += 1
	if (orgId) {
		cache.delete(orgId)
		lastFailureAt.delete(orgId)
		inFlight.delete(orgId)
		return
	}
	cache.clear()
	lastFailureAt.clear()
	inFlight.clear()
}

export function seedLoyaltyContextForTest(
	orgId: string,
	features: LoyaltyFeatures,
	fetchedAt = Date.now(),
): void {
	cache.set(orgId, { fetchedAt, features })
	lastFailureAt.delete(orgId)
}

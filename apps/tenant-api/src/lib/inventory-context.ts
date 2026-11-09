import {
	INVENTORY_FEATURES_OFF,
	inventoryContextSchema,
	readInventoryFeatures,
	type InventoryErrorCode,
	type InventoryFeatures,
} from '@repo/inventory'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { LRUCache } from 'lru-cache'
import { ENV } from 'varlock/env'
import { isInventoryKillSwitchOn } from './inventory-switches.ts'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * The organization's inventory flags, from the US control plane
 * (`GET /resources/inventory/context?orgId=`, internal token). Flags only.
 * Operator routes read the flags from their token instead; this is for work
 * that has no operator token (Station routes, the sale-side queue, the tick).
 *
 * Same caching as loyalty: App's answer is kept for 5 minutes. When App
 * cannot be asked, does not answer in time or answers badly, the last `off`
 * stands for up to a day but the last `on` for only 15 minutes, so switching
 * inventory off in App takes effect within 15 minutes even then (the node
 * kill switch is the immediate stop). Past that, or with nothing cached, the
 * flags are `unknown` and everything reads as off (fail closed). One request
 * per organization is in flight at a time and a failed one is not repeated
 * for 30 seconds.
 */

export const INVENTORY_CONTEXT_FRESH_TTL_MS = 5 * 60 * 1000
export const INVENTORY_CONTEXT_STALE_ON_TTL_MS = 15 * 60 * 1000
export const INVENTORY_CONTEXT_STALE_OFF_TTL_MS = 24 * 60 * 60 * 1000
export const INVENTORY_CONTEXT_FAILURE_COOLDOWN_MS = 30 * 1000
export const INVENTORY_CONTEXT_TIMEOUT_MS = 2_000

export type InventoryFlagStatus =
	/** App says inventory is on. */
	| 'on'
	/** App says inventory is off. */
	| 'off'
	/** The flags cannot be read and nothing usable is cached. */
	| 'unknown'
	/** The node's kill switch (`INVENTORY_ENABLED=false`) is on. */
	| 'stopped'

export type InventoryFlagState = {
	status: InventoryFlagStatus
	/** All off unless `status` is `on`. */
	features: InventoryFeatures
}

type CacheEntry = { fetchedAt: number; features: InventoryFeatures }

type FetchOutcome =
	{ ok: true; features: InventoryFeatures } | { ok: false; reason: string }

const cache = new LRUCache<string, CacheEntry>({
	max: 500,
	ttl: INVENTORY_CONTEXT_STALE_OFF_TTL_MS,
})

const lastFailureAt = new LRUCache<string, number>({
	max: 500,
	ttl: INVENTORY_CONTEXT_FAILURE_COOLDOWN_MS,
})

const inFlight = new Map<string, Promise<FetchOutcome>>()

/** Bumped on invalidation so a request already running cannot refill the cache. */
let generation = 0

function resolveAppUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || '').replace(/\/$/, '')
}

async function fetchInventoryFeatures(orgId: string): Promise<FetchOutcome> {
	const controller = new AbortController()
	const timer = setTimeout(
		() => controller.abort(),
		INVENTORY_CONTEXT_TIMEOUT_MS,
	)
	try {
		const base = resolveAppUrl()
		const token = getInternalCommandToken()
		if (!base || token.length < 16) {
			return { ok: false, reason: 'not_configured' }
		}
		const response = await fetch(
			`${base}/resources/inventory/context?${new URLSearchParams({ orgId })}`,
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
		const parsed = inventoryContextSchema.safeParse(
			await response.json().catch(() => null),
		)
		if (!parsed.success || parsed.data.orgId !== orgId) {
			return { ok: false, reason: 'invalid_response' }
		}
		return { ok: true, features: readInventoryFeatures(parsed.data.features) }
	} catch {
		return {
			ok: false,
			reason: controller.signal.aborted ? 'timeout' : 'unreachable',
		}
	} finally {
		clearTimeout(timer)
	}
}

function stateOf(features: InventoryFeatures): InventoryFlagState {
	return features.enabled
		? { status: 'on', features: { ...features } }
		: { status: 'off', features: { ...INVENTORY_FEATURES_OFF } }
}

function notOn(status: Exclude<InventoryFlagStatus, 'on'>): InventoryFlagState {
	return { status, features: { ...INVENTORY_FEATURES_OFF } }
}

/** The cached answer, when it may stand in for App while App cannot be read. */
function standIn(orgId: string, now: number): CacheEntry | null {
	const entry = cache.get(orgId)
	if (!entry) return null
	const ttl = entry.features.enabled
		? INVENTORY_CONTEXT_STALE_ON_TTL_MS
		: INVENTORY_CONTEXT_STALE_OFF_TTL_MS
	return now - entry.fetchedAt < ttl ? entry : null
}

function refresh(orgId: string, now: number): Promise<FetchOutcome> {
	const running = inFlight.get(orgId)
	if (running) return running
	const startedIn = generation
	const request = fetchInventoryFeatures(orgId)
		.then((outcome) => {
			if (startedIn !== generation) return outcome
			if (outcome.ok) {
				cache.set(orgId, { fetchedAt: now, features: outcome.features })
				lastFailureAt.delete(orgId)
				return outcome
			}
			lastFailureAt.set(orgId, now)
			const stale = standIn(orgId, now)
			console.error('Inventory flags could not be read', {
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
 * The organization's inventory flags now. Never throws: anything that goes
 * wrong reading them makes them `unknown` (all off).
 */
export async function getInventoryFlagState(
	orgId: string,
	options?: { now?: number },
): Promise<InventoryFlagState> {
	if (isInventoryKillSwitchOn()) return notOn('stopped')
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return notOn('off')
	const now = options?.now ?? Date.now()
	try {
		const cached = cache.get(orgId)
		if (cached && now - cached.fetchedAt < INVENTORY_CONTEXT_FRESH_TTL_MS) {
			return stateOf(cached.features)
		}
		const failedAt = lastFailureAt.get(orgId)
		const coolingDown =
			failedAt !== undefined &&
			now - failedAt < INVENTORY_CONTEXT_FAILURE_COOLDOWN_MS
		if (!coolingDown) {
			const outcome = await refresh(orgId, now)
			if (outcome.ok) return stateOf(outcome.features)
		}
		const stale = standIn(orgId, now)
		return stale ? stateOf(stale.features) : notOn('unknown')
	} catch (error) {
		console.error('Inventory flags could not be read', {
			orgId,
			reason: error instanceof Error ? error.name : 'unknown',
			status: 'unknown',
			stale: false,
		})
		return notOn('unknown')
	}
}

/** The organization's features now: all off unless known to be on. */
export async function getInventoryFeatures(
	orgId: string,
	options?: { now?: number },
): Promise<InventoryFeatures> {
	return (await getInventoryFlagState(orgId, options)).features
}

/** Why Station and system work cannot use inventory now; null when it can. */
export function inventoryRefusal(
	state: InventoryFlagState,
): Extract<
	InventoryErrorCode,
	'inventory_unavailable' | 'inventory_disabled'
> | null {
	if (state.status === 'on') return null
	return state.status === 'off' ? 'inventory_disabled' : 'inventory_unavailable'
}

export function invalidateInventoryContext(orgId?: string): void {
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

export function seedInventoryContextForTest(
	orgId: string,
	features: InventoryFeatures,
	fetchedAt = Date.now(),
): void {
	cache.set(orgId, { fetchedAt, features })
	lastFailureAt.delete(orgId)
}

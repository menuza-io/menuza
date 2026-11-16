import {
	GIFT_CARD_FEATURES_OFF,
	defaultGiftCardSettings,
	giftCardContextSchema,
	readGiftCardFeatures,
	readGiftCardSettings,
	type GiftCardContext,
	type GiftCardFeatures,
	type GiftCardSettings,
} from '@repo/common/gift-cards'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'
import { LRUCache } from 'lru-cache'
import { ENV } from 'varlock/env'
import { isGiftCardsKillSwitchOn } from './gift-card-switches.ts'
import { getInternalCommandToken, syncEnvFromProcess } from './secrets.ts'

/**
 * The organization's gift-card flags and settings, from the US control plane
 * (`GET /resources/gift-cards/context?orgId=`). Flags and settings only,
 * never a card, code, balance or person. Operator routes read the flags from
 * their token instead.
 *
 * A fresh answer is kept for a minute (so a settings change reaches a sale
 * quickly). When App cannot be asked, the last `off` stands for a day but the
 * last `on` for only 15 minutes, so switching gift cards off in App takes
 * effect within 15 minutes even then (the node kill switch is the immediate
 * stop). Past that, or with nothing cached, the state is `unknown` and nothing
 * is sold. One request per organization is in flight at a time and a failed
 * one is not repeated for 30 seconds.
 */

export const GIFT_CARD_CONTEXT_FRESH_TTL_MS = 60 * 1000
export const GIFT_CARD_CONTEXT_STALE_ON_TTL_MS = 15 * 60 * 1000
export const GIFT_CARD_CONTEXT_STALE_OFF_TTL_MS = 24 * 60 * 60 * 1000
export const GIFT_CARD_CONTEXT_FAILURE_COOLDOWN_MS = 30 * 1000
export const GIFT_CARD_CONTEXT_TIMEOUT_MS = 2_000

export type GiftCardFlagStatus = 'on' | 'off' | 'unknown' | 'stopped'

export type GiftCardFlagState = {
	status: GiftCardFlagStatus
	/** All off unless `status` is `on`. */
	features: GiftCardFeatures
	settings: GiftCardSettings
	currency: string | null
	locations: NonNullable<GiftCardContext['locations']>
}

type Entry = {
	fetchedAt: number
	features: GiftCardFeatures
	settings: GiftCardSettings
	currency: string | null
	locations: NonNullable<GiftCardContext['locations']>
}
type Outcome = { ok: true; entry: Omit<Entry, 'fetchedAt'> } | { ok: false; reason: string }

const cache = new LRUCache<string, Entry>({
	max: 500,
	ttl: GIFT_CARD_CONTEXT_STALE_OFF_TTL_MS,
})
const lastFailureAt = new LRUCache<string, number>({
	max: 500,
	ttl: GIFT_CARD_CONTEXT_FAILURE_COOLDOWN_MS,
})
const inFlight = new Map<string, Promise<Outcome>>()
let generation = 0

/** Drops what is cached (tests, and a settings change seen in-process). */
export function clearGiftCardContextCache(): void {
	generation += 1
	cache.clear()
	lastFailureAt.clear()
	inFlight.clear()
}

async function fetchContext(orgId: string): Promise<Outcome> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), GIFT_CARD_CONTEXT_TIMEOUT_MS)
	try {
		syncEnvFromProcess()
		const base = (ENV.APP_URL || '').replace(/\/$/, '')
		const token = getInternalCommandToken()
		if (!base || token.length < 16) return { ok: false, reason: 'not_configured' }
		const response = await fetch(
			`${base}/resources/gift-cards/context?${new URLSearchParams({ orgId })}`,
			{
				headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
				redirect: 'error',
				signal: controller.signal,
			},
		)
		if (!response.ok) {
			void response.body?.cancel().catch(() => undefined)
			return { ok: false, reason: `http_${response.status}` }
		}
		const parsed = giftCardContextSchema.safeParse(await response.json().catch(() => null))
		if (!parsed.success || parsed.data.orgId !== orgId) {
			return { ok: false, reason: 'invalid_response' }
		}
		return {
			ok: true,
			entry: {
				features: readGiftCardFeatures(parsed.data.features),
				settings: readGiftCardSettings(parsed.data.settings),
				currency: parsed.data.currency ?? null,
				locations: parsed.data.locations ?? [],
			},
		}
	} catch {
		return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'unreachable' }
	} finally {
		clearTimeout(timer)
	}
}

function stateOf(entry: Omit<Entry, 'fetchedAt'>): GiftCardFlagState {
	return entry.features.enabled
		? { status: 'on', ...entry, features: { ...entry.features } }
		: { ...notOn('off'), settings: entry.settings, currency: entry.currency, locations: entry.locations }
}

function notOn(status: Exclude<GiftCardFlagStatus, 'on'>): GiftCardFlagState {
	return {
		status,
		features: { ...GIFT_CARD_FEATURES_OFF },
		settings: defaultGiftCardSettings(),
		currency: null,
		locations: [],
	}
}

function standIn(orgId: string, now: number): Entry | null {
	const entry = cache.get(orgId)
	if (!entry) return null
	const ttl = entry.features.enabled
		? GIFT_CARD_CONTEXT_STALE_ON_TTL_MS
		: GIFT_CARD_CONTEXT_STALE_OFF_TTL_MS
	return now - entry.fetchedAt < ttl ? entry : null
}

function refresh(orgId: string, now: number): Promise<Outcome> {
	const running = inFlight.get(orgId)
	if (running) return running
	const startedIn = generation
	const request = fetchContext(orgId)
		.then((outcome) => {
			if (startedIn !== generation) return outcome
			if (outcome.ok) {
				cache.set(orgId, { fetchedAt: now, ...outcome.entry })
				lastFailureAt.delete(orgId)
				return outcome
			}
			lastFailureAt.set(orgId, now)
			console.error('Gift card flags could not be read', { orgId, reason: outcome.reason })
			return outcome
		})
		.finally(() => {
			if (inFlight.get(orgId) === request) inFlight.delete(orgId)
		})
	inFlight.set(orgId, request)
	return request
}

/** The organization's gift-card state now. Never throws; trouble reads `unknown`. */
export async function getGiftCardFlagState(
	orgId: string,
	options?: { now?: number },
): Promise<GiftCardFlagState> {
	if (isGiftCardsKillSwitchOn()) return notOn('stopped')
	if (!TENANT_ORG_ID_PATTERN.test(orgId)) return notOn('off')
	const now = options?.now ?? Date.now()
	try {
		const cached = cache.get(orgId)
		if (cached && now - cached.fetchedAt < GIFT_CARD_CONTEXT_FRESH_TTL_MS) {
			return stateOf(cached)
		}
		const failedAt = lastFailureAt.get(orgId)
		const coolingDown =
			failedAt !== undefined && now - failedAt < GIFT_CARD_CONTEXT_FAILURE_COOLDOWN_MS
		if (!coolingDown) {
			const outcome = await refresh(orgId, now)
			if (outcome.ok) return stateOf(outcome.entry)
		}
		const stale = standIn(orgId, now)
		return stale ? stateOf(stale) : notOn('unknown')
	} catch {
		return notOn('unknown')
	}
}

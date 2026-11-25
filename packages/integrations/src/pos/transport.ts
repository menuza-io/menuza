/**
 * Resolves the HTTP transport for a POS connection.
 *
 * A stored OAuth access token (from an OAuth connection) wins; otherwise a
 * static token + merchant id from the environment is used; otherwise the
 * sandbox host with the mock guard. See `./credentials.ts` and `./sandbox.ts`.
 */

import { type Transport } from './adapter.ts'
import { doorDashApiHeaders, mintDoorDashJwt } from './doordash-jwt.ts'
import {
	liveApiBaseUrl,
	resolveCredentials,
	resolveDoorDashJwtCredentials,
} from './credentials.ts'
import { PosError } from './errors.ts'
import {
	canProviderOwnField,
	defaultFieldOwnership,
	parseFieldOwnership,
	posOwnershipFields,
	type FieldOwner,
	type PosFieldOwnership,
	type PosOwnershipField,
} from './ownership.ts'
import {
	isPosProvider,
	providerKind,
	sandboxUrls,
	type PosProvider,
} from './types.ts'

export type PosEnvironment = 'sandbox' | 'live'

export type PosSyncHealth = {
	firstFailedAt: string | null
	lastFailedAt: string | null
	lastError: string | null
	alertedAt: string | null
	lastMenuPushAt?: string | null
}

export type PosDeliveryPauseState = {
	pausedUntil: string | null
	openEnded: boolean
	platformPausedUntil: string | null
	lastPauseError: string | null
	lastAttemptAt: string | null
}

export type PosDeliveryStoreSettings = {
	menuIds: string[]
	holidaySync: boolean
	live: boolean
	lastHolidaySyncAt?: string | null
}

export type PosMenuCheckStatus = 'match' | 'diff' | 'error'

export type PosMenuCheckState = {
	lastCheckedAt: string | null
	lastAttemptAt: string | null
	lastStatus: PosMenuCheckStatus
	diffCount: number
	posChangedCount: number
	lastError: string | null
	manualChecksDate: string | null
	manualChecksCount: number
}

export type PosConnectionConfig = {
	environment: PosEnvironment
	merchantId: string
	locationId?: string | null
	fieldOwnership?: Partial<Record<PosOwnershipField, FieldOwner>>
	syncHealth?: PosSyncHealth
	pause?: PosDeliveryPauseState
	store?: PosDeliveryStoreSettings
	menuCheck?: PosMenuCheckState
	feedsDelivery?: PosProvider[]
}

export const SYNC_FAILING_THRESHOLD_MS = 24 * 60 * 60 * 1000

export type TransportOptions = {
	/** Decrypted OAuth access token stored on the connection. */
	accessToken?: string | null
}

/** Header the sandbox uses to find the per-connection store. */
export const POS_STORE_HEADER = 'x-pos-store'
/** Header the sandbox uses to know the connection's store id. */
export const POS_MERCHANT_HEADER = 'x-pos-merchant'

function parseNullableIsoString(value: unknown): string | null {
	if (typeof value !== 'string') return null
	const trimmed = value.trim()
	return trimmed ? trimmed : null
}

export function parsePosSyncHealth(raw: unknown): PosSyncHealth | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
	const record = raw as Record<string, unknown>
	const lastMenuPushAt = parseNullableIsoString(record.lastMenuPushAt)
	return {
		firstFailedAt: parseNullableIsoString(record.firstFailedAt),
		lastFailedAt: parseNullableIsoString(record.lastFailedAt),
		lastError:
			typeof record.lastError === 'string' && record.lastError.trim()
				? record.lastError.trim()
				: null,
		alertedAt: parseNullableIsoString(record.alertedAt),
		...(lastMenuPushAt !== null || 'lastMenuPushAt' in record
			? { lastMenuPushAt }
			: {}),
	}
}

export function parsePosPauseState(
	raw: unknown,
): PosDeliveryPauseState | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
	const record = raw as Record<string, unknown>
	return {
		pausedUntil: parseNullableIsoString(record.pausedUntil),
		openEnded: record.openEnded === true,
		platformPausedUntil: parseNullableIsoString(record.platformPausedUntil),
		lastPauseError:
			typeof record.lastPauseError === 'string' && record.lastPauseError.trim()
				? record.lastPauseError.trim()
				: null,
		lastAttemptAt: parseNullableIsoString(record.lastAttemptAt),
	}
}

export function parsePosStoreSettings(
	raw: unknown,
): PosDeliveryStoreSettings | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
	const record = raw as Record<string, unknown>
	const menuIds: string[] = []
	if (Array.isArray(record.menuIds)) {
		const seen = new Set<string>()
		for (const entry of record.menuIds) {
			if (typeof entry !== 'string') continue
			const trimmed = entry.trim()
			if (!trimmed || seen.has(trimmed)) continue
			seen.add(trimmed)
			menuIds.push(trimmed)
		}
	}
	const lastHolidaySyncAt = parseNullableIsoString(record.lastHolidaySyncAt)
	return {
		menuIds,
		holidaySync: record.holidaySync === true,
		live: record.live === true,
		...(lastHolidaySyncAt !== null || 'lastHolidaySyncAt' in record
			? { lastHolidaySyncAt }
			: {}),
	}
}

function parseNonNegativeInt(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		? Math.floor(value)
		: 0
}

export function parsePosMenuCheckState(
	raw: unknown,
): PosMenuCheckState | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
	const record = raw as Record<string, unknown>
	const lastError =
		typeof record.lastError === 'string' && record.lastError.trim()
			? record.lastError.trim()
			: null
	const diffCount = parseNonNegativeInt(record.diffCount)
	const posChangedCount = parseNonNegativeInt(record.posChangedCount)
	const lastStatus: PosMenuCheckStatus =
		record.lastStatus === 'match' ||
		record.lastStatus === 'diff' ||
		record.lastStatus === 'error'
			? record.lastStatus
			: lastError
				? 'error'
				: diffCount > 0
					? 'diff'
					: 'match'
	return {
		lastCheckedAt: parseNullableIsoString(record.lastCheckedAt),
		lastAttemptAt: parseNullableIsoString(record.lastAttemptAt),
		lastStatus,
		diffCount,
		posChangedCount,
		lastError,
		manualChecksDate: parseNullableIsoString(record.manualChecksDate),
		manualChecksCount: parseNonNegativeInt(record.manualChecksCount),
	}
}

export function parseFeedsDelivery(raw: unknown): PosProvider[] | undefined {
	if (!Array.isArray(raw)) return undefined
	const seen = new Set<PosProvider>()
	for (const entry of raw) {
		if (
			typeof entry === 'string' &&
			isPosProvider(entry) &&
			providerKind[entry] === 'delivery'
		) {
			seen.add(entry)
		}
	}
	return [...seen]
}

export function parsePosConfig(config: unknown): PosConnectionConfig {
	let raw: Record<string, unknown> = {}
	if (typeof config === 'string' && config.trim()) {
		try {
			raw = JSON.parse(config) as Record<string, unknown>
		} catch {
			raw = {}
		}
	} else if (config && typeof config === 'object') {
		raw = config as Record<string, unknown>
	}
	const metadata =
		raw.metadata && typeof raw.metadata === 'object'
			? (raw.metadata as Record<string, unknown>)
			: {}
	// OAuth connections store the merchant id under `metadata` (see
	// IntegrationManager.createIntegration); direct connections store it flat.
	const merchantId =
		typeof raw.merchantId === 'string'
			? raw.merchantId
			: typeof metadata.merchantId === 'string'
				? metadata.merchantId
				: ''
	const environment =
		raw.environment === 'live' || metadata.merchantId ? 'live' : 'sandbox'
	const locationId = typeof raw.locationId === 'string' ? raw.locationId : null
	const fieldOwnership = parseFieldOwnership(raw.fieldOwnership)
	const syncHealth = parsePosSyncHealth(raw.syncHealth)
	const pause = parsePosPauseState(raw.pause)
	const store = parsePosStoreSettings(raw.store)
	const menuCheck = parsePosMenuCheckState(raw.menuCheck)
	const feedsDelivery = parseFeedsDelivery(raw.feedsDelivery)
	return {
		environment,
		merchantId,
		locationId,
		...(fieldOwnership ? { fieldOwnership } : {}),
		...(syncHealth ? { syncHealth } : {}),
		...(pause ? { pause } : {}),
		...(store ? { store } : {}),
		...(menuCheck ? { menuCheck } : {}),
		...(feedsDelivery ? { feedsDelivery } : {}),
	}
}

/**
 * Returns true when a POS/delivery connection has been failing continuously for
 * at least 24 hours (`now - firstFailedAt >= 24h`).
 */
export function isSyncFailing(
	config: unknown,
	now: Date | number = Date.now(),
): boolean {
	const parsed = parsePosConfig(config)
	const firstFailedAt = parsed.syncHealth?.firstFailedAt
	if (!firstFailedAt) return false
	const firstMs = Date.parse(firstFailedAt)
	if (Number.isNaN(firstMs)) return false
	const nowMs = now instanceof Date ? now.getTime() : now
	return nowMs - firstMs >= SYNC_FAILING_THRESHOLD_MS
}

function parseRawConfigRecord(config: unknown): Record<string, unknown> {
	if (typeof config === 'string' && config.trim()) {
		try {
			const parsed = JSON.parse(config)
			if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
				return { ...(parsed as Record<string, unknown>) }
			}
		} catch {
			return {}
		}
	} else if (config && typeof config === 'object' && !Array.isArray(config)) {
		return { ...(config as Record<string, unknown>) }
	}
	return {}
}

/**
 * Merges a `syncHealth` patch into a stored `Integration.config` JSON string
 * without overwriting `fieldOwnership`, `metadata`, `doorDash`, or other keys.
 */
export function mergePosSyncHealth(
	rawConfig: string | null | undefined,
	patch: Partial<PosSyncHealth>,
): string {
	const base = parseRawConfigRecord(rawConfig)
	const existing = parsePosSyncHealth(base.syncHealth) ?? {
		firstFailedAt: null,
		lastFailedAt: null,
		lastError: null,
		alertedAt: null,
		lastMenuPushAt: null,
	}
	const next: PosSyncHealth = {
		firstFailedAt:
			patch.firstFailedAt !== undefined
				? patch.firstFailedAt
				: existing.firstFailedAt,
		lastFailedAt:
			patch.lastFailedAt !== undefined
				? patch.lastFailedAt
				: existing.lastFailedAt,
		lastError:
			patch.lastError !== undefined ? patch.lastError : existing.lastError,
		alertedAt:
			patch.alertedAt !== undefined ? patch.alertedAt : existing.alertedAt,
		lastMenuPushAt:
			patch.lastMenuPushAt !== undefined
				? patch.lastMenuPushAt
				: (existing.lastMenuPushAt ?? null),
	}
	return JSON.stringify({
		...base,
		syncHealth: next,
	})
}

/**
 * Clears failure fields (`firstFailedAt`, `lastFailedAt`, `lastError`,
 * `alertedAt`) on `Integration.config.syncHealth` after a successful push,
 * optionally recording `lastMenuPushAt`.
 */
export function clearPosSyncHealthFailures(
	rawConfig: string | null | undefined,
	options?: { lastMenuPushAt?: string },
): string {
	return mergePosSyncHealth(rawConfig, {
		firstFailedAt: null,
		lastFailedAt: null,
		lastError: null,
		alertedAt: null,
		...(options?.lastMenuPushAt !== undefined
			? { lastMenuPushAt: options.lastMenuPushAt }
			: {}),
	})
}

/**
 * Merges a `pause` patch into a stored `Integration.config` JSON string
 * without overwriting `fieldOwnership`, `syncHealth`, `metadata`, or other keys.
 */
export function mergePosPauseState(
	rawConfig: string | null | undefined,
	patch: Partial<PosDeliveryPauseState>,
): string {
	const base = parseRawConfigRecord(rawConfig)
	const existing = parsePosPauseState(base.pause) ?? {
		pausedUntil: null,
		openEnded: false,
		platformPausedUntil: null,
		lastPauseError: null,
		lastAttemptAt: null,
	}
	const next: PosDeliveryPauseState = {
		pausedUntil:
			patch.pausedUntil !== undefined
				? patch.pausedUntil
				: existing.pausedUntil,
		openEnded:
			patch.openEnded !== undefined ? patch.openEnded : existing.openEnded,
		platformPausedUntil:
			patch.platformPausedUntil !== undefined
				? patch.platformPausedUntil
				: existing.platformPausedUntil,
		lastPauseError:
			patch.lastPauseError !== undefined
				? patch.lastPauseError
				: existing.lastPauseError,
		lastAttemptAt:
			patch.lastAttemptAt !== undefined
				? patch.lastAttemptAt
				: existing.lastAttemptAt,
	}
	return JSON.stringify({
		...base,
		pause: next,
	})
}

/**
 * Merges a `store` patch into a stored `Integration.config` JSON string
 * without overwriting `fieldOwnership`, `syncHealth`, `pause`, `metadata`, or other keys.
 */
export function mergePosStoreSettings(
	rawConfig: string | null | undefined,
	patch: Partial<PosDeliveryStoreSettings>,
): string {
	const base = parseRawConfigRecord(rawConfig)
	const existing = parsePosStoreSettings(base.store) ?? {
		menuIds: [],
		holidaySync: false,
		live: false,
		lastHolidaySyncAt: null,
	}
	const nextMenuIds =
		patch.menuIds !== undefined
			? [...new Set(patch.menuIds.map((id) => id.trim()).filter(Boolean))]
			: existing.menuIds
	const next: PosDeliveryStoreSettings = {
		menuIds: nextMenuIds,
		holidaySync:
			patch.holidaySync !== undefined
				? patch.holidaySync
				: existing.holidaySync,
		live: patch.live !== undefined ? patch.live : existing.live,
		lastHolidaySyncAt:
			patch.lastHolidaySyncAt !== undefined
				? patch.lastHolidaySyncAt
				: (existing.lastHolidaySyncAt ?? null),
	}
	return JSON.stringify({
		...base,
		store: next,
	})
}

/**
 * Merges a `menuCheck` patch into a stored `Integration.config` JSON string
 * without overwriting `fieldOwnership`, `syncHealth`, `pause`, `store`,
 * `metadata`, or other keys.
 */
export function mergePosMenuCheckState(
	rawConfig: string | null | undefined,
	patch: Partial<PosMenuCheckState>,
): string {
	const base = parseRawConfigRecord(rawConfig)
	const existing = parsePosMenuCheckState(base.menuCheck) ?? {
		lastCheckedAt: null,
		lastAttemptAt: null,
		lastStatus: 'match',
		diffCount: 0,
		posChangedCount: 0,
		lastError: null,
		manualChecksDate: null,
		manualChecksCount: 0,
	}
	const next: PosMenuCheckState = {
		lastCheckedAt:
			patch.lastCheckedAt !== undefined
				? patch.lastCheckedAt
				: existing.lastCheckedAt,
		lastAttemptAt:
			patch.lastAttemptAt !== undefined
				? patch.lastAttemptAt
				: existing.lastAttemptAt,
		lastStatus:
			patch.lastStatus !== undefined ? patch.lastStatus : existing.lastStatus,
		diffCount:
			patch.diffCount !== undefined ? patch.diffCount : existing.diffCount,
		posChangedCount:
			patch.posChangedCount !== undefined
				? patch.posChangedCount
				: existing.posChangedCount,
		lastError:
			patch.lastError !== undefined ? patch.lastError : existing.lastError,
		manualChecksDate:
			patch.manualChecksDate !== undefined
				? patch.manualChecksDate
				: existing.manualChecksDate,
		manualChecksCount:
			patch.manualChecksCount !== undefined
				? patch.manualChecksCount
				: existing.manualChecksCount,
	}
	return JSON.stringify({
		...base,
		menuCheck: next,
	})
}

/**
 * Resolves effective per-field ownership for a POS connection, defaulting from
 * `readFields[provider]` and enforcing that only readable fields can be `'pos'`.
 */
export function resolveFieldOwnership(
	provider: PosProvider,
	config: unknown,
): PosFieldOwnership {
	const resolved = defaultFieldOwnership(provider)
	const parsed = parsePosConfig(config)
	if (!parsed.fieldOwnership) return resolved
	for (const field of posOwnershipFields) {
		const configured = parsed.fieldOwnership[field]
		if (configured === 'menuza') {
			resolved[field] = 'menuza'
		} else if (configured === 'pos') {
			resolved[field] = canProviderOwnField(provider, field) ? 'pos' : 'menuza'
		}
	}
	return resolved
}

export function resolveTransport(
	provider: PosProvider,
	integrationId: string,
	config: PosConnectionConfig,
	options: TransportOptions = {},
): Transport {
	const storedToken = options.accessToken?.trim()
	const isLiveConnection = config.environment === 'live'

	if (provider === 'doordash' && isLiveConnection && !storedToken) {
		const jwtCreds = resolveDoorDashJwtCredentials()
		if (!jwtCreds) {
			throw new PosError(
				'Set DOORDASH_DEVELOPER_ID, DOORDASH_KEY_ID, and DOORDASH_SIGNING_SECRET.',
				400,
			)
		}
		if (!config.merchantId) {
			throw new PosError(
				'This DoorDash connection has no store id. Disconnect and connect again, linking your Menuza location to your DoorDash store.',
				400,
			)
		}
		return {
			baseUrl: jwtCreds.apiBaseUrl,
			token: mintDoorDashJwt(jwtCreds),
			merchantId: config.merchantId,
			headers: doorDashApiHeaders(),
			requireMock: false,
		}
	}

	// OAuth connection: use the connection's own token.
	if (storedToken) {
		if (!config.merchantId) {
			throw new PosError(
				'This connection is missing a store id. Disconnect and connect again.',
				400,
			)
		}
		return {
			baseUrl: liveApiBaseUrl(provider),
			token: storedToken,
			merchantId: config.merchantId,
			requireMock: false,
		}
	}

	if (isLiveConnection) {
		throw new PosError('Authorization expired. Reconnect and try again.', 401)
	}

	const credentials = resolveCredentials(provider)

	const merchantId = config.merchantId || credentials.merchantId
	return {
		baseUrl: sandboxUrls[provider],
		token: credentials.token,
		merchantId,
		headers: {
			[POS_STORE_HEADER]: integrationId,
			[POS_MERCHANT_HEADER]: merchantId,
		},
		requireMock: true,
	}
}

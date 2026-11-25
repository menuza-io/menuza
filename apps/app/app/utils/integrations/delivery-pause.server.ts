import {
	and,
	db,
	eq,
	inArray,
	Integration,
	OrganizationLocation,
} from '@repo/database'
import {
	deliveryPausePolicy,
	integrationManager,
	isDoorDashStoreVerified,
	isPosIntegrationProvider,
	isPosProvider,
	mergePosPauseState,
	parsePosConfig,
	PosError,
	providerKind,
	providerNames,
	providerRegistry,
	sanitizeIntegrationErrorMessage,
	type PosIntegrationProvider,
	type PosProvider,
} from '@repo/integrations'
import { isDeliveryPauseEnabled } from '#app/utils/integrations/flags.server.ts'
import { type DeliveryPauseFailure } from '#app/utils/location/ordering-pause.ts'

export const DELIVERY_PAUSE_TIMEOUT_MS = 10_000
/** Renew capped open-ended pauses (e.g. DoorDash 24h) 60m before expiry. */
export const DELIVERY_PAUSE_RENEW_LEAD_MS = 60 * 60_000

const DELIVERY_PROVIDERS = [
	'ubereats',
	'doordash',
] as const satisfies readonly PosProvider[]

type DeliveryIntegrationRow = typeof Integration.$inferSelect & {
	providerName: PosProvider
}

export type DeliveryPauseStoreOutcome = {
	attempted: number
	succeeded: number
	failed: DeliveryPauseFailure[]
}

export type ReconcileDeliveryPausesResult = {
	checked: number
	resumed: number
	renewed: number
	failed: number
}

export type RetryDeliveryPauseResult =
	| {
			ok: true
			status: 'paused' | 'resumed'
			integrationId: string
			providerName: PosProvider
	  }
	| {
			ok: false
			status: 404 | 400 | 502
			error:
				| 'feature_off'
				| 'integration_not_found'
				| 'not_delivery_integration'
				| 'platform_pause_failed'
			store?: DeliveryPauseFailure
	  }

function isEligibleDeliveryIntegration(
	row: typeof Integration.$inferSelect,
): row is DeliveryIntegrationRow {
	if (!row.isActive) return false
	if (!isPosProvider(row.providerName)) return false
	if (providerKind[row.providerName] !== 'delivery') return false
	if (
		row.providerName === 'doordash' &&
		parsePosConfig(row.config).environment === 'live' &&
		!isDoorDashStoreVerified(row.config)
	) {
		return false
	}
	return true
}

function getDeliveryProvider(
	providerName: PosProvider,
): PosIntegrationProvider {
	const provider = providerRegistry.get(providerName) as unknown
	if (!isPosIntegrationProvider(provider)) {
		throw new PosError(
			`Provider '${providerName}' is not a delivery integration.`,
			400,
		)
	}
	return provider
}

async function callProviderPauseWithTimeout(
	provider: PosIntegrationProvider,
	integration: DeliveryIntegrationRow,
	until: string | null,
	timeoutMs = DELIVERY_PAUSE_TIMEOUT_MS,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		await Promise.race([
			provider.pause(integration, until),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					reject(
						new PosError('Delivery platform pause request timed out.', 504),
					)
				}, timeoutMs)
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

function resolvePlatformPauseTarget(
	provider: PosProvider,
	until: Date | null,
	openEnded: boolean,
	now: Date,
): { targetUntil: string | null; platformPausedUntil: string | null } {
	const desiredIso = until ? until.toISOString() : null
	const policy = deliveryPausePolicy[provider]
	if (until === null || openEnded) {
		if (policy && !policy.supportsOpenEnded && policy.maxPauseMinutes != null) {
			const cappedIso = new Date(
				now.getTime() + policy.maxPauseMinutes * 60_000,
			).toISOString()
			return { targetUntil: cappedIso, platformPausedUntil: cappedIso }
		}
		return { targetUntil: null, platformPausedUntil: null }
	}
	if (policy?.maxPauseMinutes != null) {
		const maxMs = now.getTime() + policy.maxPauseMinutes * 60_000
		if (until.getTime() > maxMs) {
			const cappedIso = new Date(maxMs).toISOString()
			return { targetUntil: cappedIso, platformPausedUntil: cappedIso }
		}
	}
	return { targetUntil: desiredIso, platformPausedUntil: desiredIso }
}

async function pauseSingleDeliveryStore(
	integration: DeliveryIntegrationRow,
	options: { until: Date | null; openEnded: boolean; now: Date },
): Promise<DeliveryPauseFailure | null> {
	const { until, openEnded, now } = options
	const desiredPausedUntilIso = until ? until.toISOString() : null
	const { targetUntil, platformPausedUntil } = resolvePlatformPauseTarget(
		integration.providerName,
		until,
		openEnded,
		now,
	)

	try {
		const provider = getDeliveryProvider(integration.providerName)
		await callProviderPauseWithTimeout(provider, integration, targetUntil)
		const nextConfig = mergePosPauseState(integration.config, {
			pausedUntil: desiredPausedUntilIso,
			openEnded,
			platformPausedUntil,
			lastPauseError: null,
			lastAttemptAt: now.toISOString(),
		})
		await db
			.update(Integration)
			.set({ config: nextConfig, updatedAt: now })
			.where(eq(Integration.id, integration.id))

		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_pause',
			'success',
			{
				provider: integration.providerName,
				locationId: integration.organizationLocationId,
				action: 'pause',
				pausedUntil: desiredPausedUntilIso,
				openEnded,
				platformPausedUntil,
			},
		)
		return null
	} catch (error) {
		const sanitizedError = sanitizeIntegrationErrorMessage(error)
		const nextConfig = mergePosPauseState(integration.config, {
			pausedUntil: desiredPausedUntilIso,
			openEnded,
			platformPausedUntil: null,
			lastPauseError: sanitizedError,
			lastAttemptAt: now.toISOString(),
		})
		await db
			.update(Integration)
			.set({ config: nextConfig, updatedAt: now })
			.where(eq(Integration.id, integration.id))

		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_pause',
			'error',
			{
				provider: integration.providerName,
				locationId: integration.organizationLocationId,
				action: 'pause',
				pausedUntil: desiredPausedUntilIso,
				openEnded,
				errorCode: 'platform_pause_failed',
			},
			sanitizedError,
		)
		return {
			integrationId: integration.id,
			providerName: integration.providerName,
			displayName: providerNames[integration.providerName],
			error: sanitizedError,
		}
	}
}

async function resumeSingleDeliveryStore(
	integration: DeliveryIntegrationRow,
	options: { now: Date },
): Promise<DeliveryPauseFailure | null> {
	const { now } = options
	try {
		const provider = getDeliveryProvider(integration.providerName)
		await callProviderPauseWithTimeout(provider, integration, null)
		const nextConfig = mergePosPauseState(integration.config, {
			pausedUntil: null,
			openEnded: false,
			platformPausedUntil: null,
			lastPauseError: null,
			lastAttemptAt: now.toISOString(),
		})
		await db
			.update(Integration)
			.set({ config: nextConfig, updatedAt: now })
			.where(eq(Integration.id, integration.id))

		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_pause',
			'success',
			{
				provider: integration.providerName,
				locationId: integration.organizationLocationId,
				action: 'resume',
				pausedUntil: null,
				openEnded: false,
			},
		)
		return null
	} catch (error) {
		const sanitizedError = sanitizeIntegrationErrorMessage(error)
		const nextConfig = mergePosPauseState(integration.config, {
			pausedUntil: null,
			openEnded: false,
			platformPausedUntil: null,
			lastPauseError: sanitizedError,
			lastAttemptAt: now.toISOString(),
		})
		await db
			.update(Integration)
			.set({ config: nextConfig, updatedAt: now })
			.where(eq(Integration.id, integration.id))

		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_pause',
			'error',
			{
				provider: integration.providerName,
				locationId: integration.organizationLocationId,
				action: 'resume',
				pausedUntil: null,
				openEnded: false,
				errorCode: 'platform_pause_failed',
			},
			sanitizedError,
		)
		return {
			integrationId: integration.id,
			providerName: integration.providerName,
			displayName: providerNames[integration.providerName],
			error: sanitizedError,
		}
	}
}

async function listActiveDeliveryIntegrationsForLocation(
	organizationId: string,
	locationId: string,
): Promise<DeliveryIntegrationRow[]> {
	const rows = await db
		.select()
		.from(Integration)
		.where(
			and(
				eq(Integration.organizationId, organizationId),
				eq(Integration.organizationLocationId, locationId),
				eq(Integration.isActive, true),
				inArray(Integration.providerName, [...DELIVERY_PROVIDERS]),
			),
		)
	return rows.filter(isEligibleDeliveryIntegration)
}

/**
 * Per-location delivery integration presence and failed pause notices for
 * `loadOrderingControls` when `integrations.delivery_pause` is enabled (#95).
 */
export async function loadLocationDeliveryPauseStatus(
	organizationId: string,
): Promise<
	Map<
		string,
		{
			hasDeliveryConnections: boolean
			failures: DeliveryPauseFailure[]
		}
	>
> {
	const result = new Map<
		string,
		{ hasDeliveryConnections: boolean; failures: DeliveryPauseFailure[] }
	>()
	if (!(await isDeliveryPauseEnabled(organizationId))) {
		return result
	}

	const rows = await db
		.select()
		.from(Integration)
		.where(
			and(
				eq(Integration.organizationId, organizationId),
				eq(Integration.isActive, true),
				inArray(Integration.providerName, [...DELIVERY_PROVIDERS]),
			),
		)
	for (const row of rows) {
		if (!isEligibleDeliveryIntegration(row) || !row.organizationLocationId) {
			continue
		}
		const entry = result.get(row.organizationLocationId) ?? {
			hasDeliveryConnections: false,
			failures: [],
		}
		entry.hasDeliveryConnections = true
		const pause = parsePosConfig(row.config).pause
		if (pause?.lastPauseError) {
			entry.failures.push({
				integrationId: row.id,
				providerName: row.providerName,
				displayName: providerNames[row.providerName],
				error: pause.lastPauseError,
			})
		}
		result.set(row.organizationLocationId, entry)
	}
	return result
}

/**
 * Pauses all active delivery integrations for `locationId` (#95).
 * POS connections (Square/Clover/Toast) are never touched.
 * Failures are recorded per integration without undoing the location pause.
 */
export async function pauseDeliveryStores(
	organizationId: string,
	locationId: string,
	options: { until: Date | null; openEnded?: boolean; now?: Date },
): Promise<DeliveryPauseStoreOutcome> {
	if (!(await isDeliveryPauseEnabled(organizationId))) {
		return { attempted: 0, succeeded: 0, failed: [] }
	}
	const now = options.now ?? new Date()
	const openEnded = options.openEnded ?? options.until === null
	const targets = await listActiveDeliveryIntegrationsForLocation(
		organizationId,
		locationId,
	)
	if (targets.length === 0) {
		return { attempted: 0, succeeded: 0, failed: [] }
	}

	const outcomes = await Promise.all(
		targets.map((integration) =>
			pauseSingleDeliveryStore(integration, {
				until: options.until,
				openEnded,
				now,
			}),
		),
	)
	const failed = outcomes.filter(
		(failure): failure is DeliveryPauseFailure => failure !== null,
	)

	if (options.until && options.until.getTime() > now.getTime()) {
		const { wakeMenuSyncAt } =
			await import('#app/utils/menu/menu-sync.server.ts')
		void wakeMenuSyncAt(options.until)
	}

	return {
		attempted: targets.length,
		succeeded: targets.length - failed.length,
		failed,
	}
}

/**
 * Resumes all active delivery integrations for `locationId` (#95).
 * POS connections (Square/Clover/Toast) are never touched.
 */
export async function resumeDeliveryStores(
	organizationId: string,
	locationId: string,
	options?: { now?: Date },
): Promise<DeliveryPauseStoreOutcome> {
	if (!(await isDeliveryPauseEnabled(organizationId))) {
		return { attempted: 0, succeeded: 0, failed: [] }
	}
	const now = options?.now ?? new Date()
	const targets = await listActiveDeliveryIntegrationsForLocation(
		organizationId,
		locationId,
	)
	if (targets.length === 0) {
		return { attempted: 0, succeeded: 0, failed: [] }
	}

	const outcomes = await Promise.all(
		targets.map((integration) =>
			resumeSingleDeliveryStore(integration, { now }),
		),
	)
	const failed = outcomes.filter(
		(failure): failure is DeliveryPauseFailure => failure !== null,
	)

	return {
		attempted: targets.length,
		succeeded: targets.length - failed.length,
		failed,
	}
}

/**
 * Reconciles delivery store pauses during the menu sync sweep / workflow wake (#95):
 * 1) Resumes delivery stores whose timed pause has expired (`<= now`).
 * 2) Renews capped open-ended pauses (e.g. DoorDash 24h) before `platformPausedUntil` expires.
 */
export async function reconcileDeliveryPauses(options?: {
	now?: Date
	organizationId?: string
	integrationId?: string
}): Promise<ReconcileDeliveryPausesResult> {
	const now = options?.now ?? new Date()
	const nowMs = now.getTime()
	const conditions = [
		eq(Integration.isActive, true),
		inArray(Integration.providerName, [...DELIVERY_PROVIDERS]),
	]
	if (options?.organizationId) {
		conditions.push(eq(Integration.organizationId, options.organizationId))
	}
	if (options?.integrationId) {
		conditions.push(eq(Integration.id, options.integrationId))
	}

	const rows = await db
		.select()
		.from(Integration)
		.where(and(...conditions))
	const candidates = rows.filter(isEligibleDeliveryIntegration)
	if (candidates.length === 0) {
		return { checked: 0, resumed: 0, renewed: 0, failed: 0 }
	}

	const enabledByOrg = new Map<string, boolean>()
	const locationIds = [
		...new Set(
			candidates
				.map((c) => c.organizationLocationId)
				.filter((id): id is string => Boolean(id)),
		),
	]
	const locationRows = locationIds.length
		? await db
				.select({
					id: OrganizationLocation.id,
					orderingPausedAt: OrganizationLocation.orderingPausedAt,
					orderingPausedUntil: OrganizationLocation.orderingPausedUntil,
				})
				.from(OrganizationLocation)
				.where(inArray(OrganizationLocation.id, locationIds))
		: []
	const locationById = new Map(locationRows.map((loc) => [loc.id, loc]))

	let checked = 0
	let resumed = 0
	let renewed = 0
	let failed = 0

	for (const integration of candidates) {
		let enabled = enabledByOrg.get(integration.organizationId)
		if (enabled === undefined) {
			enabled = await isDeliveryPauseEnabled(integration.organizationId)
			enabledByOrg.set(integration.organizationId, enabled)
		}
		if (!enabled) continue

		const pause = parsePosConfig(integration.config).pause
		const location = integration.organizationLocationId
			? locationById.get(integration.organizationLocationId)
			: undefined
		const locPaused =
			location != null &&
			location.orderingPausedAt != null &&
			(location.orderingPausedUntil == null ||
				location.orderingPausedUntil.getTime() > nowMs)

		const hasActivePauseState =
			pause != null &&
			(pause.pausedUntil !== null ||
				pause.openEnded ||
				pause.platformPausedUntil !== null)

		if (!hasActivePauseState) continue
		checked++

		const pausedUntilMs = pause.pausedUntil
			? Date.parse(pause.pausedUntil)
			: Number.NaN
		const storeTimedExpired =
			!pause.openEnded && !Number.isNaN(pausedUntilMs) && pausedUntilMs <= nowMs
		const locationTimedExpired =
			location != null &&
			location.orderingPausedAt != null &&
			location.orderingPausedUntil != null &&
			location.orderingPausedUntil.getTime() <= nowMs

		if ((storeTimedExpired && !locPaused) || locationTimedExpired) {
			const failure = await resumeSingleDeliveryStore(integration, { now })
			if (failure) {
				failed++
			} else {
				resumed++
			}
			continue
		}

		// Renew capped pauses (e.g. DoorDash maxPauseMinutes) before platformPausedUntil expires.
		const policy = deliveryPausePolicy[integration.providerName]
		if (
			policy &&
			!policy.supportsOpenEnded &&
			policy.maxPauseMinutes != null &&
			(pause.openEnded || locPaused)
		) {
			const platformEndMs = pause.platformPausedUntil
				? Date.parse(pause.platformPausedUntil)
				: Number.NaN
			const desiredEndMs = location?.orderingPausedUntil
				? location.orderingPausedUntil.getTime()
				: !Number.isNaN(pausedUntilMs)
					? pausedUntilMs
					: null
			const needsMoreTime =
				desiredEndMs === null ||
				(!Number.isNaN(platformEndMs) && desiredEndMs > platformEndMs)

			if (
				!Number.isNaN(platformEndMs) &&
				needsMoreTime &&
				platformEndMs - nowMs <= DELIVERY_PAUSE_RENEW_LEAD_MS
			) {
				const until = desiredEndMs !== null ? new Date(desiredEndMs) : null
				const failure = await pauseSingleDeliveryStore(integration, {
					until,
					openEnded: pause.openEnded && until === null,
					now,
				})
				if (failure) {
					failed++
				} else {
					renewed++
				}
			}
		}
	}

	return { checked, resumed, renewed, failed }
}

/**
 * Retries pausing or resuming a single delivery store to match its location's
 * current `orderingPausedAt` / `orderingPausedUntil` state (#95).
 */
export async function retryDeliveryPause(
	organizationId: string,
	integrationId: string,
	options?: { now?: Date },
): Promise<RetryDeliveryPauseResult> {
	if (!(await isDeliveryPauseEnabled(organizationId))) {
		return { ok: false, status: 404, error: 'feature_off' }
	}
	const now = options?.now ?? new Date()
	const [row] = await db
		.select()
		.from(Integration)
		.where(
			and(
				eq(Integration.id, integrationId),
				eq(Integration.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!row || !row.isActive) {
		return { ok: false, status: 404, error: 'integration_not_found' }
	}
	if (
		!isPosProvider(row.providerName) ||
		providerKind[row.providerName] !== 'delivery'
	) {
		return { ok: false, status: 400, error: 'not_delivery_integration' }
	}
	const integration = row as DeliveryIntegrationRow

	const location = integration.organizationLocationId
		? await db
				.select({
					orderingPausedAt: OrganizationLocation.orderingPausedAt,
					orderingPausedUntil: OrganizationLocation.orderingPausedUntil,
				})
				.from(OrganizationLocation)
				.where(
					and(
						eq(OrganizationLocation.id, integration.organizationLocationId),
						eq(OrganizationLocation.organizationId, organizationId),
					),
				)
				.limit(1)
				.then((rows) => rows[0])
		: undefined

	const isLocationPaused =
		location != null &&
		location.orderingPausedAt != null &&
		(location.orderingPausedUntil == null ||
			location.orderingPausedUntil.getTime() > now.getTime())

	if (isLocationPaused) {
		const until = location.orderingPausedUntil
		const failure = await pauseSingleDeliveryStore(integration, {
			until,
			openEnded: until === null,
			now,
		})
		if (failure) {
			return {
				ok: false,
				status: 502,
				error: 'platform_pause_failed',
				store: failure,
			}
		}
		return {
			ok: true,
			status: 'paused',
			integrationId: integration.id,
			providerName: integration.providerName,
		}
	}

	const failure = await resumeSingleDeliveryStore(integration, { now })
	if (failure) {
		return {
			ok: false,
			status: 502,
			error: 'platform_pause_failed',
			store: failure,
		}
	}
	return {
		ok: true,
		status: 'resumed',
		integrationId: integration.id,
		providerName: integration.providerName,
	}
}

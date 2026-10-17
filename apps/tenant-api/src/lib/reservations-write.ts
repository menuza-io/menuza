import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import {
	rsvAreas,
	rsvBlocks,
	rsvDayVersions,
	rsvHolds,
	rsvIdempotencyKeys,
	rsvLocationSettings,
	rsvNotifyRequests,
	rsvPacingRules,
	rsvReservationEvents,
	rsvReservations,
	rsvServiceAvailability,
	rsvServices,
	rsvSpecialDays,
	rsvTableComboMembers,
	rsvTableCombos,
	rsvTableOccupancies,
	rsvTables,
	rsvTurnTimes,
	rsvWaitlistEntries,
	getTenantDb,
	getTenantDbOrgId,
	runTenantTransaction,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, gt, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm'
import { forEachInChunks, queryInChunks } from './chunked-in.ts'
import { runExclusive } from './concurrency.ts'
import {
	enqueueReservationMessage,
	reconcileScheduledMessages,
} from '../services/rsv-message-queue.ts'
import { conflict, HttpError } from './http.ts'
import { retryOnSqliteBusy } from './sqlite-retry.ts'

export const IDEMPOTENCY_TTL_MS = 48 * 60 * 60 * 1000

const OCCUPANCY_WINDOW_BEFORE_MS = 2 * 24 * 60 * 60 * 1000
const OCCUPANCY_WINDOW_AFTER_MS = 3 * 24 * 60 * 60 * 1000

/**
 * Bounds an occupancy read to rows that can matter for one business date.
 * The date is read as UTC midnight and padded by days on both sides, which
 * covers any location time zone and overnight services; a row only counts
 * when it overlaps the padded window (`end_at > from AND start_at < to`).
 * `lastBusinessDate` widens the window for a multi-day read (availability).
 * An unparseable date adds no filter.
 */
export function occupancyWindowFilter(
	businessDate: string,
	lastBusinessDate: string = businessDate,
) {
	const base = Date.parse(`${businessDate}T00:00:00Z`)
	const last = Date.parse(`${lastBusinessDate}T00:00:00Z`)
	if (!Number.isFinite(base) || !Number.isFinite(last)) return []
	return [
		gt(rsvTableOccupancies.endAt, base - OCCUPANCY_WINDOW_BEFORE_MS),
		lt(
			rsvTableOccupancies.startAt,
			Math.max(base, last) + OCCUPANCY_WINDOW_AFTER_MS,
		),
	]
}

export type ReservationWriteTx = Parameters<
	Parameters<TenantDatabase['transaction']>[0]
>[0]

type ActiveReservationWriteContext = {
	orgId: string
	tx: ReservationWriteTx
	helpers: ReservationWriteHelpers
}

const activeWriteStorage =
	new AsyncLocalStorage<ActiveReservationWriteContext>()

export async function getReservationDb(orgId: string): Promise<TenantDatabase> {
	const active = activeWriteStorage.getStore()
	if (active && active.orgId === orgId) {
		return active.tx as unknown as TenantDatabase
	}
	return getTenantDb(orgId)
}

export async function withSetupWrite<T>(
	db: TenantDatabase | ReservationWriteTx,
	fn: (tx: TenantDatabase) => Promise<T>,
	explicitOrgId?: string,
): Promise<T> {
	const active = activeWriteStorage.getStore()
	if (active) {
		return fn(active.tx as unknown as TenantDatabase)
	}
	// The lock must be the org's own key so setup writes serialize with that
	// org's reservation writes and never with another org's.
	const orgId = explicitOrgId ?? getTenantDbOrgId(db)
	if (!orgId) {
		throw new Error('withSetupWrite needs a database handle from getTenantDb')
	}
	return withReservationWrite({ orgId, db: db as TenantDatabase }, async (tx) =>
		fn(tx as unknown as TenantDatabase),
	)
}

export type SweepSummary = {
	expiredHolds: number
	expiredPendingPayments: number
	expiredPendingRequests: number
	expiredWaitlistOffers: number
	/** Ids of requests that lapsed unanswered, so the guest can be told. */
	expiredRequestIds: string[]
	affectedLocationDates: Array<{ locationId: string; businessDate: string }>
}

export type LoadedReservationDayState = {
	locationId: string
	businessDate: string
	dayVersion: number
	settings: typeof rsvLocationSettings.$inferSelect | null
	areas: Array<typeof rsvAreas.$inferSelect>
	tables: Array<typeof rsvTables.$inferSelect>
	combos: Array<typeof rsvTableCombos.$inferSelect>
	comboMembers: Array<typeof rsvTableComboMembers.$inferSelect>
	services: Array<typeof rsvServices.$inferSelect>
	serviceAvailability: Array<typeof rsvServiceAvailability.$inferSelect>
	turnTimes: Array<typeof rsvTurnTimes.$inferSelect>
	pacingRules: Array<typeof rsvPacingRules.$inferSelect>
	specialDays: Array<typeof rsvSpecialDays.$inferSelect>
	blocks: Array<typeof rsvBlocks.$inferSelect>
	reservations: Array<typeof rsvReservations.$inferSelect>
	holds: Array<typeof rsvHolds.$inferSelect>
	occupancies: Array<typeof rsvTableOccupancies.$inferSelect>
	waitlistEntries: Array<typeof rsvWaitlistEntries.$inferSelect>
}

export type IdempotencyOptions = {
	scope: string
	key: string
	requestHash: string
	statusCode?: number
	ttlMs?: number
}

export type WithReservationWriteOptions = {
	orgId: string
	db?: TenantDatabase
	locationId?: string
	dates?: string | readonly string[]
	now?: number
	scope?: string
	idempotencyKey?: string
	requestHash?: string
	idempotency?: IdempotencyOptions
	onAfterCommit?: () => void | Promise<void>
}

export type ReservationWriteHelpers = {
	orgId: string
	locationId?: string
	now: number
	swept: SweepSummary
	dayState: LoadedReservationDayState | null
	dayStates: Map<string, LoadedReservationDayState>
	loadDayState: (
		locationId: string,
		businessDate: string,
	) => Promise<LoadedReservationDayState>
	bumpDayVersions: (
		locationId: string,
		dates: string | readonly string[],
	) => Promise<Map<string, number>>
	markAffectedDate: (locationId: string, businessDate: string) => void
	afterCommit: (hook: () => void | Promise<void>) => void
}

const dayStateCache = new Map<
	string,
	{ version: number; state: LoadedReservationDayState }
>()

function dayCacheKey(
	orgId: string,
	locationId: string,
	businessDate: string,
): string {
	return `${orgId}:${locationId}:${businessDate}`
}

export function invalidateReservationDayCache(
	orgId: string,
	locationId?: string,
	businessDate?: string,
): void {
	if (locationId && businessDate) {
		dayStateCache.delete(dayCacheKey(orgId, locationId, businessDate))
		return
	}
	const prefix = locationId ? `${orgId}:${locationId}:` : `${orgId}:`
	for (const key of dayStateCache.keys()) {
		if (key.startsWith(prefix)) {
			dayStateCache.delete(key)
		}
	}
}

export function clearReservationDayCacheForTest(): void {
	dayStateCache.clear()
}

export function hashIdempotencyPayload(payload: unknown): string {
	const normalized =
		typeof payload === 'string' ? payload : JSON.stringify(payload ?? null)
	return createHash('sha256').update(normalized).digest('hex')
}

function normalizeDates(
	dates: string | readonly string[] | undefined,
): string[] {
	if (!dates) return []
	if (typeof dates === 'string') return [dates]
	return Array.from(new Set(dates))
}

/**
 * Sweep expired holds, pending-payment reservations, pending-approval requests,
 * and notified waitlist offers inside the write transaction before capacity is
 * evaluated or mutated.
 */
export async function sweepExpiredInTx(
	tx: ReservationWriteTx | TenantDatabase,
	options: {
		locationId?: string
		now: number
	},
): Promise<SweepSummary> {
	const { locationId, now } = options
	const affected = new Map<
		string,
		{ locationId: string; businessDate: string }
	>()
	const recordAffected = (locId: string, businessDate: string) => {
		affected.set(`${locId}:${businessDate}`, {
			locationId: locId,
			businessDate,
		})
	}

	// 1. Expired holds
	const holdWhere = locationId
		? and(
				eq(rsvHolds.locationId, locationId),
				eq(rsvHolds.status, 'active'),
				lte(rsvHolds.expiresAt, now),
			)
		: and(eq(rsvHolds.status, 'active'), lte(rsvHolds.expiresAt, now))

	const expiredHoldRows = await tx
		.select({
			id: rsvHolds.id,
			locationId: rsvHolds.locationId,
			businessDate: rsvHolds.businessDate,
		})
		.from(rsvHolds)
		.where(holdWhere)

	if (expiredHoldRows.length > 0) {
		const holdIds = expiredHoldRows.map((row) => row.id)
		await forEachInChunks(holdIds, async (chunk) => {
			await tx
				.update(rsvTableOccupancies)
				.set({ active: false })
				.where(
					and(
						inArray(rsvTableOccupancies.holdId, chunk),
						eq(rsvTableOccupancies.active, true),
					),
				)
			await tx
				.update(rsvHolds)
				.set({ status: 'expired' })
				.where(inArray(rsvHolds.id, chunk))
		})
		for (const row of expiredHoldRows) {
			recordAffected(row.locationId, row.businessDate)
		}
	}

	// 2. Expired pending-payment reservations
	const paymentWhere = locationId
		? and(
				eq(rsvReservations.locationId, locationId),
				eq(rsvReservations.status, 'pending_payment'),
				isNotNull(rsvReservations.paymentExpiresAt),
				lte(rsvReservations.paymentExpiresAt, now),
			)
		: and(
				eq(rsvReservations.status, 'pending_payment'),
				isNotNull(rsvReservations.paymentExpiresAt),
				lte(rsvReservations.paymentExpiresAt, now),
			)

	const expiredPaymentRows = await tx
		.select({
			id: rsvReservations.id,
			locationId: rsvReservations.locationId,
			businessDate: rsvReservations.businessDate,
		})
		.from(rsvReservations)
		.where(paymentWhere)

	if (expiredPaymentRows.length > 0) {
		const resIds = expiredPaymentRows.map((row) => row.id)
		await forEachInChunks(resIds, async (chunk) => {
			await tx
				.update(rsvTableOccupancies)
				.set({ active: false })
				.where(
					and(
						inArray(rsvTableOccupancies.reservationId, chunk),
						eq(rsvTableOccupancies.active, true),
					),
				)
			await tx
				.update(rsvReservations)
				.set({
					status: 'expired',
					updatedAt: now,
					version: sql`${rsvReservations.version} + 1`,
				})
				.where(inArray(rsvReservations.id, chunk))
		})
		for (const row of expiredPaymentRows) {
			await tx.insert(rsvReservationEvents).values({
				reservationId: row.id,
				at: now,
				actorKind: 'system',
				type: 'expired',
				fromStatus: 'pending_payment',
				toStatus: 'expired',
				data: { reason: 'payment_expired' },
			})
			recordAffected(row.locationId, row.businessDate)
		}
	}

	// 3. Expired pending-approval (request) reservations
	const requestWhere = locationId
		? and(
				eq(rsvReservations.locationId, locationId),
				eq(rsvReservations.status, 'pending_approval'),
				isNotNull(rsvReservations.requestDeadlineAt),
				lte(rsvReservations.requestDeadlineAt, now),
			)
		: and(
				eq(rsvReservations.status, 'pending_approval'),
				isNotNull(rsvReservations.requestDeadlineAt),
				lte(rsvReservations.requestDeadlineAt, now),
			)

	const expiredRequestRows = await tx
		.select({
			id: rsvReservations.id,
			locationId: rsvReservations.locationId,
			businessDate: rsvReservations.businessDate,
		})
		.from(rsvReservations)
		.where(requestWhere)

	if (expiredRequestRows.length > 0) {
		const resIds = expiredRequestRows.map((row) => row.id)
		await forEachInChunks(resIds, async (chunk) => {
			await tx
				.update(rsvTableOccupancies)
				.set({ active: false })
				.where(
					and(
						inArray(rsvTableOccupancies.reservationId, chunk),
						eq(rsvTableOccupancies.active, true),
					),
				)
			await tx
				.update(rsvReservations)
				.set({
					status: 'expired',
					updatedAt: now,
					version: sql`${rsvReservations.version} + 1`,
				})
				.where(inArray(rsvReservations.id, chunk))
		})
		for (const row of expiredRequestRows) {
			await tx.insert(rsvReservationEvents).values({
				reservationId: row.id,
				at: now,
				actorKind: 'system',
				type: 'expired',
				fromStatus: 'pending_approval',
				toStatus: 'expired',
				data: { reason: 'request_deadline_expired' },
			})
			recordAffected(row.locationId, row.businessDate)
		}
	}

	// 4. Expired waitlist offers (`notified` past `responseDeadlineAt`)
	const waitlistWhere = locationId
		? and(
				eq(rsvWaitlistEntries.locationId, locationId),
				eq(rsvWaitlistEntries.status, 'notified'),
				isNotNull(rsvWaitlistEntries.responseDeadlineAt),
				lte(rsvWaitlistEntries.responseDeadlineAt, now),
			)
		: and(
				eq(rsvWaitlistEntries.status, 'notified'),
				isNotNull(rsvWaitlistEntries.responseDeadlineAt),
				lte(rsvWaitlistEntries.responseDeadlineAt, now),
			)

	const expiredWaitlistRows = await tx
		.select({
			id: rsvWaitlistEntries.id,
			locationId: rsvWaitlistEntries.locationId,
			businessDate: rsvWaitlistEntries.businessDate,
		})
		.from(rsvWaitlistEntries)
		.where(waitlistWhere)

	if (expiredWaitlistRows.length > 0) {
		const entryIds = expiredWaitlistRows.map((row) => row.id)
		await forEachInChunks(entryIds, (chunk) =>
			tx
				.update(rsvWaitlistEntries)
				.set({
					status: 'no_response',
					version: sql`${rsvWaitlistEntries.version} + 1`,
				})
				.where(inArray(rsvWaitlistEntries.id, chunk)),
		)
		for (const row of expiredWaitlistRows) {
			recordAffected(row.locationId, row.businessDate)
		}
	}

	// 5. Purge expired idempotency keys
	await tx
		.delete(rsvIdempotencyKeys)
		.where(lte(rsvIdempotencyKeys.expiresAt, now))

	return {
		expiredHolds: expiredHoldRows.length,
		expiredPendingPayments: expiredPaymentRows.length,
		expiredPendingRequests: expiredRequestRows.length,
		expiredWaitlistOffers: expiredWaitlistRows.length,
		expiredRequestIds: expiredRequestRows.map((row) => row.id),
		affectedLocationDates: Array.from(affected.values()),
	}
}

export async function loadDayStateInTx(
	tx: ReservationWriteTx | TenantDatabase,
	locationId: string,
	businessDate: string,
	now = Date.now(),
): Promise<LoadedReservationDayState> {
	const [
		settingsRow,
		versionRow,
		areas,
		tables,
		combos,
		services,
		turnTimes,
		specialDays,
		blocks,
		reservations,
		holds,
		occupancies,
		waitlistEntries,
	] = await Promise.all([
		tx
			.select()
			.from(rsvLocationSettings)
			.where(eq(rsvLocationSettings.locationId, locationId))
			.get(),
		tx
			.select()
			.from(rsvDayVersions)
			.where(
				and(
					eq(rsvDayVersions.locationId, locationId),
					eq(rsvDayVersions.businessDate, businessDate),
				),
			)
			.get(),
		tx.select().from(rsvAreas).where(eq(rsvAreas.locationId, locationId)),
		tx.select().from(rsvTables).where(eq(rsvTables.locationId, locationId)),
		tx
			.select()
			.from(rsvTableCombos)
			.where(eq(rsvTableCombos.locationId, locationId)),
		tx.select().from(rsvServices).where(eq(rsvServices.locationId, locationId)),
		tx
			.select()
			.from(rsvTurnTimes)
			.where(eq(rsvTurnTimes.locationId, locationId)),
		tx
			.select()
			.from(rsvSpecialDays)
			.where(
				and(
					eq(rsvSpecialDays.locationId, locationId),
					lte(rsvSpecialDays.fromDate, businessDate),
					gte(rsvSpecialDays.toDate, businessDate),
				),
			),
		tx
			.select()
			.from(rsvBlocks)
			.where(
				and(
					eq(rsvBlocks.locationId, locationId),
					eq(rsvBlocks.businessDate, businessDate),
				),
			),
		tx
			.select()
			.from(rsvReservations)
			.where(
				and(
					eq(rsvReservations.locationId, locationId),
					eq(rsvReservations.businessDate, businessDate),
				),
			),
		tx
			.select()
			.from(rsvHolds)
			.where(
				and(
					eq(rsvHolds.locationId, locationId),
					eq(rsvHolds.businessDate, businessDate),
					eq(rsvHolds.status, 'active'),
					gt(rsvHolds.expiresAt, now),
				),
			),
		tx
			.select()
			.from(rsvTableOccupancies)
			.where(
				and(
					eq(rsvTableOccupancies.locationId, locationId),
					eq(rsvTableOccupancies.active, true),
					...occupancyWindowFilter(businessDate),
				),
			),
		tx
			.select()
			.from(rsvWaitlistEntries)
			.where(
				and(
					eq(rsvWaitlistEntries.locationId, locationId),
					eq(rsvWaitlistEntries.businessDate, businessDate),
				),
			),
	])

	const comboIds = combos.map((c) => c.id)
	const comboMembers = await queryInChunks(comboIds, (chunk) =>
		tx
			.select()
			.from(rsvTableComboMembers)
			.where(inArray(rsvTableComboMembers.comboId, chunk)),
	)

	const serviceIds = services.map((s) => s.id)
	const [serviceAvailability, pacingRules] = await Promise.all([
		queryInChunks(serviceIds, (chunk) =>
			tx
				.select()
				.from(rsvServiceAvailability)
				.where(inArray(rsvServiceAvailability.serviceId, chunk)),
		),
		queryInChunks(serviceIds, (chunk) =>
			tx
				.select()
				.from(rsvPacingRules)
				.where(inArray(rsvPacingRules.serviceId, chunk)),
		),
	])

	return {
		locationId,
		businessDate,
		dayVersion: versionRow?.version ?? 0,
		settings: settingsRow ?? null,
		areas,
		tables,
		combos,
		comboMembers,
		services,
		serviceAvailability,
		turnTimes,
		pacingRules,
		specialDays,
		blocks,
		reservations,
		holds,
		occupancies,
		waitlistEntries,
	}
}

export async function bumpDayVersionsInTx(
	tx: ReservationWriteTx | TenantDatabase,
	locationId: string,
	dates: string | readonly string[],
	now = Date.now(),
): Promise<Map<string, number>> {
	const normalized = normalizeDates(dates)
	const result = new Map<string, number>()

	for (const businessDate of normalized) {
		await tx
			.insert(rsvDayVersions)
			.values({
				locationId,
				businessDate,
				version: 1,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [rsvDayVersions.locationId, rsvDayVersions.businessDate],
				set: {
					version: sql`${rsvDayVersions.version} + 1`,
					updatedAt: now,
				},
			})

		// Any write on a day someone is waiting on may have freed a slot. The
		// matcher recomputes real availability, so a false alarm costs one pass.
		const watching = await tx
			.select({ id: rsvNotifyRequests.id })
			.from(rsvNotifyRequests)
			.where(
				and(
					eq(rsvNotifyRequests.locationId, locationId),
					eq(rsvNotifyRequests.businessDate, businessDate),
					inArray(rsvNotifyRequests.status, ['active', 'notified']),
				),
			)
			.limit(1)
			.get()
		if (watching) {
			await tx
				.update(rsvDayVersions)
				.set({ availabilityIncreasedAt: now })
				.where(
					and(
						eq(rsvDayVersions.locationId, locationId),
						eq(rsvDayVersions.businessDate, businessDate),
					),
				)
		}

		const row = await tx
			.select({ version: rsvDayVersions.version })
			.from(rsvDayVersions)
			.where(
				and(
					eq(rsvDayVersions.locationId, locationId),
					eq(rsvDayVersions.businessDate, businessDate),
				),
			)
			.get()
		result.set(businessDate, row?.version ?? 1)
	}

	return result
}

function sqliteErrorText(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error)
	const causeText =
		error instanceof Error
			? String((error as { cause?: unknown }).cause ?? '')
			: ''
	return `${message} ${causeText}`
}

/** True when the occupancy overlap trigger aborted a statement. */
export function isOccupancyOverlapError(error: unknown): boolean {
	return (
		!(error instanceof HttpError) &&
		sqliteErrorText(error).includes('rsv_table_occupancies overlap')
	)
}

function mapSqliteConstraintError(error: unknown): never {
	if (error instanceof HttpError) throw error
	// Never forward the driver message: drizzle wraps the failing statement and
	// its bound parameters ("Failed query: ...") into it.
	if (isOccupancyOverlapError(error)) {
		throw new HttpError(409, 'slot_unavailable')
	}
	const combined = sqliteErrorText(error)
	if (
		combined.includes('hold_already_converted') ||
		combined.includes('uniq_rsv_reservations_hold_id')
	) {
		throw conflict('conflict')
	}
	throw error
}

/**
 * Serialized per-organization reservation write gate.
 *
 * 1. Acquires the per-org in-process mutex (`runExclusive(orgId)`).
 * 2. Wraps the SQLite transaction in `retryOnSqliteBusy`.
 * 3. Inside a single transaction:
 *    - Sweeps expired holds, pending-payment reservations, pending requests,
 *      and waitlist offers.
 *    - Checks `rsv_idempotency_keys` when an idempotency key is provided
 *      (replaying the stored result on a matching `requestHash` or throwing
 *      `409 idempotency_conflict` on a mismatched `requestHash`).
 *    - Loads fresh day state for the target `locationId` and `dates`.
 *    - Runs `fn(tx, helpers)`.
 *    - Increments `rsv_day_versions.version` for every affected `(locationId, businessDate)`.
 *    - Stores the idempotency record on first execution.
 * 4. After commit: invalidates affected day-cache entries and runs `afterCommit` hooks.
 */
export async function withReservationWrite<T>(
	options: WithReservationWriteOptions,
	fn: (tx: ReservationWriteTx, helpers: ReservationWriteHelpers) => Promise<T>,
): Promise<T> {
	const { orgId } = options
	const now = options.now ?? Date.now()
	const idempotency: IdempotencyOptions | undefined =
		options.idempotency ??
		(options.scope && options.idempotencyKey && options.requestHash
			? {
					scope: options.scope,
					key: options.idempotencyKey,
					requestHash: options.requestHash,
				}
			: undefined)

	const initialDates = normalizeDates(options.dates)

	const active = activeWriteStorage.getStore()
	if (active && !idempotency) {
		let innerPrimaryDayState = active.helpers.dayState
		if (options.locationId && initialDates.length > 0) {
			innerPrimaryDayState = null
			for (const date of initialDates) {
				active.helpers.markAffectedDate(options.locationId, date)
				const loaded = await active.helpers.loadDayState(
					options.locationId,
					date,
				)
				if (!innerPrimaryDayState) innerPrimaryDayState = loaded
			}
		}
		if (options.onAfterCommit) {
			active.helpers.afterCommit(options.onAfterCommit)
		}
		const innerHelpers: ReservationWriteHelpers = {
			...active.helpers,
			locationId: options.locationId ?? active.helpers.locationId,
			dayState: innerPrimaryDayState,
		}
		return fn(active.tx, innerHelpers)
	}

	// Per-attempt state lives in `attempt` (below), never out here: a
	// SQLITE_BUSY retry re-runs the whole closure, and state left over from a
	// rolled-back attempt would skip day-version bumps or run its hooks.
	const committed: {
		current: {
			affectedDatesByLocation: Map<string, Set<string>>
			postCommitHooks: Array<() => void | Promise<void>>
		} | null
	} = { current: null }

	const outcome = await runExclusive(orgId, async () => {
		const db = options.db ?? (await getTenantDb(orgId))

		return retryOnSqliteBusy(async () => {
			const postCommitHooks: Array<() => void | Promise<void>> = []
			if (options.onAfterCommit) {
				postCommitHooks.push(options.onAfterCommit)
			}
			const affectedDatesByLocation = new Map<string, Set<string>>()
			const markAffectedDate = (locId: string, businessDate: string) => {
				let set = affectedDatesByLocation.get(locId)
				if (!set) {
					set = new Set<string>()
					affectedDatesByLocation.set(locId, set)
				}
				set.add(businessDate)
			}
			if (options.locationId) {
				for (const d of initialDates) {
					markAffectedDate(options.locationId, d)
				}
			}
			const explicitlyBumped = new Set<string>()
			try {
				const result = await runTenantTransaction(db, async (tx) => {
					const swept = await sweepExpiredInTx(tx, {
						locationId: options.locationId,
						now,
					})
					for (const item of swept.affectedLocationDates) {
						markAffectedDate(item.locationId, item.businessDate)
					}
					const queueCtx = {
						orgId,
						now,
						afterCommit: (hook: () => void | Promise<void>) => {
							postCommitHooks.push(hook)
						},
					}
					for (const requestId of swept.expiredRequestIds) {
						await enqueueReservationMessage(tx, queueCtx, {
							reservationId: requestId,
							kind: 'request_declined',
						})
					}

					if (idempotency) {
						const existing = await tx
							.select()
							.from(rsvIdempotencyKeys)
							.where(
								and(
									eq(rsvIdempotencyKeys.scope, idempotency.scope),
									eq(rsvIdempotencyKeys.key, idempotency.key),
								),
							)
							.get()

						if (existing && existing.expiresAt > now) {
							if (existing.requestHash !== idempotency.requestHash) {
								throw conflict(
									'idempotency_conflict',
									'Idempotency key already used with a different request payload',
								)
							}
							return {
								replayed: true as const,
								value: JSON.parse(existing.responseJson) as T,
							}
						}
					}

					const dayStates = new Map<string, LoadedReservationDayState>()
					const loadDayState = async (
						locId: string,
						businessDate: string,
					): Promise<LoadedReservationDayState> => {
						const state = await loadDayStateInTx(tx, locId, businessDate, now)
						dayStates.set(`${locId}:${businessDate}`, state)
						dayStates.set(businessDate, state)
						return state
					}

					let primaryDayState: LoadedReservationDayState | null = null
					if (options.locationId && initialDates.length > 0) {
						for (const date of initialDates) {
							const loaded = await loadDayState(options.locationId, date)
							if (!primaryDayState) primaryDayState = loaded
						}
					}

					const bumpDayVersions = async (
						locId: string,
						datesToBump: string | readonly string[],
					): Promise<Map<string, number>> => {
						const list = normalizeDates(datesToBump)
						const toBumpNow: string[] = []
						for (const d of list) {
							markAffectedDate(locId, d)
							const key = `${locId}:${d}`
							if (!explicitlyBumped.has(key)) {
								explicitlyBumped.add(key)
								toBumpNow.push(d)
							}
						}
						if (toBumpNow.length === 0) {
							const current = new Map<string, number>()
							for (const d of list) {
								const row = await tx
									.select({ version: rsvDayVersions.version })
									.from(rsvDayVersions)
									.where(
										and(
											eq(rsvDayVersions.locationId, locId),
											eq(rsvDayVersions.businessDate, d),
										),
									)
									.get()
								current.set(d, row?.version ?? 1)
							}
							return current
						}
						return bumpDayVersionsInTx(tx, locId, toBumpNow, now)
					}

					const helpers: ReservationWriteHelpers = {
						orgId,
						locationId: options.locationId,
						now,
						swept,
						dayState: primaryDayState,
						dayStates,
						loadDayState,
						bumpDayVersions,
						markAffectedDate,
						afterCommit: (hook) => {
							postCommitHooks.push(hook)
						},
					}

					const value = await activeWriteStorage.run(
						{ orgId, tx, helpers },
						() => fn(tx, helpers),
					)

					// Reminders follow the booking: whatever this write changed, the
					// scheduled rows of the touched days are brought back in line.
					for (const [locId, datesSet] of affectedDatesByLocation.entries()) {
						await reconcileScheduledMessages(tx, queueCtx, {
							locationId: locId,
							dates: [...datesSet],
						})
					}

					for (const [locId, datesSet] of affectedDatesByLocation.entries()) {
						const remaining = Array.from(datesSet).filter(
							(d) => !explicitlyBumped.has(`${locId}:${d}`),
						)
						if (remaining.length > 0) {
							await bumpDayVersionsInTx(tx, locId, remaining, now)
							for (const d of remaining) {
								explicitlyBumped.add(`${locId}:${d}`)
							}
						}
					}

					if (idempotency) {
						const ttlMs = idempotency.ttlMs ?? IDEMPOTENCY_TTL_MS
						await tx
							.insert(rsvIdempotencyKeys)
							.values({
								scope: idempotency.scope,
								key: idempotency.key,
								requestHash: idempotency.requestHash,
								statusCode: idempotency.statusCode ?? 200,
								responseJson: JSON.stringify(value ?? null),
								createdAt: now,
								expiresAt: now + ttlMs,
							})
							.onConflictDoUpdate({
								target: [rsvIdempotencyKeys.scope, rsvIdempotencyKeys.key],
								set: {
									requestHash: idempotency.requestHash,
									statusCode: idempotency.statusCode ?? 200,
									responseJson: JSON.stringify(value ?? null),
									createdAt: now,
									expiresAt: now + ttlMs,
								},
							})
					}

					return {
						replayed: false as const,
						value,
					}
				})
				committed.current = { affectedDatesByLocation, postCommitHooks }
				return result
			} catch (error) {
				mapSqliteConstraintError(error)
			}
		})
	})

	const finished = committed.current
	for (const [locId, datesSet] of finished?.affectedDatesByLocation ?? []) {
		for (const businessDate of datesSet) {
			invalidateReservationDayCache(orgId, locId, businessDate)
		}
	}

	if (!outcome.replayed) {
		for (const hook of finished?.postCommitHooks ?? []) {
			await hook()
		}
	}

	return outcome.value
}

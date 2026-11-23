import {
	parseClosedSpecialDates,
	type InventoryLocationSettings,
	type InventoryContextLocation,
} from '@repo/inventory'
import { isValidTimeZone } from '@repo/reservations'
import {
	getTenantDb,
	invLocationSettings,
	invMovements,
	rsvLocationSettings,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import {
	getInventoryPlaceContext,
	type InventoryPlaceContext,
} from '../lib/inventory-context.ts'
import { InventoryError } from '../lib/inventory-http.ts'
import {
	type InventoryIdempotency,
	type InventoryReader,
	withInventoryWrite,
} from '../lib/inventory-write.ts'
import { recordInventoryAudit } from './inventory-audit.ts'
import { assertLocationAllowed, assertVersion } from './inventory-common.ts'
import {
	type UpdateLocationCountControlsInput,
	type UpdateLocationSpendingLimitsInput,
} from './inventory-contract-types.ts'
import { type InventoryCaller } from './inventory-items-service.ts'

/**
 * Where a location's inventory money and days come from.
 *
 * The control plane (App) knows each location's time zone and tax settings.
 * It tells the region through `GET /resources/inventory/context`, and the
 * region keeps a copy in `inv_location_settings` so the tick, Station and sale
 * work read it without a network call. The row `location_id = '*'` holds the
 * organization's defaults.
 *
 * Currency: ONE per location, never guessed. It is the App's when the control
 * plane names one for the location, else the currency of the location's first
 * priced delivery (`source: 'delivery'`). It never changes once the location
 * has valued movements. The organization default is only a hint, used to
 * label a quantity-only delivery when the location has no currency yet; with
 * no hint either, that delivery answers 409 `currency_unknown`.
 *
 * Time: the location's own zone and day start, else the reservations setting
 * (when that module is set up), else the organization's zone, else UTC with a
 * 04:00 day start.
 */

export const ORG_DEFAULT_LOCATION = '*'
export const DEFAULT_DAY_START_MINUTES = 240
export const LOCATION_SYNC_INTERVAL_MS = 5 * 60 * 1000

type SettingsRow = typeof invLocationSettings.$inferSelect

export type LocationTime = {
	/** `null` while no zone is known anywhere (UTC is used). */
	timeZone: string | null
	dayStartMin: number
}

const lastSyncAt = new Map<string, number>()

/** Forget the throttle (tests, and after the App says something changed). */
export function resetLocationSettingsSync(orgId?: string): void {
	if (orgId) lastSyncAt.delete(orgId)
	else lastSyncAt.clear()
}

function toWire(
	locationId: string,
	row: SettingsRow | undefined,
	time: LocationTime,
	cost = true,
): InventoryLocationSettings {
	const out: InventoryLocationSettings = {
		locationId,
		currency: row?.currency ?? null,
		currencySource: row?.currencySource ?? null,
		timeZone: time.timeZone,
		dayStartMinutes: time.dayStartMin,
		pricesIncludeTax: row?.pricesIncludeTax ?? false,
		taxRateBp: row?.taxRateBp ?? null,
		secondCountRequired: row?.secondCountRequired ?? false,
		version: row?.version ?? 0,
	}
	if (cost) {
		out.orderLimitMinor = row?.orderLimitMinor ?? null
		out.monthlyLimitMinor = row?.monthlyLimitMinor ?? null
	}
	return out
}

async function readRow(
	db: InventoryReader,
	locationId: string,
): Promise<SettingsRow | undefined> {
	return db
		.select()
		.from(invLocationSettings)
		.where(eq(invLocationSettings.locationId, locationId))
		.get()
}

/** The location's time zone and day start (the chain in the file header). */
export async function resolveLocationTime(
	db: InventoryReader,
	locationId: string,
): Promise<LocationTime> {
	const rows = await db
		.select()
		.from(invLocationSettings)
		.where(
			inArray(invLocationSettings.locationId, [
				locationId,
				ORG_DEFAULT_LOCATION,
			]),
		)
	const own = rows.find((row) => row.locationId === locationId)
	if (own?.timeZone && isValidTimeZone(own.timeZone)) {
		return { timeZone: own.timeZone, dayStartMin: own.dayStartMinutes }
	}
	const rsv = await db
		.select({
			timeZone: rsvLocationSettings.timeZone,
			dayStartMin: rsvLocationSettings.dayStartMin,
		})
		.from(rsvLocationSettings)
		.where(eq(rsvLocationSettings.locationId, locationId))
		.get()
	if (rsv && isValidTimeZone(rsv.timeZone)) {
		return { timeZone: rsv.timeZone, dayStartMin: rsv.dayStartMin }
	}
	const org = rows.find((row) => row.locationId === ORG_DEFAULT_LOCATION)
	if (org?.timeZone && isValidTimeZone(org.timeZone)) {
		return {
			timeZone: org.timeZone,
			dayStartMin: own?.dayStartMinutes ?? org.dayStartMinutes,
		}
	}
	return {
		timeZone: null,
		dayStartMin: own?.dayStartMinutes ?? DEFAULT_DAY_START_MINUTES,
	}
}

/** One location's settings as they go on the wire. */
export async function getLocationSettings(
	db: InventoryReader,
	locationId: string,
	options: { cost?: boolean } = {},
): Promise<InventoryLocationSettings> {
	const [row, time] = await Promise.all([
		readRow(db, locationId),
		resolveLocationTime(db, locationId),
	])
	return toWire(locationId, row, time, options.cost ?? true)
}

/**
 * Closed special dates (`YYYY-MM-DD` → optional reason/note) for `locationId`,
 * read from `inv_location_settings.special_hours` (synced from
 * `OrganizationLocation.specialHours`).
 */
export async function getLocationClosedSpecialDates(
	db: InventoryReader,
	locationId: string,
): Promise<Map<string, string | null>> {
	const inv = await readRow(db, locationId)
	return parseClosedSpecialDates(inv?.specialHours ?? null)
}

/** The settings of every location the token covers that the region knows. */
export async function listLocationSettings(
	db: InventoryReader,
	scope: readonly string[] | null,
	options: { cost?: boolean } = {},
): Promise<InventoryLocationSettings[]> {
	const cost = options.cost ?? true
	const rows = await db.select().from(invLocationSettings)
	const out: InventoryLocationSettings[] = []
	for (const row of rows) {
		if (row.locationId === ORG_DEFAULT_LOCATION) continue
		if (scope !== null && !scope.includes(row.locationId)) continue
		out.push(
			toWire(
				row.locationId,
				row,
				await resolveLocationTime(db, row.locationId),
				cost,
			),
		)
	}
	return out.sort((a, b) => (a.locationId < b.locationId ? -1 : 1))
}

/**
 * Updates per-location purchasing spending limits (`orderLimitMinor`,
 * `monthlyLimitMinor`). Requires `update:inventory_purchasing:any`,
 * `update:settings:any` (`canManageSettings`), and `read:inventory_cost:any`.
 */
export async function updateLocationSpendingLimits(
	caller: InventoryCaller,
	input: {
		locationId: string
		body: UpdateLocationSpendingLimitsInput
		idempotency?: InventoryIdempotency | null
	},
): Promise<InventoryLocationSettings> {
	if (!caller.purchasing || !caller.canManageSettings || !caller.cost) {
		throw new InventoryError('forbidden', 403, { reason: 'grant' })
	}
	assertLocationAllowed(caller.locationIds, input.locationId)
	return withInventoryWrite(
		{ orgId: caller.orgId, idempotency: input.idempotency },
		async (tx, ctx) => {
			const existing = await readRow(tx, input.locationId)
			const currentVersion = existing?.version ?? 0
			assertVersion(currentVersion, input.body.expectedVersion)
			const orderLimitMinor =
				input.body.orderLimitMinor === undefined
					? (existing?.orderLimitMinor ?? null)
					: input.body.orderLimitMinor
			const monthlyLimitMinor =
				input.body.monthlyLimitMinor === undefined
					? (existing?.monthlyLimitMinor ?? null)
					: input.body.monthlyLimitMinor
			const nextVersion = currentVersion + 1
			const values = {
				orderLimitMinor,
				monthlyLimitMinor,
				version: nextVersion,
				updatedAt: ctx.now,
			}
			await tx
				.insert(invLocationSettings)
				.values({ locationId: input.locationId, ...values })
				.onConflictDoUpdate({
					target: invLocationSettings.locationId,
					set: values,
				})
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'location_settings.limits.update',
				resourceType: 'location_settings',
				resourceId: input.locationId,
				locationId: input.locationId,
				detail: {
					version: nextVersion,
					orderLimitMinor,
					monthlyLimitMinor,
				},
				at: ctx.now,
			})
			return getLocationSettings(tx, input.locationId, { cost: caller.cost })
		},
	)
}

/** The count rules a location chose (#525); a location with no settings row has none. */
export async function getLocationCountControls(
	db: InventoryReader,
	locationId: string,
): Promise<{ secondCountRequired: boolean; version: number }> {
	const row = await readRow(db, locationId)
	return {
		secondCountRequired: row?.secondCountRequired ?? false,
		version: row?.version ?? 0,
	}
}

/**
 * Turns the key-item second-person check on or off for one location (#525).
 * A manager's setting (`update:settings:any`, the same as the spending limits).
 */
export async function updateLocationCountControls(
	caller: InventoryCaller,
	input: {
		locationId: string
		body: UpdateLocationCountControlsInput
		idempotency?: InventoryIdempotency | null
	},
): Promise<InventoryLocationSettings> {
	if (!caller.canManageSettings) {
		throw new InventoryError('forbidden', 403, { reason: 'grant' })
	}
	assertLocationAllowed(caller.locationIds, input.locationId)
	return withInventoryWrite(
		{
			orgId: caller.orgId,
			idempotency: input.idempotency,
			skipAutoSoldOut: true,
		},
		async (tx, ctx) => {
			const existing = await readRow(tx, input.locationId)
			const currentVersion = existing?.version ?? 0
			assertVersion(currentVersion, input.body.expectedVersion)
			const values = {
				secondCountRequired: input.body.secondCountRequired,
				version: currentVersion + 1,
				updatedAt: ctx.now,
			}
			await tx
				.insert(invLocationSettings)
				.values({ locationId: input.locationId, ...values })
				.onConflictDoUpdate({
					target: invLocationSettings.locationId,
					set: values,
				})
			await recordInventoryAudit(tx, {
				actorKind: caller.actor.kind,
				actorId: caller.actor.id,
				action: 'location_settings.count_controls.update',
				resourceType: 'location_settings',
				resourceId: input.locationId,
				locationId: input.locationId,
				detail: {
					version: values.version,
					secondCountRequired: input.body.secondCountRequired,
				},
				at: ctx.now,
			})
			return getLocationSettings(tx, input.locationId, { cost: caller.cost })
		},
	)
}

/** The location's currency, or null while unknown. */
export async function getLocationCurrency(
	db: InventoryReader,
	locationId: string,
): Promise<string | null> {
	return (await readRow(db, locationId))?.currency ?? null
}

/**
 * The currency to label a quantity-only delivery with: the location's, else
 * the organization hint. 409 `currency_unknown` when neither exists (the
 * money is not known yet, so nothing is guessed).
 */
export async function requireLocationCurrency(
	db: InventoryReader,
	locationId: string,
): Promise<string> {
	const own = (await readRow(db, locationId))?.currency
	if (own) return own
	const hint = (await readRow(db, ORG_DEFAULT_LOCATION))?.currency
	if (hint) return hint
	throw new InventoryError('currency_unknown', 409, {
		reason: 'currency_unknown',
	})
}

/**
 * A priced write names a currency. It must be the location's; a location with
 * none takes it (the first priced delivery sets it, `source: 'delivery'`).
 * 400 `currency_mismatch` otherwise.
 */
export async function assertLocationCurrency(
	db: InventoryReader,
	input: { locationId: string; currency: string; now: number },
): Promise<void> {
	const row = await readRow(db, input.locationId)
	if (row?.currency) {
		if (row.currency !== input.currency) {
			throw new InventoryError('currency_mismatch', 400, {
				reason: 'currency_mismatch',
			})
		}
		return
	}
	const values = {
		currency: input.currency,
		currencySource: 'delivery' as const,
		version: (row?.version ?? 0) + 1,
		updatedAt: input.now,
	}
	await db
		.insert(invLocationSettings)
		.values({ locationId: input.locationId, ...values })
		.onConflictDoUpdate({
			target: invLocationSettings.locationId,
			set: values,
		})
}

/** The same check for work that must not fail on a mismatch (it returns instead). */
export function sameCurrency(
	locationCurrency: string | null,
	valueCurrency: string | null | undefined,
): boolean {
	return (
		locationCurrency === null ||
		valueCurrency === null ||
		valueCurrency === undefined ||
		locationCurrency === valueCurrency
	)
}

async function hasValuedMovements(
	db: InventoryReader,
	locationId: string,
): Promise<boolean> {
	const row = await db
		.select({ id: invMovements.id })
		.from(invMovements)
		.where(
			and(
				eq(invMovements.locationId, locationId),
				isNotNull(invMovements.currency),
			),
		)
		.limit(1)
		.get()
	return row !== undefined
}

function taxBp(location: InventoryContextLocation): number | null {
	return location.taxRatePercent === undefined
		? null
		: Math.min(10_000, Math.max(0, Math.round(location.taxRatePercent * 100)))
}

function serializeSpecialHours(raw: unknown): string | null {
	if (raw === null || raw === undefined) return null
	if (typeof raw === 'string') {
		const trimmed = raw.trim()
		return trimmed.length > 0 ? trimmed : null
	}
	return JSON.stringify(raw)
}

async function applyLocation(
	db: TenantDatabase,
	orgId: string,
	location: InventoryContextLocation,
	now: number,
): Promise<void> {
	const existing = await readRow(db, location.id)
	let currency = existing?.currency ?? null
	let currencySource = existing?.currencySource ?? null
	if (location.currency && location.currency !== currency) {
		if (currency !== null && (await hasValuedMovements(db, location.id))) {
			console.error('Inventory location currency change ignored', {
				orgId,
				locationId: location.id,
			})
		} else {
			currency = location.currency
			currencySource = 'app'
		}
	}
	const zone =
		location.timeZone && isValidTimeZone(location.timeZone)
			? location.timeZone
			: (existing?.timeZone ?? null)
	const pricesIncludeTax =
		location.taxInclusive ?? existing?.pricesIncludeTax ?? false
	const taxRateBp = taxBp(location) ?? existing?.taxRateBp ?? null
	const specialHours =
		location.specialHours !== undefined
			? serializeSpecialHours(location.specialHours)
			: (existing?.specialHours ?? null)
	if (
		existing &&
		existing.currency === currency &&
		existing.currencySource === currencySource &&
		existing.timeZone === zone &&
		existing.pricesIncludeTax === pricesIncludeTax &&
		existing.taxRateBp === taxRateBp &&
		existing.specialHours === specialHours
	) {
		await db
			.update(invLocationSettings)
			.set({ syncedAt: now })
			.where(eq(invLocationSettings.locationId, location.id))
		return
	}
	let dayStart = existing?.dayStartMinutes
	if (dayStart === undefined) {
		const rsv = await db
			.select({ dayStartMin: rsvLocationSettings.dayStartMin })
			.from(rsvLocationSettings)
			.where(eq(rsvLocationSettings.locationId, location.id))
			.get()
		dayStart = rsv?.dayStartMin ?? DEFAULT_DAY_START_MINUTES
	}
	const values = {
		currency,
		currencySource,
		timeZone: zone,
		dayStartMinutes: dayStart,
		pricesIncludeTax,
		taxRateBp,
		specialHours,
		version: (existing?.version ?? 0) + 1,
		syncedAt: now,
		updatedAt: now,
	}
	await db
		.insert(invLocationSettings)
		.values({ locationId: location.id, ...values })
		.onConflictDoUpdate({
			target: invLocationSettings.locationId,
			set: values,
		})
}

async function applyOrganization(
	db: TenantDatabase,
	organization: NonNullable<InventoryPlaceContext['organization']>,
	now: number,
): Promise<void> {
	const existing = await readRow(db, ORG_DEFAULT_LOCATION)
	const zone =
		organization.timeZone && isValidTimeZone(organization.timeZone)
			? organization.timeZone
			: (existing?.timeZone ?? null)
	const currency = organization.currency ?? existing?.currency ?? null
	if (
		existing &&
		existing.currency === currency &&
		existing.timeZone === zone
	) {
		return
	}
	const values = {
		currency,
		timeZone: zone,
		version: (existing?.version ?? 0) + 1,
		syncedAt: now,
		updatedAt: now,
	}
	await db
		.insert(invLocationSettings)
		.values({ locationId: ORG_DEFAULT_LOCATION, ...values })
		.onConflictDoUpdate({
			target: invLocationSettings.locationId,
			set: values,
		})
}

/** Copies a context answer into the region's tables. */
export async function applyPlaceContext(
	db: TenantDatabase,
	orgId: string,
	context: InventoryPlaceContext,
	now: number,
): Promise<void> {
	if (context.organization) {
		await applyOrganization(db, context.organization, now)
	}
	for (const location of context.locations ?? []) {
		await applyLocation(db, orgId, location, now)
	}
}

/**
 * Brings `inv_location_settings` up to date with what the App says, at most
 * every five minutes per organization. Best effort: never throws, and a
 * context that cannot be read leaves the region's copy as it is.
 */
export async function syncLocationSettings(
	orgId: string,
	options: { now?: number; db?: TenantDatabase; force?: boolean } = {},
): Promise<void> {
	const now = options.now ?? Date.now()
	const last = lastSyncAt.get(orgId)
	if (
		!options.force &&
		last !== undefined &&
		now - last < LOCATION_SYNC_INTERVAL_MS
	) {
		return
	}
	try {
		const context = await getInventoryPlaceContext(orgId, { now })
		if (!context || (!context.organization && !context.locations)) return
		const db = options.db ?? (await getTenantDb(orgId))
		await applyPlaceContext(db, orgId, context, now)
		lastSyncAt.set(orgId, now)
	} catch (error) {
		console.error('Inventory location settings could not be synced', {
			orgId,
			reason: error instanceof Error ? error.name : 'unknown',
		})
	}
}

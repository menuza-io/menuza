import { auditService, type AuditAction } from '@repo/audit'
import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	changedLocationSettings,
	changedLocationSettingsInForm,
	getLocationSetting,
	LOCATION_SETTINGS_COLUMNS,
	listLocationSettings,
	LOCATION_SETTING_IDS,
	settingValuesEqual,
	type LocationSettingContext,
	type LocationSettingId,
	type LocationSettingsPatch,
	type LocationSettingsRow,
} from '@repo/common/location-settings-registry'
import { getLocationCurrency } from '@repo/common/location-types'
import {
	and,
	db,
	eq,
	OrganizationLocation,
	OrganizationLocationSettingPolicy,
} from '@repo/database'
import { notifyReservationsContextChanged } from '#app/utils/reservations/access.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'

/**
 * Shared server side of the multi-location tools: copy settings (#125), compare
 * and edit (#418) and chain defaults and locks (#417). Every write to the
 * registry's columns that is not the single-location form goes through
 * `commitLocationPatches`, which is one database batch (every location changes
 * or none), and the callers refuse locked settings with `lockedAmong` first.
 */

export type LocationRecord = {
	id: string
	name: string
	isActive: boolean
	isDefault: boolean
	address: string | null
	row: LocationSettingsRow
	ctx: LocationSettingContext
}

export type OrganizationForSettings = {
	id: string
	slug: string
	dataRegion: string
}

/** The currency a location's amounts are in: SAR in KSA, else from its address. */
export function currencyForLocation(
	dataRegion: string,
	address: string | null,
): string {
	return dataRegion === 'ksa' ? 'SAR' : getLocationCurrency(address)
}

export async function loadLocationRecords(
	organization: Pick<OrganizationForSettings, 'id' | 'dataRegion'>,
): Promise<LocationRecord[]> {
	const rows = await db
		.select()
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organization.id))
	return rows
		.map((row) => ({
			id: row.id,
			name: row.name,
			isActive: row.isActive,
			isDefault: row.isDefault,
			address: row.address,
			row: {
				timezone: row.timezone,
				storeHours: row.storeHours,
				onlineHours: row.onlineHours,
				specialHours: row.specialHours,
				prepTime: row.prepTime,
				largeOrderThreshold: row.largeOrderThreshold,
				largeOrderThresholdType: row.largeOrderThresholdType,
				largeOrderExtraPrepTime: row.largeOrderExtraPrepTime,
				fulfillmentOptions: row.fulfillmentOptions,
				inHouseTips: row.inHouseTips,
				tipSettings: row.tipSettings,
				serviceFee: row.serviceFee,
				onlineOrderingSettings: row.onlineOrderingSettings,
				packagingFee: row.packagingFee,
				orderCaps: row.orderCaps,
				scheduling: row.scheduling,
				deliveryConfig: row.deliveryConfig,
			},
			ctx: {
				currency: currencyForLocation(organization.dataRegion, row.address),
			},
		}))
		.sort(
			(a, b) =>
				Number(b.isDefault) - Number(a.isDefault) ||
				a.name.localeCompare(b.name),
		)
}

export type SettingPolicy = {
	settingId: LocationSettingId
	defaultValue: unknown
	locked: boolean
	lockReason: string | null
}

/**
 * The chain defaults and locks of an organization, by setting. A stored policy
 * whose id or value no longer parses is ignored (and so locks nothing): the
 * registry is the only source of what a value means.
 */
export async function loadSettingPolicies(
	organizationId: string,
): Promise<Map<LocationSettingId, SettingPolicy>> {
	const rows = await db
		.select()
		.from(OrganizationLocationSettingPolicy)
		.where(eq(OrganizationLocationSettingPolicy.organizationId, organizationId))
	const policies = new Map<LocationSettingId, SettingPolicy>()
	for (const row of rows) {
		if (!(LOCATION_SETTING_IDS as readonly string[]).includes(row.settingId))
			continue
		const settingId = row.settingId as LocationSettingId
		let raw: unknown
		try {
			raw = JSON.parse(row.defaultValue)
		} catch {
			continue
		}
		const parsed = getLocationSetting(settingId).parse(raw)
		if (!parsed.ok) continue
		policies.set(settingId, {
			settingId,
			defaultValue: parsed.value,
			locked: row.locked,
			lockReason: row.lockReason,
		})
	}
	return policies
}

/** Settings whose organization flag is on (settings without a flag always are). */
export async function enabledSettingIds(
	organizationId: string,
): Promise<Set<LocationSettingId>> {
	const enabled = new Set<LocationSettingId>()
	const flags = new Map<string, boolean>()
	for (const definition of listLocationSettings()) {
		if (!definition.flag) {
			enabled.add(definition.id)
			continue
		}
		if (!flags.has(definition.flag)) {
			flags.set(
				definition.flag,
				(await getFeatureFlag(definition.flag, { organizationId })) === true,
			)
		}
		if (flags.get(definition.flag)) enabled.add(definition.id)
	}
	return enabled
}

/** Locked settings among `settings`, in registry order. */
export function lockedAmong(
	policies: ReadonlyMap<LocationSettingId, SettingPolicy>,
	settings: readonly LocationSettingId[],
): LocationSettingId[] {
	return LOCATION_SETTING_IDS.filter(
		(id) => settings.includes(id) && policies.get(id)?.locked === true,
	)
}

/** Settings of a row whose value differs from the chain default (its overrides). */
export function overridesOf(
	record: Pick<LocationRecord, 'row' | 'ctx'>,
	policies: ReadonlyMap<LocationSettingId, SettingPolicy>,
): LocationSettingId[] {
	const result: LocationSettingId[] = []
	for (const [settingId, policy] of policies) {
		const current = getLocationSetting(settingId).read(record.row, record.ctx)
		if (!settingValuesEqual(current, policy.defaultValue))
			result.push(settingId)
	}
	return LOCATION_SETTING_IDS.filter((id) => result.includes(id))
}

/**
 * The settings a form save would change on a location: the stored row against
 * the row with the submitted columns applied.
 */
export function settingsChangedBy(
	record: Pick<LocationRecord, 'row' | 'ctx'>,
	patch: LocationSettingsPatch,
): LocationSettingId[] {
	return changedLocationSettings(
		record.row,
		{ ...record.row, ...patch },
		record.ctx,
	)
}

export type LocationPatchEntry = {
	locationId: string
	patch: LocationSettingsPatch
}

/**
 * Writes column patches to locations of this organization as one database
 * batch: every location changes or none. The organization id is part of every
 * statement's condition, so an id from another organization writes nothing.
 */
export async function commitLocationPatches(
	organizationId: string,
	entries: readonly LocationPatchEntry[],
): Promise<void> {
	const writes = entries.filter((entry) => Object.keys(entry.patch).length > 0)
	if (writes.length === 0) return
	const statements = writes.map((entry) =>
		db
			.update(OrganizationLocation)
			.set(entry.patch)
			.where(
				and(
					eq(OrganizationLocation.id, entry.locationId),
					eq(OrganizationLocation.organizationId, organizationId),
				),
			),
	)
	await db.batch(statements as unknown as [(typeof statements)[number]])
}

/** What a changed location needs after the commit: fresh Sites and region data. */
export async function afterLocationSettingsWritten(
	organization: Pick<OrganizationForSettings, 'id' | 'slug'>,
): Promise<void> {
	await purgeOrganizationSiteCache(organization.id, organization.slug)
	await notifyReservationsContextChanged(organization.id, 'locations')
}

export type SettingAuditEntry = {
	action: AuditAction
	/** The location the entry is about. */
	locationId: string
	details: string
	metadata: Record<string, unknown>
	/** For an entry about a chain default rather than one location. */
	resource?: { type: string; id: string }
}

/**
 * One activity log entry per entry given (the callers pass one per setting per
 * location). Ids and setting names only. A log failure never undoes a change.
 */
export async function auditLocationSettingEntries(input: {
	organizationId: string
	userId: string
	request: Request
	entries: readonly SettingAuditEntry[]
}): Promise<void> {
	for (const entry of input.entries) {
		try {
			await auditService.log({
				action: entry.action,
				userId: input.userId,
				organizationId: input.organizationId,
				details: entry.details,
				metadata: entry.metadata,
				request: input.request,
				resourceType: entry.resource?.type ?? 'organization_location',
				resourceId: entry.resource?.id ?? entry.locationId,
			})
		} catch (error) {
			console.error('location settings audit failed', {
				action: entry.action,
				reason: error instanceof Error ? error.name : 'unknown',
			})
		}
	}
}

/**
 * The locked settings a single-location form save would change. `set` is the
 * column set the save is about to write; only the registry's columns count and
 * the comparison is in form terms, so saving an untouched form changes nothing.
 * The server refuses the save when this is not empty: a lock is never only a
 * disabled field.
 */
export async function lockedSettingsChangedByFormSave(
	organization: OrganizationForSettings,
	locationId: string,
	set: Record<string, unknown>,
): Promise<LocationSettingId[]> {
	const [records, policies] = await Promise.all([
		loadLocationRecords(organization),
		loadSettingPolicies(organization.id),
	])
	if (policies.size === 0) return []
	const record = records.find((r) => r.id === locationId)
	if (!record) return []
	const patch: Record<string, unknown> = {}
	for (const column of LOCATION_SETTINGS_COLUMNS) {
		if (column in set && set[column] !== undefined) patch[column] = set[column]
	}
	const changed = changedLocationSettingsInForm(
		record.row,
		{ ...record.row, ...(patch as LocationSettingsPatch) },
		record.ctx,
	)
	return lockedAmong(policies, changed)
}

import { AuditAction } from '@repo/audit'
import {
	getLocationSetting,
	listLocationSettings,
	settingValuesEqual,
	type LocationSettingId,
	LOCATION_SETTING_IDS,
	MAX_LOCK_REASON_LENGTH,
} from '@repo/common/location-settings-registry'
import {
	and,
	db,
	eq,
	OrganizationLocation,
	OrganizationLocationSettingPolicy,
} from '@repo/database'
import { z } from 'zod'
import {
	afterLocationSettingsWritten,
	auditLocationSettingEntries,
	commitLocationPatches,
	enabledSettingIds,
	loadLocationRecords,
	loadSettingPolicies,
	overridesOf,
	type LocationPatchEntry,
	type LocationRecord,
	type OrganizationForSettings,
	type SettingAuditEntry,
	type SettingPolicy,
} from './location-settings.server.ts'

/**
 * Chain defaults and locks (#417). Head office gives a registry setting a
 * default value and marks it locked or overridable. The default is copied into
 * the columns of every location that inherits it, so Sites and the region read
 * the same columns as before; a location "overrides" the default when its own
 * value differs, which is read from the columns, never stored twice.
 *
 * Inheriting means: the location's value equals the default it inherited. When
 * the default changes, those locations follow it; locations with a different
 * value keep it (listed as overrides) unless head office resets them.
 */


const idSchema = z.string().trim().min(1).max(64)
const settingIdSchema = z.enum(LOCATION_SETTING_IDS)
const reasonSchema = z.string().trim().max(MAX_LOCK_REASON_LENGTH).optional()

export const chainDefaultInputSchema = z.discriminatedUnion('intent', [
	z.object({
		intent: z.literal('set-default'),
		settingId: settingIdSchema,
		value: z.unknown(),
		locked: z.boolean(),
		lockReason: reasonSchema,
		/** Also move locations that currently override the default. */
		applyToOverrides: z.boolean().default(false),
	}),
	z.object({
		intent: z.literal('use-location'),
		settingId: settingIdSchema,
		sourceId: idSchema,
		locked: z.boolean(),
		lockReason: reasonSchema,
		applyToOverrides: z.boolean().default(false),
	}),
	z.object({
		intent: z.literal('set-lock'),
		settingId: settingIdSchema,
		locked: z.boolean(),
		lockReason: reasonSchema,
	}),
	z.object({
		intent: z.literal('remove-default'),
		settingId: settingIdSchema,
	}),
	z.object({
		intent: z.literal('reset-overrides'),
		settingId: settingIdSchema,
		locationIds: z.array(idSchema).min(1).max(200),
	}),
])
export type ChainDefaultInput = z.infer<typeof chainDefaultInputSchema>

export type ChainDefaultFailure = {
	ok: false
	status: 400 | 404 | 409 | 500
	error:
		| 'invalid_request'
		| 'invalid_value'
		| 'not_supported'
		| 'setting_unavailable'
		| 'mixed_currencies'
		| 'no_default'
		| 'source_not_found'
		| 'copy_failed'
}

export type ChainDefaultSuccess = {
	ok: true
	settingId: LocationSettingId
	/** Locations whose value was changed by this action. */
	updatedLocationIds: string[]
	/** Locations that now differ from the default, kept as they are. */
	overrides: Array<{ locationId: string; name: string }>
}

function inheritingFollowers(
	records: readonly LocationRecord[],
	settingId: LocationSettingId,
	previous: SettingPolicy | undefined,
) {
	const definition = getLocationSetting(settingId)
	return (record: LocationRecord) => {
		if (!previous) return false
		return settingValuesEqual(
			definition.read(record.row, record.ctx),
			previous.defaultValue,
		)
	}
}

/** Runs one chain-default intent. Head office only (the route checks it). */
export async function applyChainDefaultIntent(input: {
	organization: OrganizationForSettings
	userId: string
	request: Request
	body: ChainDefaultInput
}): Promise<ChainDefaultSuccess | ChainDefaultFailure> {
	const { organization, body } = input
	const settingId = body.settingId
	const definition = getLocationSetting(settingId)
	if (!definition.chainDefault) {
		return { ok: false, status: 400, error: 'not_supported' }
	}
	const [records, policies, enabled] = await Promise.all([
		loadLocationRecords(organization),
		loadSettingPolicies(organization.id),
		enabledSettingIds(organization.id),
	])
	if (!enabled.has(settingId)) {
		return { ok: false, status: 400, error: 'setting_unavailable' }
	}
	const previous = policies.get(settingId)
	const audit: SettingAuditEntry[] = []
	const settingResource = { type: 'organization_location_setting', id: settingId }

	if (body.intent === 'remove-default') {
		if (!previous) return { ok: false, status: 404, error: 'no_default' }
		await db
			.delete(OrganizationLocationSettingPolicy)
			.where(
				and(
					eq(OrganizationLocationSettingPolicy.organizationId, organization.id),
					eq(OrganizationLocationSettingPolicy.settingId, settingId),
				),
			)
		await auditLocationSettingEntries({
			organizationId: organization.id,
			userId: input.userId,
			request: input.request,
			entries: [
				{
					action: AuditAction.LOCATION_SETTING_DEFAULT_CHANGED,
					locationId: '',
					resource: settingResource,
					details: `Removed the chain default for ${definition.label}`,
					metadata: { setting: settingId, removed: true },
				},
			],
		})
		// Every location keeps its own value; nothing else changes.
		return { ok: true, settingId, updatedLocationIds: [], overrides: [] }
	}

	if (body.intent === 'set-lock') {
		if (!previous) return { ok: false, status: 404, error: 'no_default' }
		await db
			.update(OrganizationLocationSettingPolicy)
			.set({
				locked: body.locked,
				lockReason: body.locked ? body.lockReason || null : null,
				updatedById: input.userId,
			})
			.where(
				and(
					eq(OrganizationLocationSettingPolicy.organizationId, organization.id),
					eq(OrganizationLocationSettingPolicy.settingId, settingId),
				),
			)
		await auditLocationSettingEntries({
			organizationId: organization.id,
			userId: input.userId,
			request: input.request,
			entries: [
				{
					action: AuditAction.LOCATION_SETTING_LOCK_CHANGED,
					locationId: '',
					resource: settingResource,
					details: `${body.locked ? 'Locked' : 'Unlocked'} ${definition.label}`,
					metadata: {
						setting: settingId,
						locked: body.locked,
						...(body.locked && body.lockReason ? { reason: body.lockReason } : {}),
					},
				},
			],
		})
		return {
			ok: true,
			settingId,
			updatedLocationIds: [],
			overrides: overridesList(records, settingId, previous.defaultValue),
		}
	}

	if (body.intent === 'reset-overrides') {
		if (!previous) return { ok: false, status: 404, error: 'no_default' }
		const wanted = new Set(body.locationIds)
		const entries: LocationPatchEntry[] = []
		for (const record of records) {
			if (!wanted.has(record.id)) continue
			const current = definition.read(record.row, record.ctx)
			if (settingValuesEqual(current, previous.defaultValue)) continue
			entries.push({
				locationId: record.id,
				patch: definition.write(record.row, previous.defaultValue, record.ctx),
			})
		}
		return commitDefaultWrites({
			input,
			settingId,
			entries,
			policyWrite: null,
			overridesAfter: overridesList(
				withPatches(records, entries),
				settingId,
				previous.defaultValue,
			),
			audit,
			auditDetails: `Reset ${definition.label} to the chain default`,
		})
	}

	// set-default / use-location
	let value: unknown
	if (body.intent === 'use-location') {
		const source = records.find((record) => record.id === body.sourceId)
		if (!source) return { ok: false, status: 404, error: 'source_not_found' }
		value = definition.read(source.row, source.ctx)
	} else {
		const parsed = definition.parse(body.value)
		if (!parsed.ok) return { ok: false, status: 400, error: 'invalid_value' }
		value = parsed.value
	}
	if (
		definition.currencySensitive &&
		new Set(records.map((record) => record.ctx.currency)).size > 1
	) {
		// Amounts in a default are in one currency; locations in several cannot share them.
		return { ok: false, status: 409, error: 'mixed_currencies' }
	}

	const follows = inheritingFollowers(records, settingId, previous)
	const entries: LocationPatchEntry[] = []
	for (const record of records) {
		const current = definition.read(record.row, record.ctx)
		if (settingValuesEqual(current, value)) continue
		const move = body.applyToOverrides || follows(record)
		if (!move) continue
		entries.push({
			locationId: record.id,
			patch: definition.write(record.row, value, record.ctx),
		})
	}
	const after = withPatches(records, entries)
	const lockReason = body.locked ? body.lockReason || null : null
	audit.push({
		action: AuditAction.LOCATION_SETTING_DEFAULT_CHANGED,
		locationId: '',
		resource: settingResource,
		details: `Set the chain default for ${definition.label}`,
		metadata: { setting: settingId, summary: definition.summarize(value, records[0]?.ctx ?? { currency: 'USD' }) },
	})
	if (!previous || previous.locked !== body.locked || previous.lockReason !== lockReason) {
		audit.push({
			action: AuditAction.LOCATION_SETTING_LOCK_CHANGED,
			locationId: '',
			resource: settingResource,
			details: `${body.locked ? 'Locked' : 'Unlocked'} ${definition.label}`,
			metadata: {
				setting: settingId,
				locked: body.locked,
				...(lockReason ? { reason: lockReason } : {}),
			},
		})
	}
	return commitDefaultWrites({
		input,
		settingId,
		entries,
		policyWrite: { value, locked: body.locked, lockReason },
		overridesAfter: overridesList(after, settingId, value),
		audit,
		auditDetails: `Applied the chain default for ${definition.label}`,
	})
}

function withPatches(
	records: readonly LocationRecord[],
	entries: readonly LocationPatchEntry[],
): LocationRecord[] {
	const patches = new Map(entries.map((entry) => [entry.locationId, entry.patch]))
	return records.map((record) =>
		patches.has(record.id)
			? { ...record, row: { ...record.row, ...patches.get(record.id)! } }
			: record,
	)
}

function overridesList(
	records: readonly LocationRecord[],
	settingId: LocationSettingId,
	defaultValue: unknown,
) {
	const definition = getLocationSetting(settingId)
	return records
		.filter(
			(record) =>
				!settingValuesEqual(
					definition.read(record.row, record.ctx),
					defaultValue,
				),
		)
		.map((record) => ({ locationId: record.id, name: record.name }))
}

async function commitDefaultWrites(args: {
	input: { organization: OrganizationForSettings; userId: string; request: Request }
	settingId: LocationSettingId
	entries: LocationPatchEntry[]
	policyWrite: { value: unknown; locked: boolean; lockReason: string | null } | null
	overridesAfter: Array<{ locationId: string; name: string }>
	audit: SettingAuditEntry[]
	auditDetails: string
}): Promise<ChainDefaultSuccess | ChainDefaultFailure> {
	const { input, settingId, entries, policyWrite } = args
	const { organization } = input
	try {
		// The policy and the location values are written together: every inheriting
		// location follows the new default or none does.
		const statements: Array<unknown> = []
		if (policyWrite) {
			statements.push(
				db
					.insert(OrganizationLocationSettingPolicy)
					.values({
						organizationId: organization.id,
						settingId,
						defaultValue: JSON.stringify(policyWrite.value),
						locked: policyWrite.locked,
						lockReason: policyWrite.lockReason,
						updatedById: input.userId,
					})
					.onConflictDoUpdate({
						target: [
							OrganizationLocationSettingPolicy.organizationId,
							OrganizationLocationSettingPolicy.settingId,
						],
						set: {
							defaultValue: JSON.stringify(policyWrite.value),
							locked: policyWrite.locked,
							lockReason: policyWrite.lockReason,
							updatedById: input.userId,
							updatedAt: new Date(),
						},
					}),
			)
		}
		await commitPolicyAndLocations(organization.id, statements, entries)
	} catch (error) {
		console.error('chain default failed', {
			organizationId: organization.id,
			setting: settingId,
			reason: error instanceof Error ? error.name : 'unknown',
		})
		return { ok: false, status: 500, error: 'copy_failed' }
	}
	if (entries.length > 0) await afterLocationSettingsWritten(organization)
	await auditLocationSettingEntries({
		organizationId: organization.id,
		userId: input.userId,
		request: input.request,
		entries: [
			...args.audit,
			...entries.map((entry) => ({
				action: AuditAction.LOCATION_SETTING_CHANGED,
				locationId: entry.locationId,
				details: args.auditDetails,
				metadata: { setting: settingId, mode: 'chain_default' },
			})),
		],
	})
	return {
		ok: true,
		settingId,
		updatedLocationIds: entries.map((entry) => entry.locationId),
		overrides: args.overridesAfter,
	}
}

async function commitPolicyAndLocations(
	organizationId: string,
	policyStatements: unknown[],
	entries: readonly LocationPatchEntry[],
) {
	if (policyStatements.length === 0) {
		await commitLocationPatches(organizationId, entries)
		return
	}
	// One batch: the policy row and every location update.
	const updates = entries
		.filter((entry) => Object.keys(entry.patch).length > 0)
		.map((entry) =>
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
	await db.batch([...policyStatements, ...updates] as unknown as [
		(typeof updates)[number],
	])
}

export type ChainDefaultRow = {
	settingId: LocationSettingId
	group: string
	hasDefault: boolean
	defaultText: string | null
	/** The default as a canonical value (for editors). */
	defaultRaw: unknown
	locked: boolean
	lockReason: string | null
	editor: ReturnType<typeof getLocationSetting>['editor']
	/** Locations whose value differs from the default. */
	overrides: Array<{ locationId: string; name: string; value: string }>
	inheritingCount: number
}

/** Every setting that can take a chain default, with its default and overrides. */
export async function loadChainDefaults(
	organization: OrganizationForSettings,
): Promise<{ rows: ChainDefaultRow[]; locationCount: number }> {
	const [records, policies, enabled] = await Promise.all([
		loadLocationRecords(organization),
		loadSettingPolicies(organization.id),
		enabledSettingIds(organization.id),
	])
	const ctx = records[0]?.ctx ?? { currency: 'USD' }
	return {
		locationCount: records.length,
		rows: listLocationSettings()
			.filter((definition) => definition.chainDefault && enabled.has(definition.id))
			.map((definition) => {
				const policy = policies.get(definition.id)
				const overrides = policy
					? records
							.filter((record) =>
								overridesOf(record, policies).includes(definition.id),
							)
							.map((record) => ({
								locationId: record.id,
								name: record.name,
								value: definition.summarize(
									definition.read(record.row, record.ctx),
									record.ctx,
								),
							}))
					: []
				return {
					settingId: definition.id,
					group: definition.group,
					hasDefault: Boolean(policy),
					defaultText: policy
						? definition.summarize(policy.defaultValue, ctx)
						: null,
					defaultRaw: policy?.defaultValue ?? null,
					locked: policy?.locked ?? false,
					lockReason: policy?.lockReason ?? null,
					editor: definition.editor,
					overrides,
					inheritingCount: policy ? records.length - overrides.length : 0,
				}
			}),
	}
}

/**
 * What the single-location form needs: the settings locked for everyone with
 * their reasons, and which settings of this location override a chain default.
 */
export async function loadLocationPolicyView(
	organization: OrganizationForSettings,
	locationId: string,
): Promise<{
	locked: Array<{ settingId: LocationSettingId; reason: string | null }>
	overrides: LocationSettingId[]
}> {
	const [records, policies] = await Promise.all([
		loadLocationRecords(organization),
		loadSettingPolicies(organization.id),
	])
	const record = records.find((r) => r.id === locationId)
	return {
		locked: LOCATION_SETTING_IDS.filter((id) => policies.get(id)?.locked).map(
			(id) => ({ settingId: id, reason: policies.get(id)?.lockReason ?? null }),
		),
		overrides: record ? overridesOf(record, policies) : [],
	}
}

/**
 * A new location starts on the chain defaults: locked or not, every setting
 * with a default takes it (a manager can override an unlocked one afterwards).
 * Called right after the location row is created, with the organization's
 * data region for currency. Returns the settings it set.
 */
export async function applyChainDefaultsToNewLocation(
	organization: OrganizationForSettings,
	locationId: string,
): Promise<LocationSettingId[]> {
	const [records, policies, enabled] = await Promise.all([
		loadLocationRecords(organization),
		loadSettingPolicies(organization.id),
		enabledSettingIds(organization.id),
	])
	const record = records.find((r) => r.id === locationId)
	if (!record || policies.size === 0) return []
	let row = record.row
	const applied: LocationSettingId[] = []
	// Amounts in a default are in the currency the other locations use.
	const otherCurrency = records.find((r) => r.id !== locationId)?.ctx.currency
	for (const [settingId, policy] of policies) {
		if (!enabled.has(settingId)) continue
		const definition = getLocationSetting(settingId)
		if (
			definition.currencySensitive &&
			otherCurrency !== undefined &&
			otherCurrency !== record.ctx.currency
		) {
			continue
		}
		const patch = definition.write(row, policy.defaultValue, record.ctx)
		row = { ...row, ...patch }
		applied.push(settingId)
	}
	const patch: Record<string, unknown> = {}
	for (const key of Object.keys(row) as Array<keyof typeof row>) {
		if (row[key] !== record.row[key]) patch[key] = row[key]
	}
	await commitLocationPatches(organization.id, [
		{ locationId, patch: patch as never },
	])
	return applied
}

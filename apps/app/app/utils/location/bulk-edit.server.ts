import { AuditAction } from '@repo/audit'
import {
	getLocationSetting,
	LOCATION_SETTING_IDS,
	settingValuesEqual,
	type LocationSettingId,
} from '@repo/common/location-settings-registry'
import { z } from 'zod'
import { MAX_COPY_TARGETS } from './copy-settings.server.ts'
import {
	afterLocationSettingsWritten,
	auditLocationSettingEntries,
	commitLocationPatches,
	enabledSettingIds,
	loadLocationRecords,
	loadSettingPolicies,
	overridesOf,
	type LocationRecord,
	type OrganizationForSettings,
} from './location-settings.server.ts'
import { partitionByScope } from './member-scope.server.ts'

/**
 * Settings the compare-and-edit table covers: every registry setting except
 * special hours, which belong to one place and one year (use "Copy settings"
 * or "Add holiday" for those).
 */
export const BULK_EDIT_SETTING_IDS = LOCATION_SETTING_IDS.filter(
	(id) => id !== 'specialHours',
) as Exclude<LocationSettingId, 'specialHours'>[]

const idSchema = z.string().trim().min(1).max(64)

export const bulkEditInputSchema = z.object({
	settingId: z.enum(BULK_EDIT_SETTING_IDS as [string, ...string[]]),
	locationIds: z.array(idSchema).min(1).max(MAX_COPY_TARGETS),
	change: z.discriminatedUnion('kind', [
		/** A new value typed in the table (prep time, fulfillment toggles). */
		z.object({ kind: z.literal('value'), value: z.unknown() }),
		/** The value another location has. */
		z.object({ kind: z.literal('match'), sourceId: idSchema }),
		/** Clear the override: back to the chain default, or the built-in default. */
		z.object({ kind: z.literal('clear') }),
	]),
})
export type BulkEditInput = z.infer<typeof bulkEditInputSchema>

export type BulkEditTargetView = {
	locationId: string
	name: string
	changed: boolean
	before: string
	after: string
	skipped?: 'currency_differs'
}

export type BulkEditSuccess = {
	ok: true
	applied: boolean
	settingId: LocationSettingId
	targets: BulkEditTargetView[]
	skipped: Array<{
		locationId: string
		name: string | null
		reason: 'not_manageable' | 'not_found'
	}>
	changedLocationIds: string[]
}

export type BulkEditFailure = {
	ok: false
	status: 400 | 403 | 404 | 409 | 500
	error:
		| 'invalid_request'
		| 'invalid_value'
		| 'location_not_allowed'
		| 'source_not_found'
		| 'setting_locked'
		| 'setting_unavailable'
		| 'copy_failed'
}

/**
 * Changes one setting on several locations (#418): a typed value, another
 * location's value, or a return to the default (clearing the override). It
 * never touches a location the person may not manage (those are skipped and
 * listed), refuses a locked setting (except clearing back to its locked
 * default), and writes every location in one batch or none. One activity log
 * entry per location whose setting really changed.
 */
export async function editLocationSettingBulk(input: {
	organization: OrganizationForSettings
	userId: string
	scope: string[] | null
	request: Request
	body: BulkEditInput
	apply: boolean
}): Promise<BulkEditSuccess | BulkEditFailure> {
	const { organization, body } = input
	const settingId = body.settingId as LocationSettingId
	const definition = getLocationSetting(settingId)

	const [records, policies, enabled] = await Promise.all([
		loadLocationRecords(organization),
		loadSettingPolicies(organization.id),
		enabledSettingIds(organization.id),
	])
	if (!enabled.has(settingId)) {
		return { ok: false, status: 400, error: 'setting_unavailable' }
	}
	const policy = policies.get(settingId)
	// A lock stops every way of changing the value at a location. Clearing the
	// override only moves a location onto the locked default, which is allowed.
	if (policy?.locked && body.change.kind !== 'clear') {
		return { ok: false, status: 409, error: 'setting_locked' }
	}

	const byId = new Map<string, LocationRecord>(records.map((r) => [r.id, r]))
	let typed: unknown
	let source: LocationRecord | undefined
	if (body.change.kind === 'value') {
		const parsed = definition.parse(body.change.value)
		if (!parsed.ok) return { ok: false, status: 400, error: 'invalid_value' }
		typed = parsed.value
	} else if (body.change.kind === 'match') {
		source = byId.get(body.change.sourceId)
		if (!source) return { ok: false, status: 404, error: 'source_not_found' }
		if (input.scope !== null && !input.scope.includes(source.id)) {
			return { ok: false, status: 403, error: 'location_not_allowed' }
		}
	}

	const requested = [...new Set(body.locationIds)]
	const known = requested.filter((id) => byId.has(id))
	const { allowed, denied } = partitionByScope(input.scope, known)
	const skipped: BulkEditSuccess['skipped'] = [
		...requested
			.filter((id) => !byId.has(id))
			.map((id) => ({
				locationId: id,
				name: null,
				reason: 'not_found' as const,
			})),
		...denied.map((id) => ({
			locationId: id,
			name: byId.get(id)!.name,
			reason: 'not_manageable' as const,
		})),
	]

	const views: BulkEditTargetView[] = []
	const patches: Array<{ locationId: string; patch: Record<string, unknown> }> =
		[]
	for (const id of allowed) {
		const target = byId.get(id)!
		const before = definition.read(target.row, target.ctx)
		const beforeText = definition.summarize(before, target.ctx)
		if (
			source &&
			definition.currencySensitive &&
			source.ctx.currency !== target.ctx.currency
		) {
			views.push({
				locationId: id,
				name: target.name,
				changed: false,
				before: beforeText,
				after: beforeText,
				skipped: 'currency_differs',
			})
			continue
		}
		const value =
			body.change.kind === 'value'
				? typed
				: body.change.kind === 'match'
					? definition.read(source!.row, source!.ctx)
					: policy
						? policy.defaultValue
						: definition.systemDefault(target.ctx)
		const patch = definition.write(target.row, value, target.ctx)
		const after = definition.read({ ...target.row, ...patch }, target.ctx)
		const changed = !settingValuesEqual(before, after)
		views.push({
			locationId: id,
			name: target.name,
			changed,
			before: beforeText,
			after: definition.summarize(after, target.ctx),
		})
		if (changed) patches.push({ locationId: id, patch })
	}

	const changedLocationIds = patches.map((entry) => entry.locationId)
	if (input.apply && patches.length > 0) {
		try {
			await commitLocationPatches(organization.id, patches)
		} catch (error) {
			console.error('bulk edit failed', {
				organizationId: organization.id,
				reason: error instanceof Error ? error.name : 'unknown',
			})
			return { ok: false, status: 500, error: 'copy_failed' }
		}
		await afterLocationSettingsWritten(organization)
		await auditLocationSettingEntries({
			organizationId: organization.id,
			userId: input.userId,
			request: input.request,
			entries: views
				.filter((view) => view.changed)
				.map((view) => ({
					action: AuditAction.LOCATION_SETTING_CHANGED,
					locationId: view.locationId,
					details: `Changed ${definition.label} in bulk`,
					metadata: {
						setting: settingId,
						mode: body.change.kind,
						...(source ? { sourceLocationId: source.id } : {}),
						bulkSize: allowed.length,
					},
				})),
		})
	}

	return {
		ok: true,
		applied: input.apply,
		settingId,
		targets: views,
		skipped,
		changedLocationIds: input.apply ? changedLocationIds : [],
	}
}

/**
 * The compare table: one setting across the locations the person may manage,
 * with whether each overrides the chain default.
 */
export type CompareRow = {
	locationId: string
	name: string
	isActive: boolean
	value: string
	/** The value as a canonical object, for the typed editors. */
	raw: unknown
	/** Differs from the chain default (only when the setting has one). */
	overridesDefault: boolean
}

export async function loadCompareRows(input: {
	organization: OrganizationForSettings
	scope: string[] | null
	settingId: LocationSettingId
}): Promise<{
	rows: CompareRow[]
	hiddenCount: number
	defaultText: string | null
	locked: boolean
	lockReason: string | null
}> {
	const [records, policies] = await Promise.all([
		loadLocationRecords(input.organization),
		loadSettingPolicies(input.organization.id),
	])
	const definition = getLocationSetting(input.settingId)
	const policy = policies.get(input.settingId)
	const visible = records.filter(
		(record) => input.scope === null || input.scope.includes(record.id),
	)
	const sampleCtx = visible[0]?.ctx ?? { currency: 'USD' }
	return {
		rows: visible.map((record) => {
			const raw = definition.read(record.row, record.ctx)
			return {
				locationId: record.id,
				name: record.name,
				isActive: record.isActive,
				value: definition.summarize(raw, record.ctx),
				raw,
				overridesDefault: overridesOf(record, policies).includes(
					input.settingId,
				),
			}
		}),
		hiddenCount: records.length - visible.length,
		defaultText: policy
			? definition.summarize(policy.defaultValue, sampleCtx)
			: null,
		locked: policy?.locked ?? false,
		lockReason: policy?.lockReason ?? null,
	}
}

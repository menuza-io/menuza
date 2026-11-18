import { createId } from '@paralleldrive/cuid2'
import { AuditAction } from '@repo/audit'
import {
	addHolidayToLocation,
	mergeLocationSettings,
	type CopyTargetResult,
	type CopyNote,
	type CopySkipReason,
} from '@repo/common/location-settings-copy'
import {
	getLocationSetting,
	LOCATION_SETTING_IDS,
	type LocationSettingId,
} from '@repo/common/location-settings-registry'
import { z } from 'zod'
import {
	afterLocationSettingsWritten,
	auditLocationSettingEntries,
	commitLocationPatches,
	enabledSettingIds,
	loadLocationRecords,
	loadSettingPolicies,
	lockedAmong,
	type LocationRecord,
	type OrganizationForSettings,
	type SettingAuditEntry,
} from './location-settings.server.ts'
import { partitionByScope } from './member-scope.server.ts'

/** Most targets one request may name (more than any group has). */
export const MAX_COPY_TARGETS = 200

const idSchema = z.string().trim().min(1).max(64)
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)

export const copySettingsInputSchema = z.object({
	sourceId: idSchema,
	targetIds: z.array(idSchema).min(1).max(MAX_COPY_TARGETS),
	parts: z
		.array(z.enum(LOCATION_SETTING_IDS))
		.min(1)
		.max(LOCATION_SETTING_IDS.length),
	specialHours: z
		.object({
			mode: z.enum(['add', 'replace']),
			from: dateSchema.nullish(),
			to: dateSchema.nullish(),
		})
		.optional(),
})
export type CopySettingsInput = z.infer<typeof copySettingsInputSchema>

export const addHolidayInputSchema = z.object({
	targetIds: z.array(idSchema).min(1).max(MAX_COPY_TARGETS),
	date: dateSchema,
	isOpen: z.boolean(),
	slots: z
		.array(z.object({ start: timeSchema, end: timeSchema }))
		.max(4)
		.default([]),
	note: z.string().trim().max(200).optional(),
})
export type AddHolidayInput = z.infer<typeof addHolidayInputSchema>

export type SkippedLocation = {
	locationId: string
	name: string | null
	reason: 'not_manageable' | 'not_found'
}

export type CopyTargetView = {
	targetId: string
	targetName: string
	changed: boolean
	changes: Array<{
		part: LocationSettingId
		changed: boolean
		before: string
		after: string
		notes: CopyNote[]
		skipped?: CopySkipReason
	}>
}

export type CopyFailure = {
	ok: false
	status: 400 | 403 | 404 | 409 | 500
	error:
		| 'invalid_request'
		| 'location_not_allowed'
		| 'source_not_found'
		| 'setting_locked'
		| 'setting_unavailable'
		| 'copy_failed'
	/** For `setting_locked` and `setting_unavailable`: which settings. */
	settings?: LocationSettingId[]
}

export type CopySuccess = {
	ok: true
	applied: boolean
	sourceId: string
	targets: CopyTargetView[]
	skipped: SkippedLocation[]
	/** Locations that really changed (empty on a preview). */
	changedLocationIds: string[]
}

function splitTargets(
	records: ReadonlyMap<string, LocationRecord>,
	scope: string[] | null,
	requested: readonly string[],
	sourceId: string,
): { targets: LocationRecord[]; skipped: SkippedLocation[] } {
	const unique = [...new Set(requested)].filter((id) => id !== sourceId)
	const known = unique.filter((id) => records.has(id))
	const { allowed, denied } = partitionByScope(scope, known)
	return {
		targets: allowed.map((id) => records.get(id)!),
		skipped: [
			...unique
				.filter((id) => !records.has(id))
				.map((id) => ({
					locationId: id,
					name: null,
					reason: 'not_found' as const,
				})),
			...denied.map((id) => ({
				locationId: id,
				name: records.get(id)!.name,
				reason: 'not_manageable' as const,
			})),
		],
	}
}

function view(result: CopyTargetResult): CopyTargetView {
	return {
		targetId: result.targetId,
		targetName: result.targetName,
		changed: result.changed,
		changes: result.changes.map((change) => ({
			part: change.part,
			changed: change.changed,
			before: change.before,
			after: change.after,
			notes: change.notes,
			...(change.skipped ? { skipped: change.skipped } : {}),
		})),
	}
}

/**
 * Copies chosen settings from one location to others (`apply: true`) or shows
 * what would change (`apply: false`, the `preview-copy` intent): the same merge
 * produces both, so the preview is exactly what is written.
 *
 * Server rules: the source must be a location of this organization inside the
 * person's scope (`location_not_allowed` otherwise); targets outside the scope
 * or the organization are skipped and listed, never written; a locked setting
 * or one whose organization flag is off refuses the request; every target
 * changes in one database batch or none (`copy_failed`).
 */
export async function copyLocationSettings(input: {
	organization: OrganizationForSettings
	userId: string
	scope: string[] | null
	request: Request
	body: CopySettingsInput
	apply: boolean
}): Promise<CopySuccess | CopyFailure> {
	const { organization, body } = input
	const records = new Map(
		(await loadLocationRecords(organization)).map((r) => [r.id, r]),
	)
	const source = records.get(body.sourceId)
	if (!source) return { ok: false, status: 404, error: 'source_not_found' }
	if (input.scope !== null && !input.scope.includes(source.id)) {
		return { ok: false, status: 403, error: 'location_not_allowed' }
	}

	const parts = [...new Set(body.parts)]
	const [policies, enabled] = await Promise.all([
		loadSettingPolicies(organization.id),
		enabledSettingIds(organization.id),
	])
	const unavailable = parts.filter((part) => !enabled.has(part))
	if (unavailable.length > 0) {
		return {
			ok: false,
			status: 400,
			error: 'setting_unavailable',
			settings: unavailable,
		}
	}
	const locked = lockedAmong(policies, parts)
	if (locked.length > 0) {
		return { ok: false, status: 409, error: 'setting_locked', settings: locked }
	}

	const { targets, skipped } = splitTargets(
		records,
		input.scope,
		body.targetIds,
		source.id,
	)
	const results = targets.map((target) =>
		mergeLocationSettings(source, target, parts, {
			specialHours: body.specialHours,
			makeId: createId,
		}),
	)
	const changed = results.filter((result) => result.changed)

	if (!input.apply) {
		return {
			ok: true,
			applied: false,
			sourceId: source.id,
			targets: results.map(view),
			skipped,
			changedLocationIds: [],
		}
	}

	if (changed.length > 0) {
		try {
			await commitLocationPatches(
				organization.id,
				changed.map((result) => ({
					locationId: result.targetId,
					patch: result.patch,
				})),
			)
		} catch (error) {
			console.error('copy settings failed', {
				organizationId: organization.id,
				reason: error instanceof Error ? error.name : 'unknown',
			})
			return { ok: false, status: 500, error: 'copy_failed' }
		}
		await afterLocationSettingsWritten(organization)
		const entries: SettingAuditEntry[] = changed.flatMap((result) =>
			result.changedParts.map((part) => ({
				action: AuditAction.LOCATION_SETTING_COPIED,
				locationId: result.targetId,
				details: `Copied ${getLocationSetting(part).label} from ${source.name}`,
				metadata: {
					setting: part,
					sourceLocationId: source.id,
					parts,
				},
			})),
		)
		await auditLocationSettingEntries({
			organizationId: organization.id,
			userId: input.userId,
			request: input.request,
			entries,
		})
	}

	return {
		ok: true,
		applied: true,
		sourceId: source.id,
		targets: results.map(view),
		skipped,
		changedLocationIds: changed.map((result) => result.targetId),
	}
}

export type HolidaySuccess = {
	ok: true
	added: Array<{ locationId: string; name: string }>
	/** Locations that already had the date, left alone. */
	alreadyHadDate: Array<{ locationId: string; name: string }>
	skipped: SkippedLocation[]
}

/**
 * "Add holiday to all locations": one special-hours entry on every chosen
 * location the person may manage; one that already has the date is left alone.
 * One database batch, one activity log entry per location changed.
 */
export async function addHolidayToLocations(input: {
	organization: OrganizationForSettings
	userId: string
	scope: string[] | null
	request: Request
	body: AddHolidayInput
}): Promise<HolidaySuccess | CopyFailure> {
	const { organization, body } = input
	if (body.isOpen && body.slots.length === 0) {
		return { ok: false, status: 400, error: 'invalid_request' }
	}
	if (body.slots.some((slot) => slot.end <= slot.start)) {
		return { ok: false, status: 400, error: 'invalid_request' }
	}
	const records = new Map(
		(await loadLocationRecords(organization)).map((r) => [r.id, r]),
	)
	const { targets, skipped } = splitTargets(records, input.scope, body.targetIds, '')
	const holiday = {
		date: body.date,
		isOpen: body.isOpen,
		slots: body.isOpen ? body.slots : [],
		...(body.note ? { note: body.note } : {}),
	}
	const results = targets.map((target) =>
		addHolidayToLocation(target, holiday, createId),
	)
	const added = results.filter((result) => result.added)
	if (added.length > 0) {
		try {
			await commitLocationPatches(
				organization.id,
				added.map((result) => ({
					locationId: result.targetId,
					patch: result.patch,
				})),
			)
		} catch (error) {
			console.error('add holiday failed', {
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
			entries: added.map((result) => ({
				action: AuditAction.LOCATION_SETTING_CHANGED,
				locationId: result.targetId,
				details: `Added special hours for ${body.date}`,
				metadata: {
					setting: 'specialHours',
					holidayDate: body.date,
					isOpen: body.isOpen,
				},
			})),
		})
	}
	return {
		ok: true,
		added: added.map((result) => ({
			locationId: result.targetId,
			name: result.targetName,
		})),
		alreadyHadDate: results
			.filter((result) => !result.added)
			.map((result) => ({
				locationId: result.targetId,
				name: result.targetName,
			})),
		skipped,
	}
}

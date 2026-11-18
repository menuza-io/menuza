import { createId } from '@paralleldrive/cuid2'
import { AuditAction } from '@repo/audit'
import { locationTagNameKey } from '@repo/common/location-tags'
import {
	db,
	eq,
	OrganizationLocation,
	OrganizationLocationTag,
	OrganizationLocationTagLink,
} from '@repo/database'
import {
	afterLocationSettingsWritten,
	auditLocationSettingEntries,
	type OrganizationForSettings,
} from './location-settings.server.ts'
import {
	buildLocationsCsv,
	LOCATIONS_CSV_MAX_BYTES,
	planLocationsCsv,
	type CsvLocation,
	type LocationsCsvPlan,
} from './locations-csv.ts'
import { listLocationTags } from './tags.server.ts'

/** Rows per insert: D1 allows 100 bound parameters per statement. */
const INSERT_CHUNK = 30

async function loadCsvLocations(
	organizationId: string,
): Promise<CsvLocation[]> {
	const [rows, tags] = await Promise.all([
		db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				slug: OrganizationLocation.slug,
				phone: OrganizationLocation.phone,
				isActive: OrganizationLocation.isActive,
			})
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, organizationId)),
		listLocationTags(organizationId),
	])
	const tagNames = new Map<string, string[]>()
	for (const tag of tags) {
		for (const locationId of tag.locationIds) {
			tagNames.set(locationId, [...(tagNames.get(locationId) ?? []), tag.name])
		}
	}
	return rows
		.map((row) => ({ ...row, tags: tagNames.get(row.id) ?? [] }))
		.sort((a, b) => a.name.localeCompare(b.name))
}

/** The download: every location with its tags, ready to edit and upload again. */
export async function exportLocationsCsv(organizationId: string) {
	return buildLocationsCsv(await loadCsvLocations(organizationId))
}

export type LocationsCsvResult =
	| {
			ok: true
			applied: boolean
			plan: Extract<LocationsCsvPlan, { ok: true }>
	  }
	| {
			ok: false
			error:
				| 'too_large'
				| 'empty'
				| 'not_template'
				| 'too_many_rows'
				| 'tag_limit'
				| 'import_failed'
	  }

/**
 * Reads an uploaded locations file (`apply: false` previews it). A file with
 * even one bad row is refused whole: nothing is created or changed, and the
 * plan names each bad row. A good file is applied in one database batch.
 */
export async function importLocationsCsv(input: {
	organization: OrganizationForSettings
	userId: string
	request: Request
	text: string
	apply: boolean
}): Promise<LocationsCsvResult> {
	const { organization } = input
	if (input.text.length > LOCATIONS_CSV_MAX_BYTES) {
		return { ok: false, error: 'too_large' }
	}
	const [csvLocations, tags] = await Promise.all([
		loadCsvLocations(organization.id),
		listLocationTags(organization.id),
	])
	const plan = planLocationsCsv(
		input.text,
		new Map(csvLocations.map((location) => [location.id, location])),
		tags.map((tag) => tag.name),
	)
	if (!plan.ok) return { ok: false, error: plan.error }
	if (!input.apply || plan.problems.length > 0 || plan.changes.length === 0) {
		return { ok: true, applied: false, plan }
	}

	const tagIds = new Map(
		tags.map((tag) => [locationTagNameKey(tag.name), tag.id]),
	)
	const statements: unknown[] = []
	for (const name of plan.newTags) {
		const id = createId()
		tagIds.set(locationTagNameKey(name), id)
		statements.push(
			db.insert(OrganizationLocationTag).values({
				id,
				organizationId: organization.id,
				name,
				nameKey: locationTagNameKey(name),
			}),
		)
	}
	for (const change of plan.changes) {
		const set: Partial<typeof OrganizationLocation.$inferInsert> = {}
		if ('phone' in change.write) set.phone = change.write.phone ?? null
		if ('isActive' in change.write) set.isActive = change.write.isActive
		if (Object.keys(set).length > 0) {
			statements.push(
				db
					.update(OrganizationLocation)
					.set(set)
					.where(eq(OrganizationLocation.id, change.locationId)),
			)
		}
		if (change.write.tags) {
			statements.push(
				db
					.delete(OrganizationLocationTagLink)
					.where(eq(OrganizationLocationTagLink.locationId, change.locationId)),
			)
			const links = change.write.tags.map((name) => ({
				locationId: change.locationId,
				tagId: tagIds.get(locationTagNameKey(name))!,
			}))
			for (let i = 0; i < links.length; i += INSERT_CHUNK) {
				statements.push(
					db
						.insert(OrganizationLocationTagLink)
						.values(links.slice(i, i + INSERT_CHUNK)),
				)
			}
		}
	}
	try {
		await db.batch(
			statements as unknown as [(typeof statements)[number] & never],
		)
	} catch (error) {
		console.error('locations csv import failed', {
			organizationId: organization.id,
			reason: error instanceof Error ? error.name : 'unknown',
		})
		return { ok: false, error: 'import_failed' }
	}
	if (
		plan.changes.some(
			(change) => 'phone' in change.write || 'isActive' in change.write,
		)
	) {
		await afterLocationSettingsWritten(organization)
	}
	await auditLocationSettingEntries({
		organizationId: organization.id,
		userId: input.userId,
		request: input.request,
		entries: plan.changes.map((change) => ({
			action: change.write.tags
				? AuditAction.LOCATION_TAGS_ASSIGNED
				: AuditAction.LOCATION_SETTING_CHANGED,
			locationId: change.locationId,
			details: 'Locations file uploaded',
			metadata: { fields: change.fields, source: 'csv' },
		})),
	})
	return { ok: true, applied: true, plan }
}

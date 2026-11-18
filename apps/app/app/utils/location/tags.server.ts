import {
	validateLocationTagName,
	MAX_LOCATION_TAGS,
	type LocationTagNameError,
} from '@repo/common/location-tags'
import {
	and,
	asc,
	db,
	eq,
	OrganizationLocation,
	OrganizationLocationTag,
	OrganizationLocationTagLink,
} from '@repo/database'

/** Rows per insert: D1 allows 100 bound parameters per statement. */
const INSERT_CHUNK = 30

export type LocationTagRow = {
	id: string
	name: string
	/** Ids of the locations that carry it. */
	locationIds: string[]
}

export type TagError =
	| LocationTagNameError
	| 'duplicate'
	| 'limit_reached'
	| 'tag_not_found'
	| 'unknown_location'

/** The organization's tags with the locations each carries, by name. */
export async function listLocationTags(
	organizationId: string,
): Promise<LocationTagRow[]> {
	const [tags, links, locations] = await Promise.all([
		db
			.select({
				id: OrganizationLocationTag.id,
				name: OrganizationLocationTag.name,
			})
			.from(OrganizationLocationTag)
			.where(eq(OrganizationLocationTag.organizationId, organizationId))
			.orderBy(asc(OrganizationLocationTag.nameKey)),
		db
			.select({
				tagId: OrganizationLocationTagLink.tagId,
				locationId: OrganizationLocationTagLink.locationId,
			})
			.from(OrganizationLocationTagLink)
			.innerJoin(
				OrganizationLocationTag,
				and(
					eq(OrganizationLocationTag.id, OrganizationLocationTagLink.tagId),
					eq(OrganizationLocationTag.organizationId, organizationId),
				),
			),
		db
			.select({ id: OrganizationLocation.id })
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.organizationId, organizationId)),
	])
	const known = new Set(locations.map((row) => row.id))
	const byTag = new Map<string, string[]>()
	for (const link of links) {
		if (!known.has(link.locationId)) continue
		byTag.set(link.tagId, [...(byTag.get(link.tagId) ?? []), link.locationId])
	}
	return tags.map((tag) => ({
		...tag,
		locationIds: (byTag.get(tag.id) ?? []).sort(),
	}))
}

/** Tags of each location, for list columns and filters. */
export async function tagsByLocation(
	organizationId: string,
): Promise<Map<string, Array<{ id: string; name: string }>>> {
	const tags = await listLocationTags(organizationId)
	const result = new Map<string, Array<{ id: string; name: string }>>()
	for (const tag of tags) {
		for (const locationId of tag.locationIds) {
			result.set(locationId, [
				...(result.get(locationId) ?? []),
				{ id: tag.id, name: tag.name },
			])
		}
	}
	return result
}

export async function createLocationTag(
	organizationId: string,
	rawName: string,
): Promise<{ ok: true; id: string; name: string } | { ok: false; error: TagError }> {
	const parsed = validateLocationTagName(rawName)
	if (!parsed.ok) return parsed
	const existing = await db
		.select({
			id: OrganizationLocationTag.id,
			nameKey: OrganizationLocationTag.nameKey,
		})
		.from(OrganizationLocationTag)
		.where(eq(OrganizationLocationTag.organizationId, organizationId))
	if (existing.some((row) => row.nameKey === parsed.key)) {
		return { ok: false, error: 'duplicate' }
	}
	if (existing.length >= MAX_LOCATION_TAGS) {
		return { ok: false, error: 'limit_reached' }
	}
	const [row] = await db
		.insert(OrganizationLocationTag)
		.values({
			organizationId,
			name: parsed.name,
			nameKey: parsed.key,
		})
		.returning({ id: OrganizationLocationTag.id })
	return { ok: true, id: row!.id, name: parsed.name }
}

export async function renameLocationTag(
	organizationId: string,
	tagId: string,
	rawName: string,
): Promise<{ ok: true; name: string } | { ok: false; error: TagError }> {
	const parsed = validateLocationTagName(rawName)
	if (!parsed.ok) return parsed
	const tags = await db
		.select({
			id: OrganizationLocationTag.id,
			nameKey: OrganizationLocationTag.nameKey,
		})
		.from(OrganizationLocationTag)
		.where(eq(OrganizationLocationTag.organizationId, organizationId))
	if (!tags.some((row) => row.id === tagId)) {
		return { ok: false, error: 'tag_not_found' }
	}
	if (tags.some((row) => row.id !== tagId && row.nameKey === parsed.key)) {
		return { ok: false, error: 'duplicate' }
	}
	await db
		.update(OrganizationLocationTag)
		.set({ name: parsed.name, nameKey: parsed.key })
		.where(
			and(
				eq(OrganizationLocationTag.id, tagId),
				eq(OrganizationLocationTag.organizationId, organizationId),
			),
		)
	return { ok: true, name: parsed.name }
}

/** Deletes a tag; its links and every member grant of it go with it. */
export async function deleteLocationTag(
	organizationId: string,
	tagId: string,
): Promise<{ ok: true } | { ok: false; error: TagError }> {
	const deleted = await db
		.delete(OrganizationLocationTag)
		.where(
			and(
				eq(OrganizationLocationTag.id, tagId),
				eq(OrganizationLocationTag.organizationId, organizationId),
			),
		)
		.returning({ id: OrganizationLocationTag.id })
	return deleted.length > 0 ? { ok: true } : { ok: false, error: 'tag_not_found' }
}

/**
 * Replaces which locations carry a tag. Every id must be a location of this
 * organization. Used by the tag page; callers have already checked the person
 * may manage tags (head office only: a tag is a way to grant access).
 */
export async function setTagLocations(
	organizationId: string,
	tagId: string,
	locationIds: readonly string[],
): Promise<{ ok: true } | { ok: false; error: TagError }> {
	const [tag] = await db
		.select({ id: OrganizationLocationTag.id })
		.from(OrganizationLocationTag)
		.where(
			and(
				eq(OrganizationLocationTag.id, tagId),
				eq(OrganizationLocationTag.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!tag) return { ok: false, error: 'tag_not_found' }
	const owned = new Set(
		(
			await db
				.select({ id: OrganizationLocation.id })
				.from(OrganizationLocation)
				.where(eq(OrganizationLocation.organizationId, organizationId))
		).map((row) => row.id),
	)
	const wanted = [...new Set(locationIds)]
	if (!wanted.every((id) => owned.has(id))) {
		return { ok: false, error: 'unknown_location' }
	}
	await db.transaction(async (tx) => {
		await tx
			.delete(OrganizationLocationTagLink)
			.where(eq(OrganizationLocationTagLink.tagId, tagId))
		for (let i = 0; i < wanted.length; i += INSERT_CHUNK) {
			await tx.insert(OrganizationLocationTagLink).values(
				wanted
					.slice(i, i + INSERT_CHUNK)
					.map((locationId) => ({ locationId, tagId })),
			)
		}
	})
	return { ok: true }
}

/**
 * The names of the locations a tag covers, limited to the ones the person may
 * see (`scope`: `null` is every location). `null` when the tag is not one of
 * this organization's, so a made-up id changes nothing. Used to filter reports
 * by tag (#374): the browser's token already limits the data to the person's
 * locations, this only picks which of those to show.
 */
export async function locationNamesForTag(
	organizationId: string,
	tagId: string,
	scope: readonly string[] | null,
): Promise<string[] | null> {
	const tags = await listLocationTags(organizationId)
	const tag = tags.find((row) => row.id === tagId)
	if (!tag) return null
	const rows = await db
		.select({ id: OrganizationLocation.id, name: OrganizationLocation.name })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
	const inTag = new Set(tag.locationIds)
	return rows
		.filter((row) => inTag.has(row.id))
		.filter((row) => scope === null || scope.includes(row.id))
		.map((row) => row.name)
		.sort((a, b) => a.localeCompare(b))
}

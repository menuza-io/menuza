import {
	addTags,
	blocksArchive,
	canSetParent,
	chainRoot,
	MAX_BULK_ASSETS,
	type MediaLibraryError,
} from '@repo/common/media-library'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	isNotNull,
	isNull,
	sql,
	OrganizationMediaAsset,
	OrganizationMediaTag,
} from '@repo/database'
import { findMediaReferences } from './references.server.ts'
import { type MediaReferenceItem } from './references.ts'

/**
 * The organizing actions of the media library (#147): tags, archive, bulk
 * edits and photo versions. Every id is checked against the organization
 * first, so another organization's id is "not found", never touched.
 */

export type OrganizeFailure = {
	ok: false
	status: number
	error: MediaLibraryError | 'not_found' | 'invalid_request'
	/** Where the asset is used (`asset_in_use`). */
	references?: MediaReferenceItem[]
	assetId?: string
}

export type OrganizeResult<T extends object = object> =
	({ ok: true } & T) | OrganizeFailure

const notFound: OrganizeFailure = { ok: false, status: 404, error: 'not_found' }

/** D1 allows 100 bound parameters per statement. */
const ROWS_PER_INSERT = 20

export function parseAssetIds(raw: FormDataEntryValue[]): string[] | null {
	const ids = raw
		.flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
		.map((value) => value.trim())
		.filter(Boolean)
	const unique = [...new Set(ids)]
	if (unique.length === 0 || unique.length > MAX_BULK_ASSETS) return null
	return unique
}

/** The organization's assets among `ids`, or null when any id is foreign. */
async function ownedAssets(organizationId: string, ids: string[]) {
	const rows = await db
		.select({
			id: OrganizationMediaAsset.id,
			objectKey: OrganizationMediaAsset.objectKey,
			source: OrganizationMediaAsset.source,
			archivedAt: OrganizationMediaAsset.archivedAt,
		})
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				inArray(OrganizationMediaAsset.id, ids),
			),
		)
	return rows.length === ids.length ? rows : null
}

export async function tagsByAsset(assetIds: string[]) {
	const map = new Map<string, string[]>()
	for (let i = 0; i < assetIds.length; i += 90) {
		const chunk = assetIds.slice(i, i + 90)
		const rows = await db
			.select({
				assetId: OrganizationMediaTag.assetId,
				tag: OrganizationMediaTag.tag,
			})
			.from(OrganizationMediaTag)
			.where(inArray(OrganizationMediaTag.assetId, chunk))
			.orderBy(asc(OrganizationMediaTag.tag))
		for (const row of rows) {
			const list = map.get(row.assetId) ?? []
			list.push(row.tag)
			map.set(row.assetId, list)
		}
	}
	return map
}

/** Every tag used in the organization with how many assets carry it. */
export async function organizationTags(organizationId: string) {
	const rows = await db
		.select({
			tag: OrganizationMediaTag.tag,
			count: sql<number>`count(*)`,
		})
		.from(OrganizationMediaTag)
		.where(eq(OrganizationMediaTag.organizationId, organizationId))
		.groupBy(OrganizationMediaTag.tag)
		.orderBy(asc(OrganizationMediaTag.tag))
	return rows.map((row) => ({ tag: row.tag, count: Number(row.count) || 0 }))
}

async function insertTags(
	organizationId: string,
	rows: Array<{ assetId: string; tag: string }>,
) {
	for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
		await db
			.insert(OrganizationMediaTag)
			.values(
				rows.slice(i, i + ROWS_PER_INSERT).map((row) => ({
					...row,
					organizationId,
				})),
			)
			.onConflictDoNothing()
	}
}

/**
 * Adds tags to assets. Nothing is written unless every asset can take them
 * (`too_many_tags`), so a bulk add never half-applies.
 */
export async function addTagsToAssets(input: {
	organizationId: string
	assetIds: string[]
	tags: string[]
}): Promise<OrganizeResult<{ updated: number }>> {
	if (input.tags.length === 0) {
		return { ok: false, status: 400, error: 'invalid_request' }
	}
	if (!(await ownedAssets(input.organizationId, input.assetIds)))
		return notFound
	const current = await tagsByAsset(input.assetIds)
	const rows: Array<{ assetId: string; tag: string }> = []
	for (const assetId of input.assetIds) {
		const result = addTags(current.get(assetId) ?? [], input.tags)
		if (!result.ok) {
			return { ok: false, status: 400, error: result.error, assetId }
		}
		for (const tag of input.tags) {
			if (!(current.get(assetId) ?? []).includes(tag)) {
				rows.push({ assetId, tag })
			}
		}
	}
	await insertTags(input.organizationId, rows)
	return { ok: true, updated: input.assetIds.length }
}

export async function removeTagsFromAssets(input: {
	organizationId: string
	assetIds: string[]
	tags: string[]
}): Promise<OrganizationResultUpdated> {
	if (input.tags.length === 0) {
		return { ok: false, status: 400, error: 'invalid_request' }
	}
	if (!(await ownedAssets(input.organizationId, input.assetIds)))
		return notFound
	await db
		.delete(OrganizationMediaTag)
		.where(
			and(
				eq(OrganizationMediaTag.organizationId, input.organizationId),
				inArray(OrganizationMediaTag.assetId, input.assetIds),
				inArray(OrganizationMediaTag.tag, input.tags),
			),
		)
	return { ok: true, updated: input.assetIds.length }
}

type OrganizationResultUpdated = OrganizeResult<{ updated: number }>

/**
 * Archives assets: hidden from the library and every picker until restored.
 * A photo a dish uses, or the website shows, cannot be archived
 * (`asset_in_use`, with where). Archived assets still count toward storage.
 */
export async function archiveAssets(input: {
	organizationId: string
	orgSlug: string
	userId: string
	assetIds: string[]
}): Promise<OrganizeResult<{ updated: number }>> {
	const assets = await ownedAssets(input.organizationId, input.assetIds)
	if (!assets) return notFound
	for (const asset of assets) {
		const references = await findMediaReferences({
			organizationId: input.organizationId,
			orgSlug: input.orgSlug,
			userId: input.userId,
			asset,
		})
		const blocking = references.filter((reference) =>
			blocksArchive(reference.type),
		)
		if (blocking.length > 0) {
			return {
				ok: false,
				status: 409,
				error: 'asset_in_use',
				references: blocking,
				assetId: asset.id,
			}
		}
	}
	await db
		.update(OrganizationMediaAsset)
		.set({ archivedAt: new Date() })
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, input.organizationId),
				inArray(OrganizationMediaAsset.id, input.assetIds),
				isNull(OrganizationMediaAsset.archivedAt),
			),
		)
	return { ok: true, updated: input.assetIds.length }
}

export async function restoreAssets(input: {
	organizationId: string
	assetIds: string[]
}): Promise<OrganizeResult<{ updated: number }>> {
	if (!(await ownedAssets(input.organizationId, input.assetIds)))
		return notFound
	await db
		.update(OrganizationMediaAsset)
		.set({ archivedAt: null })
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, input.organizationId),
				inArray(OrganizationMediaAsset.id, input.assetIds),
				isNotNull(OrganizationMediaAsset.archivedAt),
			),
		)
	return { ok: true, updated: input.assetIds.length }
}

/** Alt text for several assets at once (an empty string clears it). */
export async function setAltTextForAssets(input: {
	organizationId: string
	assetIds: string[]
	altText: string
}): Promise<OrganizeResult<{ updated: number }>> {
	if (!(await ownedAssets(input.organizationId, input.assetIds)))
		return notFound
	await db
		.update(OrganizationMediaAsset)
		.set({ altText: input.altText.trim().slice(0, 500) || null })
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, input.organizationId),
				inArray(OrganizationMediaAsset.id, input.assetIds),
			),
		)
	return { ok: true, updated: input.assetIds.length }
}

/** The current original of every asset that has one, for loop checks. */
async function parentMap(organizationId: string) {
	const rows = await db
		.select({
			id: OrganizationMediaAsset.id,
			parentAssetId: OrganizationMediaAsset.parentAssetId,
		})
		.from(OrganizationMediaAsset)
		.where(eq(OrganizationMediaAsset.organizationId, organizationId))
	return new Map(rows.map((row) => [row.id, row.parentAssetId]))
}

/**
 * Links an asset to its original (a studio edit, a generated clip), or clears
 * the link. The original must be in the same organization, an asset cannot be
 * its own original, and a chain never loops (`invalid_parent`).
 */
export async function setAssetParent(input: {
	organizationId: string
	assetId: string
	parentAssetId: string | null
}): Promise<OrganizeResult<{ parentAssetId: string | null }>> {
	const ids = [input.assetId]
	if (input.parentAssetId) ids.push(input.parentAssetId)
	if (!(await ownedAssets(input.organizationId, [...new Set(ids)]))) {
		// A foreign or unknown original is "not found", like any other id.
		if (input.parentAssetId === input.assetId) {
			return { ok: false, status: 400, error: 'invalid_parent' }
		}
		return notFound
	}
	const parents = await parentMap(input.organizationId)
	if (!canSetParent(input.assetId, input.parentAssetId, parents)) {
		return { ok: false, status: 400, error: 'invalid_parent' }
	}
	await db
		.update(OrganizationMediaAsset)
		.set({ parentAssetId: input.parentAssetId })
		.where(
			and(
				eq(OrganizationMediaAsset.id, input.assetId),
				eq(OrganizationMediaAsset.organizationId, input.organizationId),
			),
		)
	return { ok: true, parentAssetId: input.parentAssetId }
}

/** Whether `parentAssetId` may be the original of a new asset, before it exists. */
export async function checkNewAssetParent(
	organizationId: string,
	parentAssetId: string,
): Promise<OrganizeResult> {
	if (!(await ownedAssets(organizationId, [parentAssetId]))) return notFound
	return { ok: true }
}

/** Versions panel: the chain's original and every edit of it, newest last. */
export async function assetVersions(input: {
	organizationId: string
	assetId: string
}) {
	const rows = await db
		.select({
			id: OrganizationMediaAsset.id,
			parentAssetId: OrganizationMediaAsset.parentAssetId,
			fileName: OrganizationMediaAsset.fileName,
			altText: OrganizationMediaAsset.altText,
			source: OrganizationMediaAsset.source,
			status: OrganizationMediaAsset.status,
			archivedAt: OrganizationMediaAsset.archivedAt,
			createdAt: OrganizationMediaAsset.createdAt,
			updatedAt: OrganizationMediaAsset.updatedAt,
		})
		.from(OrganizationMediaAsset)
		.where(eq(OrganizationMediaAsset.organizationId, input.organizationId))
	const byId = new Map(rows.map((row) => [row.id, row]))
	if (!byId.has(input.assetId)) return null
	const parents = new Map(rows.map((row) => [row.id, row.parentAssetId]))
	const rootId = chainRoot(input.assetId, parents)
	const members = new Set<string>([rootId])
	let grew = true
	while (grew) {
		grew = false
		for (const row of rows) {
			if (
				row.parentAssetId &&
				members.has(row.parentAssetId) &&
				!members.has(row.id)
			) {
				members.add(row.id)
				grew = true
			}
		}
	}
	const serialize = (id: string) => {
		const row = byId.get(id)!
		return {
			id: row.id,
			parentAssetId: row.parentAssetId,
			fileName: row.fileName,
			altText: row.altText,
			source: row.source,
			status: row.status,
			archived: row.archivedAt !== null,
			createdAt: row.createdAt.toISOString(),
			url: `/resources/images?mediaId=${encodeURIComponent(row.id)}&v=${row.updatedAt.getTime()}`,
		}
	}
	const original = serialize(rootId)
	const versions = [...members]
		.filter((id) => id !== rootId)
		.map(serialize)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
	return { original, versions, current: input.assetId }
}

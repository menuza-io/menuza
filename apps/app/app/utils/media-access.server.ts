import { getUserId } from '@repo/auth'
import { db, eq, OrganizationMediaAsset } from '@repo/database'
import { isActiveOrganizationMember } from './org-membership.server.ts'

const PUBLIC_MEDIA_SOURCES = new Set([
	'organization-logo',
	'site-icon',
	'website-seo',
	'website-asset',
])

/** Platform-scoped assets and organization branding assets are public. */
export function isPublicMediaAsset(asset: {
	storageScope: string
	source: string
}) {
	return (
		asset.storageScope === 'platform' || PUBLIC_MEDIA_SOURCES.has(asset.source)
	)
}

/** Throws 401/403 unless the signed-in user is an active member of the organization. */
export async function requireOrganizationMember(
	request: Request,
	organizationId: string,
) {
	const userId = await getUserId(request)
	if (!userId) throw new Response('Unauthorized', { status: 401 })
	if (!(await isActiveOrganizationMember(userId, organizationId))) {
		throw new Response('Forbidden', { status: 403 })
	}
	return userId
}

/**
 * Authorizes a direct read of a stored object by key. Registered public assets
 * are open; registered private assets need active organization membership.
 * Returns the storage scope to sign with, taken from the registered asset,
 * never the query. `objectKey` is only unique per organization in the schema,
 * so every row for the key is considered and any private row requires
 * membership (the strictest row wins).
 */
export async function authorizeRegisteredObject(
	request: Request,
	objectKey: string,
) {
	const assets = await db
		.select({
			organizationId: OrganizationMediaAsset.organizationId,
			storageScope: OrganizationMediaAsset.storageScope,
			source: OrganizationMediaAsset.source,
		})
		.from(OrganizationMediaAsset)
		.where(eq(OrganizationMediaAsset.objectKey, objectKey))
	if (assets.length === 0) return null

	const privateAssets = assets.filter((asset) => !isPublicMediaAsset(asset))
	for (const asset of privateAssets) {
		await requireOrganizationMember(request, asset.organizationId)
	}
	const scoped = privateAssets[0] ?? assets[0]!
	return {
		isPublic: privateAssets.length === 0,
		organizationId:
			scoped.storageScope === 'organization' ? scoped.organizationId : null,
	}
}

/**
 * Object keys follow a contract (see packages/storage upload-helpers):
 * `orgs/<organizationId>/...` is private organization content (notes,
 * comments, library), `org/<organizationId>/...` is public site branding and
 * `users/<userId>/...` is an avatar. For a key that is not a registered asset
 * the owning organization is derived from the key itself, never from a query
 * parameter the caller controls.
 */
export function privateOrganizationIdFromObjectKey(objectKey: string) {
	return /^orgs\/([^/]+)\//.exec(objectKey)?.[1] ?? null
}

/**
 * Note videos (and their thumbnails) are rendered by Cloudflare Media
 * Transformations, which fetches the source URL without the viewer's cookies,
 * so they cannot be membership-gated here. Their keys carry the note and upload
 * ids and are only ever shown to members; a signed-URL scheme is the follow-up.
 */
export function noteVideoOrganizationId(objectKey: string) {
	return /^orgs\/([^/]+)\/notes\/[^/]+\/videos\//.exec(objectKey)?.[1] ?? null
}

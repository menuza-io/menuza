import { userHasOrganizationPermission } from '@repo/auth'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { parseMenuItemImageKeys } from '@repo/common/menu-types'
import {
	parseSiteLocalesConfig,
	pickLocalized,
} from '@repo/common/site-locales'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	MenuCheckDismissal,
	Organization,
	OrganizationMediaAsset,
	OrganizationMenuCategory,
	OrganizationMenuItem,
	OrganizationMenuItemCategoryAssignment,
} from '@repo/database'
import { detectRasterImage } from '@repo/storage'
import { isMediaFlagOn, MEDIA_FLAG_KEYS } from '#app/utils/media/media-flags.ts'
import { wakePhotoQualityWorkflow } from '#app/utils/media/photo-quality.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { uploadOrganizationMediaImage } from '#app/utils/storage.server.ts'
import {
	dishPhotoAssetUrl,
	findLibraryAssetByKey,
	posPhotoOwnedItemIds,
	readDishPhotoStates,
	replaceDishMainPhoto,
} from './dish-photo.server.ts'
import { sanitizeCleanDishImageBytes } from './guest-photos.server.ts'

/**
 * Menu photos taken on the operator phone (#222). The phone app lists the dishes
 * that have no photo and uploads one per dish; these helpers back the
 * `/api/menu/photos` routes. Permission is the dish form's own,
 * `update:menu:any` (org-wide: location scope does not apply to menu edits on
 * the web either). A photo is attached through `replaceDishMainPhoto`, so the
 * old photo stays in the library as a version (#147) and every channel follows.
 */

export const PHONE_PHOTO_MAX_BYTES = 10 * 1024 * 1024
export const PHONE_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const PHONE_PHOTO_LIST_MAX = 200

export async function memberMayEditMenu(
	userId: string,
	organizationId: string,
) {
	return userHasOrganizationPermission(
		userId,
		organizationId,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)
}

export type PhoneDish = {
	id: string
	name: string
	categoryName: string | null
	hasPhoto: boolean
	imageUrl: string | null
}

export async function listPhoneDishes(input: {
	organizationId: string
	query?: string
	limit?: number
	origin: string
}): Promise<{ missingCount: number; items: PhoneDish[] }> {
	const limit = Math.min(Math.max(input.limit ?? 100, 1), PHONE_PHOTO_LIST_MAX)
	const [organization] = await db
		.select({
			siteLocales: Organization.siteLocales,
			siteDefaultLocale: Organization.siteDefaultLocale,
		})
		.from(Organization)
		.where(eq(Organization.id, input.organizationId))
		.limit(1)
	const { defaultLocale } = parseSiteLocalesConfig(
		organization?.siteLocales ?? null,
		organization?.siteDefaultLocale ?? null,
	)

	const items = await db
		.select({
			id: OrganizationMenuItem.id,
			displayName: OrganizationMenuItem.displayName,
			imageKey: OrganizationMenuItem.imageKey,
			imageUrl: OrganizationMenuItem.imageUrl,
			imageKeys: OrganizationMenuItem.imageKeys,
			isPopular: OrganizationMenuItem.isPopular,
			availabilityStatus: OrganizationMenuItem.availabilityStatus,
			createdAt: OrganizationMenuItem.createdAt,
		})
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.organizationId, input.organizationId))
		.orderBy(asc(OrganizationMenuItem.createdAt))
	const visible = items.filter((item) => item.availabilityStatus !== 'hidden')

	const [owned, dismissed, categoryRows] = await Promise.all([
		posPhotoOwnedItemIds(input.organizationId),
		db
			.select({ id: MenuCheckDismissal.entityId })
			.from(MenuCheckDismissal)
			.where(
				and(
					eq(MenuCheckDismissal.organizationId, input.organizationId),
					eq(MenuCheckDismissal.checkKey, 'no_photo'),
				),
			),
		db
			.select({
				itemId: OrganizationMenuItemCategoryAssignment.itemId,
				categoryName: OrganizationMenuCategory.displayName,
				categoryPosition: OrganizationMenuCategory.position,
				position: OrganizationMenuItemCategoryAssignment.position,
			})
			.from(OrganizationMenuItemCategoryAssignment)
			.innerJoin(
				OrganizationMenuCategory,
				eq(
					OrganizationMenuCategory.id,
					OrganizationMenuItemCategoryAssignment.categoryId,
				),
			)
			.where(eq(OrganizationMenuCategory.organizationId, input.organizationId)),
	])
	const dismissedIds = new Set(dismissed.map((row) => row.id))
	const categoryOf = new Map<string, { name: string | null; order: number }>()
	for (const row of categoryRows) {
		const order = (row.categoryPosition ?? 0) * 10_000 + (row.position ?? 0)
		const current = categoryOf.get(row.itemId)
		if (!current || order < current.order) {
			categoryOf.set(row.itemId, {
				name: pickLocalized(row.categoryName, defaultLocale, defaultLocale),
				order,
			})
		}
	}

	const hasPhoto = (item: (typeof visible)[number]) =>
		Boolean(item.imageKey?.trim() || item.imageUrl?.trim()) ||
		parseMenuItemImageKeys(item.imageKeys, null).length > 0

	const query = input.query?.trim().toLowerCase()
	const shape = (item: (typeof visible)[number]): PhoneDish => ({
		id: item.id,
		name: pickLocalized(item.displayName, defaultLocale, defaultLocale),
		categoryName: categoryOf.get(item.id)?.name ?? null,
		hasPhoto: hasPhoto(item),
		imageUrl: null,
	})

	if (query) {
		const matches = visible
			.filter((item) => !owned.has(item.id))
			.filter((item) => {
				// Any language the dish has a name in.
				try {
					const names = Object.values(
						JSON.parse(item.displayName) as Record<string, string>,
					)
					return names.some(
						(name) =>
							typeof name === 'string' && name.toLowerCase().includes(query),
					)
				} catch {
					return item.displayName.toLowerCase().includes(query)
				}
			})
			.slice(0, limit)
		const urls = await thumbnailUrls(
			input.organizationId,
			matches,
			input.origin,
		)
		return {
			missingCount: 0,
			items: matches.map((item) => ({
				...shape(item),
				imageUrl: urls.get(item.id) ?? null,
			})),
		}
	}

	const missing = visible
		.filter(
			(item) =>
				!hasPhoto(item) && !owned.has(item.id) && !dismissedIds.has(item.id),
		)
		.sort(
			(a, b) =>
				// Best sellers first (the daily popular badge is computed from sales),
				// then the menu's own order.
				Number(b.isPopular) - Number(a.isPopular) ||
				(categoryOf.get(a.id)?.order ?? Number.MAX_SAFE_INTEGER) -
					(categoryOf.get(b.id)?.order ?? Number.MAX_SAFE_INTEGER) ||
				a.createdAt.getTime() - b.createdAt.getTime(),
		)
	return {
		missingCount: missing.length,
		items: missing.slice(0, limit).map(shape),
	}
}

async function thumbnailUrls(
	organizationId: string,
	items: Array<{
		id: string
		imageKey: string | null
		imageKeys: string
	}>,
	origin: string,
) {
	const primary = new Map<string, string>()
	for (const item of items) {
		const key = parseMenuItemImageKeys(item.imageKeys, item.imageKey)[0]
		if (key) primary.set(item.id, key)
	}
	const keys = [...new Set(primary.values())].slice(0, 90)
	const urls = new Map<string, string>()
	if (keys.length === 0) return urls
	const assets = await db
		.select({
			id: OrganizationMediaAsset.id,
			objectKey: OrganizationMediaAsset.objectKey,
			updatedAt: OrganizationMediaAsset.updatedAt,
		})
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				inArray(OrganizationMediaAsset.objectKey, keys),
			),
		)
	const byKey = new Map(assets.map((asset) => [asset.objectKey, asset]))
	for (const [itemId, key] of primary) {
		const asset = byKey.get(key)
		if (asset) {
			urls.set(
				itemId,
				`${origin}${dishPhotoAssetUrl(asset)}&w=240&h=240&fit=cover`,
			)
		}
	}
	return urls
}

export type PhonePhotoError =
	| 'not_found'
	| 'forbidden_pos'
	| 'unsupported_media_type'
	| 'payload_too_large'
	| 'failed'

/**
 * Attaches one phone photo to a dish. Idempotent per `clientId`: the file name
 * is derived from it, so a retry after a dropped answer finds the first
 * upload instead of storing a second copy. Metadata (EXIF, GPS, XMP) is
 * stripped here too, whatever the phone did.
 */
export async function attachPhonePhoto(input: {
	organization: { id: string; slug: string }
	userId: string
	request?: Request
	itemId: string
	clientId: string
	bytes: Uint8Array
	declaredType: string
}): Promise<
	| { ok: true; itemId: string; assetId: string; imageUrl: string }
	| { ok: false; error: PhonePhotoError }
> {
	const { organization } = input
	if (
		input.bytes.byteLength === 0 ||
		input.bytes.byteLength > PHONE_PHOTO_MAX_BYTES
	) {
		return { ok: false, error: 'payload_too_large' }
	}
	if (!PHONE_PHOTO_TYPES.includes(input.declaredType)) {
		return { ok: false, error: 'unsupported_media_type' }
	}
	// What the bytes really are, not what the phone said.
	const copy = new Uint8Array(input.bytes.byteLength)
	copy.set(input.bytes)
	const detected = detectRasterImage(copy.buffer)
	if (!detected || !PHONE_PHOTO_TYPES.includes(detected.mimeType)) {
		return { ok: false, error: 'unsupported_media_type' }
	}

	const states = await readDishPhotoStates(organization.id, [input.itemId])
	const state = states.get(input.itemId)
	if (!state) return { ok: false, error: 'not_found' }
	if ((await posPhotoOwnedItemIds(organization.id)).has(input.itemId)) {
		return { ok: false, error: 'forbidden_pos' }
	}

	const extension = detected.extension === 'jpg' ? 'jpg' : detected.extension
	const fileName = `phone-${input.clientId}.${extension}`
	const [existing] = await db
		.select()
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organization.id),
				eq(OrganizationMediaAsset.source, 'phone'),
				eq(OrganizationMediaAsset.fileName, fileName),
			),
		)
		.limit(1)

	let asset = existing ?? null
	if (!asset) {
		const clean = sanitizeCleanDishImageBytes(input.bytes)
		if (!clean) return { ok: false, error: 'unsupported_media_type' }
		const cleanCopy = new Uint8Array(clean.bytes.byteLength)
		cleanCopy.set(clean.bytes)
		const file = new File([cleanCopy.buffer], fileName, {
			type: clean.mimeType,
		})
		let objectKey: string
		try {
			objectKey = await uploadOrganizationMediaImage(
				organization.id,
				file,
				input.userId,
				'phone',
			)
		} catch (error) {
			console.error('Phone photo upload failed:', error)
			return { ok: false, error: 'failed' }
		}
		asset = await findLibraryAssetByKey(organization.id, objectKey)
		if (!asset) return { ok: false, error: 'failed' }
	}

	// A retry of a photo that is already on the dish changes nothing.
	if (!state.imageKeys.includes(asset.objectKey)) {
		const result = await replaceDishMainPhoto({
			organization,
			userId: input.userId,
			request: input.request,
			itemId: input.itemId,
			asset,
			details: 'Added a dish photo from the operator phone app',
			metadata: { source: 'phone' },
		})
		if (!result.ok) {
			return {
				ok: false,
				error: result.error === 'not_found' ? 'not_found' : 'failed',
			}
		}
	}

	// Scored like any other upload (#145); best effort, the hourly sweep follows.
	if (
		isMediaFlagOn(
			await getFeatureFlag(MEDIA_FLAG_KEYS.photoQuality, {
				organizationId: organization.id,
			}),
		)
	) {
		void wakePhotoQualityWorkflow(organization.id)
	}
	return {
		ok: true,
		itemId: input.itemId,
		assetId: asset.id,
		imageUrl: dishPhotoAssetUrl(asset),
	}
}

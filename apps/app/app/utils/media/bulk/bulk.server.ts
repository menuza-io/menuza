import {
	BULK_PHOTO_ALLOWED_TYPES,
	BULK_PHOTO_MAX_FILES,
	checkBulkPhotoPairs,
	proposeBulkPhotoMatches,
	type BulkPhotoFlag,
	type BulkPhotoInput,
	type MatchDish,
} from '@repo/common/dish-photo-match'
import { parseMenuItemImageKeys } from '@repo/common/menu-types'
import {
	parseLocalizedString,
	parseSiteLocalesConfig,
	pickLocalized,
} from '@repo/common/site-locales'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	isNull,
	OrganizationMediaAsset,
	OrganizationMenuItem,
} from '@repo/database'
import { z } from 'zod'
import {
	dishPhotoAssetUrl,
	readDishPhotoStates,
	replaceDishMainPhotosBatch,
	type DishPhotoError,
} from '#app/utils/menu/dish-photo.server.ts'
import {
	checkRateLimit,
	type RateLimitConfig,
} from '#app/utils/rate-limit.server.ts'
import { readStoredMediaImage } from '../photo-studio.server.ts'
import {
	type BulkDishChoice,
	type BulkProposeResult,
	type BulkProposedPhoto,
} from './types.ts'
import {
	BULK_VISION_MAX_DISH_NAMES,
	BULK_VISION_MAX_IMAGES,
	type DishPhotoVision,
	type DishPhotoVisionResult,
} from './vision.server.ts'

/**
 * Bulk dish photos (#316), server side. `proposeBulkPhotos` reads the uploaded
 * library photos and the menu and returns proposals; it never writes to a
 * dish. `applyBulkPhotos` attaches the pairs the operator confirmed in one
 * `db.batch` through `replaceDishMainPhotosBatch`.
 */

/** Images a model may look at per organization per hour. */
export const BULK_MATCH_RATE_LIMIT: RateLimitConfig = {
	scope: 'media-bulk-match',
	maxRequests: process.env.NODE_ENV === 'development' ? 3000 : 300,
	windowMs: 60 * 60 * 1000,
}

const CHUNK = 80
const VISION_CONCURRENCY = 4

export const proposeInputSchema = z.object({
	assetIds: z.array(z.string().min(1).max(64)).min(1).max(BULK_PHOTO_MAX_FILES),
	hashes: z.record(z.string().max(64), z.string().max(128)).optional(),
})

export const applyInputSchema = z.object({
	pairs: z
		.array(
			z.object({
				assetId: z.string().min(1).max(64),
				itemId: z.string().min(1).max(64),
				replace: z.boolean(),
				/** The dish's main photo as the reviewer saw it (null: none). */
				sourceKey: z.string().max(512).nullable().optional(),
			}),
		)
		.min(1)
		.max(BULK_PHOTO_MAX_FILES),
})

type Limiter = (organizationId: string) => Promise<boolean>

async function defaultLimiter(organizationId: string) {
	const result = await checkRateLimit(
		{ type: 'org', value: organizationId },
		BULK_MATCH_RATE_LIMIT,
	)
	return result.allowed
}

function chunks<T>(list: readonly T[]): T[][] {
	const out: T[][] = []
	for (let i = 0; i < list.length; i += CHUNK)
		out.push(list.slice(i, i + CHUNK))
	return out
}

async function runLimited<T, R>(
	items: readonly T[],
	limit: number,
	work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = Array.from<R>({ length: items.length })
	let next = 0
	async function worker() {
		while (next < items.length) {
			const index = next++
			results[index] = await work(items[index]!, index)
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => worker()),
	)
	return results
}

/** A dish has a photo when it has a stored key or a baked URL. */
export function dishHasPhoto(row: {
	imageKey: string | null
	imageUrl: string | null
	imageKeys: string | null
}) {
	return (
		parseMenuItemImageKeys(row.imageKeys, row.imageKey).length > 0 ||
		Boolean(row.imageUrl)
	)
}

export async function loadReadyImageAssets(
	organizationId: string,
	assetIds: readonly string[],
) {
	const rows: Array<typeof OrganizationMediaAsset.$inferSelect> = []
	for (const part of chunks(assetIds)) {
		rows.push(
			...(await db
				.select()
				.from(OrganizationMediaAsset)
				.where(
					and(
						eq(OrganizationMediaAsset.organizationId, organizationId),
						inArray(OrganizationMediaAsset.id, part),
						eq(OrganizationMediaAsset.status, 'ready'),
						isNull(OrganizationMediaAsset.archivedAt),
					),
				)),
		)
	}
	const byId = new Map(
		rows
			.filter((row) =>
				(BULK_PHOTO_ALLOWED_TYPES as readonly string[]).includes(row.mimeType),
			)
			.map((row) => [row.id, row]),
	)
	// The caller's order, each id once.
	return [...new Set(assetIds)].flatMap((id) => {
		const row = byId.get(id)
		return row ? [row] : []
	})
}

/** `fileName|fileSize` of library files that are not part of this batch. */
async function existingFileKeys(
	organizationId: string,
	batchIds: ReadonlySet<string>,
	fileNames: readonly string[],
) {
	const keys = new Set<string>()
	for (const part of chunks([...new Set(fileNames)])) {
		const rows = await db
			.select({
				id: OrganizationMediaAsset.id,
				fileName: OrganizationMediaAsset.fileName,
				fileSize: OrganizationMediaAsset.fileSize,
			})
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, organizationId),
					inArray(OrganizationMediaAsset.fileName, part),
				),
			)
		for (const row of rows) {
			if (batchIds.has(row.id) || !row.fileName || !row.fileSize) continue
			keys.add(`${row.fileName}|${row.fileSize}`)
		}
	}
	return keys
}

export async function proposeBulkPhotos(input: {
	organization: {
		id: string
		siteLocales?: string | null
		siteDefaultLocale?: string | null
	}
	assetIds: readonly string[]
	hashes?: Record<string, string>
	/** `null`: no model set up, match by file name only. */
	vision: DishPhotoVision | null
	limiter?: Limiter
}): Promise<BulkProposeResult> {
	const { organization } = input
	const assets = await loadReadyImageAssets(organization.id, input.assetIds)
	const ignoredAssetIds = [...new Set(input.assetIds)].filter(
		(id) => !assets.some((asset) => asset.id === id),
	)

	const { defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales ?? null,
		organization.siteDefaultLocale ?? null,
	)
	const dishRows = await db
		.select({
			id: OrganizationMenuItem.id,
			displayName: OrganizationMenuItem.displayName,
			internalName: OrganizationMenuItem.internalName,
			imageKey: OrganizationMenuItem.imageKey,
			imageUrl: OrganizationMenuItem.imageUrl,
			imageKeys: OrganizationMenuItem.imageKeys,
		})
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.organizationId, organization.id))
		.orderBy(asc(OrganizationMenuItem.position), asc(OrganizationMenuItem.id))
	const dishes = dishRows.map((row) => {
		const names = new Set<string>()
		for (const value of Object.values(parseLocalizedString(row.displayName))) {
			if (value?.trim()) names.add(value.trim())
		}
		if (row.internalName?.trim()) names.add(row.internalName.trim())
		const name =
			pickLocalized(row.displayName, defaultLocale, defaultLocale).trim() ||
			[...names][0] ||
			''
		return {
			id: row.id,
			name,
			names: [...names],
			hasPhoto: dishHasPhoto(row),
			imageUrl: row.imageUrl,
		}
	})
	const matchDishes: MatchDish[] = dishes.map((dish) => ({
		id: dish.id,
		names: dish.names,
		hasPhoto: dish.hasPhoto,
	}))

	// The model looks at each photo (a hard cap of 100 and an hourly budget).
	const vision = input.vision
	const limiter = input.limiter ?? defaultLimiter
	const dishNames = dishes
		.map((dish) => dish.name)
		.filter(Boolean)
		.slice(0, BULK_VISION_MAX_DISH_NAMES)
	let visionLimited = false
	let visionBudgetOpen = true
	const visionResults = new Map<string, DishPhotoVisionResult | null>()
	if (vision) {
		const targets = assets.slice(0, BULK_VISION_MAX_IMAGES)
		await runLimited(targets, VISION_CONCURRENCY, async (asset) => {
			// Only a real model costs credits; the emulator is free.
			if (vision.name === 'model') {
				if (!visionBudgetOpen || !(await limiter(organization.id))) {
					visionBudgetOpen = false
					visionLimited = true
					return
				}
			}
			try {
				const image = await readStoredMediaImage(asset)
				visionResults.set(
					asset.id,
					await vision.describe(image, {
						dishNames,
						fileName: asset.fileName,
					}),
				)
			} catch {
				// An unreadable or unsupported image is simply unscored.
				visionResults.set(asset.id, null)
			}
		})
	}

	const batchIds = new Set(assets.map((asset) => asset.id))
	const existing = await existingFileKeys(
		organization.id,
		batchIds,
		assets.flatMap((asset) => (asset.fileName ? [asset.fileName] : [])),
	)

	const inputs: BulkPhotoInput[] = assets.map((asset) => {
		const seen = visionResults.get(asset.id)
		return {
			assetId: asset.id,
			fileName: asset.fileName,
			width: asset.width,
			height: asset.height,
			contentHash: input.hashes?.[asset.id] ?? null,
			vision: seen ?? null,
			qualityScore: asset.qualityScore ?? null,
		}
	})
	const proposals = proposeBulkPhotoMatches(inputs, matchDishes)

	// What the proposed dishes show now, echoed back on apply.
	const stateIds = [
		...new Set([
			...proposals.flatMap((p) => (p.itemId ? [p.itemId] : [])),
			...dishes.filter((dish) => dish.hasPhoto).map((dish) => dish.id),
		]),
	]
	const states = await readDishPhotoStates(organization.id, stateIds)

	const photos = assets.map((asset, index): BulkProposedPhoto => {
		const proposal = proposals[index]!
		const duplicateOfExisting = Boolean(
			asset.fileName &&
			asset.fileSize &&
			existing.has(`${asset.fileName}|${asset.fileSize}`),
		)
		const flags: BulkPhotoFlag[] = duplicateOfExisting
			? [...new Set<BulkPhotoFlag>([...proposal.flags, 'duplicate'])]
			: proposal.flags
		return {
			assetId: asset.id,
			fileName: asset.fileName,
			url: dishPhotoAssetUrl(asset),
			width: asset.width,
			height: asset.height,
			qualityScore:
				visionResults.get(asset.id)?.qualityScore ?? asset.qualityScore ?? null,
			label: visionResults.get(asset.id)?.label ?? null,
			proposal: { ...proposal, flags },
			duplicateOfExisting,
			sourceKey: proposal.itemId
				? (states.get(proposal.itemId)?.mainKey ?? null)
				: null,
		}
	})

	// The swap list: names, photo state and the main photo key a swap is
	// checked against on apply.
	const choices: BulkDishChoice[] = dishes.map((dish) => ({
		id: dish.id,
		name: dish.name,
		hasPhoto: dish.hasPhoto,
		imageUrl: dish.imageUrl,
		sourceKey: states.get(dish.id)?.mainKey ?? null,
	}))

	return {
		ok: true,
		vision: vision ? vision.name : 'none',
		visionLimited,
		photos,
		dishes: choices,
		ignoredAssetIds,
	}
}

export type BulkApplyPair = z.infer<typeof applyInputSchema>['pairs'][number]

export type BulkApplyResult =
	| {
			ok: true
			applied: string[]
			refused: Array<{ itemId: string; error: DishPhotoError }>
	  }
	| {
			ok: false
			status: 400 | 404 | 409
			error:
				| 'empty'
				| 'duplicate_pair'
				| 'unknown_dish'
				| 'replace_not_confirmed'
				| 'asset_not_found'
			itemId?: string
			assetId?: string
	  }

/**
 * Attaches the confirmed pairs. A dish that already has a photo needs
 * `replace: true`, or the whole request is refused and nothing changes. The
 * previous photo stays in the library, linked as the original of the new one.
 */
export async function applyBulkPhotos(input: {
	organization: { id: string; slug: string }
	userId: string
	request?: Request
	pairs: readonly BulkApplyPair[]
}): Promise<BulkApplyResult> {
	const { organization, pairs } = input
	const assets = await loadReadyImageAssets(
		organization.id,
		pairs.map((pair) => pair.assetId),
	)
	const assetById = new Map(assets.map((asset) => [asset.id, asset]))
	for (const pair of pairs) {
		if (!assetById.has(pair.assetId)) {
			return {
				ok: false,
				status: 404,
				error: 'asset_not_found',
				assetId: pair.assetId,
			}
		}
	}

	const itemIds = [...new Set(pairs.map((pair) => pair.itemId))]
	const rows: Array<{
		id: string
		imageKey: string | null
		imageUrl: string | null
		imageKeys: string | null
	}> = []
	for (const part of chunks(itemIds)) {
		rows.push(
			...(await db
				.select({
					id: OrganizationMenuItem.id,
					imageKey: OrganizationMenuItem.imageKey,
					imageUrl: OrganizationMenuItem.imageUrl,
					imageKeys: OrganizationMenuItem.imageKeys,
				})
				.from(OrganizationMenuItem)
				.where(
					and(
						eq(OrganizationMenuItem.organizationId, organization.id),
						inArray(OrganizationMenuItem.id, part),
					),
				)),
		)
	}
	const hasPhoto = new Map(rows.map((row) => [row.id, dishHasPhoto(row)]))
	const check = checkBulkPhotoPairs(pairs, hasPhoto)
	if (!check.ok) {
		return {
			ok: false,
			status:
				check.error === 'unknown_dish'
					? 404
					: check.error === 'replace_not_confirmed'
						? 409
						: 400,
			error: check.error,
			itemId: check.itemId,
		}
	}

	const result = await replaceDishMainPhotosBatch({
		organization,
		userId: input.userId,
		request: input.request,
		changes: pairs.map((pair) => {
			const asset = assetById.get(pair.assetId)!
			return {
				itemId: pair.itemId,
				asset: {
					id: asset.id,
					objectKey: asset.objectKey,
					updatedAt: asset.updatedAt,
					status: asset.status,
				},
				// A reviewer who saw a dish change underneath them is told, not
				// overwritten (`undefined` skips the check).
				expectSourceKey: pair.sourceKey,
			}
		}),
		details: 'Dish photo added from a bulk upload.',
	})
	return { ok: true, applied: result.applied, refused: result.refused }
}

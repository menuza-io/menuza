/**
 * Menu and dish photos on the Google profile (#208).
 *
 *  - "Show my menu on Google" publishes the location's menu (sections, dishes,
 *    descriptions, prices, dietary labels) through `foodMenus` and points the
 *    profile's menu link at the Menuza menu page.
 *  - Publishes are coalesced: at most one per hour (the hourly sweep compares
 *    the mapped menu with the last published one) and one nightly refresh.
 *  - Photos come from the media library: up to 20 dish photos, a cover and a
 *    logo. A photo Google would refuse is skipped and listed with the reason.
 *  - Turning the switch off removes the menu Menuza published and leaves the
 *    photos in place.
 *
 * A Google failure is recorded, never thrown to the caller.
 */
import { fingerprint } from '@repo/common/gbp-hours'
import { GbpError } from '@repo/common/gbp-listing'
import {
	and,
	db,
	eq,
	GoogleMediaUpload,
	GoogleProfileField,
	inArray,
	Organization,
	OrganizationMediaAsset,
} from '@repo/database'
import {
	type GbpClient,
	gbpClientFor,
	resolveGbpAccountName,
} from '@repo/integrations'
import { buildPublicSiteMenuPayload } from '#app/utils/menu/public-menu-context.server.ts'
import { publicImageUrl } from '#app/utils/social/posts.server.ts'
import {
	type GbpContext,
	gbpFlags,
	parseJson,
	recordGbpError,
	recordGbpEvent,
	saveSync,
	siteLinks,
} from './context.server.ts'
import {
	type BuiltFoodMenus,
	type PhotoCategory,
	MAX_DISH_PHOTOS,
	buildFoodMenus,
	photoSkipReason,
} from './menu-map.ts'

/** At most one publish per hour. */
export const MENU_PUBLISH_INTERVAL_MS = 60 * 60_000
/** Even with no change, the menu is re-read about once a day. */
export const MENU_NIGHTLY_INTERVAL_MS = 20 * 60 * 60_000
export const MENU_LINK_ATTRIBUTE = 'attributes/url_menu'

export type MenuPublishResult = {
	at: string
	status: 'published' | 'removed' | 'failed' | 'unchanged'
	dishes: number
	sections: number
	skipped: Array<{ name: string; reason: string }>
	error?: string
	menuLink?: string | null
}

async function accountNameOf(ctx: GbpContext): Promise<string> {
	return (
		ctx.sync.googleAccountName ??
		(await resolveGbpAccountName(ctx.organization.id, ctx.location.id))
	)
}

function languageOf(locale: string | null | undefined) {
	return (locale ?? 'en').split('-')[0] || 'en'
}

async function buildForLocation(
	ctx: GbpContext,
	now: Date,
): Promise<BuiltFoodMenus & { link: string }> {
	const [org] = await db
		.select({
			siteDefaultLocale: Organization.siteDefaultLocale,
			siteLocales: Organization.siteLocales,
		})
		.from(Organization)
		.where(eq(Organization.id, ctx.organization.id))
		.limit(1)
	const { payload } = await buildPublicSiteMenuPayload(
		{
			id: ctx.organization.id,
			name: ctx.organization.name,
			slug: ctx.organization.slug,
			currency: ctx.organization.dataRegion === 'ksa' ? 'SAR' : 'USD',
			siteDefaultLocale: org?.siteDefaultLocale ?? null,
			siteLocales: org?.siteLocales ?? null,
			customDomain:
				ctx.organization.customDomainStatus === 'active'
					? ctx.organization.customDomain
					: null,
		},
		ctx.location.id,
	)
	const built = buildFoodMenus({
		payload,
		locationId: ctx.location.id,
		languageCode: languageOf(org?.siteDefaultLocale),
		restrictAlcohol: ctx.organization.dataRegion === 'ksa',
		now,
	})
	const link = siteLinks(
		ctx.organization,
		ctx.location,
		ctx.locationCount,
	).order
	return { ...built, link }
}

export async function loadPublishResult(
	sync: GbpContext['sync'],
): Promise<MenuPublishResult | null> {
	return parseJson<MenuPublishResult | null>(sync.menuPublishResult, null)
}

export type PublishMenuOutcome =
	| { ok: true; result: MenuPublishResult }
	| {
			ok: false
			error: 'flags_off' | 'not_enabled' | 'not_ready' | 'coalesced' | 'failed'
			result?: MenuPublishResult
	  }

/**
 * Publishes the menu now (or, unless `force`, only when due: a change at most
 * once an hour, a refresh nightly). Records the result on the link; a Google
 * refusal is recorded as `failed` with its reason.
 */
export async function publishMenu(input: {
	ctx: GbpContext
	actorId?: string | null
	/** "Publish now" and turning the switch on skip the coalescing wait. */
	force?: boolean
	now?: Date
	client?: GbpClient
}): Promise<PublishMenuOutcome> {
	const { ctx } = input
	const now = input.now ?? new Date()
	const flags = await gbpFlags(ctx.organization.id)
	if (!flags.sync || !flags.write) return { ok: false, error: 'flags_off' }
	if (!ctx.sync.menuSyncEnabled) return { ok: false, error: 'not_enabled' }
	if (
		!ctx.integration?.isActive ||
		ctx.sync.state !== 'ok' ||
		ctx.sync.verificationState === 'unverified' ||
		ctx.sync.verificationState === 'pending'
	) {
		return { ok: false, error: 'not_ready' }
	}
	const sinceAttempt = ctx.sync.menuAttemptedAt
		? now.getTime() - ctx.sync.menuAttemptedAt.getTime()
		: Infinity
	if (!input.force && sinceAttempt < MENU_PUBLISH_INTERVAL_MS) {
		// Coalesce: remember there is a change; the hourly sweep sends it.
		await saveSync(ctx.sync.id, { menuDirtyAt: ctx.sync.menuDirtyAt ?? now })
		return { ok: false, error: 'coalesced' }
	}

	const built = await buildForLocation(ctx, now)
	const hash = fingerprint({ menus: built.menus, link: built.link })
	const unchanged = ctx.sync.menuHash === hash
	if (
		!input.force &&
		unchanged &&
		sinceAttempt < MENU_NIGHTLY_INTERVAL_MS &&
		!ctx.sync.menuDirtyAt
	) {
		return { ok: false, error: 'coalesced' }
	}
	if (!input.force && unchanged && ctx.sync.menuPublishedAt) {
		// Nothing changed: record the check, send nothing.
		await saveSync(ctx.sync.id, { menuAttemptedAt: now, menuDirtyAt: null })
		return {
			ok: true,
			result: {
				...((await loadPublishResult(ctx.sync)) ?? {
					dishes: built.dishCount,
					sections: built.sectionCount,
					skipped: built.skipped,
				}),
				at: now.toISOString(),
				status: 'unchanged',
			} as MenuPublishResult,
		}
	}

	const base = {
		at: now.toISOString(),
		dishes: built.dishCount,
		sections: built.sectionCount,
		skipped: built.skipped.map((entry) => ({
			name: entry.name,
			reason: entry.reason,
		})),
	}
	try {
		const client = input.client ?? (await gbpClientFor(ctx.integration))
		const account = await accountNameOf(ctx)
		const name = ctx.sync.googleLocationName
		await client.publishFoodMenus(account, name, { menus: built.menus })
		await client.updateAttributes(name, { [MENU_LINK_ATTRIBUTE]: built.link })
		const result: MenuPublishResult = {
			...base,
			status: 'published',
			menuLink: built.link,
		}
		await saveSync(ctx.sync.id, {
			menuPublishedAt: now,
			menuAttemptedAt: now,
			menuDirtyAt: null,
			menuHash: hash,
			menuPublishResult: JSON.stringify(result),
		})
		await recordGbpEvent({
			sync: ctx.sync,
			kind: 'menu',
			actorId: input.actorId,
			summary: `Menu published to Google (${built.dishCount} dishes)`,
			request: { dishes: built.dishCount, sections: built.sectionCount },
			result: 'accepted',
		})
		return { ok: true, result }
	} catch (error) {
		const known = await recordGbpError(ctx, error)
		if (!known) throw error
		const result: MenuPublishResult = {
			...base,
			status: 'failed',
			error: known.reason || known.code,
		}
		await saveSync(ctx.sync.id, {
			menuAttemptedAt: now,
			menuPublishResult: JSON.stringify(result),
		})
		await recordGbpEvent({
			sync: ctx.sync,
			kind: 'menu',
			actorId: input.actorId,
			summary: 'Google did not take the menu',
			result: known.code === 'gbp_rejected' ? 'rejected' : 'failed',
			response: known.reason || known.code,
		})
		return { ok: false, error: 'failed', result }
	}
}

/**
 * The switch. On: publish at once. Off: remove the menu Menuza published (and
 * its menu link) and leave the photos where they are.
 */
export async function setMenuSync(input: {
	ctx: GbpContext
	enabled: boolean
	actorId: string
	now?: Date
	client?: GbpClient
}): Promise<PublishMenuOutcome | { ok: true; result: MenuPublishResult }> {
	const { ctx } = input
	const now = input.now ?? new Date()
	if (input.enabled) {
		await saveSync(ctx.sync.id, { menuSyncEnabled: true, menuDirtyAt: now })
		const refreshed = {
			...ctx,
			sync: { ...ctx.sync, menuSyncEnabled: true, menuDirtyAt: now },
		}
		return publishMenu({
			ctx: refreshed,
			actorId: input.actorId,
			force: true,
			now,
			client: input.client,
		})
	}
	await saveSync(ctx.sync.id, { menuSyncEnabled: false, menuDirtyAt: null })
	let result: MenuPublishResult = {
		at: now.toISOString(),
		status: 'removed',
		dishes: 0,
		sections: 0,
		skipped: [],
	}
	const flags = await gbpFlags(ctx.organization.id)
	if (
		ctx.integration?.isActive &&
		flags.sync &&
		flags.write &&
		ctx.sync.state === 'ok' &&
		ctx.sync.menuPublishedAt
	) {
		try {
			const client = input.client ?? (await gbpClientFor(ctx.integration))
			const account = await accountNameOf(ctx)
			const name = ctx.sync.googleLocationName
			await client.publishFoodMenus(account, name, { menus: [] })
			await client.updateAttributes(name, { [MENU_LINK_ATTRIBUTE]: null })
			await recordGbpEvent({
				sync: ctx.sync,
				kind: 'menu',
				actorId: input.actorId,
				summary: 'Menu removed from Google; photos left in place',
				result: 'accepted',
			})
		} catch (error) {
			const known = await recordGbpError(ctx, error)
			if (!known) throw error
			result = {
				...result,
				status: 'failed',
				error: known.reason || known.code,
			}
		}
	}
	await saveSync(ctx.sync.id, {
		menuPublishedAt: null,
		menuHash: null,
		menuPublishResult: JSON.stringify(result),
	})
	return { ok: true, result }
}

// ---------------------------------------------------------------------------
// Photos
// ---------------------------------------------------------------------------

export type PhotoRow = typeof GoogleMediaUpload.$inferSelect

export async function listPhotoRows(locationId: string): Promise<PhotoRow[]> {
	return db
		.select()
		.from(GoogleMediaUpload)
		.where(eq(GoogleMediaUpload.organizationLocationId, locationId))
}

const PHOTO_CATEGORIES: PhotoCategory[] = ['FOOD_AND_DRINK', 'COVER', 'PROFILE']

export type PhotoSelection = {
	dishMediaIds: string[]
	coverMediaId: string | null
	logoMediaId: string | null
}

export type SavePhotosResult =
	| {
			ok: true
			uploaded: number
			skipped: Array<{ mediaId: string; reason: string }>
	  }
	| {
			ok: false
			error: 'too_many' | 'unknown_media' | 'flags_off' | 'not_ready'
	  }

/**
 * Stores the operator's choice and uploads what is new. Photos below Google's
 * minimum size (and other refusals) are skipped and listed with the reason.
 */
export async function savePhotoSelection(input: {
	ctx: GbpContext
	selection: PhotoSelection
	actorId: string
	client?: GbpClient
}): Promise<SavePhotosResult> {
	const { ctx, selection } = input
	const dish = [...new Set(selection.dishMediaIds)]
	if (dish.length > MAX_DISH_PHOTOS) return { ok: false, error: 'too_many' }
	const flags = await gbpFlags(ctx.organization.id)
	if (!flags.sync || !flags.write) return { ok: false, error: 'flags_off' }

	const wanted: Array<{ mediaId: string; category: PhotoCategory }> = [
		...dish.map((mediaId) => ({
			mediaId,
			category: 'FOOD_AND_DRINK' as const,
		})),
		...(selection.coverMediaId
			? [{ mediaId: selection.coverMediaId, category: 'COVER' as const }]
			: []),
		...(selection.logoMediaId
			? [{ mediaId: selection.logoMediaId, category: 'PROFILE' as const }]
			: []),
	]
	const ids = [...new Set(wanted.map((entry) => entry.mediaId))]
	if (ids.length > 0) {
		const owned = await db
			.select({ id: OrganizationMediaAsset.id })
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, ctx.organization.id),
					inArray(OrganizationMediaAsset.id, ids),
				),
			)
		if (owned.length !== ids.length)
			return { ok: false, error: 'unknown_media' }
	}

	const existing = await listPhotoRows(ctx.location.id)
	const key = (mediaId: string, category: string) => `${category}:${mediaId}`
	const wantedKeys = new Set(
		wanted.map((entry) => key(entry.mediaId, entry.category)),
	)
	const toRemove = existing.filter(
		(row) =>
			!wantedKeys.has(key(row.mediaId, row.category)) &&
			row.status !== 'removed',
	)
	let client: GbpClient | null = null
	const clientFor = async () => {
		if (!ctx.integration?.isActive) throw new GbpError('gbp_token_expired', 401)
		client ??= input.client ?? (await gbpClientFor(ctx.integration))
		return client
	}
	for (const row of toRemove) {
		if (row.status === 'uploaded' && row.remoteName) {
			try {
				await (await clientFor()).deleteMedia(row.remoteName)
			} catch (error) {
				const known = await recordGbpError(ctx, error)
				if (!known) throw error
			}
		}
		await db.delete(GoogleMediaUpload).where(eq(GoogleMediaUpload.id, row.id))
	}
	for (const entry of wanted) {
		const row = existing.find(
			(candidate) =>
				candidate.mediaId === entry.mediaId &&
				candidate.category === entry.category,
		)
		if (!row) {
			await db.insert(GoogleMediaUpload).values({
				organizationId: ctx.organization.id,
				organizationLocationId: ctx.location.id,
				mediaId: entry.mediaId,
				category: entry.category,
				status: 'chosen',
			})
		} else if (row.status === 'failed' || row.status === 'skipped') {
			// An explicit save looks again (the photo may have been replaced).
			await db
				.update(GoogleMediaUpload)
				.set({ status: 'chosen', reason: null })
				.where(eq(GoogleMediaUpload.id, row.id))
		}
	}
	const result = await syncPhotos({
		ctx,
		actorId: input.actorId,
		client: input.client,
	})
	return { ok: true, ...result }
}

/** Uploads every chosen photo that is not on Google yet. */
export async function syncPhotos(input: {
	ctx: GbpContext
	actorId?: string | null
	client?: GbpClient
}): Promise<{
	uploaded: number
	skipped: Array<{ mediaId: string; reason: string }>
}> {
	const { ctx } = input
	const rows = (await listPhotoRows(ctx.location.id)).filter(
		(row) => row.status === 'chosen',
	)
	const skipped: Array<{ mediaId: string; reason: string }> = []
	if (rows.length === 0) return { uploaded: 0, skipped }
	const assets = await db
		.select()
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, ctx.organization.id),
				inArray(
					OrganizationMediaAsset.id,
					rows.map((row) => row.mediaId),
				),
			),
		)
	const byId = new Map(assets.map((asset) => [asset.id, asset]))
	let uploaded = 0
	let client: GbpClient | null = null
	for (const row of rows) {
		const reason = photoSkipReason(
			byId.get(row.mediaId) ?? null,
			row.category as PhotoCategory,
		)
		if (reason) {
			await db
				.update(GoogleMediaUpload)
				.set({ status: 'skipped', reason })
				.where(eq(GoogleMediaUpload.id, row.id))
			skipped.push({ mediaId: row.mediaId, reason })
			await recordGbpEvent({
				sync: ctx.sync,
				kind: 'media',
				actorId: input.actorId,
				summary: 'A photo was left out',
				request: { mediaId: row.mediaId, category: row.category },
				result: 'skipped',
				response: reason,
			})
			continue
		}
		if (
			!ctx.integration?.isActive ||
			ctx.sync.state !== 'ok' ||
			ctx.sync.verificationState === 'unverified' ||
			ctx.sync.verificationState === 'pending'
		) {
			continue
		}
		try {
			client ??= input.client ?? (await gbpClientFor(ctx.integration))
			const media = await client.uploadMedia(
				await accountNameOf(ctx),
				ctx.sync.googleLocationName,
				{
					sourceUrl: publicImageUrl(row.mediaId),
					category: row.category,
				},
			)
			await db
				.update(GoogleMediaUpload)
				.set({
					status: 'uploaded',
					remoteName: media.name || null,
					reason: null,
				})
				.where(eq(GoogleMediaUpload.id, row.id))
			uploaded += 1
			await recordGbpEvent({
				sync: ctx.sync,
				kind: 'media',
				actorId: input.actorId,
				summary: 'Photo added to Google',
				request: { mediaId: row.mediaId, category: row.category },
				result: 'accepted',
			})
		} catch (error) {
			const known = await recordGbpError(ctx, error)
			if (!known) throw error
			const rejected = known.code === 'gbp_rejected'
			await db
				.update(GoogleMediaUpload)
				.set({
					status: rejected ? 'skipped' : 'failed',
					reason: known.reason || known.code,
				})
				.where(eq(GoogleMediaUpload.id, row.id))
			if (rejected)
				skipped.push({
					mediaId: row.mediaId,
					reason: known.reason || known.code,
				})
			await recordGbpEvent({
				sync: ctx.sync,
				kind: 'media',
				actorId: input.actorId,
				summary: 'Google did not take a photo',
				request: { mediaId: row.mediaId, category: row.category },
				result: rejected ? 'rejected' : 'failed',
				response: known.reason || known.code,
			})
			if (!rejected) break
		}
	}
	return { uploaded, skipped }
}

// ---------------------------------------------------------------------------
// New dish photos each month
// ---------------------------------------------------------------------------

const AUTO_PHOTOS_KEY = 'setting:autoPhotos'
export const AUTO_PHOTOS_INTERVAL_MS = 30 * 24 * 60 * 60_000

export async function getAutoPhotos(
	locationId: string,
): Promise<{ enabled: boolean; lastRunAt: string | null }> {
	const [row] = await db
		.select()
		.from(GoogleProfileField)
		.where(
			and(
				eq(GoogleProfileField.organizationLocationId, locationId),
				eq(GoogleProfileField.key, AUTO_PHOTOS_KEY),
			),
		)
		.limit(1)
	return parseJson(row?.value, { enabled: false, lastRunAt: null })
}

export async function setAutoPhotos(
	ctx: GbpContext,
	enabled: boolean,
	actorId: string,
) {
	const current = await getAutoPhotos(ctx.location.id)
	const value = JSON.stringify({ enabled, lastRunAt: current.lastRunAt })
	await db
		.insert(GoogleProfileField)
		.values({
			organizationId: ctx.organization.id,
			organizationLocationId: ctx.location.id,
			key: AUTO_PHOTOS_KEY,
			value,
			source: 'hand',
			status: 'saved',
			updatedById: actorId,
		})
		.onConflictDoUpdate({
			target: [
				GoogleProfileField.organizationLocationId,
				GoogleProfileField.key,
			],
			set: { value, updatedById: actorId },
		})
}

/**
 * Monthly: adds photos of dishes on the menu that are not on the profile yet,
 * up to the 20-photo limit. Only photos of published dishes are considered.
 */
export async function addNewDishPhotos(input: {
	ctx: GbpContext
	now?: Date
	client?: GbpClient
}): Promise<number> {
	const { ctx } = input
	const now = input.now ?? new Date()
	const setting = await getAutoPhotos(ctx.location.id)
	if (!setting.enabled) return 0
	if (
		setting.lastRunAt &&
		now.getTime() - Date.parse(setting.lastRunAt) < AUTO_PHOTOS_INTERVAL_MS
	) {
		return 0
	}
	const existing = await listPhotoRows(ctx.location.id)
	const dishRows = existing.filter(
		(row) => row.category === 'FOOD_AND_DRINK' && row.status !== 'removed',
	)
	const room = MAX_DISH_PHOTOS - dishRows.length
	if (room > 0) {
		const { payload } = await buildPublicSiteMenuPayload(
			{
				id: ctx.organization.id,
				name: ctx.organization.name,
				slug: ctx.organization.slug,
				currency: ctx.organization.dataRegion === 'ksa' ? 'SAR' : 'USD',
				siteDefaultLocale: null,
				siteLocales: null,
				customDomain: null,
			},
			ctx.location.id,
		)
		const keys = new Set<string>()
		const collect = (
			categories: (typeof payload.menus)[number]['categories'],
		) => {
			for (const category of categories) {
				for (const item of category.items) {
					if (item.availabilityStatus === 'available') {
						for (const key of item.imageKeys.length > 0
							? item.imageKeys
							: item.imageKey
								? [item.imageKey]
								: []) {
							keys.add(key)
						}
					}
				}
				collect(category.subcategories ?? [])
			}
		}
		for (const menu of payload.menus) collect(menu.categories)
		if (keys.size > 0) {
			const assets = await db
				.select({ id: OrganizationMediaAsset.id })
				.from(OrganizationMediaAsset)
				.where(
					and(
						eq(OrganizationMediaAsset.organizationId, ctx.organization.id),
						inArray(OrganizationMediaAsset.objectKey, [...keys].slice(0, 90)),
					),
				)
			const have = new Set(existing.map((row) => row.mediaId))
			let added = 0
			for (const asset of assets) {
				if (added >= room) break
				if (have.has(asset.id)) continue
				await db.insert(GoogleMediaUpload).values({
					organizationId: ctx.organization.id,
					organizationLocationId: ctx.location.id,
					mediaId: asset.id,
					category: 'FOOD_AND_DRINK',
					status: 'chosen',
				})
				added += 1
			}
		}
	}
	await db
		.update(GoogleProfileField)
		.set({
			value: JSON.stringify({ enabled: true, lastRunAt: now.toISOString() }),
		})
		.where(
			and(
				eq(GoogleProfileField.organizationLocationId, ctx.location.id),
				eq(GoogleProfileField.key, AUTO_PHOTOS_KEY),
			),
		)
	const { uploaded } = await syncPhotos({ ctx, client: input.client })
	return uploaded
}

export { PHOTO_CATEGORIES }

import { auditService, AuditAction } from '@repo/audit'
import { parseMenuItemImageKeys } from '@repo/common/menu-types'
import {
	and,
	db,
	eq,
	inArray,
	isNull,
	MenuItemPhotoTest,
	or,
	sql,
	OrganizationMediaAsset,
	OrganizationMenuItem,
	OrganizationMenuPosLink,
} from '@repo/database'
import { posProviders, readFields } from '@repo/integrations/pos/types'
import { isPosOwnershipEnabled } from '#app/utils/integrations/flags.server.ts'
import { setAssetParent } from '#app/utils/media/library-organize.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { lockedFieldsFor } from './pos-ownership.server.ts'

/**
 * The one way a dish's main photo changes outside the dish form: bulk apply
 * (#316), the operator phone app (#222), keeping an A/B winner (#192) and the
 * restyle "Use new" / "Switch back" (#146) all go through here.
 *
 * - The dish's photo list is `imageKeys` (first is main). The new photo goes
 *   first; the old main photo stays in the list unless `dropKey` names it. It
 *   also stays in the media library, linked as the original of the new one
 *   (#147 versions) so nothing is lost.
 * - `expectSourceKey` makes the change refuse (`photo_changed`) when the dish's
 *   main photo is no longer that one, so a stale review never overwrites a
 *   photo someone changed meanwhile.
 * - The write is a single compare-and-set `UPDATE` inside `db.batch` (D1 has no
 *   interactive transactions): it only applies while the stored photo fields
 *   still equal what this call read.
 */

export type DishPhotoOrganization = { id: string; slug: string }

export type DishPhotoAsset = {
	id: string
	objectKey: string
	updatedAt: Date
	status?: string
}

export type DishPhotoError =
	| 'not_found'
	| 'photo_changed'
	| 'asset_not_found'
	| 'asset_not_ready'
	| 'pos_owned'

export type DishPhotoState = {
	id: string
	imageKey: string | null
	imageUrl: string | null
	rawImageKeys: string | null
	imageKeys: string[]
	/** The main photo as a library object key (a stored asset id is resolved). */
	mainKey: string | null
}

/** The library URL the dish form bakes into `imageUrl`. */
export function dishPhotoAssetUrl(asset: {
	id: string
	updatedAt: Date
}): string {
	return `/resources/images?mediaId=${encodeURIComponent(asset.id)}&v=${asset.updatedAt.getTime()}`
}

/**
 * Reads the stored photo fields of dishes of one organization (a dish of
 * another organization is simply absent). Legacy asset ids are resolved to
 * object keys so callers compare like with like.
 */
export async function readDishPhotoStates(
	organizationId: string,
	itemIds: string[],
): Promise<Map<string, DishPhotoState>> {
	const states = new Map<string, DishPhotoState>()
	for (let start = 0; start < itemIds.length; start += 80) {
		const chunk = itemIds.slice(start, start + 80)
		const rows = await db
			.select({
				id: OrganizationMenuItem.id,
				imageKey: OrganizationMenuItem.imageKey,
				imageUrl: OrganizationMenuItem.imageUrl,
				imageKeys: OrganizationMenuItem.imageKeys,
			})
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, organizationId),
					inArray(OrganizationMenuItem.id, chunk),
				),
			)
		for (const row of rows) {
			const imageKeys = parseMenuItemImageKeys(row.imageKeys, row.imageKey)
			states.set(row.id, {
				id: row.id,
				imageKey: row.imageKey,
				imageUrl: row.imageUrl,
				rawImageKeys: row.imageKeys,
				imageKeys,
				mainKey: imageKeys[0] ?? null,
			})
		}
	}
	// A stored key may be a library asset id (older dishes): resolve every one
	// to its object key so the list, the main photo and `dropKey` compare alike.
	const unresolved = [
		...new Set(
			[...states.values()].flatMap((state) =>
				state.imageKeys.filter((key) => !key.includes('/')),
			),
		),
	]
	if (unresolved.length > 0) {
		const byId = new Map<string, string>()
		for (let start = 0; start < unresolved.length; start += 80) {
			const assets = await db
				.select({
					id: OrganizationMediaAsset.id,
					objectKey: OrganizationMediaAsset.objectKey,
				})
				.from(OrganizationMediaAsset)
				.where(
					and(
						eq(OrganizationMediaAsset.organizationId, organizationId),
						inArray(
							OrganizationMediaAsset.id,
							unresolved.slice(start, start + 80),
						),
					),
				)
			for (const asset of assets) byId.set(asset.id, asset.objectKey)
		}
		for (const state of states.values()) {
			state.imageKeys = [
				...new Set(state.imageKeys.map((key) => byId.get(key) ?? key)),
			]
			state.mainKey = state.imageKeys[0] ?? null
		}
	}
	return states
}

/** The library asset behind a dish photo key (an object key or an asset id). */
export async function findLibraryAssetByKey(
	organizationId: string,
	key: string,
) {
	const [asset] = await db
		.select()
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				or(
					eq(OrganizationMediaAsset.objectKey, key),
					eq(OrganizationMediaAsset.id, key),
				),
			),
		)
		.limit(1)
	return asset ?? null
}

/**
 * A guard for statements that must run only when the dish ended up with
 * `asset` as its main photo, for use as `AND` in a `db.batch` after the
 * compare-and-set update (the batch is one transaction, in order).
 */
export function dishMainPhotoIs(itemId: string, objectKey: string) {
	return sql`EXISTS (SELECT 1 FROM ${OrganizationMenuItem} WHERE ${OrganizationMenuItem.id} = ${itemId} AND ${OrganizationMenuItem.imageKey} = ${objectKey})`
}

function buildUpdate(
	organizationId: string,
	state: DishPhotoState,
	asset: DishPhotoAsset,
	nextKeys: string[],
) {
	const json = JSON.stringify(nextKeys)
	// Compare and set: only while the stored photo fields are what we read.
	const sameKeys =
		state.rawImageKeys === null
			? sql`${OrganizationMenuItem.imageKeys} IS NULL`
			: eq(OrganizationMenuItem.imageKeys, state.rawImageKeys)
	const sameKey =
		state.imageKey === null
			? sql`${OrganizationMenuItem.imageKey} IS NULL`
			: eq(OrganizationMenuItem.imageKey, state.imageKey)
	return db
		.update(OrganizationMenuItem)
		.set({
			imageKeys: json,
			imageKey: nextKeys[0] ?? null,
			imageUrl: nextKeys[0] ? dishPhotoAssetUrl(asset) : null,
			updatedAt: new Date(),
		})
		.where(
			and(
				eq(OrganizationMenuItem.id, state.id),
				eq(OrganizationMenuItem.organizationId, organizationId),
				sameKeys,
				sameKey,
				// The photo must still exist: a restyle draft can be deleted (try
				// again, the 30-day prune) between our read and this write.
				sql`EXISTS (SELECT 1 FROM ${OrganizationMediaAsset} WHERE ${OrganizationMediaAsset.id} = ${asset.id} AND ${OrganizationMediaAsset.organizationId} = ${organizationId} AND ${OrganizationMediaAsset.status} IN ('draft', 'ready'))`,
			),
		)
		.returning({ id: OrganizationMenuItem.id })
}

export type ReplaceOptions = {
	organization: DishPhotoOrganization
	userId: string
	request?: Request
	itemId: string
	asset: DishPhotoAsset
	/** Refuse (`photo_changed`) unless this is still the dish's main photo. */
	expectSourceKey?: string | null
	/** Take this key out of the dish's list (a loser or a replaced photo). */
	dropKey?: string | null
	/** Link the new photo as an edit of the old main photo (#147). */
	linkVersion?: boolean
	/** Allow a `draft` asset (a restyle draft promoted in `after`). */
	allowDraft?: boolean
	/** Statements to run in the same batch, guarded with `dishMainPhotoIs`. */
	after?: (change: { itemId: string; newKey: string }) => unknown[]
	/** What the audit log says. */
	details: string
	metadata?: Record<string, unknown>
	/** Bulk callers purge and audit once themselves. */
	skipRecord?: boolean
	/** The caller ends the dish's photo test itself (keeping the winner). */
	skipStopTests?: boolean
}

/** Plans a photo change from a freshly read state, or says why not. */
export function planDishPhotoChange(input: {
	state: DishPhotoState
	asset: DishPhotoAsset
	expectSourceKey?: string | null
	dropKey?: string | null
	/** A restyle draft is made ready by the caller's guarded statement. */
	allowDraft?: boolean
}): { ok: true; nextKeys: string[] } | { ok: false; error: DishPhotoError } {
	const status = input.asset.status
	if (
		status &&
		status !== 'ready' &&
		!(input.allowDraft && status === 'draft')
	) {
		return { ok: false, error: 'asset_not_ready' }
	}
	if (
		input.expectSourceKey !== undefined &&
		(input.state.mainKey ?? null) !== input.expectSourceKey
	) {
		return { ok: false, error: 'photo_changed' }
	}
	const rest = input.state.imageKeys.filter(
		(key) =>
			key !== input.asset.objectKey &&
			key !== input.asset.id &&
			key !== input.dropKey &&
			key !== input.state.mainKey,
	)
	// The previous main photo stays in the gallery after the new one, unless
	// dropped; the list holds at most five photos.
	const keepMain =
		input.state.mainKey &&
		input.state.mainKey !== input.dropKey &&
		input.state.mainKey !== input.asset.objectKey
			? [input.state.mainKey]
			: []
	const nextKeys = [input.asset.objectKey, ...keepMain, ...rest].slice(0, 5)
	return { ok: true, nextKeys }
}

/**
 * Makes `asset` the dish's main photo. Returns the previous main photo key so
 * a caller can offer "switch back".
 */
export async function replaceDishMainPhoto(
	options: ReplaceOptions,
): Promise<
	| { ok: true; previousKey: string | null; nextKeys: string[] }
	| { ok: false; error: DishPhotoError }
> {
	const { organization, itemId, asset } = options
	const states = await readDishPhotoStates(organization.id, [itemId])
	const state = states.get(itemId)
	if (!state) return { ok: false, error: 'not_found' }

	// A connected POS owns this dish's photo: its next sync would undo ours.
	if ((await posPhotoOwnedItemIds(organization.id)).has(itemId)) {
		return { ok: false, error: 'pos_owned' }
	}

	// The asset must belong to this organization.
	const owned = await findLibraryAssetByKey(organization.id, asset.id)
	if (!owned || owned.objectKey !== asset.objectKey) {
		return { ok: false, error: 'asset_not_found' }
	}
	const plan = planDishPhotoChange({
		state,
		asset: { ...asset, status: owned.status },
		expectSourceKey: options.expectSourceKey,
		dropKey: options.dropKey,
		allowDraft: options.allowDraft,
	})
	if (!plan.ok) return plan

	const statements = [
		buildUpdate(organization.id, state, asset, plan.nextKeys),
		...((options.after?.({ itemId, newKey: asset.objectKey }) ??
			[]) as never[]),
	]
	const results = (await db.batch(statements as never)) as unknown[]
	const updated = results[0] as Array<{ id: string }>
	if (!updated || updated.length === 0) {
		// Someone changed the dish between our read and our write.
		return { ok: false, error: 'photo_changed' }
	}

	if (options.linkVersion !== false && state.mainKey) {
		const previous = await findLibraryAssetByKey(organization.id, state.mainKey)
		if (previous && previous.id !== asset.id && !owned.parentAssetId) {
			// Best effort: a loop or a missing original just means no version link.
			await setAssetParent({
				organizationId: organization.id,
				assetId: asset.id,
				parentAssetId: previous.id,
			}).catch(() => undefined)
		}
	}

	// A running photo test compares what is live: a new main photo ends it
	// (#192), before the site cache is purged so no menu carries a stale test.
	if (!options.skipStopTests) {
		await stopPhotoTestsForChangedDish({
			organizationId: organization.id,
			itemId,
			newMainKey: asset.objectKey,
		})
	}

	if (!options.skipRecord) {
		await auditService.log({
			action: AuditAction.MENU_ITEM_UPDATED,
			userId: options.userId,
			organizationId: organization.id,
			resourceType: 'menu_item',
			resourceId: itemId,
			details: options.details,
			metadata: options.metadata,
			request: options.request,
		})
		await purgeOrganizationSiteCache(organization.id, organization.slug)
	}
	return { ok: true, previousKey: state.mainKey, nextKeys: plan.nextKeys }
}

/**
 * Applies several photos in one `db.batch` (bulk apply, #316) and purges the
 * site cache once. Each pair carries the dish photo state the caller reviewed.
 * Returns the item ids that changed and those that were refused.
 */
export async function replaceDishMainPhotosBatch(input: {
	organization: DishPhotoOrganization
	userId: string
	request?: Request
	changes: Array<{
		itemId: string
		asset: DishPhotoAsset
		expectSourceKey?: string | null
	}>
	details: string
}): Promise<{
	applied: string[]
	refused: Array<{ itemId: string; error: DishPhotoError }>
}> {
	const { organization } = input
	const states = await readDishPhotoStates(
		organization.id,
		input.changes.map((change) => change.itemId),
	)
	const posOwned = await posPhotoOwnedItemIds(organization.id)
	const refused: Array<{ itemId: string; error: DishPhotoError }> = []
	const planned: Array<{
		itemId: string
		state: DishPhotoState
		asset: DishPhotoAsset
		nextKeys: string[]
	}> = []
	for (const change of input.changes) {
		const state = states.get(change.itemId)
		if (!state) {
			refused.push({ itemId: change.itemId, error: 'not_found' })
			continue
		}
		if (posOwned.has(change.itemId)) {
			// The next POS sync would overwrite the photo.
			refused.push({ itemId: change.itemId, error: 'pos_owned' })
			continue
		}
		const plan = planDishPhotoChange({
			state,
			asset: change.asset,
			expectSourceKey: change.expectSourceKey,
		})
		if (!plan.ok) {
			refused.push({ itemId: change.itemId, error: plan.error })
			continue
		}
		planned.push({
			itemId: change.itemId,
			state,
			asset: change.asset,
			nextKeys: plan.nextKeys,
		})
	}
	if (planned.length === 0) return { applied: [], refused }

	// One batch: an all-or-nothing write of every update.
	const results = (await db.batch(
		planned.map((entry) =>
			buildUpdate(organization.id, entry.state, entry.asset, entry.nextKeys),
		) as never,
	)) as unknown as Array<Array<{ id: string }>>
	const applied: string[] = []
	planned.forEach((entry, index) => {
		if (results[index] && results[index]!.length > 0) applied.push(entry.itemId)
		else refused.push({ itemId: entry.itemId, error: 'photo_changed' })
	})

	for (const entry of planned) {
		if (!applied.includes(entry.itemId)) continue
		if (entry.state.mainKey) {
			const previous = await findLibraryAssetByKey(
				organization.id,
				entry.state.mainKey,
			)
			const own = await findLibraryAssetByKey(organization.id, entry.asset.id)
			if (
				previous &&
				previous.id !== entry.asset.id &&
				own &&
				!own.parentAssetId
			) {
				await setAssetParent({
					organizationId: organization.id,
					assetId: entry.asset.id,
					parentAssetId: previous.id,
				}).catch(() => undefined)
			}
		}
		await stopPhotoTestsForChangedDish({
			organizationId: organization.id,
			itemId: entry.itemId,
			newMainKey: entry.asset.objectKey,
		})
		await auditService.log({
			action: AuditAction.MENU_ITEM_UPDATED,
			userId: input.userId,
			organizationId: organization.id,
			resourceType: 'menu_item',
			resourceId: entry.itemId,
			details: input.details,
			request: input.request,
		})
	}
	if (applied.length > 0) {
		await purgeOrganizationSiteCache(organization.id, organization.slug)
	}
	return { applied, refused }
}

/** Providers whose import rewrites a dish's photo: such dishes are not changed here. */
const PHOTO_PROVIDERS = new Set<string>(
	posProviders.filter((provider) => readFields[provider].includes('photo')),
)

/** Dish ids whose photo a connected POS owns (it would be overwritten). */
export async function posPhotoOwnedItemIds(organizationId: string) {
	const rows = await db
		.select({
			itemId: OrganizationMenuPosLink.localId,
			provider: OrganizationMenuPosLink.providerName,
		})
		.from(OrganizationMenuPosLink)
		.where(
			and(
				eq(OrganizationMenuPosLink.organizationId, organizationId),
				eq(OrganizationMenuPosLink.entityType, 'item'),
			),
		)
	if (rows.length === 0) return new Set<string>()
	if (await isPosOwnershipEnabled(organizationId)) {
		const locks = await lockedFieldsFor(
			organizationId,
			'item',
			rows.map((r) => r.itemId),
		)
		return new Set(
			[...locks.entries()]
				.filter(([, lock]) => lock.lockedFields.includes('photo'))
				.map(([id]) => id),
		)
	}
	return new Set(
		rows
			.filter((row) => PHOTO_PROVIDERS.has(row.provider))
			.map((row) => row.itemId),
	)
}

/**
 * A dish photo changed (any way): a running photo test of that dish is no
 * longer comparing what is live, so it stops (#192). Never throws.
 */
export async function stopPhotoTestsForChangedDish(input: {
	organizationId: string
	itemId: string
	newMainKey: string | null
	now?: Date
}) {
	try {
		const tests = await db
			.select({
				id: MenuItemPhotoTest.id,
				imageKeyA: MenuItemPhotoTest.imageKeyA,
			})
			.from(MenuItemPhotoTest)
			.where(
				and(
					eq(MenuItemPhotoTest.organizationId, input.organizationId),
					eq(MenuItemPhotoTest.itemId, input.itemId),
					isNull(MenuItemPhotoTest.endedAt),
				),
			)
		const stale = tests.filter((test) => test.imageKeyA !== input.newMainKey)
		if (stale.length === 0) return
		await db
			.update(MenuItemPhotoTest)
			.set({ endedAt: input.now ?? new Date(), endedReason: 'stopped' })
			.where(
				inArray(
					MenuItemPhotoTest.id,
					stale.map((test) => test.id),
				),
			)
	} catch (error) {
		console.error('photo test: could not stop a test for a changed dish', {
			itemId: input.itemId,
			error: error instanceof Error ? error.message : 'unknown',
		})
	}
}

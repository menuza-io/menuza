import { auditService, AuditAction } from '@repo/audit'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { focalPointOf, type FocalPoint } from '@repo/common/image-focal'
import { photoTestBeaconKey } from '@repo/common/photo-test-key'
import { type MenuChannel } from '@repo/common/menu-channels'
import {
	evaluatePhotoTest,
	PHOTO_TEST_MAX_ACTIVE,
	type PhotoTestOutcome,
	type PhotoVariant,
	type PhotoVariantCounts,
} from '@repo/common/photo-test'
import {
	and,
	count,
	db,
	eq,
	inArray,
	isNull,
	MenuItemPhotoTest,
	OrganizationMediaAsset,
	OrganizationMenuItem,
} from '@repo/database'
import { readLiveEnv } from '#app/utils/env.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import {
	dishMainPhotoIs,
	dishPhotoAssetUrl,
	findLibraryAssetByKey,
	readDishPhotoStates,
	replaceDishMainPhoto,
	type DishPhotoOrganization,
} from './dish-photo.server.ts'

export { stopPhotoTestsForChangedDish } from './dish-photo.server.ts'
import { isMenuFlagOn, MENU_FLAG_KEYS } from './menu-flags.ts'

/**
 * Dish photo A/B tests (#192). The control plane keeps the test (which two
 * photos); the region keeps numbers only (views, adds, orders per photo).
 * Photo A is the dish's main photo when the test starts; photo B lives only on
 * the test row until the operator keeps it. Ending a test never deletes either
 * photo from the media library.
 */

export type PhotoTestError =
	| 'flag_off'
	| 'not_found'
	| 'no_photo'
	| 'asset_not_found'
	| 'asset_not_ready'
	| 'same_photo'
	| 'test_running'
	| 'too_many_tests'
	| 'photo_changed'
	| 'already_ended'

export async function isPhotoTestsEnabled(organizationId: string) {
	return isMenuFlagOn(
		await getFeatureFlag(MENU_FLAG_KEYS.photoTests, { organizationId }),
	)
}

/** The channels whose menus may carry photo B: the website and QR ordering. */
export function channelMayTestPhotos(channel: MenuChannel | undefined) {
	return channel === 'web' || channel === 'qr'
}

/**
 * Running tests for the public menu, by dish id. Only the web and QR channels
 * carry photo B; every other reader (the customer app's cached menu, delivery
 * menus, the order context, print, GBP) gets none, hence photo A.
 */
export async function loadPublicPhotoTests(
	organizationId: string,
	channel: MenuChannel | undefined,
	itemIds: string[],
	options: { secret?: string } = {},
): Promise<
	Map<
		string,
		{
			id: string
			imageUrlB: string
			imageFocalB: FocalPoint | null
			key: string
		}
	>
> {
	const result = new Map<
		string,
		{
			id: string
			imageUrlB: string
			imageFocalB: FocalPoint | null
			key: string
		}
	>()
	if (!channelMayTestPhotos(channel) || itemIds.length === 0) return result
	if (!(await isPhotoTestsEnabled(organizationId))) return result

	const tests = await db
		.select({
			id: MenuItemPhotoTest.id,
			itemId: MenuItemPhotoTest.itemId,
			imageKeyB: MenuItemPhotoTest.imageKeyB,
		})
		.from(MenuItemPhotoTest)
		.where(
			and(
				eq(MenuItemPhotoTest.organizationId, organizationId),
				isNull(MenuItemPhotoTest.endedAt),
			),
		)
		.limit(PHOTO_TEST_MAX_ACTIVE)
	const wanted = new Set(itemIds)
	const running = tests.filter((test) => wanted.has(test.itemId))
	if (running.length === 0) return result
	// The region counts a beacon only with a key signed here, so invented test
	// ids count nothing. Without the shared secret nothing can be counted: no
	// test is shown rather than one that silently records nothing.
	const secret = options.secret ?? readLiveEnv('TENANT_OPERATOR_TOKEN')
	if (secret.length < 16) return result

	const assets = await db
		.select({
			id: OrganizationMediaAsset.id,
			objectKey: OrganizationMediaAsset.objectKey,
			updatedAt: OrganizationMediaAsset.updatedAt,
			status: OrganizationMediaAsset.status,
			focalX: OrganizationMediaAsset.focalX,
			focalY: OrganizationMediaAsset.focalY,
		})
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.organizationId, organizationId),
				inArray(
					OrganizationMediaAsset.objectKey,
					running.map((test) => test.imageKeyB),
				),
			),
		)
	const byKey = new Map(assets.map((asset) => [asset.objectKey, asset]))
	for (const test of running) {
		const asset = byKey.get(test.imageKeyB)
		// A photo B that is not ready (or gone) is simply not tested.
		if (!asset || asset.status !== 'ready') continue
		result.set(test.itemId, {
			id: test.id,
			imageUrlB: dishPhotoAssetUrl(asset),
			imageFocalB: focalPointOf(asset),
			key: await photoTestBeaconKey(secret, {
				organizationId,
				testId: test.id,
				itemId: test.itemId,
			}),
		})
	}
	return result
}

type StartInput = {
	organization: DishPhotoOrganization
	userId: string
	request?: Request
	itemId: string
	/** The library asset to try as photo B. */
	assetId: string
}

export async function startPhotoTest(
	input: StartInput,
): Promise<
	{ ok: true; testId: string } | { ok: false; error: PhotoTestError }
> {
	const { organization } = input
	if (!(await isPhotoTestsEnabled(organization.id))) {
		return { ok: false, error: 'flag_off' }
	}
	const states = await readDishPhotoStates(organization.id, [input.itemId])
	const state = states.get(input.itemId)
	if (!state) return { ok: false, error: 'not_found' }
	if (!state.mainKey) return { ok: false, error: 'no_photo' }

	const asset = await findLibraryAssetByKey(organization.id, input.assetId)
	if (!asset) return { ok: false, error: 'asset_not_found' }
	if (asset.status !== 'ready' || asset.archivedAt) {
		return { ok: false, error: 'asset_not_ready' }
	}
	if (asset.objectKey === state.mainKey)
		return { ok: false, error: 'same_photo' }

	const [running] = await db
		.select({ n: count() })
		.from(MenuItemPhotoTest)
		.where(
			and(
				eq(MenuItemPhotoTest.organizationId, organization.id),
				isNull(MenuItemPhotoTest.endedAt),
			),
		)
	if ((running?.n ?? 0) >= PHOTO_TEST_MAX_ACTIVE) {
		return { ok: false, error: 'too_many_tests' }
	}

	try {
		const [created] = await db
			.insert(MenuItemPhotoTest)
			.values({
				organizationId: organization.id,
				itemId: input.itemId,
				imageKeyA: state.mainKey,
				imageKeyB: asset.objectKey,
				createdById: input.userId,
			})
			.returning({ id: MenuItemPhotoTest.id })
		if (!created) return { ok: false, error: 'test_running' }

		// The 20-test cap again after the insert: two requests can both pass the
		// check above. The loser removes its own row.
		const [after] = await db
			.select({ n: count() })
			.from(MenuItemPhotoTest)
			.where(
				and(
					eq(MenuItemPhotoTest.organizationId, organization.id),
					isNull(MenuItemPhotoTest.endedAt),
				),
			)
		if ((after?.n ?? 0) > PHOTO_TEST_MAX_ACTIVE) {
			await db
				.delete(MenuItemPhotoTest)
				.where(eq(MenuItemPhotoTest.id, created.id))
			return { ok: false, error: 'too_many_tests' }
		}

		await auditService.log({
			action: AuditAction.MENU_ITEM_UPDATED,
			userId: input.userId,
			organizationId: organization.id,
			resourceType: 'menu_item',
			resourceId: input.itemId,
			details: 'Started a dish photo test',
			metadata: { testId: created.id },
			request: input.request,
		})
		await purgeOrganizationSiteCache(organization.id, organization.slug)
		return { ok: true, testId: created.id }
	} catch (error) {
		// The one-running-test-per-dish unique index.
		if (isUniqueViolation(error)) {
			return { ok: false, error: 'test_running' }
		}
		throw error
	}
}

/** A unique-index failure, however deep the driver wrapped it. */
function isUniqueViolation(error: unknown): boolean {
	for (let depth = 0; depth < 5 && error; depth += 1) {
		const text = `${(error as { code?: unknown }).code ?? ''} ${(error as { message?: unknown }).message ?? ''}`
		if (text.includes('UNIQUE')) return true
		error = (error as { cause?: unknown }).cause
	}
	return false
}

export type EndChoice = 'A' | 'B' | 'stop'

/**
 * Ends a running test. `A` keeps the main photo as it is, `B` makes photo B the
 * dish's main photo (the same helper every photo change uses, so every channel
 * follows), `stop` just ends it. The losing photo stays in the library.
 */
export async function endPhotoTest(input: {
	organization: DishPhotoOrganization
	userId: string
	request?: Request
	testId: string
	choice: EndChoice
	now?: Date
}): Promise<{ ok: true } | { ok: false; error: PhotoTestError }> {
	const { organization } = input
	const now = input.now ?? new Date()
	const [test] = await db
		.select()
		.from(MenuItemPhotoTest)
		.where(
			and(
				eq(MenuItemPhotoTest.id, input.testId),
				eq(MenuItemPhotoTest.organizationId, organization.id),
			),
		)
		.limit(1)
	if (!test) return { ok: false, error: 'not_found' }
	if (test.endedAt) return { ok: false, error: 'already_ended' }

	const finish = {
		endedAt: now,
		winner: input.choice === 'stop' ? null : input.choice,
		endedReason:
			input.choice === 'A'
				? 'kept_a'
				: input.choice === 'B'
					? 'kept_b'
					: 'stopped',
	}

	if (input.choice === 'B') {
		const asset = await findLibraryAssetByKey(organization.id, test.imageKeyB)
		if (!asset) return { ok: false, error: 'asset_not_found' }
		const result = await replaceDishMainPhoto({
			organization,
			userId: input.userId,
			request: input.request,
			itemId: test.itemId,
			asset,
			expectSourceKey: test.imageKeyA,
			// The old main photo leaves the dish but stays in the library.
			dropKey: test.imageKeyA,
			details: 'Kept photo B of a dish photo test',
			metadata: { testId: test.id },
			// The guarded statement below records the winner on the test itself.
			skipStopTests: true,
			after: () => [
				db
					.update(MenuItemPhotoTest)
					.set({ ...finish, updatedAt: now })
					.where(
						and(
							eq(MenuItemPhotoTest.id, test.id),
							isNull(MenuItemPhotoTest.endedAt),
							// Only when the dish really switched to photo B.
							dishMainPhotoIs(test.itemId, asset.objectKey),
						),
					),
			],
		})
		if (!result.ok) {
			if (result.error === 'photo_changed') {
				return { ok: false, error: 'photo_changed' }
			}
			return { ok: false, error: 'asset_not_found' }
		}
		return { ok: true }
	}

	const [ended] = await db
		.update(MenuItemPhotoTest)
		.set({ ...finish, updatedAt: now })
		.where(
			and(eq(MenuItemPhotoTest.id, test.id), isNull(MenuItemPhotoTest.endedAt)),
		)
		.returning({ id: MenuItemPhotoTest.id })
	if (!ended) return { ok: false, error: 'already_ended' }
	await auditService.log({
		action: AuditAction.MENU_ITEM_UPDATED,
		userId: input.userId,
		organizationId: organization.id,
		resourceType: 'menu_item',
		resourceId: test.itemId,
		details:
			input.choice === 'A'
				? 'Kept photo A of a dish photo test'
				: 'Stopped a dish photo test',
		metadata: { testId: test.id },
		request: input.request,
	})
	await purgeOrganizationSiteCache(organization.id, organization.slug)
	return { ok: true }
}

export type PhotoTestCounts = Record<PhotoVariant, PhotoVariantCounts>

export type PhotoTestView = {
	id: string
	itemId: string
	imageKeyA: string
	imageKeyB: string
	startedAt: Date
	endedAt: Date | null
	winner: PhotoVariant | null
	endedReason: string | null
	counts: PhotoTestCounts
	/** `null` while the region could not be read: the strip shows no numbers. */
	outcome: PhotoTestOutcome | null
	/** How many more views each photo needs, and days, before a winner. */
	needs: { viewsA: number; viewsB: number; days: number }
}

/** A dish's tests, newest first, with the regional numbers and the outcome. */
export async function listPhotoTestsForItem(input: {
	organizationId: string
	itemId: string
	readCounts: (
		tests: Array<{
			testId: string
			itemId: string
			startedAt: number
			endedAt: number | null
		}>,
	) => Promise<Map<string, PhotoTestCounts> | null>
	now?: Date
}): Promise<PhotoTestView[]> {
	const now = input.now ?? new Date()
	const tests = await db
		.select()
		.from(MenuItemPhotoTest)
		.where(
			and(
				eq(MenuItemPhotoTest.organizationId, input.organizationId),
				eq(MenuItemPhotoTest.itemId, input.itemId),
			),
		)
		.orderBy(MenuItemPhotoTest.startedAt)
		.limit(10)
	if (tests.length === 0) return []
	const counts = await input
		.readCounts(
			tests.map((test) => ({
				testId: test.id,
				itemId: test.itemId,
				startedAt: test.startedAt.getTime(),
				endedAt: test.endedAt ? test.endedAt.getTime() : null,
			})),
		)
		.catch(() => null)
	return tests
		.slice()
		.reverse()
		.map((test) => {
			const testCounts = counts?.get(test.id) ?? null
			const outcome = testCounts
				? evaluatePhotoTest({
						startedAt: test.startedAt,
						now: test.endedAt ?? now,
						a: testCounts.A,
						b: testCounts.B,
					})
				: null
			const zero = { views: 0, adds: 0, orders: 0 }
			const days = Math.max(
				0,
				Math.ceil(
					(test.startedAt.getTime() + 7 * 86_400_000 - now.getTime()) /
						86_400_000,
				),
			)
			return {
				id: test.id,
				itemId: test.itemId,
				imageKeyA: test.imageKeyA,
				imageKeyB: test.imageKeyB,
				startedAt: test.startedAt,
				endedAt: test.endedAt,
				winner: test.winner === 'A' || test.winner === 'B' ? test.winner : null,
				endedReason: test.endedReason,
				counts: testCounts ?? { A: zero, B: zero },
				outcome,
				needs: {
					viewsA: Math.max(0, 200 - (testCounts?.A.views ?? 0)),
					viewsB: Math.max(0, 200 - (testCounts?.B.views ?? 0)),
					days,
				},
			}
		})
}

/** The dish's name for a test row (used by notices); null when gone. */
export async function photoTestItemName(
	organizationId: string,
	itemId: string,
) {
	const [row] = await db
		.select({ name: OrganizationMenuItem.displayName })
		.from(OrganizationMenuItem)
		.where(
			and(
				eq(OrganizationMenuItem.organizationId, organizationId),
				eq(OrganizationMenuItem.id, itemId),
			),
		)
		.limit(1)
	return row?.name ?? null
}

/** Thumbnail URLs for the photos of tests, by object key (this organization only). */
export async function photoTestImageUrls(
	organizationId: string,
	tests: Array<{ imageKeyA: string; imageKeyB: string }>,
): Promise<Record<string, string>> {
	const keys = [
		...new Set(tests.flatMap((test) => [test.imageKeyA, test.imageKeyB])),
	].slice(0, 40)
	if (keys.length === 0) return {}
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
	return Object.fromEntries(
		assets.map((asset) => [asset.objectKey, dishPhotoAssetUrl(asset)]),
	)
}

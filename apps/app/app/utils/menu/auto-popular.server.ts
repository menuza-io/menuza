import { getFeatureFlag } from '@repo/common/feature-flags'
import { isUnavailableUntilExpired } from '@repo/common/location-availability'
import {
	MENU_POPULAR_DEFAULT_COUNT,
	MENU_POPULAR_MAX_COUNT,
	MENU_POPULAR_MIN_COUNT,
	type MenuPopularPayload,
	type MenuPopularResult,
	type PopularMode,
} from '@repo/common/menu-popular'
import {
	and,
	db,
	eq,
	inArray,
	Organization,
	OrganizationMenuItem,
} from '@repo/database'
import { z } from 'zod'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { isMenuFlagOn } from './menu-flags.ts'

export const MENU_AUTO_POPULAR_FLAG_KEY = 'menu.auto_popular'

export async function getMenuAutoPopularEnabled(
	organizationId: string,
): Promise<boolean> {
	return isMenuFlagOn(
		await getFeatureFlag(MENU_AUTO_POPULAR_FLAG_KEY, { organizationId }),
	)
}

/**
 * Computes the effective `isPopular` flag for an item when its `popularMode`
 * is changed or saved:
 * - `'always'` -> always `true`
 * - `'never'` -> always `false`
 * - `'auto'` -> preserves `currentIsPopular` (defaults to `false`) until the
 *   next daily auto-popular run updates it.
 */
export function effectiveIsPopularForMode(
	mode: PopularMode,
	currentIsPopular = false,
): boolean {
	if (mode === 'always') return true
	if (mode === 'never') return false
	return Boolean(currentIsPopular)
}

export async function getAutoPopularSettings(organizationId: string): Promise<{
	featureEnabled: boolean
	autoPopularCount: number | null
}> {
	const [featureEnabled, org] = await Promise.all([
		getMenuAutoPopularEnabled(organizationId),
		db.query.Organization.findFirst({
			where: eq(Organization.id, organizationId),
			columns: { autoPopularCount: true },
		}),
	])
	return {
		featureEnabled,
		autoPopularCount: org?.autoPopularCount ?? null,
	}
}

export function clampAutoPopularCount(value: number): number {
	const rounded = Math.round(value)
	return Math.min(
		MENU_POPULAR_MAX_COUNT,
		Math.max(MENU_POPULAR_MIN_COUNT, rounded),
	)
}

export async function updateAutoPopularSettings(input: {
	organizationId: string
	enabled: boolean
	count?: number
}): Promise<{ autoPopularCount: number | null }> {
	const org = await db.query.Organization.findFirst({
		where: eq(Organization.id, input.organizationId),
		columns: { id: true, slug: true },
	})
	if (!org) {
		throw new Response('Not Found', { status: 404 })
	}

	const nextCount = input.enabled
		? clampAutoPopularCount(input.count ?? MENU_POPULAR_DEFAULT_COUNT)
		: null

	await db
		.update(Organization)
		.set({ autoPopularCount: nextCount })
		.where(eq(Organization.id, org.id))

	if (!input.enabled) {
		await db
			.update(OrganizationMenuItem)
			.set({ isPopular: false })
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, org.id),
					eq(OrganizationMenuItem.popularMode, 'auto'),
					eq(OrganizationMenuItem.isPopular, true),
				),
			)
	}

	await purgeOrganizationSiteCache(org.id, org.slug)

	return { autoPopularCount: nextCount }
}

const autoPopularSettingsFormSchema = z.object({
	intent: z.literal('updateAutoPopular'),
	autoPopularEnabled: z.enum(['true', 'false']).transform((v) => v === 'true'),
	autoPopularCount: z.coerce
		.number()
		.int()
		.min(MENU_POPULAR_MIN_COUNT)
		.max(MENU_POPULAR_MAX_COUNT)
		.default(MENU_POPULAR_DEFAULT_COUNT),
})

/**
 * Self-contained action helper for `items._index.tsx` when `intent === 'updateAutoPopular'`.
 */
export async function handleAutoPopularSettingsAction({
	request,
	organizationId,
	formData,
}: {
	request: Request
	organizationId: string
	formData: FormData
}) {
	await requireUserWithOrganizationPermission(
		request,
		organizationId,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)

	const featureEnabled = await getMenuAutoPopularEnabled(organizationId)
	if (!featureEnabled) {
		return Response.json(
			{ ok: false, error: 'feature_disabled' },
			{ status: 403 },
		)
	}

	const parsed = autoPopularSettingsFormSchema.safeParse({
		intent: formData.get('intent'),
		autoPopularEnabled: formData.get('autoPopularEnabled'),
		autoPopularCount:
			formData.get('autoPopularCount') ?? MENU_POPULAR_DEFAULT_COUNT,
	})
	if (!parsed.success) {
		return Response.json(
			{ ok: false, error: 'invalid_settings' },
			{ status: 400 },
		)
	}

	const result = await updateAutoPopularSettings({
		organizationId,
		enabled: parsed.data.autoPopularEnabled,
		count: parsed.data.autoPopularCount,
	})

	return Response.json({ ok: true, ...result })
}

export type ApplyAutoPopularOutcome =
	{ status: 'not_found' } | { status: 'ok'; result: MenuPopularResult }

/**
 * Applies the daily top-seller IDs posted by `tenant-api`:
 * - No-op if `menu.auto_popular` flag is off or `autoPopularCount` is null.
 * - Only touches items with `popularMode === 'auto'`; `'always'` and `'never'`
 *   are never changed by the job.
 * - Skips hidden/unavailable items (and non-`'auto'` items) and takes the next
 *   ranked sellers up to `autoPopularCount`.
 * - Clears `isPopular` on `'auto'` items that dropped out of the top N.
 * - Purges site cache if any item changed.
 */
export async function applyAutoPopularBadges(
	payload: MenuPopularPayload & { orgId: string },
	now = new Date(),
): Promise<ApplyAutoPopularOutcome> {
	const organization = await db.query.Organization.findFirst({
		where: and(
			eq(Organization.id, payload.orgId),
			eq(Organization.active, true),
			eq(Organization.hasProvisionedDb, true),
		),
		columns: { id: true, slug: true, autoPopularCount: true },
	})
	if (!organization) {
		return { status: 'not_found' }
	}

	const featureEnabled = await getMenuAutoPopularEnabled(organization.id)
	if (!featureEnabled) {
		return {
			status: 'ok',
			result: { updated: 0, skipped: 'feature_disabled' },
		}
	}

	if (
		organization.autoPopularCount == null ||
		organization.autoPopularCount < MENU_POPULAR_MIN_COUNT
	) {
		return {
			status: 'ok',
			result: { updated: 0, skipped: 'setting_off' },
		}
	}

	const targetCount = clampAutoPopularCount(organization.autoPopularCount)

	const items = await db
		.select({
			id: OrganizationMenuItem.id,
			isPopular: OrganizationMenuItem.isPopular,
			popularMode: OrganizationMenuItem.popularMode,
			availabilityStatus: OrganizationMenuItem.availabilityStatus,
			unavailableUntil: OrganizationMenuItem.unavailableUntil,
		})
		.from(OrganizationMenuItem)
		.where(eq(OrganizationMenuItem.organizationId, organization.id))

	const itemById = new Map(items.map((item) => [item.id, item]))
	const chosenAutoIds = new Set<string>()
	const seenIds = new Set<string>()

	for (const id of payload.itemIds) {
		if (chosenAutoIds.size >= targetCount) break
		if (seenIds.has(id)) continue
		seenIds.add(id)

		const item = itemById.get(id)
		if (!item) continue
		if (item.popularMode !== 'auto') continue
		if (
			!isUnavailableUntilExpired(
				item.availabilityStatus,
				item.unavailableUntil,
				now,
			)
		) {
			continue
		}
		chosenAutoIds.add(item.id)
	}

	const toSetTrue: string[] = []
	const toSetFalse: string[] = []

	for (const item of items) {
		if (item.popularMode !== 'auto') continue
		const shouldBePopular = chosenAutoIds.has(item.id)
		if (item.isPopular === shouldBePopular) continue
		if (shouldBePopular) {
			toSetTrue.push(item.id)
		} else {
			toSetFalse.push(item.id)
		}
	}

	const CHUNK_SIZE = 100
	for (let i = 0; i < toSetTrue.length; i += CHUNK_SIZE) {
		const chunk = toSetTrue.slice(i, i + CHUNK_SIZE)
		await db
			.update(OrganizationMenuItem)
			.set({ isPopular: true })
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, organization.id),
					eq(OrganizationMenuItem.popularMode, 'auto'),
					inArray(OrganizationMenuItem.id, chunk),
				),
			)
	}

	for (let i = 0; i < toSetFalse.length; i += CHUNK_SIZE) {
		const chunk = toSetFalse.slice(i, i + CHUNK_SIZE)
		await db
			.update(OrganizationMenuItem)
			.set({ isPopular: false })
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, organization.id),
					eq(OrganizationMenuItem.popularMode, 'auto'),
					inArray(OrganizationMenuItem.id, chunk),
				),
			)
	}

	const updated = toSetTrue.length + toSetFalse.length
	if (updated > 0) {
		await purgeOrganizationSiteCache(organization.id, organization.slug)
	}

	return {
		status: 'ok',
		result: { updated },
	}
}

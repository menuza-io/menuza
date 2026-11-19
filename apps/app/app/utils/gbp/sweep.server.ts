/**
 * Scheduled sweeps and non-blocking lifecycle hooks for Google Business
 * Profile (#87, #199, #284, #209, #208, #135, #136).
 *
 * - Hourly sweep (`POST /resources/jobs/gbp-sync`): retries outbox pushes,
 *   handles long ordering pauses that crossed the threshold, pulls Google
 *   changes & reconciles pending profile fields, refreshes verification daily,
 *   re-checks order links weekly, publishes coalesced menus (<= 1/hour, 1/day),
 *   auto-adds approved dish photos monthly, and syncs Google social accounts.
 * - Daily metrics sweep (`POST /resources/jobs/gbp-metrics`): backfills 18
 *   months on first run and refreshes the last 7 days + monthly keywords daily.
 * - Lifecycle hooks: `onGoogleLocationLinked`, `onOrderingControlChangedGbp`,
 *   and `markGbpMenuDirty` never throw so Google failures never block Menuza.
 */
import { orderLinkShouldBeRemoved } from '@repo/common/gbp-listing'
import {
	and,
	db,
	desc,
	eq,
	GbpLocationSync,
	ListingOrderLink,
} from '@repo/database'
import { type GbpClient } from '@repo/integrations'
import { syncGoogleSocialAccounts } from '#app/utils/social/google-posts.server.ts'
import { gbpFlags, loadGbpContext } from './context.server.ts'
import { addNewDishPhotos, publishMenu } from './menu.server.ts'
import { fetchLocationMetrics } from './metrics.server.ts'
import { refreshOrderLinks } from './order-links.server.ts'
import {
	enqueueGbpPush,
	pullLocation,
	pushLocationToGoogle,
} from './sync.server.ts'
import { refreshVerification } from './verification.server.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

export type HourlyGbpSweepResult = {
	locations: number
	pushed: number
	pulled: number
	verificationsChecked: number
	orderLinksChecked: number
	menusPublished: number
	photosAdded: number
	errors: number
}

export async function runHourlyGbpSweep(
	options: { now?: Date; client?: GbpClient; organizationId?: string } = {},
): Promise<HourlyGbpSweepResult> {
	const now = options.now ?? new Date()
	const rows = options.organizationId
		? await db
				.select({
					organizationId: GbpLocationSync.organizationId,
					organizationLocationId: GbpLocationSync.organizationLocationId,
				})
				.from(GbpLocationSync)
				.where(eq(GbpLocationSync.organizationId, options.organizationId))
		: await db
				.select({
					organizationId: GbpLocationSync.organizationId,
					organizationLocationId: GbpLocationSync.organizationLocationId,
				})
				.from(GbpLocationSync)

	const result: HourlyGbpSweepResult = {
		locations: rows.length,
		pushed: 0,
		pulled: 0,
		verificationsChecked: 0,
		orderLinksChecked: 0,
		menusPublished: 0,
		photosAdded: 0,
		errors: 0,
	}

	const seenOrgs = new Set<string>()
	for (const row of rows) {
		try {
			const flags = await gbpFlags(row.organizationId)
			if (!seenOrgs.has(row.organizationId)) {
				seenOrgs.add(row.organizationId)
				if (flags.socialGoogle) {
					await syncGoogleSocialAccounts(row.organizationId).catch(() => {})
				}
			}
			if (!flags.sync) continue
			let ctx = await loadGbpContext(
				row.organizationId,
				row.organizationLocationId,
			)
			if (!ctx || !ctx.integration?.isActive) continue

			// 1. Daily verification refresh (or whenever unverified / pending).
			const needsVerificationCheck =
				ctx.sync.verificationState !== 'verified' ||
				!ctx.sync.verificationCheckedAt ||
				now.getTime() - ctx.sync.verificationCheckedAt.getTime() >= DAY_MS
			if (needsVerificationCheck) {
				await refreshVerification(ctx, { client: options.client, now })
				result.verificationsChecked += 1
				const refreshed = await loadGbpContext(
					row.organizationId,
					row.organizationLocationId,
				)
				if (refreshed) ctx = refreshed
			}

			// 2. Outbox push retries & long ordering-pause threshold transitions.
			const pauseShouldRemove = orderLinkShouldBeRemoved(
				{
					orderingPausedAt: ctx.location.orderingPausedAt,
					orderingPausedUntil: ctx.location.orderingPausedUntil,
				},
				now,
			)
			const pauseLinkOutOfDate =
				(pauseShouldRemove && !ctx.sync.orderLinkPausedAt) ||
				(!pauseShouldRemove && Boolean(ctx.sync.orderLinkPausedAt))

			if (flags.write && ctx.sync.syncEnabled) {
				if (ctx.sync.pushRequestedAt) {
					await pushLocationToGoogle({
						organizationId: ctx.organization.id,
						organizationLocationId: ctx.location.id,
						now,
						ctx,
					})
					result.pushed += 1
				} else if (pauseLinkOutOfDate) {
					await pushLocationToGoogle({
						organizationId: ctx.organization.id,
						organizationLocationId: ctx.location.id,
						fields: ['links'],
						now,
						ctx,
					})
					result.pushed += 1
				}
			}

			// 3. Pull listing diffs & reconcile pending profile fields.
			await pullLocation({
				organizationId: ctx.organization.id,
				organizationLocationId: ctx.location.id,
				now,
			})
			result.pulled += 1

			// 4. Weekly order-links re-check (#199: alerts if a delivery-app link returns as preferred).
			const [latestLink] = await db
				.select({ checkedAt: ListingOrderLink.checkedAt })
				.from(ListingOrderLink)
				.where(
					and(
						eq(ListingOrderLink.organizationLocationId, ctx.location.id),
						eq(ListingOrderLink.state, 'current'),
					),
				)
				.orderBy(desc(ListingOrderLink.checkedAt))
				.limit(1)
			const needsOrderLinkCheck =
				!latestLink || now.getTime() - latestLink.checkedAt.getTime() >= WEEK_MS
			if (needsOrderLinkCheck) {
				await refreshOrderLinks(ctx, { client: options.client, now })
				result.orderLinksChecked += 1
			}

			// 5. Coalesced menu publish (#208: at most once per hour when dirty, or nightly).
			if (flags.write && ctx.sync.menuSyncEnabled) {
				const menuOut = await publishMenu({
					ctx,
					now,
					client: options.client,
				})
				if (menuOut.ok && menuOut.result.status === 'published') {
					result.menusPublished += 1
				}
				const added = await addNewDishPhotos({
					ctx,
					now,
					client: options.client,
				})
				result.photosAdded += added
			}
		} catch {
			result.errors += 1
		}
	}

	return result
}

export type DailyGbpMetricsSweepResult = {
	locations: number
	updated: number
	skipped: number
	failed: number
}

export async function runDailyGbpMetricsSweep(
	options: { now?: Date; client?: GbpClient; organizationId?: string } = {},
): Promise<DailyGbpMetricsSweepResult> {
	const now = options.now ?? new Date()
	const rows = options.organizationId
		? await db
				.select({
					organizationId: GbpLocationSync.organizationId,
					organizationLocationId: GbpLocationSync.organizationLocationId,
				})
				.from(GbpLocationSync)
				.where(eq(GbpLocationSync.organizationId, options.organizationId))
		: await db
				.select({
					organizationId: GbpLocationSync.organizationId,
					organizationLocationId: GbpLocationSync.organizationLocationId,
				})
				.from(GbpLocationSync)

	const result: DailyGbpMetricsSweepResult = {
		locations: rows.length,
		updated: 0,
		skipped: 0,
		failed: 0,
	}

	for (const row of rows) {
		try {
			const ctx = await loadGbpContext(
				row.organizationId,
				row.organizationLocationId,
			)
			if (!ctx) {
				result.skipped += 1
				continue
			}
			const run = await fetchLocationMetrics({
				ctx,
				now,
				client: options.client,
			})
			if (run.status === 'fetched' || run.status === 'backfilled') {
				result.updated += 1
			} else if (run.status === 'skipped') {
				result.skipped += 1
			} else {
				result.failed += 1
			}
		} catch {
			result.failed += 1
		}
	}

	return result
}

/**
 * Called after a Google Business Profile location is linked to a Menuza
 * location. Sets up social account, pulls initial state/verification/order
 * links, and kicks off the 18-month metrics backfill when insights are enabled.
 * Never throws so linking never fails due to a secondary Google call.
 */
export async function onGoogleLocationLinked(input: {
	organizationId: string
	organizationLocationId: string
	now?: Date
	client?: GbpClient
}): Promise<void> {
	const now = input.now ?? new Date()
	try {
		await syncGoogleSocialAccounts(input.organizationId).catch(() => {})
		const flags = await gbpFlags(input.organizationId)
		let ctx = await loadGbpContext(
			input.organizationId,
			input.organizationLocationId,
		)
		if (!ctx || !ctx.integration?.isActive) return

		if (flags.sync) {
			await refreshVerification(ctx, { client: input.client, now }).catch(
				() => {},
			)
			const refreshed = await loadGbpContext(
				input.organizationId,
				input.organizationLocationId,
			)
			if (refreshed) ctx = refreshed
			await pullLocation({
				organizationId: input.organizationId,
				organizationLocationId: input.organizationLocationId,
				now,
			}).catch(() => {})
			await refreshOrderLinks(ctx, { client: input.client, now }).catch(
				() => {},
			)
		}

		if (flags.insights) {
			await fetchLocationMetrics({
				ctx,
				now,
				backfill: true,
				client: input.client,
			}).catch(() => {})
		}
	} catch {
		// Secondary Google sync must never break connecting a location.
	}
}

/**
 * Called after pausing or resuming online ordering (#87). A short pause (under
 * the 60-minute threshold) does not touch Google at all; a long pause removes
 * Menuza's Order online link and resuming puts it back.
 */
export async function onOrderingControlChangedGbp(input: {
	organizationId: string
	organizationLocationId: string
	intent: 'pause' | 'resume' | 'busy' | 'busy_off'
	actorId?: string | null
	now?: Date
}): Promise<void> {
	if (input.intent !== 'pause' && input.intent !== 'resume') return
	const now = input.now ?? new Date()
	try {
		const ctx = await loadGbpContext(
			input.organizationId,
			input.organizationLocationId,
		)
		if (!ctx || !ctx.sync.syncEnabled) return
		if (input.intent === 'pause') {
			const shouldRemove = orderLinkShouldBeRemoved(
				{
					orderingPausedAt: ctx.location.orderingPausedAt,
					orderingPausedUntil: ctx.location.orderingPausedUntil,
				},
				now,
			)
			// Short pause (< 60 minutes): do not call Google at all.
			if (!shouldRemove) return
		}
		await enqueueGbpPush({
			organizationId: input.organizationId,
			organizationLocationId: input.organizationLocationId,
			actorId: input.actorId,
			fields: ['links'],
		})
	} catch {
		// Never block ordering controls on Google.
	}
}

/**
 * Marks linked Google menus dirty after a menu edit or publish (#208) so the
 * coalesced hourly sweep publishes the updated menu within an hour.
 */
export async function markGbpMenuDirty(
	organizationId: string,
	organizationLocationId?: string | null,
	now = new Date(),
): Promise<void> {
	try {
		const conditions = [
			eq(GbpLocationSync.organizationId, organizationId),
			eq(GbpLocationSync.menuSyncEnabled, true),
		]
		if (organizationLocationId) {
			conditions.push(
				eq(GbpLocationSync.organizationLocationId, organizationLocationId),
			)
		}
		await db
			.update(GbpLocationSync)
			.set({ menuDirtyAt: now })
			.where(and(...conditions))
	} catch {
		// Never block menu saves on GBP bookkeeping.
	}
}

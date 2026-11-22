import {
	restyleBudgetLeft,
	restyleRunStatusFrom,
	nextBudgetReset,
	type RestyleRunStatus,
} from '@repo/common/media-restyle'
import {
	and,
	db,
	eq,
	sql,
	MarketingEmailTemplate,
	MediaRestyleRun,
	MediaRestyleRunItem,
	Organization,
	OrganizationMediaAsset,
	OrganizationMenuItem,
	OrganizationMenuOption,
	SocialPost,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import {
	columnContains,
	configContains,
	emailTemplateReferenceCondition,
	menuItemReferenceCondition,
	menuOptionReferenceCondition,
	publishedPageReferenceCondition,
	siteChromeReferenceCondition,
} from '#app/utils/media/references.server.ts'
import { deleteOrganizationStorageObject } from '#app/utils/storage.server.ts'

/**
 * Shared pieces of the menu restyle (#146): throwing a draft away safely and
 * keeping a run's counters and status in step with its items.
 */

export type RestyleRemove = typeof deleteOrganizationStorageObject

/** Is the stored file still used anywhere (a dish, a page, a template...)? */
async function objectIsReferenced(
	organizationId: string,
	objectKey: string,
	assetId: string,
) {
	const [
		asset,
		page,
		publishedPage,
		socialPost,
		emailTemplate,
		menuItem,
		menuOption,
		chrome,
	] = await Promise.all([
		db
			.select({ id: OrganizationMediaAsset.id })
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, organizationId),
					eq(OrganizationMediaAsset.objectKey, objectKey),
				),
			)
			.limit(1),
		db
			.select({ id: WebsitePageSection.id })
			.from(WebsitePageSection)
			.innerJoin(WebsitePage, eq(WebsitePageSection.pageId, WebsitePage.id))
			.where(
				and(
					eq(WebsitePage.organizationId, organizationId),
					sql`(${configContains(objectKey)} OR ${configContains(assetId)})`,
				),
			)
			.limit(1),
		db
			.select({ id: WebsitePage.id })
			.from(WebsitePage)
			.where(
				and(
					eq(WebsitePage.organizationId, organizationId),
					publishedPageReferenceCondition(objectKey, assetId),
				),
			)
			.limit(1),
		db
			.select({ id: SocialPost.id })
			.from(SocialPost)
			.where(
				and(
					eq(SocialPost.organizationId, organizationId),
					columnContains(SocialPost.media, assetId),
				),
			)
			.limit(1),
		db
			.select({ id: MarketingEmailTemplate.id })
			.from(MarketingEmailTemplate)
			.where(
				and(
					eq(MarketingEmailTemplate.organizationId, organizationId),
					emailTemplateReferenceCondition(objectKey, assetId),
				),
			)
			.limit(1),
		db
			.select({ id: OrganizationMenuItem.id })
			.from(OrganizationMenuItem)
			.where(
				and(
					eq(OrganizationMenuItem.organizationId, organizationId),
					menuItemReferenceCondition(objectKey, assetId),
				),
			)
			.limit(1),
		db
			.select({ id: OrganizationMenuOption.id })
			.from(OrganizationMenuOption)
			.where(
				and(
					eq(OrganizationMenuOption.organizationId, organizationId),
					menuOptionReferenceCondition(objectKey, assetId),
				),
			)
			.limit(1),
		db
			.select({ id: Organization.id })
			.from(Organization)
			.where(
				and(
					eq(Organization.id, organizationId),
					siteChromeReferenceCondition(objectKey, assetId),
				),
			)
			.limit(1),
	])
	return [
		asset,
		page,
		publishedPage,
		socialPost,
		emailTemplate,
		menuItem,
		menuOption,
		chrome,
	].some((rows) => rows.length > 0)
}

/**
 * Deletes a restyle draft: its library row (only while it is still a `draft`,
 * so a draft that was used is never touched) and then its stored file, but
 * only when nothing else uses that file. Returns whether the row was deleted.
 */
export async function deleteDraftAsset(
	input: { organizationId: string; assetId: string },
	deps: { remove?: RestyleRemove } = {},
): Promise<boolean> {
	const [deleted] = await db
		.delete(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.id, input.assetId),
				eq(OrganizationMediaAsset.organizationId, input.organizationId),
				eq(OrganizationMediaAsset.status, 'draft'),
			),
		)
		.returning({
			objectKey: OrganizationMediaAsset.objectKey,
			storageScope: OrganizationMediaAsset.storageScope,
		})
	if (!deleted) return false
	const referenced = await objectIsReferenced(
		input.organizationId,
		deleted.objectKey,
		input.assetId,
	).catch(() => true)
	if (!referenced) {
		const remove = deps.remove ?? deleteOrganizationStorageObject
		try {
			await remove(
				deleted.objectKey,
				input.organizationId,
				deleted.storageScope === 'platform' ? 'platform' : 'organization',
			)
		} catch (error) {
			console.error(
				`Failed to remove restyle draft ${deleted.objectKey}:`,
				error,
			)
		}
	}
	return true
}

/** The start of the UTC day `now` falls in. */
export function utcDayStart(now: Date) {
	return new Date(
		Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
	)
}

/** Photos the organization already restyled today (UTC), across runs. */
export async function restyledToday(organizationId: string, now: Date) {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(MediaRestyleRunItem)
		.where(
			and(
				eq(MediaRestyleRunItem.organizationId, organizationId),
				sql`${MediaRestyleRunItem.processedAt} >= ${utcDayStart(now).getTime()}`,
				sql`${MediaRestyleRunItem.processedAt} < ${nextBudgetReset(now).getTime()}`,
			),
		)
	return Number(row?.count ?? 0)
}

/**
 * Recounts a run from its items and sets its counters and status. A run the
 * operator cancelled stays cancelled. A run out of budget is `paused` until
 * the next budget day.
 */
export async function refreshRunCounters(
	runId: string,
	now: Date,
): Promise<{
	status: RestyleRunStatus
	pending: number
	resumeAt: Date | null
} | null> {
	const [run] = await db
		.select({
			id: MediaRestyleRun.id,
			organizationId: MediaRestyleRun.organizationId,
			status: MediaRestyleRun.status,
		})
		.from(MediaRestyleRun)
		.where(eq(MediaRestyleRun.id, runId))
		.limit(1)
	if (!run) return null
	const rows = await db
		.select({
			status: MediaRestyleRunItem.status,
			count: sql<number>`count(*)`,
		})
		.from(MediaRestyleRunItem)
		.where(eq(MediaRestyleRunItem.runId, runId))
		.groupBy(MediaRestyleRunItem.status)
	const count = (status: string) =>
		Number(rows.find((row) => row.status === status)?.count ?? 0)
	const pending = count('pending')
	const done = count('drafted')
	const failed = count('failed')
	const skipped = count('skipped')
	const total = pending + done + failed + skipped
	const budgetLeft = restyleBudgetLeft(
		await restyledToday(run.organizationId, now),
	)
	const status = restyleRunStatusFrom({
		pending,
		budgetLeft,
		cancelled: run.status === 'cancelled',
	})
	const resumeAt = status === 'paused' ? nextBudgetReset(now) : null
	await db
		.update(MediaRestyleRun)
		.set({
			status,
			total,
			done,
			failed,
			skipped,
			resumeAt,
			completedAt: status === 'ready' || status === 'cancelled' ? now : null,
		})
		.where(eq(MediaRestyleRun.id, runId))
	return { status, pending, resumeAt }
}

/** Run ids of items, for refreshing the runs a sweep touched. */
export function uniqueRunIds(rows: Array<{ runId: string }>) {
	return [...new Set(rows.map((row) => row.runId))]
}

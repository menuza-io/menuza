import { AuditAction } from '@repo/audit'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	lt,
	lte,
	Notification,
	Organization,
	User,
	WebsitePage,
	WebsiteScheduledPublish,
} from '@repo/database'
import { sql } from 'drizzle-orm'
import { notifyIndexNowForPages } from '#app/utils/seo/indexnow.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { logWebsiteActivity } from './activity.server.ts'
import {
	insertVersionStatement,
	loadDraftSections,
	pruneVersionsStatement,
} from './versions.server.ts'
import {
	hashChrome,
	hashSections,
	hashTheme,
	parseChromeSnapshot,
	parseSnapshotSections,
	summarizeSectionChange,
	canonicalJson,
	type ChromeSnapshot,
} from './versions.ts'
import { WEBSITE_ALERT_TYPES } from './website-alerts.ts'

/** A schedule may be set at least this far ahead... */
export const MIN_SCHEDULE_LEAD_MS = 5 * 60_000
/** ...and at most this far (a Workflow sleeps up to a year; we stay well under). */
export const MAX_SCHEDULE_LEAD_MS = 90 * 24 * 60 * 60_000
/** A publish that failed this many times stops and tells the scheduler. */
export const MAX_SCHEDULE_ATTEMPTS = 3
/** A `running` claim older than this was abandoned (the Worker died). */
export const STALE_RUNNING_MS = 10 * 60_000

export const SITE_SCOPE = 'site'

export type ScheduleError = 'invalid_schedule_time' | 'nothing_to_publish'

/** What a site-design schedule freezes: only the parts that have a draft. */
export type SiteSchedulePayload = {
	chrome?: ChromeSnapshot
	theme?: string | null
}

export function scopeKeyOf(pageId: string | null) {
	return pageId ?? SITE_SCOPE
}

export function isScheduleTimeValid(runAt: Date, now = new Date()) {
	const lead = runAt.getTime() - now.getTime()
	return (
		Number.isFinite(runAt.getTime()) &&
		lead >= MIN_SCHEDULE_LEAD_MS &&
		lead <= MAX_SCHEDULE_LEAD_MS
	)
}

/**
 * Schedules a page, or (`pageId` null) the pending site design, to go live at
 * `runAt`. The draft is frozen into the schedule now, in the version snapshot
 * format, so edits made later stay in the draft and are not published by the
 * schedule. Scheduling again replaces the earlier schedule of that scope.
 */
export async function scheduleWebsitePublish(input: {
	organizationId: string
	userId: string
	pageId: string | null
	runAt: Date
	now?: Date
}): Promise<
	{ ok: true; id: string; runAt: Date } | { ok: false; error: ScheduleError }
> {
	const now = input.now ?? new Date()
	if (!isScheduleTimeValid(input.runAt, now)) {
		return { ok: false, error: 'invalid_schedule_time' }
	}
	let snapshot: string
	if (input.pageId) {
		const sections = await loadDraftSections(input.pageId)
		snapshot = JSON.stringify(
			sections
				.map(({ id: _id, ...rest }) => rest)
				.map((section, index) => ({
					...section,
					position: index,
				})),
		)
	} else {
		const [org] = await db
			.select({
				siteHeaderConfig: Organization.siteHeaderConfig,
				siteFooterConfig: Organization.siteFooterConfig,
				siteTheme: Organization.siteTheme,
				draftHeaderConfig: Organization.draftHeaderConfig,
				draftFooterConfig: Organization.draftFooterConfig,
				draftSiteTheme: Organization.draftSiteTheme,
			})
			.from(Organization)
			.where(eq(Organization.id, input.organizationId))
			.limit(1)
		if (!org) return { ok: false, error: 'nothing_to_publish' }
		const payload: SiteSchedulePayload = {}
		const differs = (draft: string | null, live: string | null) =>
			draft !== null && canonicalJson(draft) !== canonicalJson(live)
		if (
			differs(org.draftHeaderConfig, org.siteHeaderConfig) ||
			differs(org.draftFooterConfig, org.siteFooterConfig)
		) {
			payload.chrome = {
				header: org.draftHeaderConfig ?? org.siteHeaderConfig,
				footer: org.draftFooterConfig ?? org.siteFooterConfig,
			}
		}
		if (differs(org.draftSiteTheme, org.siteTheme)) {
			payload.theme = org.draftSiteTheme
		}
		if (!payload.chrome && payload.theme === undefined) {
			return { ok: false, error: 'nothing_to_publish' }
		}
		snapshot = JSON.stringify(payload)
	}

	const scopeKey = scopeKeyOf(input.pageId)
	const id = crypto.randomUUID().replaceAll('-', '').slice(0, 24)
	// Replace the earlier schedule and add this one in one batch, so there is
	// never a moment with two (the unique index would refuse it) or none.
	await db.batch([
		db
			.update(WebsiteScheduledPublish)
			.set({ status: 'cancelled', completedAt: now })
			.where(
				and(
					eq(WebsiteScheduledPublish.organizationId, input.organizationId),
					eq(WebsiteScheduledPublish.scopeKey, scopeKey),
					eq(WebsiteScheduledPublish.status, 'scheduled'),
				),
			),
		db.insert(WebsiteScheduledPublish).values({
			id,
			organizationId: input.organizationId,
			pageId: input.pageId,
			scopeKey,
			kind: input.pageId ? 'page' : 'site',
			snapshot,
			runAt: input.runAt,
			createdById: input.userId,
		}),
	])
	return { ok: true, id, runAt: input.runAt }
}

/**
 * Cancels the scheduled (not yet running) publish of a page or of the site
 * design. Used by Cancel schedule, by publishing now (the frozen content would
 * otherwise overwrite newer content later), and by unpublishing or deleting
 * the page. Returns whether one was cancelled.
 */
export async function cancelSchedule(
	organizationId: string,
	pageId: string | null,
	reason:
		'cancelled' | 'published_now' | 'unpublished' | 'deleted' = 'cancelled',
) {
	const cancelled = await db
		.update(WebsiteScheduledPublish)
		.set({
			status: 'cancelled',
			completedAt: new Date(),
			lastError: reason === 'cancelled' ? null : reason,
		})
		.where(
			and(
				eq(WebsiteScheduledPublish.organizationId, organizationId),
				eq(WebsiteScheduledPublish.scopeKey, scopeKeyOf(pageId)),
				eq(WebsiteScheduledPublish.status, 'scheduled'),
			),
		)
		.returning({ id: WebsiteScheduledPublish.id })
	return cancelled.length > 0
}

/** The active schedules of an organization, for the page list and the editor. */
export async function listActiveSchedules(organizationId: string) {
	const rows = await db
		.select({
			id: WebsiteScheduledPublish.id,
			pageId: WebsiteScheduledPublish.pageId,
			kind: WebsiteScheduledPublish.kind,
			runAt: WebsiteScheduledPublish.runAt,
			status: WebsiteScheduledPublish.status,
			attempts: WebsiteScheduledPublish.attempts,
		})
		.from(WebsiteScheduledPublish)
		.where(
			and(
				eq(WebsiteScheduledPublish.organizationId, organizationId),
				inArray(WebsiteScheduledPublish.status, ['scheduled', 'running']),
			),
		)
		.orderBy(asc(WebsiteScheduledPublish.runAt))
	return rows.map((row) => ({ ...row, runAt: row.runAt.toISOString() }))
}

type ClaimedSchedule = typeof WebsiteScheduledPublish.$inferSelect

/**
 * Claims one due schedule: `scheduled` to `running`, by exactly one caller.
 * The UPDATE only applies while the row is still `scheduled`, so two sweeps
 * racing for it publish once.
 */
export async function claimSchedule(
	id: string,
	now = new Date(),
): Promise<ClaimedSchedule | null> {
	const [claimed] = await db
		.update(WebsiteScheduledPublish)
		.set({
			status: 'running',
			claimedAt: now,
			attempts: sql`${WebsiteScheduledPublish.attempts} + 1`,
		})
		.where(
			and(
				eq(WebsiteScheduledPublish.id, id),
				eq(WebsiteScheduledPublish.status, 'scheduled'),
				lte(WebsiteScheduledPublish.runAt, now),
			),
		)
		.returning()
	return claimed ?? null
}

/**
 * Applies a schedule's frozen content through the same writes a publish uses
 * (page row, version, pruning; or live chrome and theme with their versions),
 * all in one `db.batch`: nothing goes live unless everything does. The draft
 * rows are left alone, so edits made after scheduling stay drafts.
 */
export async function applySchedule(schedule: ClaimedSchedule) {
	const publishedById = schedule.createdById
	if (schedule.kind === 'page') {
		if (!schedule.pageId) throw new Error('Schedule has no page')
		const [page] = await db
			.select({
				id: WebsitePage.id,
				title: WebsitePage.title,
				slug: WebsitePage.slug,
				publishedData: WebsitePage.publishedData,
			})
			.from(WebsitePage)
			.where(
				and(
					eq(WebsitePage.id, schedule.pageId),
					eq(WebsitePage.organizationId, schedule.organizationId),
				),
			)
			.limit(1)
		if (!page) throw new Error('Page no longer exists')
		const sections = parseSnapshotSections(schedule.snapshot)
		const { id: versionId, statement } = insertVersionStatement(db, {
			organizationId: schedule.organizationId,
			pageId: page.id,
			kind: 'page',
			title: page.title,
			slug: page.slug,
			snapshot: schedule.snapshot,
			contentHash: await hashSections(sections),
			summary: summarizeSectionChange(
				parseSnapshotSections(page.publishedData),
				sections,
			),
			publishedById,
		})
		await db.batch([
			db
				.update(WebsitePage)
				.set({ status: 'published', publishedData: schedule.snapshot })
				.where(eq(WebsitePage.id, page.id)),
			statement,
			pruneVersionsStatement(db, {
				organizationId: schedule.organizationId,
				kind: 'page',
				pageId: page.id,
			}),
			db
				.update(WebsiteScheduledPublish)
				.set({ status: 'done', completedAt: new Date(), lastError: null })
				.where(eq(WebsiteScheduledPublish.id, schedule.id)),
		] as unknown as Parameters<typeof db.batch>[0])
		return { title: page.title, pageId: page.id, versionId }
	}

	let payload: SiteSchedulePayload
	try {
		payload = JSON.parse(schedule.snapshot) as SiteSchedulePayload
	} catch {
		throw new Error('Schedule snapshot is damaged')
	}
	const statements: unknown[] = []
	const set: Record<string, unknown> = {}
	if (payload.chrome) {
		const chrome = parseChromeSnapshot(JSON.stringify(payload.chrome))
		statements.push(
			insertVersionStatement(db, {
				organizationId: schedule.organizationId,
				pageId: null,
				kind: 'chrome',
				snapshot: JSON.stringify(chrome),
				contentHash: await hashChrome(chrome),
				publishedById,
			}).statement,
			pruneVersionsStatement(db, {
				organizationId: schedule.organizationId,
				kind: 'chrome',
				pageId: null,
			}),
		)
		set.siteHeaderConfig = chrome.header
		set.siteFooterConfig = chrome.footer
		// A draft equal to what just went live is no longer a draft; a later
		// edit is kept as the new draft.
		set.draftHeaderConfig = sql`CASE WHEN ${Organization.draftHeaderConfig} IS ${chrome.header} THEN NULL ELSE ${Organization.draftHeaderConfig} END`
		set.draftFooterConfig = sql`CASE WHEN ${Organization.draftFooterConfig} IS ${chrome.footer} THEN NULL ELSE ${Organization.draftFooterConfig} END`
	}
	if (payload.theme !== undefined) {
		statements.push(
			insertVersionStatement(db, {
				organizationId: schedule.organizationId,
				pageId: null,
				kind: 'theme',
				snapshot: payload.theme ?? '',
				contentHash: await hashTheme(payload.theme),
				publishedById,
			}).statement,
			pruneVersionsStatement(db, {
				organizationId: schedule.organizationId,
				kind: 'theme',
				pageId: null,
			}),
		)
		set.siteTheme = payload.theme
		set.draftSiteTheme = sql`CASE WHEN ${Organization.draftSiteTheme} IS ${payload.theme} THEN NULL ELSE ${Organization.draftSiteTheme} END`
	}
	if (Object.keys(set).length === 0)
		throw new Error('Schedule has nothing to publish')
	await db.batch([
		...statements,
		db
			.update(Organization)
			.set(set)
			.where(eq(Organization.id, schedule.organizationId)),
		db
			.update(WebsiteScheduledPublish)
			.set({ status: 'done', completedAt: new Date(), lastError: null })
			.where(eq(WebsiteScheduledPublish.id, schedule.id)),
	] as unknown as Parameters<typeof db.batch>[0])
	return { title: null, pageId: null, versionId: null }
}

async function notifyScheduler(
	schedule: ClaimedSchedule,
	kind: 'live' | 'failed',
	title: string | null,
) {
	if (!schedule.createdById) return
	const [org] = await db
		.select({ slug: Organization.slug })
		.from(Organization)
		.where(eq(Organization.id, schedule.organizationId))
		.limit(1)
	const [user] = await db
		.select({ id: User.id })
		.from(User)
		.where(eq(User.id, schedule.createdById))
		.limit(1)
	if (!org || !user) return
	await db
		.insert(Notification)
		.values({
			userId: user.id,
			organizationId: schedule.organizationId,
			type: WEBSITE_ALERT_TYPES[kind],
			// One notice per schedule and outcome.
			entityId: `${schedule.id}:${kind}`,
			payload: JSON.stringify({
				orgSlug: org.slug,
				pageId: schedule.pageId,
				pageTitle: title,
			}),
		})
		.onConflictDoNothing()
}

export type RunScheduleOutcome = 'published' | 'retry' | 'failed'

/** Runs one claimed schedule; failures retry on the next sweep, three stop. */
export async function runClaimedSchedule(
	schedule: ClaimedSchedule,
): Promise<RunScheduleOutcome> {
	const [org] = await db
		.select({
			slug: Organization.slug,
			customDomain: Organization.customDomain,
		})
		.from(Organization)
		.where(eq(Organization.id, schedule.organizationId))
		.limit(1)
	try {
		const result = await applySchedule(schedule)
		if (org) {
			await purgeOrganizationSiteCache(
				schedule.organizationId,
				org.slug,
				org.customDomain,
			)
		}
		if (result.pageId) {
			try {
				await notifyIndexNowForPages(schedule.organizationId, [result.pageId])
			} catch {
				// A search engine must never undo a publish.
			}
		}
		await notifyScheduler(schedule, 'live', result.title)
		await logWebsiteActivity({
			action: AuditAction.WEBSITE_SCHEDULED_PUBLISH_RAN,
			organizationId: schedule.organizationId,
			userId: schedule.createdById,
			details: result.title
				? `The scheduled publish of "${result.title}" went live.`
				: 'The scheduled site design publish went live.',
			metadata: {
				pageId: result.pageId,
				pageTitle: result.title,
				versionId: result.versionId,
				scheduleId: schedule.id,
			},
		})
		return 'published'
	} catch (error) {
		const message = (
			error instanceof Error ? error.message : String(error)
		).slice(0, 300)
		const exhausted = schedule.attempts >= MAX_SCHEDULE_ATTEMPTS
		await db
			.update(WebsiteScheduledPublish)
			.set({
				status: exhausted ? 'failed' : 'scheduled',
				lastError: message,
				...(exhausted ? { completedAt: new Date() } : {}),
			})
			.where(
				and(
					eq(WebsiteScheduledPublish.id, schedule.id),
					eq(WebsiteScheduledPublish.status, 'running'),
				),
			)
		if (exhausted) {
			let title: string | null = null
			if (schedule.pageId) {
				const [page] = await db
					.select({ title: WebsitePage.title })
					.from(WebsitePage)
					.where(eq(WebsitePage.id, schedule.pageId))
					.limit(1)
				title = page?.title ?? null
			}
			await notifyScheduler(schedule, 'failed', title)
			await logWebsiteActivity({
				action: AuditAction.WEBSITE_SCHEDULED_PUBLISH_FAILED,
				organizationId: schedule.organizationId,
				userId: schedule.createdById,
				details: title
					? `The scheduled publish of "${title}" failed ${schedule.attempts} times and was stopped.`
					: 'The scheduled site design publish failed and was stopped.',
				metadata: {
					pageId: schedule.pageId,
					pageTitle: title,
					scheduleId: schedule.id,
				},
			})
		}
		return exhausted ? 'failed' : 'retry'
	}
}

/**
 * The scheduled publisher (the job route and the workflow wake-up both call
 * it): hands abandoned claims back, then claims and runs every due schedule.
 * Safe to call from any number of callers at once: a row is claimed once.
 */
export async function publishDueSchedules(
	now = new Date(),
	limit = 25,
): Promise<{ published: number; retried: number; failed: number }> {
	await db
		.update(WebsiteScheduledPublish)
		.set({ status: 'scheduled', lastError: 'interrupted' })
		.where(
			and(
				eq(WebsiteScheduledPublish.status, 'running'),
				lt(
					WebsiteScheduledPublish.claimedAt,
					new Date(now.getTime() - STALE_RUNNING_MS),
				),
				lt(WebsiteScheduledPublish.attempts, MAX_SCHEDULE_ATTEMPTS),
			),
		)
	await db
		.update(WebsiteScheduledPublish)
		.set({ status: 'failed', lastError: 'interrupted', completedAt: now })
		.where(
			and(
				eq(WebsiteScheduledPublish.status, 'running'),
				lt(
					WebsiteScheduledPublish.claimedAt,
					new Date(now.getTime() - STALE_RUNNING_MS),
				),
			),
		)
	const due = await db
		.select({ id: WebsiteScheduledPublish.id })
		.from(WebsiteScheduledPublish)
		.where(
			and(
				eq(WebsiteScheduledPublish.status, 'scheduled'),
				lte(WebsiteScheduledPublish.runAt, now),
			),
		)
		.orderBy(asc(WebsiteScheduledPublish.runAt))
		.limit(limit)
	const totals = { published: 0, retried: 0, failed: 0 }
	for (const { id } of due) {
		const claimed = await claimSchedule(id, now)
		if (!claimed) continue
		const outcome = await runClaimedSchedule(claimed)
		if (outcome === 'published') totals.published++
		else if (outcome === 'retry') totals.retried++
		else totals.failed++
	}
	return totals
}

/** Drops finished schedule rows after 30 days (daily prune job). */
export async function pruneFinishedSchedules(now = new Date()) {
	const removed = await db
		.delete(WebsiteScheduledPublish)
		.where(
			and(
				inArray(WebsiteScheduledPublish.status, [
					'done',
					'cancelled',
					'failed',
				]),
				lt(
					WebsiteScheduledPublish.updatedAt,
					new Date(now.getTime() - 30 * 86_400_000),
				),
			),
		)
		.returning({ id: WebsiteScheduledPublish.id })
	return removed.length
}

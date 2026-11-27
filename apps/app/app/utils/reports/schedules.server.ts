import {
	and,
	asc,
	count,
	db,
	eq,
	inArray,
	isNull,
	Notification,
	Organization,
	OrganizationLocation,
	ReportSchedule,
	ReportScheduleRecipient,
	SavedReport,
	User,
	UserOrganization,
} from '@repo/database'
import { getFeatureFlag } from '@repo/common/feature-flags'
import { sendEmail } from '@repo/email'
import {
	DAILY_SUMMARY_PRESET,
	dailyAsOf,
	definitionAllowed,
	personalFieldsUsed,
	REPORT_HAS_PERSONAL_FIELDS,
	type ReportDefinition,
} from '@repo/reports'
import { reportSendResponseSchema } from '@repo/reports/send-contract'
import {
	dueRunKey,
	DAILY_SUMMARY_BUILT_IN,
	nextRetryAt,
	REPORT_SCHEDULE_FAILED_DAYS_TO_PAUSE,
	REPORT_SCHEDULE_LIMITS,
	reportScheduleInputSchema,
	type ReportScheduleInput,
} from '@repo/reports/schedule'
import { parseDefinition } from '@repo/reports/server'
import { isFlagOn, zonedLocalToUtc } from '@repo/staffing'
import { readLiveEnv } from '#app/utils/env.server.ts'
import { organizationReportCatalog } from '#app/utils/staffing/restaurant/report-catalog.server.ts'
import { resolveReportGrantsForRequest } from '#app/utils/staffing/report-grants.server.ts'
import { resolveReportTokenGrantsForMember } from './token-grants.server.ts'
import { reviewFigureValue, resolveFigureModules } from './modules.server.ts'
import { postRegionalReports } from './regional-reports.server.ts'
import { reportUnsubscribeUrl } from './report-unsubscribe.server.ts'

/**
 * Scheduled report emails (#121), App side. The control plane keeps the
 * schedule, its recipients and how the last sends went; the region runs the
 * report and sends the email (`POST /internal/reports/send`). This module
 * owns the rules the issue sets:
 *  - at most 10 schedules per organization, 20 recipients per schedule;
 *  - recipients are organization members only (no free-text address);
 *  - a report that reads a personal field (a customer name, phone or email)
 *    cannot be scheduled;
 *  - at send time every recipient must still be an active member and hold the
 *    grants for the report, else they are skipped (`skipped_no_access`);
 *  - a failed send is retried twice with backoff; three failed days in a row
 *    pause the schedule and tell its creator.
 */

export const REPORT_SCHEDULES_FLAG = 'reports.schedules'

export async function isReportSchedulesEnabled(organizationId: string) {
	return isFlagOn(await getFeatureFlag(REPORT_SCHEDULES_FLAG, { organizationId }))
}

export type ScheduleInput = ReportScheduleInput & {
	/** A saved report id, or null for the built-in daily summary. */
	savedReportId: string | null
	recipientUserIds: string[]
	locale: 'en' | 'ar'
}

export type ScheduleError =
	| 'feature_off'
	| 'not_found'
	| 'report_not_found'
	| 'not_allowed'
	| 'too_many_schedules'
	| 'too_many_recipients'
	| 'no_recipients'
	| 'invalid_recipient'
	| 'invalid_schedule'
	| 'daily_summary_is_daily'
	| typeof REPORT_HAS_PERSONAL_FIELDS

export type ScheduleResult<T = { id: string }> =
	| { ok: true; data: T }
	| { ok: false; error: ScheduleError; detail?: string[] }

/** The organization's reporting zone: its first location's, UTC without one. */
export async function defaultReportingTimeZone(organizationId: string) {
	const [first] = await db
		.select({ timezone: OrganizationLocation.timezone })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
		.orderBy(asc(OrganizationLocation.createdAt))
		.limit(1)
	return first?.timezone ?? 'UTC'
}

async function activeMemberIds(organizationId: string, userIds: string[]) {
	if (userIds.length === 0) return new Set<string>()
	const rows = await db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.organizationId, organizationId),
				eq(UserOrganization.active, true),
				inArray(UserOrganization.userId, userIds),
			),
		)
	return new Set(rows.map((r) => r.userId))
}

/**
 * Checks what a schedule would send: the saved report exists in this
 * organization, the creator may open it, and it holds no personal field.
 */
async function validateReport(input: {
	organizationId: string
	userId: string
	request: Request
	savedReportId: string | null
}): Promise<ScheduleResult<{ definition: ReportDefinition | null }>> {
	if (input.savedReportId === null) return { ok: true, data: { definition: null } }
	const [report] = await db
		.select()
		.from(SavedReport)
		.where(
			and(
				eq(SavedReport.id, input.savedReportId),
				eq(SavedReport.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!report) return { ok: false, error: 'report_not_found' }
	const definition = parseDefinition(report.definition)
	const grants = await resolveReportGrantsForRequest(
		input.request,
		input.userId,
		input.organizationId,
	)
	const { catalog } = await organizationReportCatalog(input.organizationId)
	if (!definitionAllowed(catalog, definition, grants)) {
		return { ok: false, error: 'report_not_found' }
	}
	const personal = personalFieldsUsed(catalog, definition)
	if (personal.length > 0) {
		return { ok: false, error: REPORT_HAS_PERSONAL_FIELDS, detail: personal }
	}
	return { ok: true, data: { definition } }
}

function parseInput(input: ScheduleInput): ScheduleResult<ReportScheduleInput> {
	const parsed = reportScheduleInputSchema.safeParse({
		cadence: input.cadence,
		weekday: input.weekday ?? null,
		hour: input.hour,
		timeZone: input.timeZone,
	})
	if (!parsed.success) return { ok: false, error: 'invalid_schedule' }
	if (input.savedReportId === null && parsed.data.cadence !== 'daily') {
		return { ok: false, error: 'daily_summary_is_daily' }
	}
	return { ok: true, data: parsed.data }
}

async function checkRecipients(
	organizationId: string,
	userIds: string[],
): Promise<ScheduleResult<string[]>> {
	const unique = [...new Set(userIds)]
	if (unique.length === 0) return { ok: false, error: 'no_recipients' }
	if (unique.length > REPORT_SCHEDULE_LIMITS.recipientsPerSchedule) {
		return { ok: false, error: 'too_many_recipients' }
	}
	const members = await activeMemberIds(organizationId, unique)
	if (unique.some((id) => !members.has(id))) {
		return { ok: false, error: 'invalid_recipient' }
	}
	return { ok: true, data: unique }
}

export async function createReportSchedule(input: {
	organizationId: string
	userId: string
	request: Request
	schedule: ScheduleInput
}): Promise<ScheduleResult> {
	if (!(await isReportSchedulesEnabled(input.organizationId))) {
		return { ok: false, error: 'feature_off' }
	}
	const timing = parseInput(input.schedule)
	if (!timing.ok) return timing
	const recipients = await checkRecipients(
		input.organizationId,
		input.schedule.recipientUserIds,
	)
	if (!recipients.ok) return recipients
	const report = await validateReport({
		organizationId: input.organizationId,
		userId: input.userId,
		request: input.request,
		savedReportId: input.schedule.savedReportId,
	})
	if (!report.ok) return report
	const [counted] = await db
		.select({ n: count() })
		.from(ReportSchedule)
		.where(eq(ReportSchedule.organizationId, input.organizationId))
	if (Number(counted?.n ?? 0) >= REPORT_SCHEDULE_LIMITS.schedulesPerOrganization) {
		return { ok: false, error: 'too_many_schedules' }
	}
	const [created] = await db
		.insert(ReportSchedule)
		.values({
			organizationId: input.organizationId,
			savedReportId: input.schedule.savedReportId,
			builtIn:
				input.schedule.savedReportId === null ? DAILY_SUMMARY_BUILT_IN : null,
			cadence: timing.data.cadence,
			weekday: timing.data.weekday,
			hour: timing.data.hour,
			timeZone: timing.data.timeZone,
			locale: input.schedule.locale,
			createdById: input.userId,
		})
		.returning({ id: ReportSchedule.id })
	await db
		.insert(ReportScheduleRecipient)
		.values(recipients.data.map((userId) => ({ scheduleId: created!.id, userId })))
	return { ok: true, data: { id: created!.id } }
}

async function loadOwnedSchedule(organizationId: string, scheduleId: string) {
	const [schedule] = await db
		.select()
		.from(ReportSchedule)
		.where(
			and(
				eq(ReportSchedule.id, scheduleId),
				eq(ReportSchedule.organizationId, organizationId),
			),
		)
		.limit(1)
	return schedule ?? null
}

export async function updateReportSchedule(input: {
	organizationId: string
	userId: string
	request: Request
	scheduleId: string
	schedule: Omit<ScheduleInput, 'savedReportId'>
}): Promise<ScheduleResult> {
	const existing = await loadOwnedSchedule(input.organizationId, input.scheduleId)
	if (!existing) return { ok: false, error: 'not_found' }
	const timing = parseInput({
		...input.schedule,
		savedReportId: existing.savedReportId,
	})
	if (!timing.ok) return timing
	const recipients = await checkRecipients(
		input.organizationId,
		input.schedule.recipientUserIds,
	)
	if (!recipients.ok) return recipients
	// Editing re-checks the report (a definition edited since may now read a
	// personal field), and wakes a schedule that was paused by failures.
	const report = await validateReport({
		organizationId: input.organizationId,
		userId: input.userId,
		request: input.request,
		savedReportId: existing.savedReportId,
	})
	if (!report.ok) return report
	await db
		.update(ReportSchedule)
		.set({
			cadence: timing.data.cadence,
			weekday: timing.data.weekday,
			hour: timing.data.hour,
			timeZone: timing.data.timeZone,
			locale: input.schedule.locale,
			failureDays: 0,
			retryCount: 0,
			nextAttemptAt: null,
			lastError: null,
			...(existing.pausedReason === 'failures'
				? { pausedAt: null, pausedReason: null }
				: {}),
		})
		.where(eq(ReportSchedule.id, existing.id))
	const current = await db
		.select({ userId: ReportScheduleRecipient.userId })
		.from(ReportScheduleRecipient)
		.where(eq(ReportScheduleRecipient.scheduleId, existing.id))
	const keep = new Set(recipients.data)
	const stale = current.map((r) => r.userId).filter((id) => !keep.has(id))
	if (stale.length > 0) {
		await db
			.delete(ReportScheduleRecipient)
			.where(
				and(
					eq(ReportScheduleRecipient.scheduleId, existing.id),
					inArray(ReportScheduleRecipient.userId, stale),
				),
			)
	}
	const have = new Set(current.map((r) => r.userId))
	const added = recipients.data.filter((id) => !have.has(id))
	if (added.length > 0) {
		await db
			.insert(ReportScheduleRecipient)
			.values(added.map((userId) => ({ scheduleId: existing.id, userId })))
	}
	return { ok: true, data: { id: existing.id } }
}

export async function setReportSchedulePaused(input: {
	organizationId: string
	scheduleId: string
	paused: boolean
}): Promise<ScheduleResult> {
	const existing = await loadOwnedSchedule(input.organizationId, input.scheduleId)
	if (!existing) return { ok: false, error: 'not_found' }
	await db
		.update(ReportSchedule)
		.set(
			input.paused
				? { pausedAt: new Date(), pausedReason: 'manual' }
				: {
						pausedAt: null,
						pausedReason: null,
						failureDays: 0,
						retryCount: 0,
						nextAttemptAt: null,
						lastError: null,
					},
		)
		.where(eq(ReportSchedule.id, existing.id))
	return { ok: true, data: { id: existing.id } }
}

export async function deleteReportSchedule(input: {
	organizationId: string
	scheduleId: string
}): Promise<ScheduleResult> {
	const existing = await loadOwnedSchedule(input.organizationId, input.scheduleId)
	if (!existing) return { ok: false, error: 'not_found' }
	await db.delete(ReportSchedule).where(eq(ReportSchedule.id, existing.id))
	return { ok: true, data: { id: existing.id } }
}

export type ScheduleRow = {
	id: string
	title: string | null
	builtIn: string | null
	savedReportId: string | null
	cadence: string
	weekday: number | null
	hour: number
	timeZone: string
	locale: string
	pausedAt: Date | null
	pausedReason: string | null
	lastSentAt: Date | null
	lastError: string | null
	failureDays: number
	recipients: Array<{
		userId: string
		name: string | null
		email: string
		unsubscribed: boolean
		lastStatus: string | null
	}>
}

/** The schedules page: every schedule with its recipients and how the last send went. */
export async function listReportSchedules(
	organizationId: string,
): Promise<ScheduleRow[]> {
	const rows = await db
		.select({
			schedule: ReportSchedule,
			title: SavedReport.title,
		})
		.from(ReportSchedule)
		.leftJoin(SavedReport, eq(SavedReport.id, ReportSchedule.savedReportId))
		.where(eq(ReportSchedule.organizationId, organizationId))
		.orderBy(asc(ReportSchedule.createdAt))
	if (rows.length === 0) return []
	const recipients = await db
		.select({
			scheduleId: ReportScheduleRecipient.scheduleId,
			userId: ReportScheduleRecipient.userId,
			unsubscribedAt: ReportScheduleRecipient.unsubscribedAt,
			lastStatus: ReportScheduleRecipient.lastStatus,
			name: User.name,
			email: User.email,
		})
		.from(ReportScheduleRecipient)
		.innerJoin(User, eq(User.id, ReportScheduleRecipient.userId))
		.where(
			inArray(
				ReportScheduleRecipient.scheduleId,
				rows.map((r) => r.schedule.id),
			),
		)
	return rows.map(({ schedule, title }) => ({
		id: schedule.id,
		title,
		builtIn: schedule.builtIn,
		savedReportId: schedule.savedReportId,
		cadence: schedule.cadence,
		weekday: schedule.weekday,
		hour: schedule.hour,
		timeZone: schedule.timeZone,
		locale: schedule.locale,
		pausedAt: schedule.pausedAt,
		pausedReason: schedule.pausedReason,
		lastSentAt: schedule.lastSentAt,
		lastError: schedule.lastError,
		failureDays: schedule.failureDays,
		recipients: recipients
			.filter((r) => r.scheduleId === schedule.id)
			.map((r) => ({
				userId: r.userId,
				name: r.name,
				email: r.email,
				unsubscribed: r.unsubscribedAt !== null,
				lastStatus: r.lastStatus,
			})),
	}))
}

/** What the Settings, Notifications page lists for a member: their report emails. */
export async function listMemberReportEmails(input: {
	userId: string
	organizationId: string
}) {
	const rows = await db
		.select({
			scheduleId: ReportSchedule.id,
			title: SavedReport.title,
			builtIn: ReportSchedule.builtIn,
			cadence: ReportSchedule.cadence,
			unsubscribedAt: ReportScheduleRecipient.unsubscribedAt,
		})
		.from(ReportScheduleRecipient)
		.innerJoin(
			ReportSchedule,
			eq(ReportSchedule.id, ReportScheduleRecipient.scheduleId),
		)
		.leftJoin(SavedReport, eq(SavedReport.id, ReportSchedule.savedReportId))
		.where(
			and(
				eq(ReportScheduleRecipient.userId, input.userId),
				eq(ReportSchedule.organizationId, input.organizationId),
			),
		)
	return rows.map((row) => ({
		scheduleId: row.scheduleId,
		title: row.title,
		builtIn: row.builtIn,
		cadence: row.cadence,
		subscribed: row.unsubscribedAt === null,
	}))
}

export async function setMemberReportEmail(input: {
	userId: string
	scheduleId: string
	organizationId: string
	subscribed: boolean
}) {
	const schedule = await loadOwnedSchedule(input.organizationId, input.scheduleId)
	if (!schedule) return false
	await db
		.update(ReportScheduleRecipient)
		.set({ unsubscribedAt: input.subscribed ? null : new Date() })
		.where(
			and(
				eq(ReportScheduleRecipient.scheduleId, input.scheduleId),
				eq(ReportScheduleRecipient.userId, input.userId),
			),
		)
	return true
}

// ---------------------------------------------------------------------------
// The hourly job
// ---------------------------------------------------------------------------

export type RunSchedulesDeps = {
	now?: Date
	/** Sends one request to the region; tests inject a fake. */
	post?: typeof postRegionalReports
	sendEmailImpl?: typeof sendEmail
}

export type RunSchedulesSummary = {
	checked: number
	due: number
	sent: number
	retried: number
	failed: number
	paused: number
	skipped: number
}

async function notifyCreatorPaused(
	schedule: typeof ReportSchedule.$inferSelect,
	title: string,
	send: typeof sendEmail,
) {
	const [org] = await db
		.select({ name: Organization.name, slug: Organization.slug })
		.from(Organization)
		.where(eq(Organization.id, schedule.organizationId))
		.limit(1)
	const [creator] = await db
		.select({ email: User.email })
		.from(User)
		.where(eq(User.id, schedule.createdById))
		.limit(1)
	if (!org) return
	await db
		.insert(Notification)
		.values({
			userId: schedule.createdById,
			organizationId: schedule.organizationId,
			type: 'reports.schedule_paused',
			entityId: `report-schedule:${schedule.id}:paused`,
			payload: JSON.stringify({ orgSlug: org.slug, scheduleId: schedule.id }),
		})
		.onConflictDoNothing()
	if (!creator) return
	const url = `${readLiveEnv('BASE_URL').replace(/\/$/u, '')}/${org.slug}/reports/schedules`
	try {
		await send({
			to: creator.email,
			subject: `Scheduled report paused: ${title}`,
			html: `<p>The scheduled report "${escapeHtml(title)}" for ${escapeHtml(org.name)} failed ${REPORT_SCHEDULE_FAILED_DAYS_TO_PAUSE} days in a row and was paused.</p><p><a href="${escapeHtml(url)}">Open schedules</a></p>`,
			text: `The scheduled report "${title}" for ${org.name} failed ${REPORT_SCHEDULE_FAILED_DAYS_TO_PAUSE} days in a row and was paused.\nOpen schedules: ${url}`,
		})
	} catch (error) {
		console.error('Report schedule pause notice failed:', error)
	}
}

function escapeHtml(value: string) {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
}

/** The instant a run is for: the scheduled hour of its local date in the schedule's zone. */
function runInstant(runKey: string, hour: number, timeZone: string): Date {
	const [y, m, d] = runKey.split('-').map(Number) as [number, number, number]
	return new Date(zonedLocalToUtc(y, m, d, hour, 0, timeZone))
}

/**
 * Sends every schedule that is due (called hourly by jobs-cron). Idempotent: a
 * schedule runs once per local date (`lastRunKey`), a failed run is retried
 * from the same instant, and a paused or flagged-off schedule is left alone.
 */
export async function runDueReportSchedules(
	deps: RunSchedulesDeps = {},
): Promise<RunSchedulesSummary> {
	const now = deps.now ?? new Date()
	const post = deps.post ?? postRegionalReports
	const send = deps.sendEmailImpl ?? sendEmail
	const summary: RunSchedulesSummary = {
		checked: 0,
		due: 0,
		sent: 0,
		retried: 0,
		failed: 0,
		paused: 0,
		skipped: 0,
	}
	const schedules = await db
		.select()
		.from(ReportSchedule)
		.where(isNull(ReportSchedule.pausedAt))
	const flagCache = new Map<string, boolean>()
	for (const schedule of schedules) {
		summary.checked += 1
		let enabled = flagCache.get(schedule.organizationId)
		if (enabled === undefined) {
			enabled = await isReportSchedulesEnabled(schedule.organizationId)
			flagCache.set(schedule.organizationId, enabled)
		}
		if (!enabled) continue

		const key = dueRunKey(
			{
				cadence: schedule.cadence as 'daily' | 'weekly' | 'monthly',
				weekday: schedule.weekday,
				hour: schedule.hour,
				timeZone: schedule.timeZone,
				createdAt: schedule.createdAt,
			},
			now,
		)
		const retryDue =
			schedule.nextAttemptAt !== null &&
			schedule.nextAttemptAt <= now &&
			schedule.lastRunKey !== null
		let runKey: string
		let failureDays = schedule.failureDays
		let retryCount = schedule.retryCount
		if (key && key !== schedule.lastRunKey) {
			// A new run. A retry still pending from an earlier day is given up: that
			// day counts as failed.
			if (schedule.nextAttemptAt !== null) failureDays += 1
			runKey = key
			retryCount = 0
		} else if (retryDue) {
			runKey = schedule.lastRunKey!
			summary.retried += 1
		} else {
			continue
		}
		summary.due += 1
		const outcome = await runOneSchedule({ schedule, runKey, now, post })
		if (outcome.kind === 'sent' || outcome.kind === 'skipped') {
			if (outcome.kind === 'sent') summary.sent += 1
			else summary.skipped += 1
			await db
				.update(ReportSchedule)
				.set({
					lastRunKey: runKey,
					lastSentAt: outcome.kind === 'sent' ? now : schedule.lastSentAt,
					lastError: null,
					failureDays: 0,
					retryCount: 0,
					nextAttemptAt: null,
				})
				.where(eq(ReportSchedule.id, schedule.id))
			continue
		}
		// A failure: retry twice with backoff, then record the error.
		const wait = nextRetryAt(retryCount, now)
		if (wait) {
			await db
				.update(ReportSchedule)
				.set({
					lastRunKey: runKey,
					retryCount: retryCount + 1,
					nextAttemptAt: wait,
					lastError: outcome.reason,
					failureDays,
				})
				.where(eq(ReportSchedule.id, schedule.id))
			continue
		}
		summary.failed += 1
		failureDays += 1
		const pause = failureDays >= REPORT_SCHEDULE_FAILED_DAYS_TO_PAUSE
		await db
			.update(ReportSchedule)
			.set({
				lastRunKey: runKey,
				retryCount: 0,
				nextAttemptAt: null,
				lastError: outcome.reason,
				failureDays,
				...(pause ? { pausedAt: now, pausedReason: 'failures' } : {}),
			})
			.where(eq(ReportSchedule.id, schedule.id))
		if (pause) {
			summary.paused += 1
			const title = await scheduleTitle(schedule)
			await notifyCreatorPaused(schedule, title, send)
		}
	}
	return summary
}

async function scheduleTitle(schedule: typeof ReportSchedule.$inferSelect) {
	if (!schedule.savedReportId) return 'Daily summary'
	const [report] = await db
		.select({ title: SavedReport.title })
		.from(SavedReport)
		.where(eq(SavedReport.id, schedule.savedReportId))
		.limit(1)
	return report?.title ?? 'Report'
}

type RunOutcome =
	| { kind: 'sent' }
	| { kind: 'skipped' }
	| { kind: 'failed'; reason: string }

async function runOneSchedule(input: {
	schedule: typeof ReportSchedule.$inferSelect
	runKey: string
	now: Date
	post: typeof postRegionalReports
}): Promise<RunOutcome> {
	const { schedule, runKey, post } = input
	const [org] = await db
		.select({
			id: Organization.id,
			name: Organization.name,
			slug: Organization.slug,
			dataRegion: Organization.dataRegion,
			hasProvisionedDb: Organization.hasProvisionedDb,
		})
		.from(Organization)
		.where(eq(Organization.id, schedule.organizationId))
		.limit(1)
	if (!org || !org.hasProvisionedDb) return { kind: 'skipped' }

	let definition: ReportDefinition | null = null
	let title = 'Daily summary'
	if (schedule.savedReportId) {
		const [report] = await db
			.select()
			.from(SavedReport)
			.where(eq(SavedReport.id, schedule.savedReportId))
			.limit(1)
		if (!report) return { kind: 'failed', reason: 'report_deleted' }
		definition = parseDefinition(report.definition)
		title = report.title
		// A report edited to read a personal field since it was scheduled is not sent.
		const { catalog } = await organizationReportCatalog(org.id)
		if (personalFieldsUsed(catalog, definition).length > 0) {
			return { kind: 'failed', reason: REPORT_HAS_PERSONAL_FIELDS }
		}
	}

	const rows = await db
		.select({
			userId: ReportScheduleRecipient.userId,
			unsubscribedAt: ReportScheduleRecipient.unsubscribedAt,
			email: User.email,
		})
		.from(ReportScheduleRecipient)
		.innerJoin(User, eq(User.id, ReportScheduleRecipient.userId))
		.where(eq(ReportScheduleRecipient.scheduleId, schedule.id))
	const live = rows.filter((r) => r.unsubscribedAt === null)
	const members = await activeMemberIds(
		org.id,
		live.map((r) => r.userId),
	)
	const statuses = new Map<string, string>()
	const modules = await resolveFigureModules(org.id)
	const catalog = (await organizationReportCatalog(org.id)).catalog

	const recipients = []
	const placeholder = new Request('https://job.invalid/')
	for (const row of live) {
		if (!members.has(row.userId)) {
			statuses.set(row.userId, 'skipped_not_member')
			continue
		}
		const grants = await resolveReportTokenGrantsForMember({
			userId: row.userId,
			organizationId: org.id,
		})
		// The report must be one this member may still run.
		if (definition) {
			const subjectGrants = await resolveReportGrantsForRequest(
				placeholder,
				row.userId,
				org.id,
			)
			if (!definitionAllowed(catalog, definition, subjectGrants)) {
				statuses.set(row.userId, 'skipped_no_access')
				continue
			}
		}
		const canReadReviews = !definition
			? (await resolveReportGrantsForRequest(placeholder, row.userId, org.id)).includes('reviews')
			: false
		recipients.push({
			userId: row.userId,
			email: row.email,
			grants: {
				subjects: [...grants.subjects, ...(canReadReviews ? ['reviews'] : [])],
				scopeIds: grants.scopeIds,
				...(grants.locationIds === undefined
					? {}
					: { locationIds: grants.locationIds }),
				modules,
			},
			unsubscribeUrl: reportUnsubscribeUrl({
				kind: 'schedule',
				scheduleId: schedule.id,
				userId: row.userId,
			}),
		})
	}
	if (recipients.length === 0) {
		await recordStatuses(schedule.id, statuses)
		return { kind: 'skipped' }
	}
	const instant = runInstant(runKey, schedule.hour, schedule.timeZone)
	let reviews: { count: number; previousCount: number } | null = null
	if (!definition && recipients.some((r) => r.grants.subjects.includes('reviews'))) {
		const value = await reviewFigureValue({
			organizationId: org.id,
			id: 'newReviews',
			preset: DAILY_SUMMARY_PRESET,
			asOf: dailyAsOf(instant),
			timeZone: schedule.timeZone,
		})
		reviews = {
			count: value.entries[0]?.value ?? 0,
			previousCount: value.previous[0]?.value ?? 0,
		}
	}
	const base = readLiveEnv('BASE_URL').replace(/\/$/u, '')
	let response: Response
	try {
		response = await post({
			dataRegion: org.dataRegion,
			path: 'send',
			body: {
				orgId: org.id,
				scheduleId: schedule.id,
				runKey,
				now: instant.toISOString(),
				timeZone: schedule.timeZone,
				locale: schedule.locale,
				organizationName: org.name,
				reportUrl: schedule.savedReportId
					? `${base}/${org.slug}/reports/${schedule.savedReportId}`
					: `${base}/${org.slug}/reports`,
				report: definition
					? { kind: 'saved', title, definition }
					: { kind: 'daily_summary', reviews },
				recipients,
			},
		})
	} catch {
		return { kind: 'failed', reason: 'region_unreachable' }
	}
	if (response.status === 422) {
		return { kind: 'failed', reason: REPORT_HAS_PERSONAL_FIELDS }
	}
	if (!response.ok) {
		return { kind: 'failed', reason: `region_${response.status}` }
	}
	const parsed = reportSendResponseSchema.safeParse(
		await response.json().catch(() => null),
	)
	if (!parsed.success) return { kind: 'failed', reason: 'region_bad_answer' }
	let anyFailed = false
	let anySent = false
	let firstReason = 'send_failed'
	for (const result of parsed.data.results) {
		statuses.set(result.userId, result.status)
		if (result.status === 'sent') anySent = true
		if (result.status === 'failed') {
			anyFailed = true
			firstReason = result.reason ?? firstReason
		}
	}
	await recordStatuses(schedule.id, statuses)
	if (anyFailed && !anySent) return { kind: 'failed', reason: firstReason }
	// Some delivered, some failed: the day is sent; the failures show in the list.
	return anySent ? { kind: 'sent' } : { kind: 'skipped' }
}

async function recordStatuses(scheduleId: string, statuses: Map<string, string>) {
	for (const [userId, status] of statuses) {
		await db
			.update(ReportScheduleRecipient)
			.set({ lastStatus: status })
			.where(
				and(
					eq(ReportScheduleRecipient.scheduleId, scheduleId),
					eq(ReportScheduleRecipient.userId, userId),
				),
			)
	}
}

import {
	and,
	asc,
	count,
	desc,
	eq,
	inArray,
	isNull,
	lte,
	min,
	or,
	type SQL,
	sql,
} from 'drizzle-orm'
import {
	canMoveHiringStage,
	declinedRetentionExpiry,
	resolveApplicantRetentionDays,
	HIRING_OPEN_STAGES,
	HIRING_STAGES,
	isHiringStage,
	parseAnswerSnapshots,
	type HiringApplicationDetail,
	type HiringApplicationSummary,
	type HiringDecline,
	type HiringHire,
	type HiringHireResult,
	type HiringInterview,
	type HiringListQuery,
	type HiringListResponse,
	type HiringNote,
	type HiringSource,
	type HiringStage,
	type HiringTimelineEvent,
	type InterviewCreate,
	type InterviewUpdate,
	type InviteStatus,
} from '@repo/staffing'
import {
	hiringApplications,
	hiringEvents,
	hiringInterviews,
	hiringNotes,
	staffJobs,
	staffScopeAssignments,
	staffMembers,
	staffPositions,
	type HiringApplicationRow,
	type HiringEventRow,
	type HiringInterviewRow,
	type HiringNoteRow,
	type TenantDatabase,
	runTenantTransaction,
} from '@repo/tenant-db'
import { isEmailEnabled } from '../lib/email-switch.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { getScopeFacts, type ScopeFacts } from '../lib/scope-context.ts'
import {
	renderApplicantEmail,
	normalizeApplicantLocale,
	type ApplicantEmailInput,
} from '../lib/applicant-email.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { hasGrant } from '../lib/staff-auth.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import {
	type StaffDb,
	writeStaffAudit,
	writeSystemAudit,
} from './staff-audit.ts'
import {
	insertChecklist,
	resolveChecklistSource,
	type ChecklistSource,
} from './onboarding-service.ts'
import { getSettings, type StaffContext } from './staff-service.ts'

/**
 * Applicants and the hire, reached by managers through `/operator/hiring`.
 *
 * Rules every function here follows:
 * - Visibility is the token's scope limit applied to the application's own
 *   scope (the posting's). An application outside it is a 404, like an
 *   unknown id, so a scoped manager cannot probe other scopes. An
 *   organization-wide posting's applicants are visible only to a token that
 *   covers every scope.
 * - Every change writes an audit row in the same transaction. The audit log
 *   holds ids, codes and counts, never a name, an answer or a note.
 * - Reading one candidate (contact details, answers) is audited before the data
 *   is returned; the list carries neither contact details nor answers.
 * - Email goes out only after the change has committed, and a failure to send
 *   never undoes the decision: the outcome is recorded on the candidate.
 */

// ---------------------------------------------------------------------------
// Result plumbing
// ---------------------------------------------------------------------------

export type HiringFailure = {
	ok: false
	status: 400 | 403 | 404 | 409 | 422
	error: string
	message?: string
}
export type HiringResult<T> = { ok: true; value: T } | HiringFailure

const ok = <T>(value: T): HiringResult<T> => ({ ok: true, value })
const fail = (
	status: HiringFailure['status'],
	error: string,
	message?: string,
): HiringFailure => ({
	ok: false,
	status,
	error,
	...(message ? { message } : {}),
})

function write<T>(
	db: TenantDatabase,
	fn: (
		tx: Parameters<Parameters<TenantDatabase['transaction']>[0]>[0],
	) => Promise<T>,
): Promise<T> {
	return retryOnSqliteBusy(() => runTenantTransaction(db, fn))
}

function isUniqueViolation(error: unknown, hints: string[] = []): boolean {
	let root: unknown = error
	while (root instanceof Error && (root as { cause?: unknown }).cause) {
		root = (root as { cause?: unknown }).cause
	}
	const text = root instanceof Error ? root.message : ''
	if (!/UNIQUE constraint failed|SQLITE_CONSTRAINT_UNIQUE/i.test(text)) {
		return false
	}
	return hints.length === 0 || hints.some((hint) => text.includes(hint))
}

/** Test seam: the clock and everything that leaves the node. */
export type HiringDeps = {
	now: () => number
	sendEmail: (input: {
		to: string
		toName: string
		subject: string
		html: string
		text: string
	}) => Promise<
		| { status: 'success' | 'skipped' }
		| { status: 'error'; error: { message: string; statusCode?: number } }
	>
	getScope: (orgId: string, scopeId: string) => Promise<ScopeFacts | null>
	getOrganizationName: (orgId: string) => Promise<string | null>
	emailEnabled: () => boolean
}

export const hiringDeps: HiringDeps = {
	now: () => Date.now(),
	sendEmail: (input) => sendTenantEmail(input),
	getScope: (orgId, scopeId) => getScopeFacts(orgId, scopeId),
	getOrganizationName: async (orgId) =>
		(await findActiveOrganizationById(orgId))?.name ?? null,
	emailEnabled: isEmailEnabled,
}

// ---------------------------------------------------------------------------
// Serializers: the only way rows leave this module
// ---------------------------------------------------------------------------

function stageOf(value: string): HiringStage {
	return isHiringStage(value) ? value : 'new'
}

function toSummary(
	row: HiringApplicationRow,
	extra: { noteCount: number; interviewAt: number | null },
): HiringApplicationSummary {
	return {
		id: row.id,
		postingId: row.postingId,
		postingTitle: row.postingTitle,
		scopeId: row.scopeId,
		firstName: row.firstName,
		lastName: row.lastName,
		source: row.source as HiringSource,
		stage: stageOf(row.stage),
		stageChangedAt: row.stageChangedAt,
		screenerScore: row.screenerScore,
		flagCount: Array.isArray(row.screenerFlags) ? row.screenerFlags.length : 0,
		hasEmail: row.email !== null,
		hasPhone: row.phone !== null,
		interviewAt: extra.interviewAt,
		noteCount: extra.noteCount,
		hiredStaffId: row.hiredStaffId,
		createdAt: row.createdAt,
	}
}

function toInterview(row: HiringInterviewRow): HiringInterview {
	return {
		id: row.id,
		applicationId: row.applicationId,
		scopeId: row.scopeId,
		scheduledAt: row.scheduledAt,
		durationMinutes: row.durationMinutes,
		mode: row.mode,
		details: row.details,
		status: row.status,
		outcome: row.outcome,
		inviteStatus: row.inviteStatus,
		inviteSentAt: row.inviteSentAt,
		createdBy: row.createdBy,
		createdAt: row.createdAt,
	}
}

function toNote(row: HiringNoteRow): HiringNote {
	return {
		id: row.id,
		applicationId: row.applicationId,
		authorId: row.authorId,
		body: row.body,
		createdAt: row.createdAt,
	}
}

function toEvent(row: HiringEventRow): HiringTimelineEvent {
	return {
		id: row.id,
		kind: row.kind,
		at: row.at,
		actorId: row.actorId,
		fromStage: row.fromStage ?? null,
		toStage: row.toStage ?? null,
		detail: row.detail,
	}
}

// ---------------------------------------------------------------------------
// Loading and visibility
// ---------------------------------------------------------------------------

/** A manager sees an application when its scope is theirs. */
function canSeeApplication(
	ctx: Pick<StaffContext, 'scope'>,
	row: Pick<HiringApplicationRow, 'scopeId'>,
): boolean {
	if (ctx.scope.unrestricted) return true
	return ctx.scope.allowsAny(row.scopeId ? [row.scopeId] : [])
}

async function loadVisible(
	db: StaffDb,
	ctx: Pick<StaffContext, 'scope'>,
	id: string,
): Promise<HiringResult<HiringApplicationRow>> {
	const [row] = await db
		.select()
		.from(hiringApplications)
		.where(eq(hiringApplications.id, id))
		.limit(1)
	if (!row || !canSeeApplication(ctx, row)) {
		return fail(404, 'Application not found')
	}
	return ok(row)
}

async function summaryFor(
	db: StaffDb,
	row: HiringApplicationRow,
): Promise<HiringApplicationSummary> {
	const extras = await extrasFor(db, [row.id])
	return toSummary(
		row,
		extras.get(row.id) ?? { noteCount: 0, interviewAt: null },
	)
}

async function extrasFor(
	db: StaffDb,
	ids: string[],
): Promise<Map<string, { noteCount: number; interviewAt: number | null }>> {
	const out = new Map<
		string,
		{ noteCount: number; interviewAt: number | null }
	>()
	if (ids.length === 0) return out
	for (const id of ids) out.set(id, { noteCount: 0, interviewAt: null })
	const [notes, interviews] = await Promise.all([
		db
			.select({ id: hiringNotes.applicationId, total: count() })
			.from(hiringNotes)
			.where(
				and(
					inArray(hiringNotes.applicationId, ids),
					isNull(hiringNotes.deletedAt),
				),
			)
			.groupBy(hiringNotes.applicationId),
		db
			.select({
				id: hiringInterviews.applicationId,
				at: min(hiringInterviews.scheduledAt),
			})
			.from(hiringInterviews)
			.where(
				and(
					inArray(hiringInterviews.applicationId, ids),
					eq(hiringInterviews.status, 'scheduled'),
				),
			)
			.groupBy(hiringInterviews.applicationId),
	])
	for (const row of notes) out.get(row.id)!.noteCount = row.total
	// The soonest interview still marked as scheduled.
	for (const row of interviews) {
		out.get(row.id)!.interviewAt = row.at
	}
	return out
}

async function recordEvent(
	tx: StaffDb,
	input: {
		applicationId: string
		kind: HiringEventRow['kind']
		actorId: string | null
		fromStage?: HiringStage | null
		toStage?: HiringStage | null
		detail?: string | null
		now: number
	},
) {
	await tx.insert(hiringEvents).values({
		applicationId: input.applicationId,
		kind: input.kind,
		actorId: input.actorId,
		fromStage: input.fromStage ?? null,
		toStage: input.toStage ?? null,
		detail: input.detail ?? null,
		at: input.now,
	})
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

function likePattern(q: string) {
	return `%${q.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`
}

/**
 * The pipeline. Rows carry no contact details and no answers; they carry what a
 * board card needs (name, job, stage, score, how many flags, next interview).
 * Counts per stage follow the same filters except the stage itself, so the
 * column headers stay right while one stage is selected.
 */
export async function listApplications(
	ctx: StaffContext,
	query: HiringListQuery,
): Promise<HiringResult<HiringListResponse>> {
	const { db, scope } = ctx
	const base: SQL[] = []
	const scopeWhere = scope.unrestricted
		? undefined
		: scope.where(hiringApplications.scopeId)
	if (scopeWhere) base.push(scopeWhere)
	if (query.scopeId) {
		if (!scope.allows(query.scopeId)) return fail(403, 'scope_out_of_scope')
		base.push(eq(hiringApplications.scopeId, query.scopeId))
	}
	if (query.q) {
		const pattern = likePattern(query.q)
		base.push(
			or(
				sql`lower(${hiringApplications.firstName} || ' ' || ${hiringApplications.lastName}) like ${pattern} escape '\\'`,
				sql`lower(${hiringApplications.postingTitle}) like ${pattern} escape '\\'`,
			)!,
		)
	}
	if (query.flagged) {
		base.push(sql`${hiringApplications.screenerFlags} <> '[]'`)
	}

	const withPosting = query.postingId
		? [...base, eq(hiringApplications.postingId, query.postingId)]
		: base
	const stageFilter = !query.stage
		? undefined
		: query.stage === 'open'
			? inArray(hiringApplications.stage, [...HIRING_OPEN_STAGES])
			: eq(hiringApplications.stage, query.stage)
	const filters = stageFilter ? [...withPosting, stageFilter] : withPosting
	const where = filters.length > 0 ? and(...filters) : undefined

	const order =
		query.sort === 'oldest'
			? [asc(hiringApplications.createdAt)]
			: query.sort === 'name'
				? [asc(hiringApplications.lastName), asc(hiringApplications.firstName)]
				: query.sort === 'score'
					? [
							sql`${hiringApplications.screenerScore} is null`,
							desc(hiringApplications.screenerScore),
							desc(hiringApplications.createdAt),
						]
					: [desc(hiringApplications.createdAt)]

	const withPostingWhere =
		withPosting.length > 0 ? and(...withPosting) : undefined
	const baseWhere = base.length > 0 ? and(...base) : undefined

	const [rows, stageRows, postingRows, [total]] = await Promise.all([
		db
			.select()
			.from(hiringApplications)
			.where(where)
			.orderBy(...order)
			.limit(query.limit)
			.offset(query.offset),
		db
			.select({ stage: hiringApplications.stage, total: count() })
			.from(hiringApplications)
			.where(withPostingWhere)
			.groupBy(hiringApplications.stage),
		db
			.select({
				postingId: hiringApplications.postingId,
				title: sql<string>`max(${hiringApplications.postingTitle})`,
				total: count(),
			})
			.from(hiringApplications)
			.where(baseWhere)
			.groupBy(hiringApplications.postingId)
			.orderBy(desc(count())),
		db.select({ total: count() }).from(hiringApplications).where(where),
	])

	const counts = Object.fromEntries(
		HIRING_STAGES.map((stage) => [stage, 0]),
	) as Record<HiringStage, number>
	for (const row of stageRows) {
		if (isHiringStage(row.stage)) counts[row.stage] = row.total
	}
	const extras = await extrasFor(
		db,
		rows.map((row) => row.id),
	)
	return ok({
		applications: rows.map((row) =>
			toSummary(row, extras.get(row.id) ?? { noteCount: 0, interviewAt: null }),
		),
		counts,
		postings: postingRows.map((row) => ({
			postingId: row.postingId,
			title: row.title,
			count: row.total,
		})),
		total: total?.total ?? 0,
	})
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

/**
 * One candidate in full: contact details, answers, notes, interviews and the
 * timeline. The audit row is written first; if it fails nothing is returned.
 */
export async function getApplication(
	ctx: StaffContext,
	id: string,
): Promise<HiringResult<HiringApplicationDetail>> {
	const { db } = ctx
	const loaded = await loadVisible(db, ctx, id)
	if (!loaded.ok) return loaded
	const row = loaded.value

	await writeStaffAudit(db, ctx.auth, ctx.ipHash, {
		action: 'hiring.application.viewed',
		entityType: 'application',
		entityId: row.id,
		scopeId: row.scopeId,
		sensitivity: 'private',
	})

	const [notes, interviews, events] = await Promise.all([
		db
			.select()
			.from(hiringNotes)
			.where(
				and(eq(hiringNotes.applicationId, id), isNull(hiringNotes.deletedAt)),
			)
			.orderBy(desc(hiringNotes.createdAt))
			.limit(200),
		db
			.select()
			.from(hiringInterviews)
			.where(eq(hiringInterviews.applicationId, id))
			.orderBy(asc(hiringInterviews.scheduledAt))
			.limit(50),
		db
			.select()
			.from(hiringEvents)
			.where(eq(hiringEvents.applicationId, id))
			.orderBy(desc(hiringEvents.at))
			.limit(200),
	])
	const settings = await getSettings(db)
	const summary = toSummary(row, { noteCount: notes.length, interviewAt: null })
	return ok(
		toDetail(row, summary, {
			declineRetentionDays: resolveApplicantRetentionDays(
				settings.retentionDaysDeclinedApplicants,
			),
			notes: notes.map(toNote),
			interviews: interviews.map(toInterview),
			timeline: events.map(toEvent),
		}),
	)
}

function toDetail(
	row: HiringApplicationRow,
	summary: HiringApplicationSummary,
	parts: {
		declineRetentionDays: number
		notes: HiringNote[]
		interviews: HiringInterview[]
		timeline: HiringTimelineEvent[]
	},
): HiringApplicationDetail {
	const {
		hasEmail: ignoredHasEmail,
		hasPhone: ignoredHasPhone,
		noteCount: ignoredNoteCount,
		interviewAt: ignoredInterviewAt,
		...rest
	} = summary
	return {
		...rest,
		email: row.email,
		phone: row.phone,
		locale: row.locale === 'ar' ? 'ar' : 'en',
		positionName: row.positionName,
		answers: parseAnswerSnapshots(row.answers),
		flags: Array.isArray(row.screenerFlags) ? row.screenerFlags : [],
		declinedReason: row.declinedReason,
		declinedAt: row.declinedAt,
		consentAt: row.consentAt,
		consentVersion: row.consentVersion,
		retentionExpiresAt: row.retentionExpiresAt,
		hiredAt: row.hiredAt,
		...parts,
	}
}

// ---------------------------------------------------------------------------
// Stage moves
// ---------------------------------------------------------------------------

export async function moveStage(
	ctx: StaffContext,
	id: string,
	to: HiringStage,
): Promise<HiringResult<{ application: HiringApplicationSummary }>> {
	const now = hiringDeps.now()
	try {
		return await write(ctx.db, async (tx) => {
			const loaded = await loadVisible(tx, ctx, id)
			if (!loaded.ok) return loaded
			const row = loaded.value
			const from = stageOf(row.stage)
			if (from === to) return ok({ application: await summaryFor(tx, row) })
			if (!canMoveHiringStage(from, to)) {
				return fail(
					409,
					from === 'hired' ? 'already_hired' : 'stage_change_not_allowed',
				)
			}
			const reopened = from === 'declined'
			await tx
				.update(hiringApplications)
				.set({
					stage: to,
					stageChangedAt: now,
					updatedAt: now,
					...(reopened
						? {
								declinedAt: null,
								declinedReason: null,
								retentionExpiresAt: null,
							}
						: {}),
				})
				.where(eq(hiringApplications.id, id))
			await recordEvent(tx, {
				applicationId: id,
				kind: reopened ? 'reopened' : 'stage_changed',
				actorId: ctx.auth.userId,
				fromStage: from,
				toStage: to,
				now,
			})
			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: reopened
					? 'hiring.application.reopened'
					: 'hiring.application.stage_changed',
				entityType: 'application',
				entityId: id,
				scopeId: row.scopeId,
				changes: { from, to },
			})
			const [fresh] = await tx
				.select()
				.from(hiringApplications)
				.where(eq(hiringApplications.id, id))
			return ok({ application: await summaryFor(tx, fresh!) })
		})
	} catch (error) {
		// Reopening a declined candidate whose person has applied again since:
		// the unique index allows one open application per person and posting.
		if (isUniqueViolation(error, ['email_hash', 'phone_hash'])) {
			return fail(409, 'duplicate_application')
		}
		throw error
	}
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export async function addNote(
	ctx: StaffContext,
	id: string,
	body: string,
): Promise<HiringResult<{ note: HiringNote }>> {
	const now = hiringDeps.now()
	return write(ctx.db, async (tx) => {
		const loaded = await loadVisible(tx, ctx, id)
		if (!loaded.ok) return loaded
		const [note] = await tx
			.insert(hiringNotes)
			.values({
				applicationId: id,
				authorId: ctx.auth.userId,
				body,
				createdAt: now,
			})
			.returning()
		await recordEvent(tx, {
			applicationId: id,
			kind: 'note_added',
			actorId: ctx.auth.userId,
			now,
		})
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'hiring.note.added',
			entityType: 'application_note',
			entityId: note!.id,
			scopeId: loaded.value.scopeId,
			// The text itself is not copied into the audit log.
			changes: { applicationId: id, length: body.length },
		})
		return ok({ note: toNote(note!) })
	})
}

export async function removeNote(
	ctx: StaffContext,
	id: string,
	noteId: string,
): Promise<HiringResult<{ removed: true }>> {
	const now = hiringDeps.now()
	return write(ctx.db, async (tx) => {
		const loaded = await loadVisible(tx, ctx, id)
		if (!loaded.ok) return loaded
		const [note] = await tx
			.select()
			.from(hiringNotes)
			.where(
				and(
					eq(hiringNotes.id, noteId),
					eq(hiringNotes.applicationId, id),
					isNull(hiringNotes.deletedAt),
				),
			)
			.limit(1)
		if (!note) return fail(404, 'Note not found')
		await tx
			.update(hiringNotes)
			.set({ deletedAt: now })
			.where(eq(hiringNotes.id, noteId))
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'hiring.note.removed',
			entityType: 'application_note',
			entityId: noteId,
			scopeId: loaded.value.scopeId,
			changes: { applicationId: id },
		})
		return ok({ removed: true as const })
	})
}

// ---------------------------------------------------------------------------
// Email to the applicant
// ---------------------------------------------------------------------------

type MailOutcome = Extract<
	InviteStatus,
	'sent' | 'failed' | 'no_email' | 'email_disabled'
>

async function sendToApplicant(
	row: HiringApplicationRow,
	build: (context: {
		organizationName: string | null
		scope: ScopeFacts | null
	}) => Omit<
		ApplicantEmailInput,
		| 'locale'
		| 'firstName'
		| 'postingTitle'
		| 'organizationName'
		| 'scopeName'
		| 'timeZone'
	>,
	scopeId: string | null,
	orgId: string,
): Promise<MailOutcome | 'scope_unavailable'> {
	if (!row.email) return 'no_email'
	if (!hiringDeps.emailEnabled()) return 'email_disabled'
	const [organizationName, scope] = await Promise.all([
		hiringDeps.getOrganizationName(orgId).catch(() => null),
		scopeId
			? hiringDeps.getScope(orgId, scopeId).catch(() => null)
			: Promise.resolve(null),
	])
	const part = build({ organizationName, scope })
	// A time with no zone would be shown wrong, so an interview email waits for
	// the scope facts; a decline has no time in it.
	if (part.kind !== 'decline' && !scope) return 'scope_unavailable'
	const rendered = renderApplicantEmail({
		...part,
		locale: normalizeApplicantLocale(row.locale),
		firstName: row.firstName,
		postingTitle: row.postingTitle,
		organizationName,
		scopeName: scope?.name ?? null,
		timeZone: scope?.timeZone ?? null,
	})
	try {
		const outcome = await hiringDeps.sendEmail({
			to: row.email,
			toName: `${row.firstName} ${row.lastName}`.trim(),
			subject: rendered.subject,
			html: rendered.html,
			text: rendered.text,
		})
		return outcome.status === 'error' ? 'failed' : 'sent'
	} catch {
		return 'failed'
	}
}

// ---------------------------------------------------------------------------
// Interviews
// ---------------------------------------------------------------------------

const MAX_INTERVIEW_LEAD_MS = 366 * 24 * 60 * 60 * 1000
const INTERVIEW_PAST_GRACE_MS = 5 * 60 * 1000

function interviewTimeProblem(scheduledAt: number, now: number): string | null {
	if (scheduledAt < now - INTERVIEW_PAST_GRACE_MS) return 'interview_in_past'
	if (scheduledAt > now + MAX_INTERVIEW_LEAD_MS) return 'interview_too_far'
	return null
}

async function deliverInvite(
	ctx: StaffContext,
	row: HiringApplicationRow,
	interview: HiringInterviewRow,
	rescheduled: boolean,
): Promise<HiringInterviewRow> {
	const now = hiringDeps.now()
	const outcome = await sendToApplicant(
		row,
		() => ({
			kind: 'interview_invite',
			interview: {
				scheduledAt: interview.scheduledAt,
				durationMinutes: interview.durationMinutes,
				mode: interview.mode,
				details: interview.details,
				rescheduled,
			},
		}),
		interview.scopeId,
		ctx.auth.orgId,
	)
	const status: InviteStatus =
		outcome === 'scope_unavailable' ? 'failed' : outcome
	const detail = outcome === 'scope_unavailable' ? 'scope_unavailable' : outcome
	return write(ctx.db, async (tx) => {
		const [updated] = await tx
			.update(hiringInterviews)
			.set({
				inviteStatus: status,
				inviteSentAt: status === 'sent' ? now : interview.inviteSentAt,
				updatedAt: now,
			})
			.where(eq(hiringInterviews.id, interview.id))
			.returning()
		await recordEvent(tx, {
			applicationId: row.id,
			kind: 'invite_sent',
			actorId: ctx.auth.userId,
			detail,
			now,
		})
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'hiring.interview.invite',
			entityType: 'application_interview',
			entityId: interview.id,
			scopeId: row.scopeId,
			changes: { applicationId: row.id, outcome: detail },
		})
		return updated!
	})
}

export async function createInterview(
	ctx: StaffContext,
	id: string,
	input: InterviewCreate,
): Promise<HiringResult<{ interview: HiringInterview }>> {
	const now = hiringDeps.now()
	const problem = interviewTimeProblem(input.scheduledAt, now)
	if (problem) return fail(422, problem)

	const created = await write(ctx.db, async (tx) => {
		const loaded = await loadVisible(tx, ctx, id)
		if (!loaded.ok) return loaded
		const row = loaded.value
		const from = stageOf(row.stage)
		if (from === 'hired' || from === 'declined') {
			return fail(409, 'application_closed')
		}
		const scopeId = input.scopeId ?? row.scopeId
		if (!scopeId) return fail(422, 'scope_required')
		if (!ctx.scope.allows(scopeId)) return fail(403, 'scope_out_of_scope')

		const [interview] = await tx
			.insert(hiringInterviews)
			.values({
				applicationId: id,
				scopeId,
				scheduledAt: input.scheduledAt,
				durationMinutes: input.durationMinutes,
				mode: input.mode,
				details: input.details || null,
				createdBy: ctx.auth.userId,
				createdAt: now,
				updatedAt: now,
			})
			.returning()
		await recordEvent(tx, {
			applicationId: id,
			kind: 'interview_scheduled',
			actorId: ctx.auth.userId,
			now,
		})
		// Booking an interview moves a card that is still waiting to the
		// interview column, so the board matches what happened.
		let moved = false
		if (from === 'new' || from === 'screening') {
			await tx
				.update(hiringApplications)
				.set({ stage: 'interview', stageChangedAt: now, updatedAt: now })
				.where(eq(hiringApplications.id, id))
			await recordEvent(tx, {
				applicationId: id,
				kind: 'stage_changed',
				actorId: ctx.auth.userId,
				fromStage: from,
				toStage: 'interview',
				now,
			})
			moved = true
		}
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'hiring.interview.scheduled',
			entityType: 'application_interview',
			entityId: interview!.id,
			scopeId: row.scopeId,
			changes: {
				applicationId: id,
				mode: input.mode,
				movedToInterview: moved,
			},
		})
		return ok({ row, interview: interview! })
	})
	if (!created.ok) return created

	let { interview } = created.value
	if (input.sendInvite) {
		interview = await deliverInvite(ctx, created.value.row, interview, false)
	}
	return ok({ interview: toInterview(interview) })
}

export async function updateInterview(
	ctx: StaffContext,
	id: string,
	interviewId: string,
	input: InterviewUpdate,
): Promise<HiringResult<{ interview: HiringInterview }>> {
	const now = hiringDeps.now()

	const updated = await write(ctx.db, async (tx) => {
		const loaded = await loadVisible(tx, ctx, id)
		if (!loaded.ok) return loaded
		const [existing] = await tx
			.select()
			.from(hiringInterviews)
			.where(
				and(
					eq(hiringInterviews.id, interviewId),
					eq(hiringInterviews.applicationId, id),
				),
			)
			.limit(1)
		if (!existing) return fail(404, 'Interview not found')
		// Only a time that is being changed must be ahead: marking a past
		// interview completed or no-show sends its unchanged time back.
		if (
			input.scheduledAt !== undefined &&
			input.scheduledAt !== existing.scheduledAt
		) {
			const problem = interviewTimeProblem(input.scheduledAt, now)
			if (problem) return fail(422, problem)
		}

		const patch: Partial<typeof hiringInterviews.$inferInsert> = {
			updatedAt: now,
		}
		if (input.scheduledAt !== undefined) patch.scheduledAt = input.scheduledAt
		if (input.durationMinutes !== undefined) {
			patch.durationMinutes = input.durationMinutes
		}
		if (input.mode !== undefined) patch.mode = input.mode
		if (input.details !== undefined) patch.details = input.details || null
		if (input.status !== undefined) patch.status = input.status
		if (input.outcome !== undefined) patch.outcome = input.outcome || null
		const moved =
			input.scheduledAt !== undefined &&
			input.scheduledAt !== existing.scheduledAt
		await tx
			.update(hiringInterviews)
			.set(patch)
			.where(eq(hiringInterviews.id, interviewId))
		await recordEvent(tx, {
			applicationId: id,
			kind: 'interview_updated',
			actorId: ctx.auth.userId,
			detail: input.status ?? (moved ? 'rescheduled' : 'edited'),
			now,
		})
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'hiring.interview.updated',
			entityType: 'application_interview',
			entityId: interviewId,
			scopeId: loaded.value.scopeId,
			changes: {
				applicationId: id,
				fields: Object.keys(patch).filter((key) => key !== 'updatedAt'),
				status: input.status ?? null,
			},
		})
		const [fresh] = await tx
			.select()
			.from(hiringInterviews)
			.where(eq(hiringInterviews.id, interviewId))
		return ok({ row: loaded.value, before: existing, interview: fresh! })
	})
	if (!updated.ok) return updated

	const { row, before } = updated.value
	let { interview } = updated.value
	const cancelled =
		input.status === 'cancelled' &&
		before.status !== 'cancelled' &&
		before.inviteStatus === 'sent'
	if (cancelled) {
		// The applicant was told about it, so they are told it is off.
		const outcome = await sendToApplicant(
			row,
			() => ({
				kind: 'interview_cancelled',
				interview: {
					scheduledAt: before.scheduledAt,
					durationMinutes: before.durationMinutes,
					mode: before.mode,
					details: null,
					rescheduled: false,
				},
			}),
			interview.scopeId,
			ctx.auth.orgId,
		)
		await write(ctx.db, async (tx) => {
			await recordEvent(tx, {
				applicationId: id,
				kind: 'invite_sent',
				actorId: ctx.auth.userId,
				detail:
					outcome === 'sent' ? 'cancellation_sent' : `cancellation_${outcome}`,
				now: hiringDeps.now(),
			})
		})
	} else if (input.resendInvite && interview.status === 'scheduled') {
		interview = await deliverInvite(
			ctx,
			row,
			interview,
			before.inviteStatus === 'sent' || before.inviteSentAt !== null,
		)
	}
	return ok({ interview: toInterview(interview) })
}

// ---------------------------------------------------------------------------
// Decline
// ---------------------------------------------------------------------------

export type DeclineOutcome = {
	application: HiringApplicationSummary
	/** What happened to the applicant's message; `none` when none was asked for. */
	email: 'none' | MailOutcome
}

/**
 * Declines a candidate: records the reason, starts the retention clock, cancels
 * interviews still ahead, and (when asked) emails a templated message. The
 * decision is committed first; a message that cannot be sent never undoes it.
 */
export async function declineApplication(
	ctx: StaffContext,
	id: string,
	input: HiringDecline,
): Promise<HiringResult<DeclineOutcome>> {
	const now = hiringDeps.now()
	const settings = await getSettings(ctx.db)
	const committed = await write(ctx.db, async (tx) => {
		const loaded = await loadVisible(tx, ctx, id)
		if (!loaded.ok) return loaded
		const row = loaded.value
		const from = stageOf(row.stage)
		if (from === 'hired') return fail(409, 'already_hired')
		if (from === 'declined') return fail(409, 'already_declined')

		await tx
			.update(hiringApplications)
			.set({
				stage: 'declined',
				stageChangedAt: now,
				declinedAt: now,
				declinedReason: input.reason,
				retentionExpiresAt: declinedRetentionExpiry(
					now,
					settings.retentionDaysDeclinedApplicants,
				),
				updatedAt: now,
			})
			.where(eq(hiringApplications.id, id))
		const cancelled = await tx
			.update(hiringInterviews)
			.set({ status: 'cancelled', updatedAt: now })
			.where(
				and(
					eq(hiringInterviews.applicationId, id),
					eq(hiringInterviews.status, 'scheduled'),
				),
			)
			.returning({ id: hiringInterviews.id })
		await recordEvent(tx, {
			applicationId: id,
			kind: 'declined',
			actorId: ctx.auth.userId,
			fromStage: from,
			toStage: 'declined',
			detail: input.reason,
			now,
		})
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'hiring.application.declined',
			entityType: 'application',
			entityId: id,
			scopeId: row.scopeId,
			changes: {
				from,
				reason: input.reason,
				template: input.template,
				interviewsCancelled: cancelled.length,
			},
		})
		const [fresh] = await tx
			.select()
			.from(hiringApplications)
			.where(eq(hiringApplications.id, id))
		return ok({ row: fresh! })
	})
	if (!committed.ok) return committed

	const { row } = committed.value
	let email: DeclineOutcome['email'] = 'none'
	if (input.template !== 'none') {
		const template = input.template
		const outcome = await sendToApplicant(
			row,
			() => ({ kind: 'decline', template }),
			row.scopeId,
			ctx.auth.orgId,
		)
		email = outcome === 'scope_unavailable' ? 'failed' : outcome
		await write(ctx.db, async (tx) => {
			await recordEvent(tx, {
				applicationId: id,
				kind: 'decline_email_sent',
				actorId: ctx.auth.userId,
				detail: email,
				now: hiringDeps.now(),
			})
			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: 'hiring.application.decline_email',
				entityType: 'application',
				entityId: id,
				scopeId: row.scopeId,
				changes: { template, outcome: email },
			})
		})
	}
	return ok({ application: await summaryFor(ctx.db, row), email })
}

// ---------------------------------------------------------------------------
// Hire
// ---------------------------------------------------------------------------

/**
 * The positions a new hire can be given. Names only (no rates): a hiring
 * manager picks the role without holding any pay or roster grant.
 */
export async function listHirePositions(db: StaffDb) {
	const rows = await db
		.select({
			id: staffPositions.id,
			name: staffPositions.name,
			nameAr: staffPositions.nameAr,
			area: staffPositions.area,
		})
		.from(staffPositions)
		.where(isNull(staffPositions.archivedAt))
		.orderBy(asc(staffPositions.name))
	return { positions: rows }
}

/**
 * The hire transaction. In one regional transaction: the staff record, its
 * scope assignment, its position (with pay when the token may set it), the
 * onboarding checklist, the application's move to Hired, the timeline entry and
 * the audit rows. Any failure rolls back all of it; there is no state in which
 * a person is on the roster but the candidate is still open, or the reverse.
 *
 * Checks, in order: the candidate is visible and still open; the token covers
 * the scope; pay fields need the pay grant; the position exists and is not
 * archived; nobody on the roster already has this email or phone.
 *
 * Offering the new person an app login is a control-plane action the App does
 * afterwards with the opaque staff id (the existing invite route); it is not
 * part of this transaction because the login lives in another region.
 */
export async function hireApplicant(
	ctx: StaffContext,
	id: string,
	input: HiringHire,
): Promise<HiringResult<HiringHireResult>> {
	const now = hiringDeps.now()
	if (!ctx.scope.allows(input.scopeId)) {
		return fail(403, 'scope_out_of_scope')
	}
	const setsPay =
		input.rateMinor !== null ||
		input.annualSalaryMinor !== null ||
		input.payType === 'salary' ||
		input.overtimeExempt ||
		input.tipEligible
	if (setsPay && !hasGrant(ctx.auth, 'update:staff_pay:any')) {
		return fail(403, 'Forbidden', 'update:staff_pay:any')
	}

	try {
		return await write(ctx.db, async (tx) => {
			const loaded = await loadVisible(tx, ctx, id)
			if (!loaded.ok) return loaded
			const row = loaded.value
			const from = stageOf(row.stage)
			if (from === 'hired') return fail(409, 'already_hired')
			if (from === 'declined') {
				return fail(409, 'application_declined', 'Reopen the candidate first')
			}

			const [position] = await tx
				.select()
				.from(staffPositions)
				.where(eq(staffPositions.id, input.positionId))
				.limit(1)
			if (!position) return fail(404, 'Position not found')
			if (position.archivedAt !== null) return fail(409, 'position_archived')

			// Which checklist to copy is settled before anything is written, so a
			// bad template id refuses the whole hire instead of half of it.
			let checklist: ChecklistSource | null = null
			if (input.startOnboarding) {
				const resolved = await resolveChecklistSource(tx, input.templateId)
				if (!resolved.ok) {
					return fail(
						resolved.status === 404 ? 404 : 409,
						resolved.status === 404 ? 'Template not found' : resolved.error,
					)
				}
				checklist = resolved.value
			}

			const contact: SQL[] = []
			if (row.email) contact.push(eq(staffMembers.email, row.email))
			if (row.phone) contact.push(eq(staffMembers.phone, row.phone))
			if (contact.length > 0) {
				const [match] = await tx
					.select({ status: staffMembers.status })
					.from(staffMembers)
					.where(or(...contact))
					.orderBy(sql`${staffMembers.status} = 'terminated'`)
					.limit(1)
				if (match) {
					return fail(
						409,
						match.status === 'terminated'
							? 'staff_terminated_match'
							: 'staff_exists',
					)
				}
			}

			const [staff] = await tx
				.insert(staffMembers)
				.values({
					workerType: input.workerType,
					firstName: row.firstName,
					lastName: row.lastName,
					email: row.email,
					phone: row.phone,
					employeeNumber: input.employeeNumber || null,
					locale: row.locale === 'ar' ? 'ar' : 'en',
					hiredDate: input.hiredDate,
					primaryScopeId: input.scopeId,
					createdBy: ctx.auth.userId,
					createdAt: now,
					updatedAt: now,
				})
				.returning()
			const staffId = staff!.id
			await tx.insert(staffScopeAssignments).values({
				staffId,
				scopeId: input.scopeId,
				isPrimary: true,
			})
			const [job] = await tx
				.insert(staffJobs)
				.values({
					staffId,
					scopeId: input.scopeId,
					positionId: input.positionId,
					payType: input.payType,
					rateMinor: input.rateMinor,
					annualSalaryMinor: input.annualSalaryMinor,
					currency: input.currency,
					overtimeExempt: input.overtimeExempt,
					tipEligible: input.tipEligible,
					isPrimary: true,
					effectiveFrom: input.hiredDate,
					createdBy: ctx.auth.userId,
				})
				.returning()

			const tasks = checklist
				? await insertChecklist(tx, checklist, {
						staffId,
						baseDate: input.hiredDate,
						now,
						origin: 'hire',
					})
				: 0

			await tx
				.update(hiringApplications)
				.set({
					stage: 'hired',
					stageChangedAt: now,
					hiredStaffId: staffId,
					hiredAt: now,
					retentionExpiresAt: null,
					declinedAt: null,
					declinedReason: null,
					updatedAt: now,
				})
				.where(eq(hiringApplications.id, id))
			// Interviews still ahead are over: the candidate is hired.
			await tx
				.update(hiringInterviews)
				.set({ status: 'completed', updatedAt: now })
				.where(
					and(
						eq(hiringInterviews.applicationId, id),
						eq(hiringInterviews.status, 'scheduled'),
					),
				)
			await recordEvent(tx, {
				applicationId: id,
				kind: 'hired',
				actorId: ctx.auth.userId,
				fromStage: from,
				toStage: 'hired',
				now,
			})

			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: 'staff.created',
				entityType: 'staff',
				entityId: staffId,
				staffId,
				scopeId: input.scopeId,
				changes: {
					source: 'hire',
					linkedToLogin: false,
					scopes: [input.scopeId],
				},
			})
			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: 'staff.job.added',
				entityType: 'job',
				entityId: job!.id,
				staffId,
				scopeId: input.scopeId,
				changes: { positionId: input.positionId, primary: true },
			})
			if (setsPay) {
				await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
					action: 'staff.pay.set',
					entityType: 'job',
					entityId: job!.id,
					staffId,
					scopeId: input.scopeId,
					sensitivity: 'pay',
					changes: {
						payType: job!.payType,
						rateMinor: job!.rateMinor,
						annualSalaryMinor: job!.annualSalaryMinor,
						currency: job!.currency,
						overtimeExempt: job!.overtimeExempt,
						tipEligible: job!.tipEligible,
					},
				})
			}
			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: 'hiring.application.hired',
				entityType: 'application',
				entityId: id,
				staffId,
				scopeId: input.scopeId,
				changes: {
					from,
					positionId: input.positionId,
					onboardingTasks: tasks,
				},
			})

			return ok({
				staffId,
				applicationId: id,
				onboardingTasks: tasks,
				inviteEmail: row.email,
			})
		})
	} catch (error) {
		if (isUniqueViolation(error, ['employee_number'])) {
			return fail(409, 'employee_number_taken')
		}
		throw error
	}
}

// ---------------------------------------------------------------------------
// Erasure and retention
// ---------------------------------------------------------------------------

/**
 * Erases one applicant: the application, its answers, notes, interviews and
 * timeline all go (they cascade). The audit log is not touched and holds only
 * ids and counts. A hired applicant's staff record is a separate record with its
 * own erasure; this removes only the application.
 */
export async function eraseApplication(
	ctx: StaffContext,
	id: string,
): Promise<HiringResult<{ erased: true; wasHired: boolean }>> {
	return write(ctx.db, async (tx) => {
		const loaded = await loadVisible(tx, ctx, id)
		if (!loaded.ok) return loaded
		const row = loaded.value
		await tx.delete(hiringApplications).where(eq(hiringApplications.id, id))
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'hiring.application.erased',
			entityType: 'application',
			entityId: id,
			scopeId: row.scopeId,
			sensitivity: 'private',
			changes: { stage: row.stage, wasHired: row.hiredStaffId !== null },
		})
		return ok({ erased: true as const, wasHired: row.hiredStaffId !== null })
	})
}

/** Most rows one retention pass deletes, so a backlog never holds a long lock. */
export const RETENTION_BATCH = 200

/**
 * Purges declined applicants whose retention period has passed. Only declined
 * rows are ever selected: a candidate still in the pipeline or hired is never
 * touched, and reopening a candidate clears the clock. One audit row per pass
 * carries the count; the audit log itself is never purged.
 */
export async function purgeExpiredApplications(
	db: StaffDb,
	now: number,
): Promise<{ purged: number }> {
	const due = await db
		.select({ id: hiringApplications.id })
		.from(hiringApplications)
		.where(
			and(
				eq(hiringApplications.stage, 'declined'),
				lte(hiringApplications.retentionExpiresAt, now),
			),
		)
		.limit(RETENTION_BATCH)
	if (due.length === 0) return { purged: 0 }
	const ids = due.map((row) => row.id)
	await db.delete(hiringApplications).where(
		and(
			inArray(hiringApplications.id, ids),
			// Re-checked in the delete itself: a candidate reopened since the select
			// is not purged.
			eq(hiringApplications.stage, 'declined'),
			lte(hiringApplications.retentionExpiresAt, now),
		),
	)
	await writeSystemAudit(db, {
		action: 'hiring.applications.purged',
		entityType: 'application',
		changes: { count: ids.length, reason: 'retention' },
	})
	return { purged: ids.length }
}

/** Applications whose hire created these staff rows (used by staff erasure). */
export async function eraseApplicationsForStaff(
	tx: StaffDb,
	staffIds: readonly string[],
): Promise<number> {
	if (staffIds.length === 0) return 0
	const deleted = await tx
		.delete(hiringApplications)
		.where(inArray(hiringApplications.hiredStaffId, [...staffIds]))
		.returning({ id: hiringApplications.id })
	return deleted.length
}

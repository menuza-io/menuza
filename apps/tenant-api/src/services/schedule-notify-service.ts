import { and, asc, between, eq, inArray, like, sql } from 'drizzle-orm'
import {
	addDays,
	dedupeKeys,
	managerOutboxKind,
	RESEND_COOLDOWN_MS,
	scheduleNoticeKey,
	scheduleNoticePrefix,
	scheduleNoticeRound,
	scheduleRecipients,
	isSchedulePublishedPayload,
	type ContactLevel,
	type NotReachedReason,
	type NoticeState,
	type NoticeView,
	type PublicationNoticesView,
	type PublicationNotification,
	type Resend,
	type ResendResult,
	type ScheduleNotifyMode,
	type SchedulePublishedPayload,
	type ScheduleLinkStatus,
	type ScheduleRecipient,
} from '@repo/staffing'
import {
	notificationOutbox,
	schedulePublications,
	shifts,
	staffMembers,
	staffPositions,
	type NotificationOutboxRow,
	type SchedulePublicationChange,
	type SchedulePublicationRow,
	type StaffMember,
	type TenantDatabase,
} from '@repo/tenant-db'
import { isEmailEnabled } from '../lib/email-switch.ts'
import { scheduleLinkUrl } from '../lib/schedule-link.ts'
import {
	normalizeStaffLocale,
	renderScheduleEmail,
	type RenderedStaffEmail,
	type ScheduleEmailShift,
} from '../lib/staff-email.ts'
import {
	ensureScheduleLink,
	revokeScheduleLink,
	scheduleLinkStatus,
} from './schedule-link-service.ts'
import {
	isOpaqueId,
	loadPeople,
	personVisible,
	type ScheduleContext,
	type ScheduleResult,
} from './schedule-shared.ts'
import { type StaffDb, writeStaffAudit } from './staff-audit.ts'
import { fail, ok } from './timesheet-shared.ts'
import { queryInChunks, inJsonList } from '../lib/chunked-in.ts'

/**
 * Telling people about a publication. Three parts:
 *
 * - at publish time, inside the publication's own transaction, a message is
 *   queued for each person who should hear about it (and the ones who cannot be
 *   reached are recorded with the reason, so the manager can see them);
 * - at send time, the regional tick builds the email from the live schedule,
 *   selecting only that person's own shifts, and attaches their link;
 * - afterwards a manager can see who was told and resend.
 *
 * The queued row carries ids and counts only. The times in an email are read
 * when it is sent, so a late or repeated message can never state an old time.
 */

/** Statuses of a person who can be sent a schedule. */
const NOTIFIABLE = 'active'
const PEOPLE_CHUNK = 90
/** Shifts listed in one email. */
const MAX_EMAIL_SHIFTS = 60
export const MAX_NOT_REACHED = 500

type NotReached = PublicationNotification['notReached']

function chunked<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size))
	return out
}

async function loadMembers(
	db: StaffDb,
	ids: readonly string[],
): Promise<Map<string, StaffMember>> {
	const map = new Map<string, StaffMember>()
	for (const part of chunked([...new Set(ids)], PEOPLE_CHUNK)) {
		const rows = await queryInChunks(part, (chunk) =>
			db.select().from(staffMembers).where(inArray(staffMembers.id, chunk)),
		)
		for (const row of rows) map.set(row.id, row)
	}
	return map
}

/** People with a live published shift at the scope in the week. */
export async function loadLiveStaffIds(
	db: StaffDb,
	scopeId: string,
	weekStart: string,
): Promise<string[]> {
	const rows = await db
		.selectDistinct({ staffId: shifts.staffId })
		.from(shifts)
		.where(
			and(
				eq(shifts.scopeId, scopeId),
				eq(shifts.status, 'published'),
				between(shifts.localDate, weekStart, addDays(weekStart, 6)),
			),
		)
	return rows.flatMap((row) => (row.staffId ? [row.staffId] : []))
}

type Eligibility =
	| { eligible: true; member: StaffMember }
	| { eligible: false; reason: NotReachedReason }

function eligibility(
	member: StaffMember | undefined,
	emailOn: boolean,
): Eligibility {
	if (!member || member.status !== NOTIFIABLE) {
		return { eligible: false, reason: 'inactive' }
	}
	if (!member.email) return { eligible: false, reason: 'no_email' }
	if (!emailOn) return { eligible: false, reason: 'email_disabled' }
	return { eligible: true, member }
}

function payloadFor(
	publication: {
		id: string
		scopeId: string
		weekStart: string
		version: number
	},
	mode: ScheduleNotifyMode,
	recipient: ScheduleRecipient,
): SchedulePublishedPayload {
	return {
		publicationId: publication.id,
		scopeId: publication.scopeId,
		weekStart: publication.weekStart,
		version: publication.version,
		mode,
		changedShiftIds: recipient.changedShiftIds,
		removedShiftIds: recipient.removedShiftIds,
	}
}

async function enqueueNotices(
	db: StaffDb,
	input: {
		publication: {
			id: string
			scopeId: string
			weekStart: string
			version: number
		}
		mode: ScheduleNotifyMode
		recipients: readonly ScheduleRecipient[]
		members: Map<string, StaffMember>
		round: number
		now: number
		emailOn: boolean
	},
): Promise<{ queued: number; notReached: NotReached }> {
	const notReached: NotReached = []
	let queued = 0
	for (const recipient of input.recipients) {
		const result = eligibility(
			input.members.get(recipient.staffId),
			input.emailOn,
		)
		if (!result.eligible) {
			notReached.push({ staffId: recipient.staffId, reason: result.reason })
			continue
		}
		const inserted = await db
			.insert(notificationOutbox)
			.values({
				kind: 'schedule_published',
				staffId: recipient.staffId,
				scopeId: input.publication.scopeId,
				dedupeKey: scheduleNoticeKey(
					input.publication.id,
					recipient.staffId,
					input.round,
				),
				payload: payloadFor(input.publication, input.mode, recipient),
				nextAttemptAt: input.now,
				createdAt: input.now,
			})
			.onConflictDoNothing()
			.returning({ id: notificationOutbox.id })
		if (inserted.length > 0) queued++
	}
	return { queued, notReached: notReached.slice(0, MAX_NOT_REACHED) }
}

/**
 * Queues the messages of a publication. Runs inside the publish transaction,
 * so a week never goes live without its messages being owed (and never the
 * other way round).
 */
export async function planPublicationNotices(
	tx: StaffDb,
	input: {
		publication: {
			id: string
			scopeId: string
			weekStart: string
			version: number
		}
		mode: ScheduleNotifyMode
		changes: readonly SchedulePublicationChange[]
		liveStaffIds: readonly string[]
		now: number
	},
): Promise<PublicationNotification> {
	const recipients = scheduleRecipients({
		mode: input.mode,
		changes: input.changes,
		liveStaffIds: input.liveStaffIds,
	})
	if (recipients.length === 0) {
		return { mode: input.mode, recipients: 0, queued: 0, notReached: [] }
	}
	const members = await loadMembers(
		tx,
		recipients.map((r) => r.staffId),
	)
	const { queued, notReached } = await enqueueNotices(tx, {
		publication: input.publication,
		mode: input.mode,
		recipients,
		members,
		round: 0,
		now: input.now,
		emailOn: isEmailEnabled(),
	})
	return {
		mode: input.mode,
		recipients: recipients.length,
		queued,
		notReached,
	}
}

/**
 * Queues the generic "a schedule was published" event for managers (the App
 * turns it into notifications). It carries the publisher's opaque user id so the
 * App can leave them out; nothing about the shifts or the people.
 */
export async function queueManagerNotice(
	tx: StaffDb,
	input: {
		publicationId: string
		scopeId: string
		publishedBy: string
		now: number
	},
) {
	await tx
		.insert(notificationOutbox)
		.values({
			kind: managerOutboxKind('schedule_published'),
			// The outbox column is "who it is about"; this is about nobody.
			staffId: 'system',
			scopeId: input.scopeId,
			dedupeKey: dedupeKeys.schedulePublishedManagers(input.publicationId),
			payload: { publishedBy: input.publishedBy },
			nextAttemptAt: input.now,
			createdAt: input.now,
		})
		.onConflictDoNothing()
}

// ---------------------------------------------------------------------------
// Who was told, and resending
// ---------------------------------------------------------------------------

async function loadPublication(
	ctx: ScheduleContext,
	id: string,
): Promise<ScheduleResult<SchedulePublicationRow>> {
	if (!isOpaqueId(id)) return fail(404, 'not_found')
	const [row] = await ctx.db
		.select()
		.from(schedulePublications)
		.where(eq(schedulePublications.id, id))
		.limit(1)
	// Outside the token's scopes reads as missing.
	if (!row || !ctx.scope.allows(row.scopeId)) return fail(404, 'not_found')
	return ok(row)
}

async function isCurrent(
	db: StaffDb,
	row: SchedulePublicationRow,
): Promise<boolean> {
	const [later] = await db
		.select({ id: schedulePublications.id })
		.from(schedulePublications)
		.where(
			and(
				eq(schedulePublications.scopeId, row.scopeId),
				eq(schedulePublications.weekStartDate, row.weekStartDate),
				sql`${schedulePublications.version} > ${row.version}`,
			),
		)
		.limit(1)
	return !later
}

function stateOf(row: NotificationOutboxRow): NoticeState {
	if (row.status === 'pending') return 'pending'
	if (row.status === 'sent') return 'sent'
	if (row.status === 'failed') return 'failed'
	return 'not_sent'
}

async function noticeRows(
	db: StaffDb,
	publicationId: string,
): Promise<NotificationOutboxRow[]> {
	return db
		.select()
		.from(notificationOutbox)
		.where(
			and(
				eq(notificationOutbox.kind, 'schedule_published'),
				like(
					notificationOutbox.dedupeKey,
					`${scheduleNoticePrefix(publicationId)}%`,
				),
			),
		)
		.orderBy(asc(notificationOutbox.createdAt))
		.limit(5000)
}

/** The latest message per person. */
function latestPerPerson(
	rows: readonly NotificationOutboxRow[],
): Map<string, NotificationOutboxRow> {
	const latest = new Map<string, NotificationOutboxRow>()
	for (const row of rows) {
		const previous = latest.get(row.staffId)
		if (
			!previous ||
			scheduleNoticeRound(row.dedupeKey) >=
				scheduleNoticeRound(previous.dedupeKey)
		) {
			latest.set(row.staffId, row)
		}
	}
	return latest
}

export async function listNotices(
	ctx: ScheduleContext,
	publicationId: string,
): Promise<ScheduleResult<PublicationNoticesView>> {
	const loaded = await loadPublication(ctx, publicationId)
	if (!loaded.ok) return loaded
	const publication = loaded.value
	const latest = latestPerPerson(await noticeRows(ctx.db, publication.id))
	const notices: NoticeView[] = [...latest.values()].map((row) => ({
		staffId: row.staffId,
		state: stateOf(row),
		reason:
			row.status === 'skipped' || row.status === 'failed'
				? row.lastError
				: null,
		round: scheduleNoticeRound(row.dedupeKey),
		sentAt: row.sentAt,
	}))
	// Someone who was never reached at first but has a message since is not
	// "not reached" any more.
	const notReached = (publication.notification?.notReached ?? []).filter(
		(entry) => !latest.has(entry.staffId),
	)
	return ok({
		publicationId: publication.id,
		mode: publication.notifyMode,
		current: await isCurrent(ctx.db, publication),
		emailEnabled: isEmailEnabled(),
		notices,
		notReached,
	})
}

/**
 * Sends the notifications of a publication again: to everyone not yet reached
 * (the default) or to everyone it was meant for. Only the latest publication of
 * a week can be resent (an older one is superseded: its people were told about
 * the newer one), and not twice within a few minutes.
 */
export async function resendNotices(
	ctx: ScheduleContext & { db: TenantDatabase },
	publicationId: string,
	input: Resend,
): Promise<ScheduleResult<ResendResult>> {
	const loaded = await loadPublication(ctx, publicationId)
	if (!loaded.ok) return loaded
	const publication = loaded.value
	if (!(await isCurrent(ctx.db, publication))) return fail(409, 'superseded')
	if (!isEmailEnabled()) return fail(409, 'email_disabled')

	const existing = await noticeRows(ctx.db, publication.id)
	const lastQueuedAt = existing.reduce(
		(max, row) => Math.max(max, row.createdAt),
		0,
	)
	if (lastQueuedAt > 0 && ctx.now - lastQueuedAt < RESEND_COOLDOWN_MS) {
		return fail(409, 'resend_too_soon', {
			retryAfterSeconds: Math.ceil(
				(lastQueuedAt + RESEND_COOLDOWN_MS - ctx.now) / 1000,
			),
		})
	}

	// A quiet publication can be announced afterwards: tell the people whose
	// shifts it changed.
	const mode: ScheduleNotifyMode =
		publication.notifyMode === 'nobody' ? 'changed' : publication.notifyMode
	const live = await loadLiveStaffIds(
		ctx.db,
		publication.scopeId,
		publication.weekStartDate,
	)
	let recipients = scheduleRecipients({
		mode,
		changes: publication.changes,
		liveStaffIds: live,
	})
	const latest = latestPerPerson(existing)
	if (input.scope === 'unsent') {
		recipients = recipients.filter((recipient) => {
			const row = latest.get(recipient.staffId)
			return !row || row.status === 'failed' || row.status === 'skipped'
		})
	}
	const round =
		existing.reduce(
			(max, row) => Math.max(max, scheduleNoticeRound(row.dedupeKey)),
			-1,
		) + 1

	const members = await loadMembers(
		ctx.db,
		recipients.map((r) => r.staffId),
	)
	const result = await ctx.db.transaction(async (tx) => {
		const queued = await enqueueNotices(tx, {
			publication: {
				id: publication.id,
				scopeId: publication.scopeId,
				weekStart: publication.weekStartDate,
				version: publication.version,
			},
			mode,
			recipients,
			members,
			round,
			now: ctx.now,
			emailOn: true,
		})
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.publication.resent',
			entityType: 'schedule_publication',
			entityId: publication.id,
			scopeId: publication.scopeId,
			changes: {
				scope: input.scope,
				round,
				queued: queued.queued,
				notReached: queued.notReached.length,
			},
		})
		return queued
	})
	return ok(result)
}

// ---------------------------------------------------------------------------
// Building the email (at send time)
// ---------------------------------------------------------------------------

export type ScheduleNoticeBuild =
	| { status: 'ok'; mail: RenderedStaffEmail }
	| { status: 'skip'; reason: 'bad_payload' }

/**
 * The email for one queued "schedule published" message, built from the live
 * schedule. It selects the recipient's own published shifts by their id and
 * nothing else, so no other person's name, time or position can reach the
 * message. The capability link is created or reused here.
 */
export async function buildScheduleNotice(
	db: StaffDb,
	input: {
		orgId: string
		row: Pick<NotificationOutboxRow, 'payload'>
		person: StaffMember
		level: ContactLevel
		scope: { name: string; timeZone: string } | null
		now: number
	},
): Promise<ScheduleNoticeBuild> {
	const payload = input.row.payload
	if (!isSchedulePublishedPayload(payload)) {
		return { status: 'skip', reason: 'bad_payload' }
	}
	const { person } = input
	const locale = normalizeStaffLocale(person.locale)
	const weekStart = payload.weekStart
	const weekEnd = addDays(weekStart, 6)

	const own = await db
		.select({
			shift: shifts,
			positionName: staffPositions.name,
			positionNameAr: staffPositions.nameAr,
		})
		.from(shifts)
		.leftJoin(staffPositions, eq(staffPositions.id, shifts.positionId))
		.where(
			and(
				eq(shifts.staffId, person.id),
				eq(shifts.scopeId, payload.scopeId),
				eq(shifts.status, 'published'),
				between(shifts.localDate, weekStart, weekEnd),
			),
		)
		.orderBy(asc(shifts.startsAt), asc(shifts.id))
		.limit(MAX_EMAIL_SHIFTS)
	const changedIds = new Set(payload.changedShiftIds)
	const heldIds = new Set(own.map((row) => row.shift.id))
	const name = (row: {
		positionName: string | null
		positionNameAr: string | null
	}) =>
		locale === 'ar' && row.positionNameAr
			? row.positionNameAr
			: row.positionName

	const shiftsOut: ScheduleEmailShift[] = own.map((row) => ({
		startsAt: row.shift.startsAt,
		endsAt: row.shift.endsAt,
		positionName: name(row),
		change: changedIds.has(row.shift.id)
			? payload.version <= 1
				? 'new'
				: 'changed'
			: 'same',
	}))

	// Shifts taken off this person (cancelled, or given to someone else). The
	// query returns times and a position only, never who holds the shift now.
	const removedIds = payload.removedShiftIds
		.filter((id) => !heldIds.has(id))
		.slice(0, MAX_EMAIL_SHIFTS)
	const removed = removedIds.length
		? (
				await db
					.select({
						startsAt: shifts.startsAt,
						endsAt: shifts.endsAt,
						positionName: staffPositions.name,
						positionNameAr: staffPositions.nameAr,
					})
					.from(shifts)
					.leftJoin(staffPositions, eq(staffPositions.id, shifts.positionId))
					.where(
						and(
							inJsonList(shifts.id, removedIds),
							eq(shifts.scopeId, payload.scopeId),
						),
					)
					.orderBy(asc(shifts.startsAt))
			).map((row) => ({
				startsAt: row.startsAt,
				endsAt: row.endsAt,
				positionName: name(row),
			}))
		: []

	const { token } = await ensureScheduleLink(
		db,
		input.orgId,
		person.id,
		input.now,
	)
	const mail = renderScheduleEmail({
		level: input.level,
		locale,
		firstName:
			locale === 'ar' && person.firstNameAr
				? person.firstNameAr
				: person.firstName,
		scopeName: input.scope?.name ?? null,
		timeZone: input.scope?.timeZone ?? null,
		weekStart,
		version: payload.version,
		mode: payload.mode,
		shifts: shiftsOut,
		removed,
		linkUrl: scheduleLinkUrl(token),
	})
	return { status: 'ok', mail }
}

// ---------------------------------------------------------------------------
// A person's link, as a manager sees it
// ---------------------------------------------------------------------------

async function visibleStaff(
	ctx: ScheduleContext,
	staffId: string,
): Promise<ScheduleResult<StaffMember>> {
	if (!isOpaqueId(staffId)) return fail(404, 'not_found')
	const person = (await loadPeople(ctx.db, [staffId])).get(staffId)
	if (!person || !personVisible(ctx.scope, person))
		return fail(404, 'not_found')
	return ok(person.member)
}

export async function getLinkStatus(
	ctx: ScheduleContext,
	staffId: string,
): Promise<ScheduleResult<ScheduleLinkStatus>> {
	const person = await visibleStaff(ctx, staffId)
	if (!person.ok) return person
	return ok(await scheduleLinkStatus(ctx.db, staffId, ctx.now))
}

/**
 * Ends a person's "my schedule" link. They keep nothing: the next schedule email
 * makes a new one. Idempotent.
 */
export async function revokeLink(
	ctx: ScheduleContext & { db: TenantDatabase },
	staffId: string,
): Promise<ScheduleResult<ScheduleLinkStatus>> {
	const person = await visibleStaff(ctx, staffId)
	if (!person.ok) return person
	await ctx.db.transaction(async (tx) => {
		const revoked = await revokeScheduleLink(
			tx,
			staffId,
			ctx.now,
			ctx.auth.userId,
		)
		if (revoked) {
			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: 'schedule.link.revoked',
				entityType: 'schedule_link',
				entityId: staffId,
				staffId,
				changes: { revoked: true },
			})
		}
	})
	return ok(await scheduleLinkStatus(ctx.db, staffId, ctx.now))
}

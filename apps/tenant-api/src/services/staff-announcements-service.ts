import { and, desc, eq, gt, isNull, lte } from 'drizzle-orm'
import {
	ANNOUNCEMENT_MAX_ACTIVE,
	ANNOUNCEMENT_MAX_DAYS,
	type AnnouncementCreate,
	type AnnouncementDetailView,
	type AnnouncementRecipient,
	type AnnouncementView,
	type MyAnnouncement,
	type MyAnnouncementsView,
} from '@repo/staffing'
import {
	staffAnnouncementReads,
	staffAnnouncements,
	staffJobs,
	staffMembers,
	staffPositions,
	staffScopeAssignments,
	type StaffAnnouncement,
	type TenantDatabase,
	runTenantTransaction,
} from '@repo/tenant-db'
import { inJsonList } from '../lib/chunked-in.ts'
import { type ScopeAccess, type StaffAuth } from '../lib/staff-auth.ts'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import {
	type StaffAuditEvent,
	type StaffDb,
	writeStaffAudit,
} from './staff-audit.ts'
import { fail, ok, type TimesheetResult } from './timesheet-shared.ts'

/**
 * Announcements to staff (#486). Regional data: the words are the manager's own
 * and who read them is staff data, so none of it reaches the control plane or
 * any alert. A manager writes one for everyone, one position or one scope; a
 * person sees the ones meant for them on My schedule and on Station, and "Got
 * it" records that they did. An announcement expires and can be withdrawn but is
 * never deleted, so the record of who read it stays.
 */

export type AnnouncementResult<T> = TimesheetResult<T>

export type AnnouncementContext = {
	db: TenantDatabase
	auth: StaffAuth
	scope: ScopeAccess
	ipHash: string | null
	now: number
}

const DAY_MS = 24 * 60 * 60 * 1000

function stateOf(
	row: Pick<StaffAnnouncement, 'startsAt' | 'expiresAt' | 'withdrawnAt'>,
	now: number,
): AnnouncementView['state'] {
	if (row.withdrawnAt !== null) return 'withdrawn'
	if (row.expiresAt <= now) return 'expired'
	if (row.startsAt > now) return 'scheduled'
	return 'live'
}

type Audience = {
	audience: StaffAnnouncement['audience']
	audienceId: string | null
}

/** Active staff an announcement is for, by id. */
async function eligibleStaff(
	db: StaffDb,
	audience: Audience,
): Promise<Array<{ id: string; firstName: string; lastName: string }>> {
	const members = await db
		.select({
			id: staffMembers.id,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
		})
		.from(staffMembers)
		.where(eq(staffMembers.status, 'active'))
	if (audience.audience === 'everyone' || audience.audienceId === null) {
		return members
	}
	const ids =
		audience.audience === 'position'
			? (
					await db
						.select({ staffId: staffJobs.staffId })
						.from(staffJobs)
						.where(
							and(
								eq(staffJobs.positionId, audience.audienceId),
								isNull(staffJobs.effectiveTo),
							),
						)
				).map((row) => row.staffId)
			: (
					await db
						.select({ staffId: staffScopeAssignments.staffId })
						.from(staffScopeAssignments)
						.where(
							and(
								eq(staffScopeAssignments.scopeId, audience.audienceId),
								eq(staffScopeAssignments.active, true),
							),
						)
				).map((row) => row.staffId)
	const wanted = new Set(ids)
	return members.filter((member) => wanted.has(member.id))
}

async function toView(
	db: StaffDb,
	row: StaffAnnouncement,
	now: number,
): Promise<AnnouncementView> {
	const [recipients, reads] = await Promise.all([
		eligibleStaff(db, row),
		db
			.select({ staffId: staffAnnouncementReads.staffId })
			.from(staffAnnouncementReads)
			.where(eq(staffAnnouncementReads.announcementId, row.id)),
	])
	const eligible = new Set(recipients.map((member) => member.id))
	return {
		id: row.id,
		title: row.title,
		body: row.body,
		audience: row.audience,
		audienceId: row.audienceId,
		startsAt: row.startsAt,
		expiresAt: row.expiresAt,
		createdAt: row.createdAt,
		withdrawnAt: row.withdrawnAt,
		state: stateOf(row, now),
		recipients: recipients.length,
		// Someone who tapped it and has since left the audience is not counted.
		read: reads.filter((read) => eligible.has(read.staffId)).length,
	}
}

/** Announcements a token may see: a limited token sees only its scopes'. */
function visibleTo(scope: ScopeAccess, row: StaffAnnouncement): boolean {
	if (scope.unrestricted) return true
	return row.audience === 'scope' && row.audienceId !== null
		? scope.allows(row.audienceId)
		: false
}

export async function listAnnouncements(
	ctx: AnnouncementContext,
	options: { includeExpired: boolean },
): Promise<AnnouncementResult<{ announcements: AnnouncementView[] }>> {
	const rows = await ctx.db
		.select()
		.from(staffAnnouncements)
		.where(
			options.includeExpired
				? undefined
				: and(
						isNull(staffAnnouncements.withdrawnAt),
						gt(staffAnnouncements.expiresAt, ctx.now),
					),
		)
		.orderBy(desc(staffAnnouncements.createdAt))
		.limit(200)
	const views: AnnouncementView[] = []
	for (const row of rows) {
		if (visibleTo(ctx.scope, row))
			views.push(await toView(ctx.db, row, ctx.now))
	}
	return ok({ announcements: views })
}

export async function getAnnouncement(
	ctx: AnnouncementContext,
	id: string,
): Promise<AnnouncementResult<AnnouncementDetailView>> {
	const [row] = await ctx.db
		.select()
		.from(staffAnnouncements)
		.where(eq(staffAnnouncements.id, id))
		.limit(1)
	if (!row || !visibleTo(ctx.scope, row)) return fail(404, 'not_found')
	const [recipients, reads] = await Promise.all([
		eligibleStaff(ctx.db, row),
		ctx.db
			.select()
			.from(staffAnnouncementReads)
			.where(eq(staffAnnouncementReads.announcementId, row.id)),
	])
	const readBy = new Map(reads.map((read) => [read.staffId, read]))
	const people: AnnouncementRecipient[] = recipients
		.map((member) => ({
			staffId: member.id,
			firstName: member.firstName,
			lastName: member.lastName,
			readAt: readBy.get(member.id)?.readAt ?? null,
			source: readBy.get(member.id)?.source ?? null,
		}))
		// Who has not read it first: that is who the manager looks for.
		.sort(
			(a, b) =>
				Number(a.readAt !== null) - Number(b.readAt !== null) ||
				a.firstName.localeCompare(b.firstName),
		)
	return ok({
		announcement: await toView(ctx.db, row, ctx.now),
		recipients: people,
	})
}

export async function createAnnouncement(
	ctx: AnnouncementContext,
	input: AnnouncementCreate,
): Promise<AnnouncementResult<{ announcement: AnnouncementView }>> {
	const startsAt = input.startsAt ?? ctx.now
	if (input.expiresAt <= ctx.now) return fail(422, 'expiry_in_the_past')
	if (input.expiresAt <= startsAt) return fail(422, 'starts_after_expiry')
	if (input.expiresAt > ctx.now + ANNOUNCEMENT_MAX_DAYS * DAY_MS) {
		return fail(422, 'expiry_too_far')
	}
	// Everyone and a position reach across places, so a token limited to some
	// places can only write to a place it holds.
	if (input.audience !== 'scope' && !ctx.scope.unrestricted) {
		return fail(403, 'unrestricted_scope_required')
	}
	if (input.audience === 'scope' && !ctx.scope.allows(input.audienceId!)) {
		return fail(403, 'scope_out_of_scope')
	}

	return retryOnSqliteBusy(() =>
		runTenantTransaction(
			ctx.db,
			async (
				tx,
			): Promise<AnnouncementResult<{ announcement: AnnouncementView }>> => {
				if (input.audience === 'position') {
					const [position] = await tx
						.select({ id: staffPositions.id })
						.from(staffPositions)
						.where(eq(staffPositions.id, input.audienceId!))
						.limit(1)
					if (!position) return fail(422, 'unknown_position')
				}
				const active = await tx
					.select({ id: staffAnnouncements.id })
					.from(staffAnnouncements)
					.where(
						and(
							isNull(staffAnnouncements.withdrawnAt),
							gt(staffAnnouncements.expiresAt, ctx.now),
						),
					)
				if (active.length >= ANNOUNCEMENT_MAX_ACTIVE) {
					return fail(409, 'too_many_active')
				}
				const [row] = await tx
					.insert(staffAnnouncements)
					.values({
						title: input.title,
						body: input.body,
						audience: input.audience,
						audienceId: input.audienceId ?? null,
						startsAt,
						expiresAt: input.expiresAt,
						createdBy: ctx.auth.userId,
						createdAt: ctx.now,
					})
					.returning()
				await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
					action: 'announcement.created',
					entityType: 'announcement',
					entityId: row!.id,
					scopeId: input.audience === 'scope' ? input.audienceId : null,
					// Ids and times only: the words stay in the announcement row.
					changes: {
						audience: input.audience,
						audienceId: input.audienceId ?? null,
						expiresAt: input.expiresAt,
					},
				})
				return ok({ announcement: await toView(tx, row!, ctx.now) })
			},
		),
	)
}

export async function withdrawAnnouncement(
	ctx: AnnouncementContext,
	id: string,
): Promise<AnnouncementResult<{ announcement: AnnouncementView }>> {
	return retryOnSqliteBusy(() =>
		runTenantTransaction(
			ctx.db,
			async (
				tx,
			): Promise<AnnouncementResult<{ announcement: AnnouncementView }>> => {
				const [row] = await tx
					.select()
					.from(staffAnnouncements)
					.where(eq(staffAnnouncements.id, id))
					.limit(1)
				if (!row || !visibleTo(ctx.scope, row)) return fail(404, 'not_found')
				if (row.withdrawnAt !== null) return fail(409, 'already_withdrawn')
				const [updated] = await tx
					.update(staffAnnouncements)
					.set({ withdrawnAt: ctx.now, withdrawnBy: ctx.auth.userId })
					.where(
						and(
							eq(staffAnnouncements.id, id),
							isNull(staffAnnouncements.withdrawnAt),
						),
					)
					.returning()
				if (!updated) return fail(409, 'already_withdrawn')
				await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
					action: 'announcement.withdrawn',
					entityType: 'announcement',
					entityId: id,
				})
				return ok({ announcement: await toView(tx, updated, ctx.now) })
			},
		),
	)
}

// ---------------------------------------------------------------------------
// What a person sees
// ---------------------------------------------------------------------------

export type AnnouncementReader = {
	db: TenantDatabase
	staffId: string
	now: number
}

/** Position ids and scope ids that decide which announcements are a person's. */
async function audienceOf(db: StaffDb, staffId: string) {
	const [jobs, scopes] = await Promise.all([
		db
			.select({ positionId: staffJobs.positionId })
			.from(staffJobs)
			.where(
				and(eq(staffJobs.staffId, staffId), isNull(staffJobs.effectiveTo)),
			),
		db
			.select({ scopeId: staffScopeAssignments.scopeId })
			.from(staffScopeAssignments)
			.where(
				and(
					eq(staffScopeAssignments.staffId, staffId),
					eq(staffScopeAssignments.active, true),
				),
			),
	])
	return {
		positionIds: new Set(jobs.map((job) => job.positionId)),
		scopeIds: new Set(scopes.map((scope) => scope.scopeId)),
	}
}

function isForPerson(
	row: StaffAnnouncement,
	audience: { positionIds: Set<string>; scopeIds: Set<string> },
): boolean {
	if (row.audience === 'everyone') return true
	if (row.audienceId === null) return false
	return row.audience === 'position'
		? audience.positionIds.has(row.audienceId)
		: audience.scopeIds.has(row.audienceId)
}

/**
 * The announcements that are live now and meant for this person, newest first,
 * each with whether they tapped "Got it". `unreadOnly` is what Station shows
 * after a punch. Only the words and the dates leave: never who else read it.
 */
export async function loadMyAnnouncements(
	reader: AnnouncementReader,
	options: { unreadOnly?: boolean } = {},
): Promise<MyAnnouncementsView> {
	const rows = await reader.db
		.select()
		.from(staffAnnouncements)
		.where(
			and(
				isNull(staffAnnouncements.withdrawnAt),
				lte(staffAnnouncements.startsAt, reader.now),
				gt(staffAnnouncements.expiresAt, reader.now),
			),
		)
		.orderBy(desc(staffAnnouncements.createdAt))
		.limit(100)
	const audience = await audienceOf(reader.db, reader.staffId)
	const mine = rows.filter((row) => isForPerson(row, audience))
	const reads = mine.length
		? await reader.db
				.select()
				.from(staffAnnouncementReads)
				.where(
					and(
						eq(staffAnnouncementReads.staffId, reader.staffId),
						inJsonList(
							staffAnnouncementReads.announcementId,
							mine.map((row) => row.id),
						),
					),
				)
		: []
	const readAt = new Map(
		reads.map((read) => [read.announcementId, read.readAt]),
	)
	const announcements: MyAnnouncement[] = mine
		.map((row) => ({
			id: row.id,
			title: row.title,
			body: row.body,
			expiresAt: row.expiresAt,
			createdAt: row.createdAt,
			readAt: readAt.get(row.id) ?? null,
		}))
		.filter((row) => !options.unreadOnly || row.readAt === null)
	return { serverNow: reader.now, announcements }
}

/**
 * "Got it": records that this person read an announcement meant for them.
 * Repeating it keeps the first time. An announcement that is not theirs, has
 * expired or was withdrawn looks like one that does not exist.
 */
export async function markAnnouncementRead(
	reader: AnnouncementReader & {
		/** Writes the audit row as whoever is acting (a link, or a Station terminal). */
		audit: (tx: StaffDb, event: StaffAuditEvent) => Promise<void>
	},
	announcementId: string,
	source: 'schedule' | 'station',
): Promise<AnnouncementResult<{ readAt: number }>> {
	return retryOnSqliteBusy(() =>
		runTenantTransaction(
			reader.db,
			async (tx): Promise<AnnouncementResult<{ readAt: number }>> => {
				const [row] = await tx
					.select()
					.from(staffAnnouncements)
					.where(eq(staffAnnouncements.id, announcementId))
					.limit(1)
				if (
					!row ||
					row.withdrawnAt !== null ||
					row.startsAt > reader.now ||
					row.expiresAt <= reader.now
				) {
					return fail(404, 'not_found')
				}
				const audience = await audienceOf(tx, reader.staffId)
				if (!isForPerson(row, audience)) return fail(404, 'not_found')
				const [existing] = await tx
					.select()
					.from(staffAnnouncementReads)
					.where(
						and(
							eq(staffAnnouncementReads.announcementId, row.id),
							eq(staffAnnouncementReads.staffId, reader.staffId),
						),
					)
					.limit(1)
				if (existing) return ok({ readAt: existing.readAt })
				await tx
					.insert(staffAnnouncementReads)
					.values({
						announcementId: row.id,
						staffId: reader.staffId,
						source,
						readAt: reader.now,
					})
					.onConflictDoNothing()
				await reader.audit(tx, {
					action: 'announcement.read',
					entityType: 'announcement',
					entityId: row.id,
					staffId: reader.staffId,
					changes: { source },
				})
				return ok({ readAt: reader.now })
			},
		),
	)
}

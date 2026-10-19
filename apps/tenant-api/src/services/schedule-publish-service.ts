import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import {
	addDays,
	SCHEDULE_MAX_SHIFTS_PER_WEEK,
	type Publish,
	type PublishResult,
	type SchedulePublicationView,
} from '@repo/staffing'
import {
	schedulePublications,
	scheduleWeeks,
	shifts,
	type SchedulePublicationChange,
	type SchedulePublicationRow,
	type ShiftDraftPatch,
	type ShiftRow,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	chunk,
	effectiveShift,
	FrameCache,
	isOpaqueId,
	loadScopeShifts,
	loadPeople,
	requireFrame,
	snapWeekStart,
	type ScheduleContext,
	type ScheduleResult,
} from './schedule-shared.ts'
import { transact } from './schedule-shift-service.ts'
import {
	loadLiveStaffIds,
	planPublicationNotices,
	queueManagerNotice,
} from './schedule-notify-service.ts'
import { writeStaffAudit } from './staff-audit.ts'
import { fail, ok } from './timesheet-shared.ts'
import { inJsonList } from '../lib/chunked-in.ts'

/**
 * Publishing a week. In one transaction: drafts become published, pending
 * edits are applied to their published shifts, pending removals cancel their
 * shifts, the week's publish counter goes up, and one append-only publication
 * row records what changed (shift and person ids and counts, never names, times
 * or pay). Staff only ever see published fields until this runs.
 *
 * Telling people is queued in the same transaction (`schedule-notify-service`):
 * one message per person who should hear about it, per the notify mode, plus a
 * generic event for managers. Nothing here sends anything; the regional tick
 * delivers the queue.
 */

export type PublishContext = Omit<ScheduleContext, 'db'> & {
	db: TenantDatabase
}

const BULK_CHUNK = 90

function toPublicationView(
	row: SchedulePublicationRow,
): SchedulePublicationView {
	return {
		id: row.id,
		scopeId: row.scopeId,
		weekStart: row.weekStartDate,
		version: row.version,
		notifyMode: row.notifyMode,
		summary: row.summary,
		publishedBy: row.publishedBy,
		publishedAt: row.publishedAt,
		changes: row.changes,
		notification: row.notification ?? null,
	}
}

export async function publishWeek(
	ctx: PublishContext,
	input: Publish,
): Promise<ScheduleResult<PublishResult>> {
	const frames = new FrameCache(ctx)
	const framed = await requireFrame(
		ctx,
		frames,
		input.scopeId,
		'scope_out_of_scope',
	)
	if (!framed.ok) return framed
	const frame = framed.value
	const weekStart = snapWeekStart(input.weekStart, frame)
	const weekEnd = addDays(weekStart, 6)

	return transact(ctx.db, async (tx) => {
		// The week row carries the counter; the first publish creates it.
		let [week] = await tx
			.select()
			.from(scheduleWeeks)
			.where(
				and(
					eq(scheduleWeeks.scopeId, frame.scopeId),
					eq(scheduleWeeks.weekStartDate, weekStart),
				),
			)
			.limit(1)
		if (!week) {
			;[week] = await tx
				.insert(scheduleWeeks)
				.values({
					scopeId: frame.scopeId,
					weekStartDate: weekStart,
					version: 0,
					createdAt: ctx.now,
					updatedAt: ctx.now,
				})
				.onConflictDoNothing()
				.returning()
			if (!week) {
				;[week] = await tx
					.select()
					.from(scheduleWeeks)
					.where(
						and(
							eq(scheduleWeeks.scopeId, frame.scopeId),
							eq(scheduleWeeks.weekStartDate, weekStart),
						),
					)
					.limit(1)
			}
		}
		if (!week) return fail(409, 'stale_week')
		if (
			input.expectedVersion !== undefined &&
			input.expectedVersion !== week.version
		) {
			return fail(409, 'stale_week', { currentVersion: week.version })
		}
		const newVersion = week.version + 1

		const rows = (
			await loadScopeShifts(tx, frame.scopeId, weekStart, weekEnd)
		).filter((row) => {
			const date = effectiveShift(row).localDate
			return date >= weekStart && date <= weekEnd
		})

		// People who have left are never published onto a shift.
		const staffIds = rows.flatMap((row) => {
			const effective = effectiveShift(row)
			return effective.staffId ? [effective.staffId] : []
		})
		const people = staffIds.length ? await loadPeople(tx, staffIds) : new Map()
		const leaver = (staffId: string | null) =>
			staffId !== null &&
			(people.get(staffId)?.member.status === 'terminated' ||
				!people.has(staffId))

		const drafts: ShiftRow[] = []
		const edits: Array<{ row: ShiftRow; patch: ShiftDraftPatch }> = []
		let publishedAlready = 0
		for (const row of rows) {
			if (row.status === 'draft') drafts.push(row)
			else if (row.status === 'published') {
				if (row.draftPatch && Object.keys(row.draftPatch).length > 0) {
					edits.push({ row, patch: row.draftPatch })
				} else {
					publishedAlready += 1
				}
			}
		}
		const pendingCount = drafts.length + edits.length
		if (pendingCount === 0) {
			if (input.notifyMode !== 'everyone' || publishedAlready === 0) {
				return fail(409, 'nothing_to_publish')
			}
		}

		const changes: SchedulePublicationChange[] = []
		let created = 0
		let changed = 0
		let cancelled = 0

		// Drafts go live. Someone who has left is replaced by an open shift.
		const keep = drafts.filter((row) => !leaver(row.staffId))
		const orphaned = drafts.filter((row) => leaver(row.staffId))
		for (const part of chunk(keep, BULK_CHUNK)) {
			await tx
				.update(shifts)
				.set({
					status: 'published',
					publishedAt: ctx.now,
					publishedVersion: newVersion,
					version: sql`${shifts.version} + 1`,
					updatedBy: ctx.auth.userId,
					updatedAt: ctx.now,
				})
				.where(
					inJsonList(
						shifts.id,
						part.map((row) => row.id),
					),
				)
		}
		for (const row of orphaned) {
			await tx
				.update(shifts)
				.set({
					status: 'published',
					staffId: null,
					publishedAt: ctx.now,
					publishedVersion: newVersion,
					version: sql`${shifts.version} + 1`,
					updatedBy: ctx.auth.userId,
					updatedAt: ctx.now,
				})
				.where(eq(shifts.id, row.id))
		}
		for (const row of drafts) {
			created += 1
			changes.push({
				shiftId: row.id,
				kind: 'created',
				staffId: leaver(row.staffId) ? null : row.staffId,
			})
		}

		for (const { row, patch } of edits) {
			if (patch.cancel === true) {
				await tx
					.update(shifts)
					.set({
						status: 'cancelled',
						cancelledAt: ctx.now,
						draftPatch: null,
						publishedVersion: newVersion,
						version: sql`${shifts.version} + 1`,
						updatedBy: ctx.auth.userId,
						updatedAt: ctx.now,
					})
					.where(eq(shifts.id, row.id))
				cancelled += 1
				changes.push({
					shiftId: row.id,
					kind: 'cancelled',
					staffId: row.staffId,
				})
				continue
			}
			const nextStaff =
				patch.staffId !== undefined ? patch.staffId : row.staffId
			const staffId = leaver(nextStaff) ? null : nextStaff
			await tx
				.update(shifts)
				.set({
					staffId,
					positionId:
						patch.positionId !== undefined ? patch.positionId : row.positionId,
					startsAt: patch.startsAt ?? row.startsAt,
					endsAt: patch.endsAt ?? row.endsAt,
					localDate: patch.localDate ?? row.localDate,
					unpaidBreakMinutes:
						patch.unpaidBreakMinutes ?? row.unpaidBreakMinutes,
					notes: patch.notes !== undefined ? patch.notes : row.notes,
					draftPatch: null,
					publishedAt: ctx.now,
					publishedVersion: newVersion,
					version: sql`${shifts.version} + 1`,
					updatedBy: ctx.auth.userId,
					updatedAt: ctx.now,
				})
				.where(eq(shifts.id, row.id))
			changed += 1
			changes.push({
				shiftId: row.id,
				kind: 'changed',
				staffId,
				...(staffId !== row.staffId ? { previousStaffId: row.staffId } : {}),
			})
		}

		const bumped = await tx
			.update(scheduleWeeks)
			.set({
				version: newVersion,
				lastPublishedAt: ctx.now,
				lastPublishedBy: ctx.auth.userId,
				updatedAt: ctx.now,
			})
			.where(
				and(
					eq(scheduleWeeks.id, week.id),
					eq(scheduleWeeks.version, week.version),
				),
			)
			.returning({ id: scheduleWeeks.id })
		if (bumped.length === 0) return fail(409, 'stale_week')

		// What is live now, for the summary.
		const live = (
			await loadScopeShifts(tx, frame.scopeId, weekStart, weekEnd)
		).filter((row) => row.status === 'published')
		const summary: Record<string, number> = {
			created,
			changed,
			cancelled,
			shifts: live.length,
			openShifts: live.filter((row) => row.staffId === null).length,
			people: new Set(live.flatMap((row) => (row.staffId ? [row.staffId] : [])))
				.size,
		}
		// Who hears about it. The row is append-only, so the plan is made first and
		// written with it; the messages are queued with the same transaction.
		const publicationId = randomUUID()
		const kept = changes.slice(0, SCHEDULE_MAX_SHIFTS_PER_WEEK)
		const notification = await planPublicationNotices(tx, {
			publication: {
				id: publicationId,
				scopeId: frame.scopeId,
				weekStart,
				version: newVersion,
			},
			mode: input.notifyMode,
			changes: kept,
			liveStaffIds: await loadLiveStaffIds(tx, frame.scopeId, weekStart),
			now: ctx.now,
		})
		const [publication] = await tx
			.insert(schedulePublications)
			.values({
				id: publicationId,
				scopeId: frame.scopeId,
				weekStartDate: weekStart,
				version: newVersion,
				notifyMode: input.notifyMode,
				summary,
				changes: kept,
				notification,
				publishedBy: ctx.auth.userId,
				publishedAt: ctx.now,
			})
			.returning()
		if (input.notifyMode !== 'nobody') {
			await queueManagerNotice(tx, {
				publicationId,
				scopeId: frame.scopeId,
				publishedBy: ctx.auth.userId,
				now: ctx.now,
			})
		}
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.week.published',
			entityType: 'schedule_week',
			entityId: week.id,
			scopeId: frame.scopeId,
			changes: {
				weekStart,
				version: newVersion,
				notifyMode: input.notifyMode,
				notified: notification.queued,
				notReached: notification.notReached.length,
				...summary,
			},
		})
		return ok({
			publication: toPublicationView(publication!),
			week: { version: newVersion, unpublishedCount: 0 },
		})
	})
}

export async function listPublications(
	ctx: ScheduleContext,
	query: { scopeId: string; weekStart?: string },
): Promise<ScheduleResult<SchedulePublicationView[]>> {
	if (!isOpaqueId(query.scopeId) || !ctx.scope.allows(query.scopeId)) {
		return fail(404, 'not_found')
	}
	const rows = await ctx.db
		.select()
		.from(schedulePublications)
		.where(
			and(
				eq(schedulePublications.scopeId, query.scopeId),
				query.weekStart
					? eq(schedulePublications.weekStartDate, query.weekStart)
					: undefined,
			),
		)
		.orderBy(
			desc(schedulePublications.publishedAt),
			desc(schedulePublications.version),
		)
		.limit(100)
	return ok(rows.map(toPublicationView))
}

import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { type PublishHourCapBreach } from '@repo/staffing'
import {
	schedulePublications,
	scheduleWeeks,
	shifts,
	type SchedulePublicationChange,
	type ShiftRow,
} from '@repo/tenant-db'
import {
	effectiveShift,
	FrameCache,
	hourCapBreachesFor,
	isLive,
	MAX_BREACHES_LISTED,
	snapWeekStart,
	type ScheduleContext,
	type ScheduleResult,
} from './schedule-shared.ts'
import {
	loadLiveStaffIds,
	planPublicationNotices,
} from './schedule-notify-service.ts'
import { type StaffDb, writeStaffAudit } from './staff-audit.ts'
import { fail, ok } from './timesheet-shared.ts'

/**
 * Putting an approved swap, cover or drop on the live schedule (#528).
 *
 * An approval changes whose shift it is. The change goes through the same
 * draft mechanics as any edit (`applyShiftChange`), and this then publishes
 * exactly that change, in the caller's transaction: the shift's person
 * changes on the published row, the week's publish counter moves, one
 * publication row records it (ids only) and both people are queued the usual
 * "your schedule changed" email (the person who loses a shift hears about it
 * too). Nothing else pending in the week is published: another unpublished
 * edit to the same shift stays a draft.
 *
 * It re-checks the new person's conflicts and hour caps first. Conflicts are
 * warnings the manager already sees in the response; an hour cap is the same
 * soft gate as publishing a week, so the approval needs a reason when the
 * change takes someone over a cap.
 */

export type AppliedSwap = {
	/** The publications written, one per scope and week the change touches. */
	publicationIds: string[]
	/** Who each affected shift belonged to before, by shift id. */
	previousStaffIds: Record<string, string | null>
}

export async function publishRequestChanges(
	tx: StaffDb,
	ctx: ScheduleContext,
	input: {
		requestId: string
		kind: 'swap' | 'cover' | 'drop'
		shiftIds: readonly string[]
		capReason?: string
	},
): Promise<ScheduleResult<AppliedSwap>> {
	const rows: ShiftRow[] = []
	for (const id of input.shiftIds) {
		const [row] = await tx
			.select()
			.from(shifts)
			.where(eq(shifts.id, id))
			.limit(1)
		if (row) rows.push(row)
	}
	const frames = new FrameCache({ db: tx, auth: ctx.auth, now: ctx.now })

	// Hour caps and conflicts, on the shifts as they will be.
	const byScope = new Map<string, ShiftRow[]>()
	for (const row of rows) {
		byScope.set(row.scopeId, [...(byScope.get(row.scopeId) ?? []), row])
	}
	const breaches: PublishHourCapBreach[] = []
	for (const [scopeId, group] of byScope) {
		const frame = await frames.get(scopeId, group[0]!.timeZone)
		if (!frame) return fail(409, 'time_zone_unknown')
		breaches.push(
			...(await hourCapBreachesFor(
				{ ...ctx, db: tx },
				frame,
				group.map(effectiveShift).filter(isLive),
			)),
		)
	}
	if (breaches.length > 0 && input.capReason === undefined) {
		return fail(409, 'hour_caps_exceeded', {
			breaches: breaches.slice(0, MAX_BREACHES_LISTED),
			total: breaches.length,
		})
	}

	// One publication per scope and workweek.
	type Group = { scopeId: string; weekStart: string; rows: ShiftRow[] }
	const groups = new Map<string, Group>()
	for (const row of rows) {
		const frame = await frames.get(row.scopeId, row.timeZone)
		if (!frame) return fail(409, 'time_zone_unknown')
		const weekStart = snapWeekStart(effectiveShift(row).localDate, frame)
		const key = `${row.scopeId}:${weekStart}`
		const group = groups.get(key) ?? {
			scopeId: row.scopeId,
			weekStart,
			rows: [],
		}
		group.rows.push(row)
		groups.set(key, group)
	}

	const publicationIds: string[] = []
	const previousStaffIds: Record<string, string | null> = {}
	for (const group of groups.values()) {
		let [week] = await tx
			.select()
			.from(scheduleWeeks)
			.where(
				and(
					eq(scheduleWeeks.scopeId, group.scopeId),
					eq(scheduleWeeks.weekStartDate, group.weekStart),
				),
			)
			.limit(1)
		if (!week) {
			;[week] = await tx
				.insert(scheduleWeeks)
				.values({
					scopeId: group.scopeId,
					weekStartDate: group.weekStart,
					version: 0,
					createdAt: ctx.now,
					updatedAt: ctx.now,
				})
				.returning()
		}
		if (!week) return fail(409, 'stale_week')
		const newVersion = week.version + 1

		const changes: SchedulePublicationChange[] = []
		for (const row of group.rows) {
			const patch = row.draftPatch ?? {}
			if (patch.staffId === undefined) continue
			// Only the person changes hands; any other pending edit stays pending.
			const { staffId: ignoredStaff, ...rest } = patch
			void ignoredStaff
			const updated = await tx
				.update(shifts)
				.set({
					staffId: patch.staffId,
					draftPatch: Object.keys(rest).length > 0 ? rest : null,
					publishedAt: ctx.now,
					publishedVersion: newVersion,
					version: sql`${shifts.version} + 1`,
					updatedBy: ctx.auth.userId,
					updatedAt: ctx.now,
				})
				.where(and(eq(shifts.id, row.id), eq(shifts.version, row.version)))
				.returning({ id: shifts.id })
			if (updated.length === 0) {
				// Someone changed the shift while this was being approved.
				return fail(409, 'stale_shift')
			}
			previousStaffIds[row.id] = row.staffId
			changes.push({
				shiftId: row.id,
				kind: 'changed',
				staffId: patch.staffId,
				previousStaffId: row.staffId,
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

		const publicationId = randomUUID()
		const notification = await planPublicationNotices(tx, {
			publication: {
				id: publicationId,
				scopeId: group.scopeId,
				weekStart: group.weekStart,
				version: newVersion,
			},
			mode: 'changed',
			changes,
			liveStaffIds: await loadLiveStaffIds(tx, group.scopeId, group.weekStart),
			now: ctx.now,
		})
		await tx.insert(schedulePublications).values({
			id: publicationId,
			scopeId: group.scopeId,
			weekStartDate: group.weekStart,
			version: newVersion,
			notifyMode: 'changed',
			summary: { created: 0, changed: changes.length, cancelled: 0, swaps: 1 },
			changes,
			notification,
			publishedBy: ctx.auth.userId,
			publishedAt: ctx.now,
		})
		publicationIds.push(publicationId)
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: `schedule.${input.kind}.approved`,
			entityType: 'shift_request',
			entityId: input.requestId,
			scopeId: group.scopeId,
			changes: {
				publicationId,
				weekStart: group.weekStart,
				version: newVersion,
				shifts: changes.length,
				notified: notification.queued,
				...(breaches.length > 0
					? { capBreaches: breaches.length, capReason: input.capReason }
					: {}),
			},
		})
	}
	return ok({ publicationIds, previousStaffIds })
}

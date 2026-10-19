import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import {
	addDays,
	type AvailabilityCreate,
	type AvailabilityView,
	daysBetween,
	localDateOf,
	minuteOfDayFromAvailabilityTime,
	type RequestWarning,
	type ScheduleDecision,
	type TimeOffCreate,
	type TimeOffListQuery,
	type TimeOffView,
} from '@repo/staffing'
import {
	staffAvailability,
	staffScopeAssignments,
	timeOffRequests,
	type StaffAvailabilityRow,
	type TenantDatabase,
	type TimeOffRequestRow,
} from '@repo/tenant-db'
import {
	chunk,
	FrameCache,
	isOpaqueId,
	loadPeople,
	loadScheduleSettings,
	MAX_LIST_ROWS,
	personVisible,
	type PersonRecord,
	type ScheduleContext,
	type ScheduleResult,
	visibleStaffWhere,
} from './schedule-shared.ts'
import { transact } from './schedule-shift-service.ts'
import { type StaffDb, writeStaffAudit } from './staff-audit.ts'
import { fail, ok } from './timesheet-shared.ts'
import {
	queryInChunks,
	forEachInChunks,
	insertRowsInChunks,
	inJsonList,
} from '../lib/chunked-in.ts'

/**
 * Time off and availability. A manager entering a request for someone is final
 * (approved at once); a request recorded as the person's own waits for a
 * decision. Only approved rows affect the schedule's warnings and the
 * recommendation. Short notice and a full day are warnings to the approver,
 * never a refusal.
 */

export type TimeOffWriteContext = Omit<ScheduleContext, 'db'> & {
	db: TenantDatabase
}

const MAX_WARNING_SCAN_DAYS = 62

async function visiblePerson(
	db: StaffDb,
	scope: ScheduleContext['scope'],
	staffId: unknown,
	options: { allowTerminated: boolean },
): Promise<ScheduleResult<PersonRecord>> {
	if (!isOpaqueId(staffId)) return fail(422, 'staff_not_found')
	const person = (await loadPeople(db, [staffId])).get(staffId)
	if (!person || !personVisible(scope, person)) {
		return fail(422, 'staff_not_found')
	}
	if (!options.allowTerminated && person.member.status === 'terminated') {
		return fail(422, 'staff_terminated')
	}
	return ok(person)
}

/** A row's person, when the token can see them; otherwise the row does not exist. */
async function rowPerson(
	db: StaffDb,
	scope: ScheduleContext['scope'],
	staffId: string,
): Promise<PersonRecord | null> {
	const person = (await loadPeople(db, [staffId])).get(staffId)
	return person && personVisible(scope, person) ? person : null
}

// ---------------------------------------------------------------------------
// Time off
// ---------------------------------------------------------------------------

async function timeOffWarnings(
	ctx: Pick<ScheduleContext, 'db' | 'auth' | 'now'>,
	frames: FrameCache,
	row: TimeOffRequestRow,
	person: PersonRecord,
): Promise<RequestWarning[]> {
	if (row.status !== 'pending') return []
	const warnings: RequestWarning[] = []
	const home =
		person.assignments.find((a) => a.isPrimary) ?? person.assignments[0]
	if (!home) return warnings
	const frame = await frames.get(home.scopeId)
	if (!frame) return warnings

	const settings = await loadScheduleSettings(ctx.db)
	if (settings.timeOffMinNoticeDays > 0) {
		const notice = daysBetween(
			localDateOf(row.createdAt, frame.timeZone),
			row.startDate,
		)
		if (notice < settings.timeOffMinNoticeDays) {
			warnings.push({ code: 'short_notice', detail: Math.max(0, notice) })
		}
	}

	const limit = frame.policy.timeOffMaxPerDay
	if (limit !== null) {
		const span = Math.min(
			daysBetween(row.startDate, row.endDate) + 1,
			MAX_WARNING_SCAN_DAYS,
		)
		const others = await ctx.db
			.select({
				staffId: timeOffRequests.staffId,
				startDate: timeOffRequests.startDate,
				endDate: timeOffRequests.endDate,
			})
			.from(timeOffRequests)
			.innerJoin(
				staffScopeAssignments,
				and(
					eq(staffScopeAssignments.staffId, timeOffRequests.staffId),
					eq(staffScopeAssignments.scopeId, home.scopeId),
					eq(staffScopeAssignments.active, true),
				),
			)
			.where(
				and(
					eq(timeOffRequests.status, 'approved'),
					sql`${timeOffRequests.staffId} != ${row.staffId}`,
					sql`${timeOffRequests.startDate} <= ${row.endDate}`,
					sql`${timeOffRequests.endDate} >= ${row.startDate}`,
				),
			)
		let worst = 0
		for (let i = 0; i < span; i++) {
			const date = addDays(row.startDate, i)
			const count = new Set(
				others
					.filter((o) => o.startDate <= date && o.endDate >= date)
					.map((o) => o.staffId),
			).size
			worst = Math.max(worst, count)
		}
		if (worst >= limit)
			warnings.push({ code: 'over_daily_limit', detail: worst })
	}
	return warnings
}

function toTimeOffView(
	row: TimeOffRequestRow,
	warnings: RequestWarning[],
): TimeOffView {
	return {
		id: row.id,
		staffId: row.staffId,
		category: row.category,
		startDate: row.startDate,
		endDate: row.endDate,
		allDay: row.allDay,
		startMinute: row.startMinute,
		endMinute: row.endMinute,
		note: row.note,
		status: row.status,
		source: row.source,
		decidedBy: row.decidedBy,
		decidedAt: row.decidedAt,
		decisionNote: row.decisionNote,
		createdAt: row.createdAt,
		warnings,
	}
}

export async function listTimeOff(
	ctx: ScheduleContext,
	query: TimeOffListQuery,
): Promise<ScheduleResult<TimeOffView[]>> {
	if (query.scopeId !== undefined) {
		if (!isOpaqueId(query.scopeId) || !ctx.scope.allows(query.scopeId)) {
			return fail(404, 'not_found')
		}
	}
	const rows = await ctx.db
		.select()
		.from(timeOffRequests)
		.where(
			and(
				query.staffId ? eq(timeOffRequests.staffId, query.staffId) : undefined,
				query.status ? eq(timeOffRequests.status, query.status) : undefined,
				query.from ? gte(timeOffRequests.endDate, query.from) : undefined,
				query.to ? lte(timeOffRequests.startDate, query.to) : undefined,
				visibleStaffWhere(
					ctx.db,
					ctx.scope,
					timeOffRequests.staffId,
					query.scopeId,
				),
			),
		)
		.orderBy(desc(timeOffRequests.startDate), desc(timeOffRequests.id))
		.limit(Math.min(query.limit, MAX_LIST_ROWS))
	const frames = new FrameCache(ctx)
	const pendingStaff = [
		...new Set(
			rows.filter((r) => r.status === 'pending').map((r) => r.staffId),
		),
	]
	const people = pendingStaff.length
		? await loadPeople(ctx.db, pendingStaff)
		: new Map<string, PersonRecord>()
	const out: TimeOffView[] = []
	for (const row of rows) {
		const person = people.get(row.staffId)
		out.push(
			toTimeOffView(
				row,
				person ? await timeOffWarnings(ctx, frames, row, person) : [],
			),
		)
	}
	return ok(out)
}

export async function createTimeOff(
	ctx: TimeOffWriteContext,
	input: TimeOffCreate,
): Promise<ScheduleResult<TimeOffView>> {
	const person = await visiblePerson(ctx.db, ctx.scope, input.staffId, {
		allowTerminated: false,
	})
	if (!person.ok) return person
	const approved = input.submission === 'manager_entered'
	const created = await transact(ctx.db, async (tx) => {
		const [row] = await tx
			.insert(timeOffRequests)
			.values({
				staffId: input.staffId,
				category: input.category,
				startDate: input.startDate,
				endDate: input.endDate,
				allDay: input.allDay,
				startMinute:
					!input.allDay && input.startTime
						? minuteOfDayFromAvailabilityTime(input.startTime)
						: null,
				endMinute:
					!input.allDay && input.endTime
						? minuteOfDayFromAvailabilityTime(input.endTime)
						: null,
				note: input.note ?? null,
				status: approved ? 'approved' : 'pending',
				source: approved ? 'manager' : 'staff',
				requestedBy: ctx.auth.userId,
				decidedBy: approved ? ctx.auth.userId : null,
				decidedAt: approved ? ctx.now : null,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			.returning()
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.time_off.created',
			entityType: 'time_off_request',
			entityId: row!.id,
			staffId: input.staffId,
			changes: {
				category: input.category,
				startDate: input.startDate,
				endDate: input.endDate,
				status: row!.status,
			},
		})
		return ok(row!)
	})
	if (!created.ok) return created
	return ok(
		toTimeOffView(
			created.value,
			await timeOffWarnings(
				ctx,
				new FrameCache(ctx),
				created.value,
				person.value,
			),
		),
	)
}

async function loadVisibleTimeOff(
	tx: StaffDb,
	scope: ScheduleContext['scope'],
	id: string,
): Promise<ScheduleResult<{ row: TimeOffRequestRow; person: PersonRecord }>> {
	if (!isOpaqueId(id)) return fail(404, 'not_found')
	const [row] = await tx
		.select()
		.from(timeOffRequests)
		.where(eq(timeOffRequests.id, id))
		.limit(1)
	if (!row) return fail(404, 'not_found')
	const person = await rowPerson(tx, scope, row.staffId)
	if (!person) return fail(404, 'not_found')
	return ok({ row, person })
}

export async function decideTimeOff(
	ctx: TimeOffWriteContext,
	id: string,
	input: ScheduleDecision,
): Promise<ScheduleResult<TimeOffView>> {
	const outcome = await transact(ctx.db, async (tx) => {
		const loaded = await loadVisibleTimeOff(tx, ctx.scope, id)
		if (!loaded.ok) return loaded
		const { row, person } = loaded.value
		if (row.status !== 'pending') return fail(409, 'already_decided')
		const status = input.decision === 'approve' ? 'approved' : 'rejected'
		const [updated] = await tx
			.update(timeOffRequests)
			.set({
				status,
				decidedBy: ctx.auth.userId,
				decidedAt: ctx.now,
				decisionNote: input.note ?? null,
				updatedAt: ctx.now,
			})
			.where(
				and(eq(timeOffRequests.id, id), eq(timeOffRequests.status, 'pending')),
			)
			.returning()
		if (!updated) return fail(409, 'already_decided')
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: `schedule.time_off.${status}`,
			entityType: 'time_off_request',
			entityId: id,
			staffId: row.staffId,
			changes: { startDate: row.startDate, endDate: row.endDate },
		})
		return ok({ row: updated, person })
	})
	if (!outcome.ok) return outcome
	return ok(toTimeOffView(outcome.value.row, []))
}

export async function cancelTimeOff(
	ctx: TimeOffWriteContext,
	id: string,
): Promise<ScheduleResult<TimeOffView>> {
	const outcome = await transact(ctx.db, async (tx) => {
		const loaded = await loadVisibleTimeOff(tx, ctx.scope, id)
		if (!loaded.ok) return loaded
		const { row } = loaded.value
		if (row.status !== 'pending' && row.status !== 'approved') {
			return fail(409, 'already_decided')
		}
		const [updated] = await tx
			.update(timeOffRequests)
			.set({ status: 'cancelled', updatedAt: ctx.now })
			.where(eq(timeOffRequests.id, id))
			.returning()
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.time_off.cancelled',
			entityType: 'time_off_request',
			entityId: id,
			staffId: row.staffId,
			changes: { was: row.status },
		})
		return ok(updated!)
	})
	if (!outcome.ok) return outcome
	return ok(toTimeOffView(outcome.value, []))
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

function toAvailabilityView(row: StaffAvailabilityRow): AvailabilityView {
	return {
		id: row.id,
		staffId: row.staffId,
		kind: row.kind,
		weekday: row.weekday,
		date: row.date,
		availability: row.availability,
		allDay: row.allDay,
		startMinute: row.startMinute,
		endMinute: row.endMinute,
		effectiveFrom: row.effectiveFrom,
		effectiveTo: row.effectiveTo,
		note: row.note,
		status: row.status,
		source: row.source,
		decidedBy: row.decidedBy,
		decidedAt: row.decidedAt,
		decisionNote: row.decisionNote,
		createdAt: row.createdAt,
	}
}

export async function listAvailability(
	ctx: ScheduleContext,
	query: {
		staffId?: string
		status?: AvailabilityView['status']
		scopeId?: string
		limit: number
	},
): Promise<ScheduleResult<AvailabilityView[]>> {
	if (query.scopeId !== undefined) {
		if (!isOpaqueId(query.scopeId) || !ctx.scope.allows(query.scopeId)) {
			return fail(404, 'not_found')
		}
	}
	const rows = await ctx.db
		.select()
		.from(staffAvailability)
		.where(
			and(
				query.staffId
					? eq(staffAvailability.staffId, query.staffId)
					: undefined,
				query.status ? eq(staffAvailability.status, query.status) : undefined,
				visibleStaffWhere(
					ctx.db,
					ctx.scope,
					staffAvailability.staffId,
					query.scopeId,
				),
			),
		)
		.orderBy(desc(staffAvailability.createdAt), desc(staffAvailability.id))
		.limit(Math.min(query.limit, MAX_LIST_ROWS))
	return ok(rows.map(toAvailabilityView))
}

/** Earlier approved weekly rows of a person become superseded. */
async function supersedeWeekly(
	tx: StaffDb,
	staffId: string,
	exceptIds: readonly string[],
	createdBefore: number,
	now: number,
) {
	const stale = await tx
		.select({ id: staffAvailability.id })
		.from(staffAvailability)
		.where(
			and(
				eq(staffAvailability.staffId, staffId),
				eq(staffAvailability.kind, 'weekly'),
				eq(staffAvailability.status, 'approved'),
				sql`${staffAvailability.createdAt} < ${createdBefore}`,
			),
		)
	const ids = stale.map((s) => s.id).filter((id) => !exceptIds.includes(id))
	for (const part of chunk(ids, 90)) {
		await forEachInChunks(
			part,
			(chunk) =>
				tx
					.update(staffAvailability)
					.set({ status: 'superseded', updatedAt: now })
					.where(inArray(staffAvailability.id, chunk)),
			40,
		)
	}
	return ids.length
}

/**
 * Records availability rows. A manager-entered batch is approved at once; with
 * `replaceWeekly` its weekly rows replace the person's earlier approved weekly
 * pattern. A batch recorded as the person's own request waits for a decision,
 * and approving its weekly rows replaces the earlier pattern.
 */
export async function createAvailability(
	ctx: TimeOffWriteContext,
	input: AvailabilityCreate,
): Promise<ScheduleResult<AvailabilityView[]>> {
	const person = await visiblePerson(ctx.db, ctx.scope, input.staffId, {
		allowTerminated: false,
	})
	if (!person.ok) return person
	const approved = input.submission === 'manager_entered'
	return transact(ctx.db, async (tx) => {
		const rows = await insertRowsInChunks(
			staffAvailability,
			input.rows.map((row) => ({
				staffId: input.staffId,
				kind: row.kind,
				weekday: row.kind === 'weekly' ? (row.weekday ?? null) : null,
				date: row.kind === 'one_off' ? (row.date ?? null) : null,
				availability: row.availability,
				allDay: row.allDay,
				startMinute:
					!row.allDay && row.startTime
						? minuteOfDayFromAvailabilityTime(row.startTime)
						: null,
				endMinute:
					!row.allDay && row.endTime
						? minuteOfDayFromAvailabilityTime(row.endTime)
						: null,
				effectiveFrom:
					row.kind === 'weekly' ? (row.effectiveFrom ?? null) : null,
				effectiveTo: row.kind === 'weekly' ? (row.effectiveTo ?? null) : null,
				note: row.note ?? null,
				status: approved ? ('approved' as const) : ('pending' as const),
				source: approved ? ('manager' as const) : ('staff' as const),
				requestedBy: ctx.auth.userId,
				decidedBy: approved ? ctx.auth.userId : null,
				decidedAt: approved ? ctx.now : null,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})),
			(chunk) => tx.insert(staffAvailability).values(chunk).returning(),
		)
		let superseded = 0
		if (
			approved &&
			input.replaceWeekly &&
			rows.some((r) => r.kind === 'weekly')
		) {
			superseded = await supersedeWeekly(
				tx,
				input.staffId,
				rows.map((r) => r.id),
				// Everything approved before this batch, whatever its timestamp.
				Number.MAX_SAFE_INTEGER,
				ctx.now,
			)
		}
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.availability.created',
			entityType: 'staff_availability',
			entityId: rows[0]!.id,
			staffId: input.staffId,
			changes: {
				count: rows.length,
				status: approved ? 'approved' : 'pending',
				superseded,
			},
		})
		return ok(rows.map(toAvailabilityView))
	})
}

export async function decideAvailability(
	ctx: TimeOffWriteContext,
	input: { ids: string[]; decision: 'approve' | 'reject'; note?: string },
): Promise<ScheduleResult<AvailabilityView[]>> {
	const ids = [...new Set(input.ids)]
	if (!ids.every(isOpaqueId)) return fail(404, 'not_found')
	return transact(ctx.db, async (tx) => {
		const rows = await queryInChunks(ids, (chunk) =>
			tx
				.select()
				.from(staffAvailability)
				.where(inArray(staffAvailability.id, chunk)),
		)
		if (rows.length !== ids.length) return fail(404, 'not_found')
		const people = await loadPeople(
			tx,
			rows.map((r) => r.staffId),
		)
		for (const row of rows) {
			const person = people.get(row.staffId)
			if (!person || !personVisible(ctx.scope, person)) {
				return fail(404, 'not_found')
			}
		}
		if (rows.some((row) => row.status !== 'pending')) {
			return fail(409, 'already_decided')
		}
		const status = input.decision === 'approve' ? 'approved' : 'rejected'
		const updated = await tx
			.update(staffAvailability)
			.set({
				status,
				decidedBy: ctx.auth.userId,
				decidedAt: ctx.now,
				decisionNote: input.note ?? null,
				updatedAt: ctx.now,
			})
			.where(
				and(
					inJsonList(staffAvailability.id, ids),
					eq(staffAvailability.status, 'pending'),
				),
			)
			.returning()
		if (updated.length !== ids.length) return fail(409, 'already_decided')
		let superseded = 0
		if (status === 'approved') {
			const byStaff = new Map<string, StaffAvailabilityRow[]>()
			for (const row of updated) {
				if (row.kind !== 'weekly') continue
				const list = byStaff.get(row.staffId) ?? []
				list.push(row)
				byStaff.set(row.staffId, list)
			}
			for (const [staffId, weekly] of byStaff) {
				// Rows from the same submission share a creation time and are kept.
				superseded += await supersedeWeekly(
					tx,
					staffId,
					weekly.map((r) => r.id),
					Math.min(...weekly.map((r) => r.createdAt)),
					ctx.now,
				)
			}
		}
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: `schedule.availability.${status}`,
			entityType: 'staff_availability',
			entityId: ids[0],
			staffId: rows.every((r) => r.staffId === rows[0]!.staffId)
				? rows[0]!.staffId
				: null,
			changes: { count: ids.length, superseded },
		})
		return ok(updated.map(toAvailabilityView))
	})
}

export async function cancelAvailability(
	ctx: TimeOffWriteContext,
	id: string,
): Promise<ScheduleResult<AvailabilityView>> {
	if (!isOpaqueId(id)) return fail(404, 'not_found')
	return transact(ctx.db, async (tx) => {
		const [row] = await tx
			.select()
			.from(staffAvailability)
			.where(eq(staffAvailability.id, id))
			.limit(1)
		if (!row || !(await rowPerson(tx, ctx.scope, row.staffId))) {
			return fail(404, 'not_found')
		}
		if (row.status !== 'pending' && row.status !== 'approved') {
			return fail(409, 'already_decided')
		}
		const [updated] = await tx
			.update(staffAvailability)
			.set({ status: 'cancelled', updatedAt: ctx.now })
			.where(eq(staffAvailability.id, id))
			.returning()
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.availability.cancelled',
			entityType: 'staff_availability',
			entityId: id,
			staffId: row.staffId,
			changes: { was: row.status },
		})
		return ok(toAvailabilityView(updated!))
	})
}

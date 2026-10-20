import { and, eq, isNull, sql } from 'drizzle-orm'
import {
	addDays,
	minuteOfDayFromHhmm,
	placeWallClock,
	resolveShiftWindow,
	SCHEDULE_MAX_SHIFTS_PER_WEEK,
	type ScheduleShiftView,
	type ShiftCreate,
	type ShiftDeleteResult,
	type ShiftUpdate,
	type ShiftWriteResult,
	wallClockOf,
	weekStartFor,
} from '@repo/staffing'
import {
	shifts,
	staffPositions,
	type NewShiftRow,
	type ShiftRow,
	type TenantDatabase,
	runTenantTransaction,
} from '@repo/tenant-db'
import { retryOnSqliteBusy } from '../lib/sqlite-retry.ts'
import { type ScopeAccess } from '../lib/staff-auth.ts'
import {
	buildShiftViews,
	chunk,
	effectiveShift,
	diffToPatch,
	FrameCache,
	isOpaqueId,
	loadPeople,
	loadShiftsByIds,
	personVisible,
	requireFrame,
	type PersonRecord,
	type ScheduleContext,
	type ScheduleResult,
} from './schedule-shared.ts'
import { type StaffDb, writeStaffAudit } from './staff-audit.ts'
import { fail, moneyAccess, ok } from './timesheet-shared.ts'

/**
 * Shift writes. A new shift is a draft. Editing a published shift never touches
 * the published fields: the proposed change is kept in `draft_patch` until the
 * week is published, so staff keep seeing what was published. Every write is
 * one transaction with its audit row, guarded by the shift's version so two
 * managers editing the same shift cannot silently overwrite each other.
 *
 * Conflicts (overlap, time off, availability, overtime, rest, position) are
 * warnings returned with the shift. Nothing here refuses a write because of one.
 */

export type ScheduleWriteContext = Omit<ScheduleContext, 'db'> & {
	db: TenantDatabase
}

const MS_PER_MINUTE = 60_000
const INSERT_CHUNK = 100

function rootMessage(error: unknown): string {
	let root: unknown = error
	while (root instanceof Error && (root as { cause?: unknown }).cause) {
		root = (root as { cause?: unknown }).cause
	}
	return root instanceof Error ? root.message : ''
}

/** Turns a constraint a trigger or index raised into the code a caller should see. */
function mapWriteError(error: unknown) {
	const message = rootMessage(error)
	if (/a cancelled shift cannot change/i.test(message)) {
		return fail(409, 'shift_cancelled')
	}
	if (/shift must end after it starts/i.test(message)) {
		return fail(422, 'invalid_shift_time')
	}
	if (/FOREIGN KEY constraint failed/i.test(message)) {
		return fail(409, 'request_stale')
	}
	if (
		/UNIQUE constraint failed: (shift_templates\.|index 'uniq_shift_templates)/i.test(
			message,
		)
	) {
		return fail(409, 'template_name_taken')
	}
	if (/UNIQUE constraint failed: shift_requests\.shift_id/i.test(message)) {
		return fail(409, 'request_pending')
	}
	return null
}

/** Thrown inside a transaction so a refused result rolls its writes back. */
class RefusedResult {
	constructor(
		readonly failure: Extract<ScheduleResult<never>, { ok: false }>,
	) {}
}

/**
 * One transaction, retried when SQLite is busy, with known constraint errors as
 * results. A refused result (`ok: false`) rolls the whole transaction back: a
 * handler can insert a row, find the change cannot be applied and return the
 * failure, and the caller must never be left with the half-done write (a
 * pending request that blocks the next one, a partly applied swap, a publish
 * whose counter did not move).
 */
export async function transact<T>(
	db: TenantDatabase,
	run: (tx: StaffDb) => Promise<ScheduleResult<T>>,
): Promise<ScheduleResult<T>> {
	try {
		return await retryOnSqliteBusy(() =>
			runTenantTransaction(db, async (tx) => {
				const result = await run(tx)
				if (!result.ok) throw new RefusedResult(result)
				return result
			}),
		)
	} catch (error) {
		if (error instanceof RefusedResult) return error.failure
		const mapped = mapWriteError(error)
		if (mapped) return mapped
		throw error
	}
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** A person who can be put on a shift by a token with this scope. */
export async function requireSchedulablePerson(
	db: StaffDb,
	scope: ScopeAccess,
	staffId: unknown,
): Promise<ScheduleResult<PersonRecord>> {
	if (!isOpaqueId(staffId)) return fail(422, 'staff_not_found')
	const person = (await loadPeople(db, [staffId])).get(staffId)
	// Outside the token's scopes reads as missing, so it is not confirmed.
	if (!person || !personVisible(scope, person)) {
		return fail(422, 'staff_not_found')
	}
	if (person.member.status === 'terminated') {
		return fail(422, 'staff_terminated')
	}
	return ok(person)
}

export async function requirePosition(
	db: StaffDb,
	positionId: unknown,
): Promise<ScheduleResult<true>> {
	if (!isOpaqueId(positionId)) return fail(422, 'position_not_found')
	const [row] = await db
		.select({ id: staffPositions.id })
		.from(staffPositions)
		.where(
			and(eq(staffPositions.id, positionId), isNull(staffPositions.archivedAt)),
		)
		.limit(1)
	return row ? ok(true) : fail(422, 'position_not_found')
}

function durationMinutes(startsAt: number, endsAt: number): number {
	return Math.round((endsAt - startsAt) / MS_PER_MINUTE)
}

/** Count of a scope's live shifts in a date range (for the per-week cap). */
async function countWeekShifts(
	db: StaffDb,
	scopeId: string,
	fromDate: string,
	toDate: string,
): Promise<number> {
	const [row] = await db
		.select({ count: sql<number>`count(*)` })
		.from(shifts)
		.where(
			and(
				eq(shifts.scopeId, scopeId),
				sql`${shifts.status} != 'cancelled'`,
				sql`${shifts.localDate} >= ${fromDate}`,
				sql`${shifts.localDate} <= ${toDate}`,
			),
		)
	return Number(row?.count ?? 0)
}

/** Fails with `week_full` when adding `added` shifts to each week would pass the cap. */
export async function checkWeekCapacity(
	db: StaffDb,
	scopeId: string,
	weekStartsOn: number,
	addedByDate: ReadonlyMap<string, number>,
): Promise<ScheduleResult<true>> {
	const addedByWeek = new Map<string, number>()
	for (const [date, count] of addedByDate) {
		const week = weekStartFor(date, weekStartsOn)
		addedByWeek.set(week, (addedByWeek.get(week) ?? 0) + count)
	}
	for (const [week, added] of addedByWeek) {
		const existing = await countWeekShifts(db, scopeId, week, addDays(week, 6))
		if (existing + added > SCHEDULE_MAX_SHIFTS_PER_WEEK) {
			return fail(422, 'week_full', { weekStart: week })
		}
	}
	return ok(true)
}

/** Inserts drafts in chunks, inside the caller's transaction. */
export async function insertDrafts(
	tx: StaffDb,
	ctx: Pick<ScheduleContext, 'auth' | 'now'>,
	rows: readonly Omit<
		NewShiftRow,
		'status' | 'createdBy' | 'updatedBy' | 'createdAt' | 'updatedAt' | 'version'
	>[],
): Promise<ShiftRow[]> {
	const inserted: ShiftRow[] = []
	for (const part of chunk(rows, INSERT_CHUNK)) {
		inserted.push(
			...(await tx
				.insert(shifts)
				.values(
					part.map((row) => ({
						...row,
						status: 'draft' as const,
						version: 1,
						createdBy: ctx.auth.userId,
						updatedBy: ctx.auth.userId,
						createdAt: ctx.now,
						updatedAt: ctx.now,
					})),
				)
				.returning()),
		)
	}
	return inserted
}

// ---------------------------------------------------------------------------
// The one change path
// ---------------------------------------------------------------------------

export type ShiftChange = Partial<{
	staffId: string | null
	positionId: string | null
	startsAt: number
	endsAt: number
	localDate: string
	unpaidBreakMinutes: number
	notes: string | null
}>

/**
 * Applies a change to one shift: directly to a draft, as a pending patch to a
 * published shift. Returns the shift as stored afterwards. Shared by edits,
 * assignments, and approved swap, cover and drop requests.
 */
export async function applyShiftChange(
	tx: StaffDb,
	ctx: Pick<ScheduleContext, 'auth' | 'now'>,
	row: ShiftRow,
	change: ShiftChange,
	expectedVersion?: number,
): Promise<ScheduleResult<ShiftRow>> {
	if (row.status === 'cancelled') return fail(409, 'shift_cancelled')
	if (expectedVersion !== undefined && expectedVersion !== row.version) {
		return fail(409, 'stale_shift', { currentVersion: row.version })
	}
	const current = effectiveShift(row)
	if (current.cancelPending) return fail(409, 'cancel_pending')

	const next = {
		staffId: change.staffId !== undefined ? change.staffId : current.staffId,
		positionId:
			change.positionId !== undefined ? change.positionId : current.positionId,
		startsAt: change.startsAt ?? current.startsAt,
		endsAt: change.endsAt ?? current.endsAt,
		localDate: change.localDate ?? current.localDate,
		unpaidBreakMinutes: change.unpaidBreakMinutes ?? current.unpaidBreakMinutes,
		notes: change.notes !== undefined ? change.notes : current.notes,
	}
	if (next.unpaidBreakMinutes > durationMinutes(next.startsAt, next.endsAt)) {
		return fail(422, 'break_exceeds_shift')
	}

	let set: Partial<NewShiftRow>
	if (row.status === 'draft') {
		set = { ...next }
	} else {
		set = { draftPatch: diffToPatch(row, next) }
	}
	const updated = await tx
		.update(shifts)
		.set({
			...set,
			version: row.version + 1,
			updatedBy: ctx.auth.userId,
			updatedAt: ctx.now,
		})
		.where(and(eq(shifts.id, row.id), eq(shifts.version, row.version)))
		.returning()
	if (updated.length === 0) {
		return fail(409, 'stale_shift', { currentVersion: row.version })
	}
	return ok(updated[0]!)
}

async function loadScopedShift(
	tx: StaffDb,
	ctx: Pick<ScheduleContext, 'scope'>,
	id: string,
): Promise<ScheduleResult<ShiftRow>> {
	if (!isOpaqueId(id)) return fail(404, 'not_found')
	const [row] = await tx.select().from(shifts).where(eq(shifts.id, id)).limit(1)
	if (!row || !ctx.scope.allows(row.scopeId)) return fail(404, 'not_found')
	return ok(row)
}

async function viewsFor(
	ctx: ScheduleWriteContext,
	frames: FrameCache,
	ids: readonly string[],
): Promise<ScheduleShiftView[]> {
	const rows = await loadShiftsByIds(ctx.db, ids)
	const byId = new Map(rows.map((row) => [row.id, row]))
	const ordered = ids.flatMap((id) => {
		const row = byId.get(id)
		return row ? [row] : []
	})
	return buildShiftViews(ctx, frames, ordered, moneyAccess(ctx.auth))
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createShifts(
	ctx: ScheduleWriteContext,
	input: ShiftCreate,
): Promise<ScheduleResult<ShiftWriteResult>> {
	const frames = new FrameCache(ctx)
	const framed = await requireFrame(
		ctx,
		frames,
		input.scopeId,
		'scope_out_of_scope',
	)
	if (!framed.ok) return framed
	const frame = framed.value

	if (input.staffId) {
		const person = await requireSchedulablePerson(
			ctx.db,
			ctx.scope,
			input.staffId,
		)
		if (!person.ok) return person
	}
	if (input.positionId) {
		const position = await requirePosition(ctx.db, input.positionId)
		if (!position.ok) return position
	}

	const startMinute = minuteOfDayFromHhmm(input.startTime)
	const endMinute = minuteOfDayFromHhmm(input.endTime)
	const dates = [...input.dates].sort()
	const resolved: Array<{ date: string; startsAt: number; endsAt: number }> = []
	for (const date of dates) {
		const window = resolveShiftWindow({
			date,
			startMinute,
			endMinute,
			timeZone: frame.timeZone,
		})
		if (!window.ok) {
			return fail(422, 'invalid_shift_time', {
				reason: window.reason,
				date,
			})
		}
		if (input.unpaidBreakMinutes > window.window.durationMinutes) {
			return fail(422, 'break_exceeds_shift', { date })
		}
		resolved.push({
			date,
			startsAt: window.window.startsAt,
			endsAt: window.window.endsAt,
		})
	}

	const outcome = await transact(ctx.db, async (tx) => {
		const capacity = await checkWeekCapacity(
			tx,
			frame.scopeId,
			frame.weekStartsOn,
			new Map(resolved.map((r) => [r.date, 1])),
		)
		if (!capacity.ok) return capacity
		const rows = await insertDrafts(
			tx,
			ctx,
			resolved.map((r) => ({
				scopeId: frame.scopeId,
				staffId: input.staffId ?? null,
				positionId: input.positionId ?? null,
				startsAt: r.startsAt,
				endsAt: r.endsAt,
				localDate: r.date,
				timeZone: frame.timeZone,
				unpaidBreakMinutes: input.unpaidBreakMinutes,
				notes: input.notes ?? null,
			})),
		)
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.shift.created',
			entityType: 'shift',
			entityId: rows[0]!.id,
			staffId: input.staffId ?? null,
			scopeId: frame.scopeId,
			changes: {
				count: rows.length,
				firstDate: dates[0],
				lastDate: dates[dates.length - 1],
				open: !input.staffId,
			},
		})
		return ok(rows.map((row) => row.id))
	})
	if (!outcome.ok) return outcome
	return ok({ shifts: await viewsFor(ctx, frames, outcome.value) })
}

// ---------------------------------------------------------------------------
// Update, assign, unassign
// ---------------------------------------------------------------------------

export async function updateShift(
	ctx: ScheduleWriteContext,
	id: string,
	input: ShiftUpdate,
): Promise<ScheduleResult<ScheduleShiftView>> {
	const frames = new FrameCache(ctx)
	if (input.positionId) {
		const position = await requirePosition(ctx.db, input.positionId)
		if (!position.ok) return position
	}
	if (input.staffId) {
		const person = await requireSchedulablePerson(
			ctx.db,
			ctx.scope,
			input.staffId,
		)
		if (!person.ok) return person
	}

	const outcome = await transact(ctx.db, async (tx) => {
		const loaded = await loadScopedShift(tx, ctx, id)
		if (!loaded.ok) return loaded
		const row = loaded.value
		const current = effectiveShift(row)

		const change: ShiftChange = {}
		if (input.staffId !== undefined) change.staffId = input.staffId
		if (input.positionId !== undefined) change.positionId = input.positionId
		if (input.unpaidBreakMinutes !== undefined) {
			change.unpaidBreakMinutes = input.unpaidBreakMinutes
		}
		if (input.notes !== undefined) change.notes = input.notes

		const timeZone = row.timeZone
		if (input.startTime !== undefined && input.endTime !== undefined) {
			const date = input.date ?? current.localDate
			const window = resolveShiftWindow({
				date,
				startMinute: minuteOfDayFromHhmm(input.startTime),
				endMinute: minuteOfDayFromHhmm(input.endTime),
				timeZone,
			})
			if (!window.ok) {
				return fail(422, 'invalid_shift_time', { reason: window.reason })
			}
			change.startsAt = window.window.startsAt
			change.endsAt = window.window.endsAt
			change.localDate = window.window.localDate
		} else if (input.date !== undefined && input.date !== current.localDate) {
			// Moving to another day keeps the wall-clock times.
			const wall = wallClockOf(current.startsAt, current.endsAt, timeZone)
			const placed = placeWallClock({
				date: input.date,
				wallClock: wall,
				timeZone,
				fallbackDurationMinutes: durationMinutes(
					current.startsAt,
					current.endsAt,
				),
			})
			if (!placed.ok) {
				return fail(422, 'invalid_shift_time', { reason: placed.reason })
			}
			change.startsAt = placed.window.startsAt
			change.endsAt = placed.window.endsAt
			change.localDate = placed.window.localDate
		}

		const applied = await applyShiftChange(
			tx,
			ctx,
			row,
			change,
			input.expectedVersion,
		)
		if (!applied.ok) return applied
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.shift.updated',
			entityType: 'shift',
			entityId: row.id,
			staffId: change.staffId ?? current.staffId,
			scopeId: row.scopeId,
			changes: {
				fields: Object.keys(change).sort(),
				state: row.status,
			},
		})
		return ok(row.id)
	})
	if (!outcome.ok) return outcome
	const [view] = await viewsFor(ctx, frames, [outcome.value])
	return view ? ok(view) : fail(404, 'not_found')
}

export async function assignShift(
	ctx: ScheduleWriteContext,
	id: string,
	staffId: string | null,
	expectedVersion?: number,
): Promise<ScheduleResult<ScheduleShiftView>> {
	if (staffId !== null) {
		const person = await requireSchedulablePerson(ctx.db, ctx.scope, staffId)
		if (!person.ok) return person
	}
	const frames = new FrameCache(ctx)
	const outcome = await transact(ctx.db, async (tx) => {
		const loaded = await loadScopedShift(tx, ctx, id)
		if (!loaded.ok) return loaded
		const row = loaded.value
		const previous = effectiveShift(row).staffId
		const applied = await applyShiftChange(
			tx,
			ctx,
			row,
			{ staffId },
			expectedVersion,
		)
		if (!applied.ok) return applied
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action:
				staffId === null
					? 'schedule.shift.unassigned'
					: 'schedule.shift.assigned',
			entityType: 'shift',
			entityId: row.id,
			staffId: staffId ?? previous,
			scopeId: row.scopeId,
			changes: { previousStaffId: previous, staffId },
		})
		return ok(row.id)
	})
	if (!outcome.ok) return outcome
	const [view] = await viewsFor(ctx, frames, [outcome.value])
	return view ? ok(view) : fail(404, 'not_found')
}

// ---------------------------------------------------------------------------
// Delete and revert
// ---------------------------------------------------------------------------

/**
 * Removes a shift. A draft was never seen by staff, so it is deleted outright.
 * A published shift is marked for removal: staff keep it until the week is
 * published, and the removal can be reverted until then.
 */
export async function deleteShift(
	ctx: ScheduleWriteContext,
	id: string,
	expectedVersion?: number,
): Promise<ScheduleResult<ShiftDeleteResult>> {
	const frames = new FrameCache(ctx)
	const outcome = await transact(
		ctx.db,
		async (tx): Promise<ScheduleResult<ShiftDeleteResult | { id: string }>> => {
			const loaded = await loadScopedShift(tx, ctx, id)
			if (!loaded.ok) return loaded
			const row = loaded.value
			if (row.status === 'cancelled') return fail(409, 'shift_cancelled')
			if (expectedVersion !== undefined && expectedVersion !== row.version) {
				return fail(409, 'stale_shift', { currentVersion: row.version })
			}
			const current = effectiveShift(row)
			if (row.status === 'draft') {
				const removed = await tx
					.delete(shifts)
					.where(and(eq(shifts.id, row.id), eq(shifts.version, row.version)))
					.returning({ id: shifts.id })
				if (removed.length === 0) {
					return fail(409, 'stale_shift', { currentVersion: row.version })
				}
				await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
					action: 'schedule.shift.deleted',
					entityType: 'shift',
					entityId: row.id,
					staffId: current.staffId,
					scopeId: row.scopeId,
					changes: { state: 'draft' },
				})
				return ok({ state: 'deleted' as const, id: row.id })
			}
			if (!current.cancelPending) {
				const updated = await tx
					.update(shifts)
					.set({
						draftPatch: { cancel: true },
						version: row.version + 1,
						updatedBy: ctx.auth.userId,
						updatedAt: ctx.now,
					})
					.where(and(eq(shifts.id, row.id), eq(shifts.version, row.version)))
					.returning({ id: shifts.id })
				if (updated.length === 0) {
					return fail(409, 'stale_shift', { currentVersion: row.version })
				}
				await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
					action: 'schedule.shift.removal_pending',
					entityType: 'shift',
					entityId: row.id,
					staffId: current.staffId,
					scopeId: row.scopeId,
					changes: { state: 'published' },
				})
			}
			return ok({ id: row.id })
		},
	)
	if (!outcome.ok) return outcome
	if ('state' in outcome.value) return ok(outcome.value)
	const [view] = await viewsFor(ctx, frames, [outcome.value.id])
	return view
		? ok({ state: 'cancel_pending' as const, shift: view })
		: fail(404, 'not_found')
}

/** Drops a published shift's pending edit or pending removal. */
export async function revertShift(
	ctx: ScheduleWriteContext,
	id: string,
): Promise<ScheduleResult<ScheduleShiftView>> {
	const frames = new FrameCache(ctx)
	const outcome = await transact(ctx.db, async (tx) => {
		const loaded = await loadScopedShift(tx, ctx, id)
		if (!loaded.ok) return loaded
		const row = loaded.value
		if (row.status === 'cancelled') return fail(409, 'shift_cancelled')
		if (row.status !== 'published') return fail(409, 'not_published')
		if (row.draftPatch !== null) {
			const updated = await tx
				.update(shifts)
				.set({
					draftPatch: null,
					version: row.version + 1,
					updatedBy: ctx.auth.userId,
					updatedAt: ctx.now,
				})
				.where(and(eq(shifts.id, row.id), eq(shifts.version, row.version)))
				.returning({ id: shifts.id })
			if (updated.length === 0) {
				return fail(409, 'stale_shift', { currentVersion: row.version })
			}
			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: 'schedule.shift.reverted',
				entityType: 'shift',
				entityId: row.id,
				staffId: row.staffId,
				scopeId: row.scopeId,
				changes: { cancel: row.draftPatch.cancel === true },
			})
		}
		return ok(row.id)
	})
	if (!outcome.ok) return outcome
	const [view] = await viewsFor(ctx, frames, [outcome.value])
	return view ? ok(view) : fail(404, 'not_found')
}

import { and, desc, eq } from 'drizzle-orm'
import {
	type ScheduleDecision,
	type ScheduleShiftView,
	type ShiftRequestCreate,
	type ShiftRequestView,
} from '@repo/staffing'
import {
	shiftRequests,
	shifts,
	type ShiftRequestRow,
	type ShiftRow,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	buildShiftViews,
	effectiveShift,
	FrameCache,
	isOpaqueId,
	loadShiftsByIds,
	MAX_LIST_ROWS,
	type ScheduleContext,
	type ScheduleResult,
} from './schedule-shared.ts'
import {
	applyShiftChange,
	requireSchedulablePerson,
	transact,
} from './schedule-shift-service.ts'
import { type StaffDb, writeStaffAudit } from './staff-audit.ts'
import { fail, moneyAccess, ok } from './timesheet-shared.ts'

/**
 * Swap, cover and drop requests, decided by a manager. Approval changes the
 * shift through the same draft mechanics as any edit: the published shift is
 * untouched and the new person shows as a pending change until the week is
 * published. A request that no longer matches the schedule (the shift moved,
 * was removed or changed hands) is refused as stale instead of guessing.
 */

export type ShiftRequestWriteContext = Omit<ScheduleContext, 'db'> & {
	db: TenantDatabase
}

export type ShiftRequestDecisionResult = {
	request: ShiftRequestView
	/** The shifts the decision changed, with their warnings (empty for a rejection). */
	shifts: ScheduleShiftView[]
}

function toView(row: ShiftRequestRow, shift: ShiftRow): ShiftRequestView {
	return {
		id: row.id,
		kind: row.kind,
		shiftId: row.shiftId,
		scopeId: shift.scopeId,
		localDate: effectiveShift(shift).localDate,
		requesterStaffId: row.requesterStaffId,
		targetStaffId: row.targetStaffId,
		targetShiftId: row.targetShiftId,
		note: row.note,
		status: row.status,
		source: row.source,
		decidedBy: row.decidedBy,
		decidedAt: row.decidedAt,
		decisionNote: row.decisionNote,
		createdAt: row.createdAt,
	}
}

export async function listShiftRequests(
	ctx: ScheduleContext,
	query: {
		status?: ShiftRequestView['status']
		kind?: ShiftRequestView['kind']
		scopeId?: string
		limit: number
	},
): Promise<ScheduleResult<ShiftRequestView[]>> {
	if (query.scopeId !== undefined) {
		if (!isOpaqueId(query.scopeId) || !ctx.scope.allows(query.scopeId)) {
			return fail(404, 'not_found')
		}
	}
	const rows = await ctx.db
		.select({ request: shiftRequests, shift: shifts })
		.from(shiftRequests)
		.innerJoin(shifts, eq(shifts.id, shiftRequests.shiftId))
		.where(
			and(
				query.status ? eq(shiftRequests.status, query.status) : undefined,
				query.kind ? eq(shiftRequests.kind, query.kind) : undefined,
				query.scopeId ? eq(shifts.scopeId, query.scopeId) : undefined,
				ctx.scope.where(shifts.scopeId),
			),
		)
		.orderBy(desc(shiftRequests.createdAt), desc(shiftRequests.id))
		.limit(Math.min(query.limit, MAX_LIST_ROWS))
	return ok(rows.map((row) => toView(row.request, row.shift)))
}

async function loadRequest(
	tx: StaffDb,
	scope: ScheduleContext['scope'],
	id: string,
): Promise<ScheduleResult<{ request: ShiftRequestRow; shift: ShiftRow }>> {
	if (!isOpaqueId(id)) return fail(404, 'not_found')
	const [row] = await tx
		.select({ request: shiftRequests, shift: shifts })
		.from(shiftRequests)
		.innerJoin(shifts, eq(shifts.id, shiftRequests.shiftId))
		.where(eq(shiftRequests.id, id))
		.limit(1)
	if (!row || !scope.allows(row.shift.scopeId)) return fail(404, 'not_found')
	return ok(row)
}

/**
 * Applies an approved request to the schedule, inside the caller's
 * transaction. Returns the ids of the shifts it changed.
 */
async function applyRequest(
	tx: StaffDb,
	ctx: ShiftRequestWriteContext,
	request: ShiftRequestRow,
	shift: ShiftRow,
): Promise<ScheduleResult<string[]>> {
	if (shift.status !== 'published') return fail(409, 'request_stale')
	const current = effectiveShift(shift)
	if (current.cancelPending) return fail(409, 'request_stale')
	// The requester must still hold the shift, including any pending change.
	if (current.staffId !== request.requesterStaffId) {
		return fail(409, 'request_stale')
	}

	if (request.kind === 'drop') {
		const changed = await applyShiftChange(tx, ctx, shift, { staffId: null })
		return changed.ok ? ok([shift.id]) : changed
	}

	const target = await requireSchedulablePerson(
		tx,
		ctx.scope,
		request.targetStaffId,
	)
	if (!target.ok) return target

	if (request.kind === 'cover') {
		const changed = await applyShiftChange(tx, ctx, shift, {
			staffId: request.targetStaffId,
		})
		return changed.ok ? ok([shift.id]) : changed
	}

	// Swap: the two shifts change hands together.
	if (!request.targetShiftId) return fail(409, 'request_stale')
	const [other] = await tx
		.select()
		.from(shifts)
		.where(eq(shifts.id, request.targetShiftId))
		.limit(1)
	if (
		!other ||
		other.status !== 'published' ||
		!ctx.scope.allows(other.scopeId)
	) {
		return fail(409, 'request_stale')
	}
	const otherCurrent = effectiveShift(other)
	if (
		otherCurrent.cancelPending ||
		otherCurrent.staffId !== request.targetStaffId
	) {
		return fail(409, 'request_stale')
	}
	const first = await applyShiftChange(tx, ctx, shift, {
		staffId: request.targetStaffId,
	})
	if (!first.ok) return first
	const second = await applyShiftChange(tx, ctx, other, {
		staffId: request.requesterStaffId,
	})
	if (!second.ok) return second
	return ok([shift.id, other.id])
}

async function viewsOf(
	ctx: ShiftRequestWriteContext,
	ids: readonly string[],
): Promise<ScheduleShiftView[]> {
	const rows = await loadShiftsByIds(ctx.db, ids)
	const order = new Map(ids.map((id, index) => [id, index]))
	rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
	return buildShiftViews(ctx, new FrameCache(ctx), rows, moneyAccess(ctx.auth))
}

export async function createShiftRequest(
	ctx: ShiftRequestWriteContext,
	input: ShiftRequestCreate,
): Promise<ScheduleResult<ShiftRequestDecisionResult>> {
	const requester = await requireSchedulablePerson(
		ctx.db,
		ctx.scope,
		input.requesterStaffId,
	)
	if (!requester.ok) return requester
	if (input.targetStaffId) {
		const target = await requireSchedulablePerson(
			ctx.db,
			ctx.scope,
			input.targetStaffId,
		)
		if (!target.ok) return target
		if (input.targetStaffId === input.requesterStaffId) {
			return fail(422, 'not_your_shift')
		}
	}

	const approved = input.submission === 'manager_entered'
	const outcome = await transact(
		ctx.db,
		async (
			tx,
		): Promise<
			ScheduleResult<{
				request: ShiftRequestRow
				shift: ShiftRow
				ids: string[]
			}>
		> => {
			if (!isOpaqueId(input.shiftId)) return fail(404, 'not_found')
			const [shift] = await tx
				.select()
				.from(shifts)
				.where(eq(shifts.id, input.shiftId))
				.limit(1)
			if (!shift || !ctx.scope.allows(shift.scopeId)) {
				return fail(404, 'not_found')
			}
			if (shift.status === 'cancelled') return fail(409, 'shift_cancelled')
			if (shift.status !== 'published') return fail(409, 'not_published')
			if (shift.staffId !== input.requesterStaffId) {
				return fail(422, 'not_your_shift')
			}
			if (input.kind === 'swap') {
				const [other] = await tx
					.select()
					.from(shifts)
					.where(eq(shifts.id, input.targetShiftId!))
					.limit(1)
				if (
					!other ||
					other.status !== 'published' ||
					!ctx.scope.allows(other.scopeId) ||
					other.staffId !== input.targetStaffId
				) {
					return fail(422, 'not_your_shift')
				}
			}
			const [request] = await tx
				.insert(shiftRequests)
				.values({
					kind: input.kind,
					shiftId: input.shiftId,
					requesterStaffId: input.requesterStaffId,
					targetStaffId: input.targetStaffId ?? null,
					targetShiftId: input.targetShiftId ?? null,
					note: input.note ?? null,
					status: 'pending',
					source: approved ? 'manager' : 'staff',
					requestedBy: ctx.auth.userId,
					createdAt: ctx.now,
					updatedAt: ctx.now,
				})
				.returning()
			let ids: string[] = []
			let final = request!
			if (approved) {
				const applied = await applyRequest(tx, ctx, request!, shift)
				if (!applied.ok) return applied
				ids = applied.value
				const [approvedRow] = await tx
					.update(shiftRequests)
					.set({
						status: 'approved',
						decidedBy: ctx.auth.userId,
						decidedAt: ctx.now,
						updatedAt: ctx.now,
					})
					.where(eq(shiftRequests.id, request!.id))
					.returning()
				final = approvedRow!
			}
			await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
				action: 'schedule.shift_request.created',
				entityType: 'shift_request',
				entityId: final!.id,
				staffId: input.requesterStaffId,
				scopeId: shift.scopeId,
				changes: { kind: input.kind, status: final!.status },
			})
			return ok({ request: final!, shift, ids })
		},
	)
	if (!outcome.ok) return outcome
	return ok({
		request: toView(outcome.value.request, outcome.value.shift),
		shifts: outcome.value.ids.length
			? await viewsOf(ctx, outcome.value.ids)
			: [],
	})
}

export async function decideShiftRequest(
	ctx: ShiftRequestWriteContext,
	id: string,
	input: ScheduleDecision,
): Promise<ScheduleResult<ShiftRequestDecisionResult>> {
	const outcome = await transact(ctx.db, async (tx) => {
		const loaded = await loadRequest(tx, ctx.scope, id)
		if (!loaded.ok) return loaded
		const { request, shift } = loaded.value
		if (request.status !== 'pending') return fail(409, 'already_decided')
		let ids: string[] = []
		if (input.decision === 'approve') {
			const applied = await applyRequest(tx, ctx, request, shift)
			if (!applied.ok) return applied
			ids = applied.value
		}
		const status = input.decision === 'approve' ? 'approved' : 'rejected'
		const [updated] = await tx
			.update(shiftRequests)
			.set({
				status,
				decidedBy: ctx.auth.userId,
				decidedAt: ctx.now,
				decisionNote: input.note ?? null,
				updatedAt: ctx.now,
			})
			.where(and(eq(shiftRequests.id, id), eq(shiftRequests.status, 'pending')))
			.returning()
		if (!updated) return fail(409, 'already_decided')
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: `schedule.shift_request.${status}`,
			entityType: 'shift_request',
			entityId: id,
			staffId: request.requesterStaffId,
			scopeId: shift.scopeId,
			changes: { kind: request.kind },
		})
		return ok({ request: updated, shift, ids })
	})
	if (!outcome.ok) return outcome
	return ok({
		request: toView(outcome.value.request, outcome.value.shift),
		shifts: outcome.value.ids.length
			? await viewsOf(ctx, outcome.value.ids)
			: [],
	})
}

export async function cancelShiftRequest(
	ctx: ShiftRequestWriteContext,
	id: string,
): Promise<ScheduleResult<ShiftRequestView>> {
	const outcome = await transact(ctx.db, async (tx) => {
		const loaded = await loadRequest(tx, ctx.scope, id)
		if (!loaded.ok) return loaded
		const { request, shift } = loaded.value
		if (request.status !== 'pending') return fail(409, 'already_decided')
		const [updated] = await tx
			.update(shiftRequests)
			.set({ status: 'cancelled', updatedAt: ctx.now })
			.where(eq(shiftRequests.id, id))
			.returning()
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.shift_request.cancelled',
			entityType: 'shift_request',
			entityId: id,
			staffId: request.requesterStaffId,
			scopeId: shift.scopeId,
			changes: { kind: request.kind },
		})
		return ok(toView(updated!, shift))
	})
	return outcome
}

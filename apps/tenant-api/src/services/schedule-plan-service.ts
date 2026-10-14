import { asc, eq } from 'drizzle-orm'
import {
	addDays,
	type CopyResult,
	type ConflictShift,
	type NewShiftPlan,
	type PlanShift,
	planCopyWeek,
	planRecommendation,
	planTemplateApply,
	type RecommendResult,
	SCHEDULE_MAX_TEMPLATE_SLOTS,
	slotsFromShifts,
	type ShiftTemplateView,
	type TemplateApply,
	type TemplateCreate,
	type WeekCopy,
	type Recommend,
} from '@repo/staffing'
import {
	shiftTemplates,
	type ShiftRow,
	type ShiftTemplateRow,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	checkWeekCapacity,
	insertDrafts,
	transact,
} from './schedule-shift-service.ts'
import {
	conflictContextOf,
	effectiveShift,
	type EffectiveShift,
	FrameCache,
	isLive,
	isOpaqueId,
	type ScopeFrame,
	loadApprovedAvailability,
	loadApprovedTimeOff,
	loadScopeShifts,
	loadPeople,
	loadShiftsInRange,
	personVisible,
	type PersonRecord,
	requireFrame,
	snapWeekStart,
	toAnalyzed,
	weekNeighbourhood,
	type ScheduleContext,
	type ScheduleResult,
} from './schedule-shared.ts'
import { type StaffDb, writeStaffAudit } from './staff-audit.ts'
import { fail, ok } from './timesheet-shared.ts'

/**
 * Copy a week, templates and "recommend a schedule". Everything lands as
 * drafts, so nothing reaches staff before a manager publishes. The planning is
 * pure (`@repo/staffing`) and deterministic: the same base week, the same
 * people and the same approved availability and time off always give the same
 * proposal, and running it twice adds nothing the second time.
 */

export type PlanWriteContext = Omit<ScheduleContext, 'db'> & {
	db: TenantDatabase
}

function weekSources(
	rows: readonly ShiftRow[],
	weekStart: string,
): { effective: EffectiveShift[]; plan: PlanShift[] } {
	const weekEnd = addDays(weekStart, 6)
	const effective = rows
		.map(effectiveShift)
		.filter(
			(shift) =>
				isLive(shift) &&
				shift.localDate >= weekStart &&
				shift.localDate <= weekEnd,
		)
	return {
		effective,
		plan: effective.map((shift) => ({
			id: shift.id,
			staffId: shift.staffId,
			positionId: shift.positionId,
			startsAt: shift.startsAt,
			endsAt: shift.endsAt,
			localDate: shift.localDate,
			unpaidBreakMinutes: shift.unpaidBreakMinutes,
			notes: shift.notes,
		})),
	}
}

function toExisting(effective: readonly EffectiveShift[]) {
	return effective.map((shift) => ({
		staffId: shift.staffId,
		positionId: shift.positionId,
		startsAt: shift.startsAt,
		endsAt: shift.endsAt,
	}))
}

/**
 * A copied or templated shift keeps its person only when the person is still
 * on the roster and the token can see them; otherwise the shift goes out open.
 */
async function openForInactive<T extends { staffId: string | null }>(
	db: StaffDb,
	scope: ScheduleContext['scope'],
	plans: readonly T[],
): Promise<{ plans: T[]; opened: number }> {
	const ids = [...new Set(plans.flatMap((p) => (p.staffId ? [p.staffId] : [])))]
	const people = ids.length ? await loadPeople(db, ids) : new Map()
	let opened = 0
	const result = plans.map((plan) => {
		if (!plan.staffId) return plan
		const person = people.get(plan.staffId) as PersonRecord | undefined
		if (
			!person ||
			person.member.status === 'terminated' ||
			!personVisible(scope, person)
		) {
			opened += 1
			return { ...plan, staffId: null }
		}
		return plan
	})
	return { plans: result, opened }
}

async function writePlans(
	tx: StaffDb,
	ctx: PlanWriteContext,
	frame: ScopeFrame,
	plans: readonly NewShiftPlan[],
): Promise<ScheduleResult<ShiftRow[]>> {
	const byDate = new Map<string, number>()
	for (const plan of plans) {
		byDate.set(plan.localDate, (byDate.get(plan.localDate) ?? 0) + 1)
	}
	const capacity = await checkWeekCapacity(
		tx,
		frame.scopeId,
		frame.weekStartsOn,
		byDate,
	)
	if (!capacity.ok) return capacity
	return ok(
		await insertDrafts(
			tx,
			ctx,
			plans.map((plan) => ({
				scopeId: frame.scopeId,
				staffId: plan.staffId,
				positionId: plan.positionId,
				startsAt: plan.startsAt,
				endsAt: plan.endsAt,
				localDate: plan.localDate,
				timeZone: frame.timeZone,
				unpaidBreakMinutes: plan.unpaidBreakMinutes,
				notes: plan.notes,
			})),
		),
	)
}

// ---------------------------------------------------------------------------
// Copy a week
// ---------------------------------------------------------------------------

export async function copyWeek(
	ctx: PlanWriteContext,
	input: WeekCopy,
): Promise<ScheduleResult<CopyResult>> {
	const frames = new FrameCache(ctx)
	const framed = await requireFrame(
		ctx,
		frames,
		input.scopeId,
		'scope_out_of_scope',
	)
	if (!framed.ok) return framed
	const frame = framed.value
	const from = snapWeekStart(input.fromWeekStart, frame)
	const to = snapWeekStart(input.toWeekStart, frame)
	if (from === to) return fail(422, 'same_week')

	return transact(ctx.db, async (tx) => {
		const source = weekSources(
			await loadScopeShifts(tx, frame.scopeId, from, addDays(from, 6)),
			from,
		)
		const target = weekSources(
			await loadScopeShifts(tx, frame.scopeId, to, addDays(to, 6)),
			to,
		)
		const plan = planCopyWeek({
			sources: source.plan,
			existing: toExisting(target.effective),
			fromWeekStart: from,
			toWeekStart: to,
			timeZone: frame.timeZone,
			scope: input.scope,
			includeOpenShifts: input.includeOpenShifts,
		})
		const { plans, opened } = await openForInactive(tx, ctx.scope, plan.create)
		const written = await writePlans(tx, ctx, frame, plans)
		if (!written.ok) return written
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.week.copied',
			entityType: 'schedule_week',
			entityId: to,
			scopeId: frame.scopeId,
			changes: {
				fromWeekStart: from,
				toWeekStart: to,
				scope: input.scope.mode,
				created: written.value.length,
				skippedDuplicates: plan.skippedDuplicates,
			},
		})
		return ok({
			weekStart: to,
			created: written.value.length,
			skippedDuplicates: plan.skippedDuplicates,
			skippedUnplaceable: plan.skippedUnplaceable,
			openedForInactive: opened,
		})
	})
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

function toTemplateView(row: ShiftTemplateRow): ShiftTemplateView {
	return {
		id: row.id,
		scopeId: row.scopeId,
		name: row.name,
		slotCount: row.slotCount,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}
}

export async function listTemplates(
	ctx: ScheduleContext,
	scopeId: string,
): Promise<ScheduleResult<ShiftTemplateView[]>> {
	if (!isOpaqueId(scopeId) || !ctx.scope.allows(scopeId)) {
		return fail(404, 'not_found')
	}
	const rows = await ctx.db
		.select()
		.from(shiftTemplates)
		.where(eq(shiftTemplates.scopeId, scopeId))
		.orderBy(asc(shiftTemplates.name), asc(shiftTemplates.id))
	return ok(rows.map(toTemplateView))
}

export async function createTemplate(
	ctx: PlanWriteContext,
	input: TemplateCreate,
): Promise<ScheduleResult<ShiftTemplateView>> {
	const frames = new FrameCache(ctx)
	const framed = await requireFrame(
		ctx,
		frames,
		input.scopeId,
		'scope_out_of_scope',
	)
	if (!framed.ok) return framed
	const frame = framed.value
	const weekStart = snapWeekStart(input.fromWeekStart, frame)

	return transact(ctx.db, async (tx) => {
		const source = weekSources(
			await loadScopeShifts(
				tx,
				frame.scopeId,
				weekStart,
				addDays(weekStart, 6),
			),
			weekStart,
		)
		const slots = slotsFromShifts({
			shifts: source.plan,
			timeZone: frame.timeZone,
			scope: input.scope,
			keepAssignments: input.keepAssignments,
		})
		if (slots.length === 0) return fail(422, 'empty_template')
		if (slots.length > SCHEDULE_MAX_TEMPLATE_SLOTS) {
			return fail(422, 'too_many_slots')
		}
		const [row] = await tx
			.insert(shiftTemplates)
			.values({
				scopeId: frame.scopeId,
				name: input.name,
				slots,
				slotCount: slots.length,
				createdBy: ctx.auth.userId,
				createdAt: ctx.now,
				updatedAt: ctx.now,
			})
			.returning()
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.template.created',
			entityType: 'shift_template',
			entityId: row!.id,
			scopeId: frame.scopeId,
			changes: {
				slotCount: slots.length,
				keepAssignments: input.keepAssignments,
			},
		})
		return ok(toTemplateView(row!))
	})
}

async function loadTemplate(
	db: StaffDb,
	scope: ScheduleContext['scope'],
	id: string,
): Promise<ScheduleResult<ShiftTemplateRow>> {
	if (!isOpaqueId(id)) return fail(404, 'not_found')
	const [row] = await db
		.select()
		.from(shiftTemplates)
		.where(eq(shiftTemplates.id, id))
		.limit(1)
	if (!row || !scope.allows(row.scopeId)) return fail(404, 'not_found')
	return ok(row)
}

export async function deleteTemplate(
	ctx: PlanWriteContext,
	id: string,
): Promise<ScheduleResult<{ id: string }>> {
	return transact(ctx.db, async (tx) => {
		const loaded = await loadTemplate(tx, ctx.scope, id)
		if (!loaded.ok) return loaded
		await tx.delete(shiftTemplates).where(eq(shiftTemplates.id, id))
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.template.deleted',
			entityType: 'shift_template',
			entityId: id,
			scopeId: loaded.value.scopeId,
			changes: { slotCount: loaded.value.slotCount },
		})
		return ok({ id })
	})
}

export async function applyTemplate(
	ctx: PlanWriteContext,
	id: string,
	input: TemplateApply,
): Promise<ScheduleResult<CopyResult>> {
	const frames = new FrameCache(ctx)
	const loaded = await loadTemplate(ctx.db, ctx.scope, id)
	if (!loaded.ok) return loaded
	const template = loaded.value
	const framed = await requireFrame(
		ctx,
		frames,
		template.scopeId,
		'scope_out_of_scope',
	)
	if (!framed.ok) return framed
	const frame = framed.value
	const weekStart = snapWeekStart(input.weekStart, frame)

	return transact(ctx.db, async (tx) => {
		const target = weekSources(
			await loadScopeShifts(
				tx,
				frame.scopeId,
				weekStart,
				addDays(weekStart, 6),
			),
			weekStart,
		)
		const plan = planTemplateApply({
			slots: template.slots,
			weekStart,
			timeZone: frame.timeZone,
			assignments: input.assignments,
			existing: toExisting(target.effective),
		})
		const { plans, opened } = await openForInactive(tx, ctx.scope, plan.create)
		const written = await writePlans(tx, ctx, frame, plans)
		if (!written.ok) return written
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.template.applied',
			entityType: 'shift_template',
			entityId: template.id,
			scopeId: frame.scopeId,
			changes: {
				weekStart,
				assignments: input.assignments,
				created: written.value.length,
				skippedDuplicates: plan.skippedDuplicates,
			},
		})
		return ok({
			weekStart,
			created: written.value.length,
			skippedDuplicates: plan.skippedDuplicates,
			skippedUnplaceable: plan.skippedUnplaceable,
			openedForInactive: opened,
		})
	})
}

// ---------------------------------------------------------------------------
// Recommend a schedule
// ---------------------------------------------------------------------------

/**
 * Proposes a week from a base week: the base shifts move to the target week,
 * each person keeps their shift unless approved availability, approved time
 * off, an overlap, or their roster status says otherwise, and anything that
 * conflicts goes out as an open shift for a manager to fill. Overtime and
 * minimum rest stay warnings. With `apply` false nothing is written.
 */
export async function recommendWeek(
	ctx: PlanWriteContext,
	input: Recommend,
): Promise<ScheduleResult<RecommendResult>> {
	const frames = new FrameCache(ctx)
	const framed = await requireFrame(
		ctx,
		frames,
		input.scopeId,
		'scope_out_of_scope',
	)
	if (!framed.ok) return framed
	const frame = framed.value
	const base = snapWeekStart(input.baseWeekStart, frame)
	const target = snapWeekStart(input.targetWeekStart, frame)
	if (base === target) return fail(422, 'same_week')

	const build = async (
		db: StaffDb,
	): Promise<{
		plan: ReturnType<typeof planRecommendation>
	}> => {
		const source = weekSources(
			await loadScopeShifts(db, frame.scopeId, base, addDays(base, 6)),
			base,
		)
		const existingTarget = weekSources(
			await loadScopeShifts(db, frame.scopeId, target, addDays(target, 6)),
			target,
		)
		const staffIds = [
			...new Set(source.plan.flatMap((s) => (s.staffId ? [s.staffId] : []))),
		]
		const records = staffIds.length ? await loadPeople(db, staffIds) : new Map()
		const people = new Map<string, ReturnType<typeof conflictContextOf>>()
		const timeOff = await loadApprovedTimeOff(
			db,
			staffIds,
			addDays(target, -7),
			addDays(target, 14),
		)
		const availability = await loadApprovedAvailability(db, staffIds)
		for (const staffId of staffIds) {
			const person = records.get(staffId) as PersonRecord | undefined
			// A person the token cannot see is treated as unavailable to it.
			if (!person || !personVisible(ctx.scope, person)) continue
			people.set(
				staffId,
				conflictContextOf(
					person,
					timeOff.get(staffId) ?? [],
					availability.get(staffId) ?? [],
				),
			)
		}

		// Everything else the same people already have around the target week.
		const bounds = weekNeighbourhood(target, frame)
		const around = staffIds.length
			? await loadShiftsInRange(db, staffIds, bounds.fromMs, bounds.toMs)
			: []
		const existingByStaff = new Map<string, ConflictShift[]>()
		for (const row of around) {
			const effective = effectiveShift(row)
			if (!effective.staffId || !isLive(effective)) continue
			if (!ctx.scope.allows(effective.scopeId)) continue
			const list = existingByStaff.get(effective.staffId) ?? []
			list.push(toAnalyzed(effective, records.get(effective.staffId) ?? null))
			existingByStaff.set(effective.staffId, list)
		}

		return {
			plan: planRecommendation({
				sources: source.plan,
				existingByStaff,
				existingTarget: toExisting(existingTarget.effective),
				people,
				fromWeekStart: base,
				toWeekStart: target,
				timeZone: frame.timeZone,
				scopeId: frame.scopeId,
				scope: input.scope,
				includeOpenShifts: true,
				rules: frame.rules,
			}),
		}
	}

	const result = (
		plan: ReturnType<typeof planRecommendation>,
		created: number,
	): RecommendResult => ({
		estimate: true,
		applied: input.apply,
		scopeId: frame.scopeId,
		weekStart: target,
		shifts: plan.shifts.map((shift) => ({
			staffId: shift.staffId,
			positionId: shift.positionId,
			localDate: shift.localDate,
			startsAt: shift.startsAt,
			endsAt: shift.endsAt,
			unpaidBreakMinutes: shift.unpaidBreakMinutes,
			...(shift.openReason
				? {
						openReason: shift.openReason,
						previousStaffId: shift.previousStaffId ?? null,
					}
				: {}),
		})),
		counts: {
			total: plan.shifts.length,
			opened: plan.opened,
			skippedDuplicates: plan.skippedDuplicates,
			skippedUnplaceable: plan.skippedUnplaceable,
			created,
		},
	})

	if (!input.apply) {
		return ok(result((await build(ctx.db)).plan, 0))
	}
	return transact(ctx.db, async (tx) => {
		const { plan } = await build(tx)
		const written = await writePlans(tx, ctx, frame, plan.shifts)
		if (!written.ok) return written
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.week.recommended',
			entityType: 'schedule_week',
			entityId: target,
			scopeId: frame.scopeId,
			changes: {
				baseWeekStart: base,
				targetWeekStart: target,
				scope: input.scope.mode,
				created: written.value.length,
				opened: plan.opened,
			},
		})
		return ok(result(plan, written.value.length))
	})
}

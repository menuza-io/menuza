import { and, eq, inArray, sql } from 'drizzle-orm'
import {
	addDays,
	allocatePaidMinutesByDay,
	computeDemandGuide,
	computeLaborTarget,
	demandWindow,
	manualSalesGuide,
	costUnitsToMinor,
	type DemandBucket,
	type DemandGuide,
	demandWindowSeconds,
	estimateWeek,
	localDateOf,
	type ScheduleDayFooter,
	type ScheduleOverlay,
	type SchedulePersonView,
	type ScheduleSettingsUpdate,
	type ScheduleSettingsView,
	type ScheduleShiftView,
	type ScheduleWeekView,
	startOfLocalDay,
	type WeekQuery,
	weekDates,
} from '@repo/staffing'
import {
	scheduleSettings,
	scheduleWeeks,
	shiftRequests,
	shifts,
	staffAvailability,
	staffScopeAssignments,
	staffPositions,
	timeOffRequests,
	type TenantDatabase,
} from '@repo/tenant-db'
import {
	loadLaborSettings,
	loadManualSales,
	loadOrderBuckets,
	manualSalesFacts,
} from './labor-data.ts'
import {
	analyzePeople,
	effectiveShift,
	type EffectiveShift,
	FrameCache,
	isLive,
	type ScopeFrame,
	loadApprovedAvailability,
	loadScopeShifts,
	loadPeople,
	loadScheduleSettings,
	MAX_LIST_ROWS,
	type PersonAnalysis,
	requireFrame,
	type ScheduleContext,
	type ScheduleResult,
	snapWeekStart,
	toShiftView,
} from './schedule-shared.ts'
import { type StaffDb, writeStaffAudit } from './staff-audit.ts'
import { fail, moneyAccess, ok } from './timesheet-shared.ts'
import { transact } from './schedule-shift-service.ts'
import { inJsonList } from '../lib/chunked-in.ts'

/**
 * The week the schedule grid shows, the orders-based demand guide and the
 * organization's schedule settings.
 *
 * Money is left out of the response, not hidden: a shift's estimated cost and a
 * person's week cost need the pay grant; the day footers' cost, the totals and
 * the labor target need the labor (or pay) grant.
 */

export async function getScheduleSettings(
	db: StaffDb,
): Promise<ScheduleSettingsView> {
	return loadScheduleSettings(db)
}

export async function updateScheduleSettings(
	ctx: ScheduleContext & { db: TenantDatabase },
	input: ScheduleSettingsUpdate,
): Promise<ScheduleResult<ScheduleSettingsView>> {
	// The settings apply to every scope, so (like positions and the default
	// labor policy) a token limited to some scopes cannot change them.
	if (!ctx.scope.unrestricted) return fail(403, 'unrestricted_scope_required')
	return transact(ctx.db, async (tx) => {
		const before = await loadScheduleSettings(tx)
		const next = {
			minRestMinutes: input.minRestMinutes ?? before.minRestMinutes,
			timeOffMinNoticeDays:
				input.timeOffMinNoticeDays ?? before.timeOffMinNoticeDays,
		}
		await tx
			.insert(scheduleSettings)
			.values({
				id: 'org',
				...next,
				updatedBy: ctx.auth.userId,
				updatedAt: ctx.now,
			})
			.onConflictDoUpdate({
				target: scheduleSettings.id,
				set: { ...next, updatedBy: ctx.auth.userId, updatedAt: ctx.now },
			})
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'schedule.settings.updated',
			entityType: 'schedule_settings',
			entityId: 'org',
			changes: {
				minRestMinutes: {
					before: before.minRestMinutes,
					after: next.minRestMinutes,
				},
				timeOffMinNoticeDays: {
					before: before.timeOffMinNoticeDays,
					after: next.timeOffMinNoticeDays,
				},
			},
		})
		return ok({ ...next, updatedAt: ctx.now })
	})
}

// ---------------------------------------------------------------------------
// Demand guide
// ---------------------------------------------------------------------------

/**
 * Median counted orders by weekday and hour over the trailing eight weeks. A
 * guide from past orders, not a forecast. It reads the order source a vertical
 * registered (see `order-source.ts`); without one the guide is empty and only
 * the manual-sales guide (when the labor grant allows it) has figures. A week
 * in the future is guided by the most recent real weeks.
 */
export async function loadDemandGuide(
	ctx: Pick<ScheduleContext, 'db' | 'now'>,
	frame: ScopeFrame,
	weekStart: string,
	includeSales: boolean,
): Promise<DemandGuide> {
	const today = localDateOf(ctx.now, frame.timeZone)
	const anchor = weekStart > today ? today : weekStart
	const { fromSeconds, toSeconds } = demandWindowSeconds(anchor, frame.timeZone)
	const rows = await loadOrderBuckets(
		ctx.db,
		frame.scopeId,
		fromSeconds,
		toSeconds,
	)
	const byKey = new Map<string, DemandBucket>()
	for (const row of rows) {
		const key = `${row.bucket}|${row.currency}`
		const bucket = byKey.get(key) ?? {
			bucket: row.bucket,
			currency: row.currency,
			orders: 0,
			salesMinor: 0,
		}
		bucket.orders += row.orders
		bucket.salesMinor += row.subtotalMinor
		byKey.set(key, bucket)
	}
	const buckets: DemandBucket[] = [...byKey.values()]
	return computeDemandGuide({
		buckets,
		weekDates: weekDates(weekStart),
		anchorDate: anchor,
		timeZone: frame.timeZone,
		includeSales,
	})
}

export async function getDemand(
	ctx: ScheduleContext,
	query: { scopeId: string; date: string },
): Promise<ScheduleResult<DemandGuide>> {
	const frames = new FrameCache(ctx)
	const framed = await requireFrame(ctx, frames, query.scopeId, 'not_found')
	if (!framed.ok) return framed
	const money = moneyAccess(ctx.auth)
	return ok(
		await loadDemandGuide(
			ctx,
			framed.value,
			snapWeekStart(query.date, framed.value),
			money.labor,
		),
	)
}

// ---------------------------------------------------------------------------
// Week
// ---------------------------------------------------------------------------

function overlapsWeek(
	row: { startDate: string; endDate: string },
	weekStart: string,
	weekEnd: string,
) {
	return row.startDate <= weekEnd && row.endDate >= weekStart
}

export async function loadWeek(
	ctx: ScheduleContext,
	query: WeekQuery,
): Promise<ScheduleResult<ScheduleWeekView>> {
	const frames = new FrameCache(ctx)
	const framed = await requireFrame(ctx, frames, query.scopeId, 'not_found')
	if (!framed.ok) return framed
	const frame = framed.value
	const money = moneyAccess(ctx.auth)
	const weekStart = snapWeekStart(query.date, frame)
	const dates = weekDates(weekStart)
	const weekEnd = dates[6]!
	const inWeek = new Set(dates)

	// The shifts the grid shows: effective date in the week, not removed.
	const rows = await loadScopeShifts(ctx.db, frame.scopeId, weekStart, weekEnd)
	const effective = rows
		.map(effectiveShift)
		.filter((shift) => inWeek.has(shift.localDate))
		.sort((a, b) => a.startsAt - b.startsAt || a.id.localeCompare(b.id))

	// The roster: people shown in the schedule here, plus anyone with a shift.
	const rosterRows = await ctx.db
		.select({ staffId: staffScopeAssignments.staffId })
		.from(staffScopeAssignments)
		.where(
			and(
				eq(staffScopeAssignments.scopeId, frame.scopeId),
				eq(staffScopeAssignments.active, true),
				eq(staffScopeAssignments.showInSchedule, true),
			),
		)
		.limit(MAX_LIST_ROWS)
	const shiftStaffIds = effective.flatMap((s) => (s.staffId ? [s.staffId] : []))
	const people = await loadPeople(ctx.db, [
		...rosterRows.map((r) => r.staffId),
		...shiftStaffIds,
	])
	const shown = new Set(shiftStaffIds)
	for (const row of rosterRows) {
		const person = people.get(row.staffId)
		if (person && person.member.status !== 'terminated') shown.add(row.staffId)
	}

	const live = effective.filter(isLive)
	// A shift that started the evening before and runs past midnight still puts
	// people on the clock on the first morning. It belongs to the earlier week's
	// grid, but its minutes after midnight count in this week's footers.
	const weekStartMs = startOfLocalDay(weekStart, frame.timeZone)
	const spill = (
		await loadScopeShifts(
			ctx.db,
			frame.scopeId,
			addDays(weekStart, -1),
			addDays(weekStart, -1),
		)
	)
		.map(effectiveShift)
		.filter(
			(shift) =>
				isLive(shift) &&
				shift.localDate === addDays(weekStart, -1) &&
				shift.endsAt > weekStartMs,
		)
	const spillStaff = spill.flatMap((shift) =>
		shift.staffId ? [shift.staffId] : [],
	)
	for (const [id, person] of await loadPeople(
		ctx.db,
		spillStaff.filter((id) => !people.has(id)),
	)) {
		people.set(id, person)
	}
	const analyses = await analyzePeople(ctx, frame, [...live, ...spill], people)

	const shiftViews: ScheduleShiftView[] = effective.map((shift) =>
		toShiftView(
			shift,
			shift.staffId ? analyses.get(shift.staffId) : undefined,
			money,
		),
	)

	// People rows with their week figures.
	const personViews: SchedulePersonView[] = []
	for (const staffId of shown) {
		const person = people.get(staffId)
		if (!person) continue
		const analysis = analyses.get(staffId)
		const summary = analysis
			? estimateWeek(analysis.shifts, frame.rules, frame.timeZone, weekStart)
			: null
		const assignment = person.assignments.find(
			(a) => a.scopeId === frame.scopeId,
		)
		const view: SchedulePersonView = {
			id: staffId,
			firstName: person.member.firstName,
			lastName: person.member.lastName,
			firstNameAr: person.member.firstNameAr ?? null,
			lastNameAr: person.member.lastNameAr ?? null,
			status: person.member.status,
			positionIds: [
				...new Set(
					person.jobs
						.filter(
							({ job }) =>
								job.scopeId === frame.scopeId &&
								job.effectiveFrom <= weekEnd &&
								(job.effectiveTo === null || job.effectiveTo >= weekStart),
						)
						.map(({ job }) => job.positionId),
				),
			].sort(),
			showInSchedule: assignment?.showInSchedule ?? false,
			eligibleOpenShifts: assignment?.eligibleOpenShifts ?? false,
			weekMinutes: summary?.total ?? 0,
			overtimeMinutes: summary ? summary.overtime + summary.doubleTime : 0,
		}
		if (money.person) {
			const units: Record<string, number> = {}
			if (summary && analysis) {
				for (const shift of analysis.shifts) {
					if (shift.scopeId !== frame.scopeId) continue
					const cost = summary.entryCost[shift.id]
					if (cost?.currency) {
						units[cost.currency] = (units[cost.currency] ?? 0) + cost.units
					}
				}
			}
			view.weekCostMinor = Object.fromEntries(
				Object.entries(units)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([currency, value]) => [currency, costUnitsToMinor(value)]),
			)
		}
		personViews.push(view)
	}
	personViews.sort(
		(a, b) =>
			a.lastName.localeCompare(b.lastName) ||
			a.firstName.localeCompare(b.firstName) ||
			a.id.localeCompare(b.id),
	)

	// Overlays: time off and availability for the people on the grid.
	const peopleIds = personViews.map((p) => p.id)
	const overlays = await loadOverlays(ctx.db, peopleIds, weekStart, weekEnd)

	// Footers.
	const footers = buildFooters(
		dates,
		[...live, ...spill],
		analyses,
		frame,
		money.labor,
	)

	const totals: ScheduleWeekView['totals'] = {
		minutes: footers.reduce((sum, f) => sum + f.minutes, 0),
		overtimeMinutes: footers.reduce((sum, f) => sum + f.overtimeMinutes, 0),
		openShifts: footers.reduce((sum, f) => sum + f.openShifts, 0),
		openMinutes: footers.reduce((sum, f) => sum + f.openMinutes, 0),
	}
	if (money.labor) {
		const cost: Record<string, number> = {}
		for (const footer of footers) {
			for (const [currency, value] of Object.entries(
				footer.costMinorByCurrency ?? {},
			)) {
				cost[currency] = (cost[currency] ?? 0) + value
			}
		}
		totals.costMinorByCurrency = sortRecord(cost)
		totals.unpricedMinutes = unpricedMinutesOf(live, analyses)
	}

	// Week bookkeeping.
	const [weekRow] = await ctx.db
		.select()
		.from(scheduleWeeks)
		.where(
			and(
				eq(scheduleWeeks.scopeId, frame.scopeId),
				eq(scheduleWeeks.weekStartDate, weekStart),
			),
		)
		.limit(1)
	const unpublishedCount = effective.filter(
		(s) =>
			s.state === 'draft' ||
			s.state === 'changed' ||
			s.state === 'cancel_pending',
	).length

	const pending = await countPending(ctx.db, peopleIds, frame.scopeId)

	// Positions in use here.
	const positionIds = new Set<string>()
	for (const shift of effective) {
		if (shift.positionId) positionIds.add(shift.positionId)
	}
	for (const view of personViews) {
		for (const id of view.positionIds) positionIds.add(id)
	}
	const positionRows =
		positionIds.size === 0
			? []
			: await ctx.db
					.select()
					.from(staffPositions)
					.where(inJsonList(staffPositions.id, [...positionIds]))
	const positions = positionRows
		.map((row) => ({
			id: row.id,
			name: row.name,
			nameAr: row.nameAr,
			colorKey:
				row.colorKey as ScheduleWeekView['positions'][number]['colorKey'],
		}))
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))

	const view: ScheduleWeekView = {
		estimate: true,
		scopeId: frame.scopeId,
		timeZone: frame.timeZone,
		weekStart,
		weekEnd,
		weekStartsOn: frame.weekStartsOn,
		dates,
		version: weekRow?.version ?? 0,
		lastPublishedAt: weekRow?.lastPublishedAt ?? null,
		unpublishedCount,
		people: personViews,
		shifts: shiftViews,
		overlays,
		footers,
		totals,
		pending,
		positions,
		currencies: [],
	}

	if (money.labor) {
		const laborSettings = await loadLaborSettings(ctx.db, frame.scopeId)
		const guide = await loadDemandGuide(ctx, frame, weekStart, true)
		// Guide sales by day: the median of past orders, or, for a scope that
		// enters its own sales, the median of the same weekdays it entered.
		let guideSalesByDate: Record<
			string,
			Record<string, number>
		> = Object.fromEntries(
			guide.days.map((day) => [day.date, day.salesMinorByCurrency ?? {}]),
		)
		if (laborSettings.salesSource === 'manual') {
			const today = localDateOf(ctx.now, frame.timeZone)
			const anchor = weekStart > today ? today : weekStart
			const window = demandWindow(anchor)
			const entries = await loadManualSales(
				ctx.db,
				frame.scopeId,
				window.startDate,
				window.endDate,
			)
			guideSalesByDate = manualSalesGuide({
				entries: manualSalesFacts(entries),
				weekDates: dates,
				anchorDate: anchor,
			})
		}
		const guideSales: Record<string, number> = {}
		for (const byCurrency of Object.values(guideSalesByDate)) {
			for (const [currency, value] of Object.entries(byCurrency)) {
				guideSales[currency] = (guideSales[currency] ?? 0) + value
			}
		}
		view.laborTarget = computeLaborTarget({
			targetBp: frame.policy.laborTargetBp,
			costMinorByCurrency: totals.costMinorByCurrency ?? {},
			guideSalesMinorByCurrency: guideSales,
			salesSource: laborSettings.salesSource,
			guideSalesByDate,
		})
		view.currencies = view.laborTarget.currencies.map(
			(c) => c.currency as ScheduleWeekView['currencies'][number],
		)
	}
	return ok(view)
}

function sortRecord(record: Record<string, number>): Record<string, number> {
	return Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
	)
}

function unpricedMinutesOf(
	live: readonly EffectiveShift[],
	analyses: ReadonlyMap<string, PersonAnalysis>,
): number {
	let total = 0
	for (const shift of live) {
		if (!shift.staffId) continue
		total +=
			analyses.get(shift.staffId)?.estimates.get(shift.id)?.unpricedMinutes ?? 0
	}
	return total
}

function buildFooters(
	dates: readonly string[],
	live: readonly EffectiveShift[],
	analyses: ReadonlyMap<string, PersonAnalysis>,
	frame: ScopeFrame,
	withCost: boolean,
): ScheduleDayFooter[] {
	const byDate = new Map<
		string,
		{
			minutes: number
			overtime: number
			people: Set<string>
			openShifts: number
			openMinutes: number
			units: Record<string, number>
		}
	>(
		dates.map((date) => [
			date,
			{
				minutes: 0,
				overtime: 0,
				people: new Set<string>(),
				openShifts: 0,
				openMinutes: 0,
				units: {},
			},
		]),
	)
	for (const shift of live) {
		if (shift.scopeId !== frame.scopeId) continue
		const parts = allocatePaidMinutesByDay(shift, frame.timeZone)
		const paid = parts.reduce((sum, p) => sum + p.minutes, 0)
		if (!shift.staffId) {
			const startDay = byDate.get(shift.localDate)
			if (startDay) startDay.openShifts += 1
			for (const part of parts) {
				const day = byDate.get(part.date)
				if (day) day.openMinutes += part.minutes
			}
			continue
		}
		const estimate = analyses.get(shift.staffId)?.estimates.get(shift.id)
		const startDay = byDate.get(shift.localDate)
		if (startDay && estimate) startDay.overtime += estimate.overtimeMinutes
		for (const part of parts) {
			const day = byDate.get(part.date)
			if (!day) continue
			day.minutes += part.minutes
			day.people.add(shift.staffId)
			if (withCost && estimate && paid > 0) {
				for (const [currency, units] of Object.entries(
					estimate.costUnitsByCurrency,
				)) {
					day.units[currency] =
						(day.units[currency] ?? 0) + (units * part.minutes) / paid
				}
			}
		}
	}
	return dates.map((date) => {
		const day = byDate.get(date)!
		const footer: ScheduleDayFooter = {
			date,
			minutes: day.minutes,
			overtimeMinutes: day.overtime,
			headcount: day.people.size,
			openShifts: day.openShifts,
			openMinutes: day.openMinutes,
		}
		if (withCost) {
			footer.costMinorByCurrency = sortRecord(
				Object.fromEntries(
					Object.entries(day.units).map(([currency, units]) => [
						currency,
						costUnitsToMinor(units),
					]),
				),
			)
		}
		return footer
	})
}

async function loadOverlays(
	db: StaffDb,
	staffIds: readonly string[],
	weekStart: string,
	weekEnd: string,
): Promise<ScheduleOverlay[]> {
	if (staffIds.length === 0) return []
	const timeOff = await db
		.select()
		.from(timeOffRequests)
		.where(
			and(
				inJsonList(timeOffRequests.staffId, [...staffIds]),
				inArray(timeOffRequests.status, ['pending', 'approved']),
				sql`${timeOffRequests.startDate} <= ${weekEnd}`,
				sql`${timeOffRequests.endDate} >= ${weekStart}`,
			),
		)
	const availability = await loadApprovedAvailability(db, staffIds)
	const overlays = new Map<string, ScheduleOverlay>()
	const overlayFor = (staffId: string) => {
		let overlay = overlays.get(staffId)
		if (!overlay) {
			overlay = { staffId, timeOff: [], availability: [] }
			overlays.set(staffId, overlay)
		}
		return overlay
	}
	for (const row of timeOff) {
		if (!overlapsWeek(row, weekStart, weekEnd)) continue
		overlayFor(row.staffId).timeOff.push({
			id: row.id,
			status: row.status as 'pending' | 'approved',
			category: row.category,
			startDate: row.startDate,
			endDate: row.endDate,
			allDay: row.allDay,
			startMinute: row.startMinute,
			endMinute: row.endMinute,
		})
	}
	for (const [staffId, windows] of availability) {
		for (const window of windows) {
			const relevant =
				window.kind === 'one_off'
					? window.date !== null &&
						window.date >= weekStart &&
						window.date <= weekEnd
					: (window.effectiveFrom === null ||
							window.effectiveFrom <= weekEnd) &&
						(window.effectiveTo === null || window.effectiveTo >= weekStart)
			if (relevant) overlayFor(staffId).availability.push(window)
		}
	}
	return [...overlays.values()]
		.map((overlay) => ({
			...overlay,
			timeOff: overlay.timeOff.sort((a, b) => a.id.localeCompare(b.id)),
			availability: overlay.availability.sort((a, b) =>
				a.id.localeCompare(b.id),
			),
		}))
		.sort((a, b) => a.staffId.localeCompare(b.staffId))
}

async function countPending(
	db: StaffDb,
	staffIds: readonly string[],
	scopeId: string,
): Promise<ScheduleWeekView['pending']> {
	const [timeOff, availability, requests] = await Promise.all([
		staffIds.length === 0
			? Promise.resolve([{ count: 0 }])
			: db
					.select({ count: sql<number>`count(*)` })
					.from(timeOffRequests)
					.where(
						and(
							inJsonList(timeOffRequests.staffId, [...staffIds]),
							eq(timeOffRequests.status, 'pending'),
						),
					),
		staffIds.length === 0
			? Promise.resolve([{ count: 0 }])
			: db
					.select({ count: sql<number>`count(*)` })
					.from(staffAvailability)
					.where(
						and(
							inJsonList(staffAvailability.staffId, [...staffIds]),
							eq(staffAvailability.status, 'pending'),
						),
					),
		db
			.select({ count: sql<number>`count(*)` })
			.from(shiftRequests)
			.innerJoin(shifts, eq(shifts.id, shiftRequests.shiftId))
			.where(
				and(eq(shiftRequests.status, 'pending'), eq(shifts.scopeId, scopeId)),
			),
	])
	return {
		timeOff: Number(timeOff[0]?.count ?? 0),
		availability: Number(availability[0]?.count ?? 0),
		shiftRequests: Number(requests[0]?.count ?? 0),
	}
}

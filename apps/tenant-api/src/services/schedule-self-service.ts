import {
	and,
	asc,
	between,
	count,
	desc,
	eq,
	gte,
	inArray,
	ne,
} from 'drizzle-orm'
import {
	addDays,
	localDateOf,
	SELF_DEFAULT_DAYS_BACK,
	SELF_DEFAULT_DAYS_FORWARD,
	SELF_MAX_PENDING_REQUESTS,
	SELF_MAX_RANGE_DAYS,
	type AvailabilityCreate,
	type MyAvailabilityView,
	type MyScope,
	type MyRequestsView,
	type MyScheduleView,
	type MyShift,
	type MyShiftRequestView,
	type MyTeammatesView,
	type MyTimeCard,
	type MyTimeCardEdit,
	type MyTimeCardsView,
	type MyTimeOffView,
	type SelfRangeQuery,
	type ShiftRequestCreate,
	type TimeOffCreate,
} from '@repo/staffing'
import {
	shiftRequests,
	shifts,
	staffAvailability,
	staffScopeAssignments,
	staffMembers,
	staffPositions,
	timeEntries,
	timeEntryEdits,
	timeOffRequests,
	type ScheduleLinkRow,
	type StaffMember,
	type TenantDatabase,
	type TimeEntryEdit,
} from '@repo/tenant-db'
import { getScopeFacts } from '../lib/scope-context.ts'
import {
	scopeToScopes,
	type ScopeAccess,
	type StaffAuth,
} from '../lib/staff-auth.ts'
import { resolvePolicy } from './labor-policy-service.ts'
import {
	createAvailability,
	cancelAvailability,
	cancelTimeOff,
	createTimeOff,
} from './schedule-timeoff-service.ts'
import {
	cancelShiftRequest,
	createShiftRequest,
} from './schedule-shift-request-service.ts'
import {
	isOpaqueId,
	type ScheduleContext,
	type ScheduleResult,
} from './schedule-shared.ts'
import { buildLiveCards, fail, ok, selectCardRows } from './timesheet-shared.ts'

/**
 * What a person can do with their own "my schedule" link: read their own
 * published shifts and time cards, and make requests (time off, availability,
 * swap, cover, drop) that wait for a manager. Nothing here changes the schedule
 * or a time card, and nothing is returned about anyone else beyond a teammate's
 * first name and last initial (and, where the scope lets the team see the
 * schedule, the times of teammates' shifts for a swap).
 *
 * The writes reuse the manager-side services, run as a synthetic principal that
 * holds no grants and is limited to the person's own scopes, recording each
 * request as the person's own (`staff_request`: it waits for a decision).
 */

export type SelfContext = {
	db: TenantDatabase
	orgId: string
	staff: StaffMember
	link: ScheduleLinkRow
	ipHash: string | null
	now: number
}

type Person = { scopeIds: string[] }

async function assignedScopes(
	db: TenantDatabase,
	staffId: string,
): Promise<Person> {
	const rows = await db
		.select({ scopeId: staffScopeAssignments.scopeId })
		.from(staffScopeAssignments)
		.where(
			and(
				eq(staffScopeAssignments.staffId, staffId),
				eq(staffScopeAssignments.active, true),
			),
		)
	return { scopeIds: [...new Set(rows.map((row) => row.scopeId))].sort() }
}

/** The principal the manager-side services run as: no grants, own scopes only. */
function selfAuth(ctx: SelfContext, scopeIds: string[]): StaffAuth {
	return {
		orgId: ctx.orgId,
		userId: `staff:${ctx.staff.id}`,
		scope: 'schedule',
		grants: [],
		scopeIds,
		impersonated: false,
		actorKind: 'staff_link',
	}
}

function writeContext(ctx: SelfContext, scopeIds: string[]) {
	const auth = selfAuth(ctx, scopeIds)
	return {
		db: ctx.db,
		auth,
		scope: scopeToScopes(auth) satisfies ScopeAccess,
		ipHash: ctx.ipHash,
		now: ctx.now,
	} satisfies ScheduleContext
}

type ScopeInfo = {
	name: string | null
	timeZone: string
	visibility: 'own' | 'team'
}

async function scopeInfo(
	ctx: SelfContext,
	scopeId: string,
): Promise<ScopeInfo> {
	const facts = await getScopeFacts(ctx.orgId, scopeId, ctx.now).catch(
		() => null,
	)
	const policy = await resolvePolicy(ctx.db, scopeId)
	return {
		name: facts?.name ?? null,
		timeZone: facts?.timeZone ?? policy.timeZone ?? 'UTC',
		visibility: policy.scheduleVisibility === 'team' ? 'team' : 'own',
	}
}

async function loadScopes(
	ctx: SelfContext,
	scopeIds: readonly string[],
): Promise<Map<string, ScopeInfo>> {
	const out = new Map<string, ScopeInfo>()
	for (const id of scopeIds) out.set(id, await scopeInfo(ctx, id))
	return out
}

function daysBetween(from: string, to: string): number {
	const a = Date.UTC(
		Number(from.slice(0, 4)),
		Number(from.slice(5, 7)) - 1,
		Number(from.slice(8, 10)),
	)
	const b = Date.UTC(
		Number(to.slice(0, 4)),
		Number(to.slice(5, 7)) - 1,
		Number(to.slice(8, 10)),
	)
	return Math.round((b - a) / 86_400_000)
}

function resolveRange(
	query: SelfRangeQuery,
	today: string,
	back: number,
	forward: number,
): ScheduleResult<{ from: string; to: string }> {
	const from =
		query.from ??
		(query.to ? addDays(query.to, -forward) : addDays(today, -back))
	const to = query.to ?? addDays(from, back + forward)
	if (to < from) return fail(400, 'invalid_range')
	if (daysBetween(from, to) > SELF_MAX_RANGE_DAYS) {
		return fail(422, 'range_too_large', { maxDays: SELF_MAX_RANGE_DAYS })
	}
	return ok({ from, to })
}

/** "Rana K." */
function shortName(
	member: Pick<StaffMember, 'firstName' | 'lastName'>,
): string {
	const initial = member.lastName.trim().charAt(0)
	return `${member.firstName.trim()}${initial ? ` ${initial.toUpperCase()}.` : ''}`.trim()
}

// ---------------------------------------------------------------------------
// Own schedule
// ---------------------------------------------------------------------------

const MAX_SHIFTS = 300

function toMyShift(
	row: typeof shifts.$inferSelect,
	position: { name: string | null; nameAr: string | null },
): MyShift {
	return {
		id: row.id,
		scopeId: row.scopeId,
		positionName: position.name,
		positionNameAr: position.nameAr,
		startsAt: row.startsAt,
		endsAt: row.endsAt,
		localDate: row.localDate,
		timeZone: row.timeZone,
		unpaidBreakMinutes: row.unpaidBreakMinutes,
		notes: row.notes,
	}
}

export async function loadMySchedule(
	ctx: SelfContext,
	query: SelfRangeQuery,
): Promise<ScheduleResult<MyScheduleView>> {
	const { scopeIds } = await assignedScopes(ctx.db, ctx.staff.id)
	const scopes = await loadScopes(ctx, scopeIds)
	const zone = [...scopes.values()][0]?.timeZone ?? 'UTC'
	const range = resolveRange(
		query,
		localDateOf(ctx.now, zone),
		SELF_DEFAULT_DAYS_BACK,
		SELF_DEFAULT_DAYS_FORWARD,
	)
	if (!range.ok) return range
	const { from, to } = range.value

	// Only this person's own published shifts: a draft, a pending edit, a
	// cancelled shift and an open shift are never part of what they see.
	const rows = await ctx.db
		.select({
			shift: shifts,
			positionName: staffPositions.name,
			positionNameAr: staffPositions.nameAr,
		})
		.from(shifts)
		.leftJoin(staffPositions, eq(staffPositions.id, shifts.positionId))
		.where(
			and(
				eq(shifts.staffId, ctx.staff.id),
				eq(shifts.status, 'published'),
				between(shifts.localDate, from, to),
			),
		)
		.orderBy(asc(shifts.startsAt), asc(shifts.id))
		.limit(MAX_SHIFTS)

	const known = new Set(scopeIds)
	const extra = [...new Set(rows.map((row) => row.shift.scopeId))].filter(
		(id) => !known.has(id),
	)
	// A shift at a scope the person is no longer assigned to still shows.
	for (const id of extra) scopes.set(id, await scopeInfo(ctx, id))

	const myScopes: MyScope[] = [...scopes.entries()].map(([id, info]) => ({
		id,
		name: info.name,
		timeZone: info.timeZone,
		scheduleVisibility: info.visibility,
	}))
	return ok({
		serverNow: ctx.now,
		person: {
			firstName: ctx.staff.firstName,
			firstNameAr: ctx.staff.firstNameAr,
			locale: ctx.staff.locale,
		},
		scopes: myScopes,
		from,
		to,
		shifts: rows.map((row) =>
			toMyShift(row.shift, {
				name: row.positionName,
				nameAr: row.positionNameAr,
			}),
		),
		link: { expiresAt: ctx.link.expiresAt },
	})
}

// ---------------------------------------------------------------------------
// Own time cards, with their edit history
// ---------------------------------------------------------------------------

type Times = { clockInAt: number | null; clockOutAt: number | null }

function timesOf(snapshot: unknown): Times | null {
	if (!snapshot || typeof snapshot !== 'object') return null
	const value = snapshot as Record<string, unknown>
	const num = (v: unknown) => (typeof v === 'number' ? v : null)
	return { clockInAt: num(value.clockInAt), clockOutAt: num(value.clockOutAt) }
}

/**
 * One edit as the person sees it: what happened, why (the reason the manager
 * recorded) and how the times moved. Pay, tips, notes and who edited are never
 * included.
 */
function toMyEdit(row: TimeEntryEdit): MyTimeCardEdit {
	return {
		id: row.id,
		action: row.action,
		via: row.via,
		reason: row.reason,
		hoursDeltaMinutes: row.hoursDeltaMinutes,
		before: timesOf(row.before),
		after: timesOf(row.after),
		createdAt: row.createdAt,
	}
}

const STAFF_STATUS: Record<string, string> = {
	open: 'open',
	closed: 'closed',
	needs_review: 'closed',
	approved: 'approved',
	locked: 'locked',
}

export async function loadMyTimeCards(
	ctx: SelfContext,
	query: SelfRangeQuery,
): Promise<ScheduleResult<MyTimeCardsView>> {
	const { scopeIds } = await assignedScopes(ctx.db, ctx.staff.id)
	const scopes = await loadScopes(ctx, scopeIds)
	const zone = [...scopes.values()][0]?.timeZone ?? 'UTC'
	const range = resolveRange(query, localDateOf(ctx.now, zone), 27, 0)
	if (!range.ok) return range
	const { from, to } = range.value

	const rows = await selectCardRows(
		ctx.db,
		and(
			eq(timeEntries.staffId, ctx.staff.id),
			between(timeEntries.localDate, from, to),
		),
		MAX_SHIFTS,
	)
	const live = await buildLiveCards(ctx, rows, { fromDate: from, toDate: to })
	const edits = live.length
		? await ctx.db
				.select()
				.from(timeEntryEdits)
				.where(
					and(
						inArray(
							timeEntryEdits.entryId,
							live.map((card) => card.entry.id),
						),
						eq(timeEntryEdits.staffId, ctx.staff.id),
					),
				)
				.orderBy(desc(timeEntryEdits.createdAt))
		: []
	const byEntry = new Map<string, TimeEntryEdit[]>()
	for (const edit of edits) {
		const list = byEntry.get(edit.entryId) ?? []
		list.push(edit)
		byEntry.set(edit.entryId, list)
	}
	const cards: MyTimeCard[] = live
		.map((card) => ({
			id: card.entry.id,
			scopeId: card.entry.scopeId,
			positionName: card.positionName,
			positionNameAr: card.positionNameAr,
			timeZone: card.entry.timeZone,
			localDate: card.entry.localDate,
			clockInAt: card.entry.clockInAt,
			clockOutAt: card.entry.clockOutAt,
			status: STAFF_STATUS[card.status] ?? 'closed',
			paidMinutes: card.figures.paidMinutes,
			unpaidBreakMinutes: card.figures.unpaidBreakMinutes,
			edited: card.issues.includes('edited') || byEntry.has(card.entry.id),
			edits: (byEntry.get(card.entry.id) ?? []).map(toMyEdit),
		}))
		.sort((a, b) => b.clockInAt - a.clockInAt)
	return ok({ serverNow: ctx.now, from, to, cards })
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function toMyTimeOff(row: typeof timeOffRequests.$inferSelect): MyTimeOffView {
	return {
		id: row.id,
		category: row.category,
		startDate: row.startDate,
		endDate: row.endDate,
		allDay: row.allDay,
		startMinute: row.startMinute,
		endMinute: row.endMinute,
		note: row.note,
		status: row.status,
		decisionNote: row.decisionNote,
		createdAt: row.createdAt,
	}
}

function toMyAvailability(
	row: typeof staffAvailability.$inferSelect,
): MyAvailabilityView {
	return {
		id: row.id,
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
		decisionNote: row.decisionNote,
		createdAt: row.createdAt,
	}
}

const LIST_LIMIT = 60

async function myShiftRequests(
	ctx: SelfContext,
	where?: ReturnType<typeof and>,
): Promise<MyShiftRequestView[]> {
	const rows = await ctx.db
		.select({ request: shiftRequests, shift: shifts })
		.from(shiftRequests)
		.innerJoin(shifts, eq(shifts.id, shiftRequests.shiftId))
		.where(and(eq(shiftRequests.requesterStaffId, ctx.staff.id), where))
		.orderBy(desc(shiftRequests.createdAt))
		.limit(LIST_LIMIT)
	const targetIds = [
		...new Set(
			rows.flatMap((row) =>
				row.request.targetStaffId ? [row.request.targetStaffId] : [],
			),
		),
	]
	const targets = targetIds.length
		? await ctx.db
				.select()
				.from(staffMembers)
				.where(inArray(staffMembers.id, targetIds))
		: []
	const names = new Map(targets.map((t) => [t.id, shortName(t)]))
	return rows.map(({ request, shift }) => ({
		id: request.id,
		kind: request.kind,
		shiftId: shift.id,
		localDate: shift.localDate,
		startsAt: shift.startsAt,
		endsAt: shift.endsAt,
		timeZone: shift.timeZone,
		targetName: request.targetStaffId
			? (names.get(request.targetStaffId) ?? null)
			: null,
		note: request.note,
		status: request.status,
		decisionNote: request.decisionNote,
		createdAt: request.createdAt,
	}))
}

export async function listMyRequests(
	ctx: SelfContext,
): Promise<ScheduleResult<MyRequestsView>> {
	const [timeOff, availability, requests] = await Promise.all([
		ctx.db
			.select()
			.from(timeOffRequests)
			.where(eq(timeOffRequests.staffId, ctx.staff.id))
			.orderBy(desc(timeOffRequests.startDate))
			.limit(LIST_LIMIT),
		ctx.db
			.select()
			.from(staffAvailability)
			.where(
				and(
					eq(staffAvailability.staffId, ctx.staff.id),
					ne(staffAvailability.status, 'superseded'),
				),
			)
			.orderBy(desc(staffAvailability.createdAt))
			.limit(LIST_LIMIT),
		myShiftRequests(ctx),
	])
	return ok({
		timeOff: timeOff.map(toMyTimeOff),
		availability: availability.map(toMyAvailability),
		shiftRequests: requests,
	})
}

async function pendingCount(ctx: SelfContext): Promise<number> {
	const counts = await Promise.all([
		ctx.db
			.select({ n: count() })
			.from(timeOffRequests)
			.where(
				and(
					eq(timeOffRequests.staffId, ctx.staff.id),
					eq(timeOffRequests.status, 'pending'),
				),
			),
		ctx.db
			.select({ n: count() })
			.from(staffAvailability)
			.where(
				and(
					eq(staffAvailability.staffId, ctx.staff.id),
					eq(staffAvailability.status, 'pending'),
				),
			),
		ctx.db
			.select({ n: count() })
			.from(shiftRequests)
			.where(
				and(
					eq(shiftRequests.requesterStaffId, ctx.staff.id),
					eq(shiftRequests.status, 'pending'),
				),
			),
	])
	return counts.reduce((sum, [row]) => sum + Number(row?.n ?? 0), 0)
}

/** Open requests are capped, so a leaked link cannot fill a manager's queue. */
async function underPendingCap(
	ctx: SelfContext,
	adding = 1,
): Promise<ScheduleResult<null>> {
	if ((await pendingCount(ctx)) + adding > SELF_MAX_PENDING_REQUESTS) {
		return fail(409, 'too_many_pending')
	}
	return ok(null)
}

export async function createMyTimeOff(
	ctx: SelfContext,
	input: TimeOffCreate,
): Promise<ScheduleResult<MyTimeOffView>> {
	const capped = await underPendingCap(ctx)
	if (!capped.ok) return capped
	const { scopeIds } = await assignedScopes(ctx.db, ctx.staff.id)
	const created = await createTimeOff(writeContext(ctx, scopeIds), {
		...input,
		staffId: ctx.staff.id,
		submission: 'staff_request',
	})
	if (!created.ok) return created
	const [row] = await ctx.db
		.select()
		.from(timeOffRequests)
		.where(eq(timeOffRequests.id, created.value.id))
		.limit(1)
	return ok(toMyTimeOff(row!))
}

export async function cancelMyTimeOff(
	ctx: SelfContext,
	id: string,
): Promise<ScheduleResult<MyTimeOffView>> {
	if (!isOpaqueId(id)) return fail(404, 'not_found')
	const [row] = await ctx.db
		.select()
		.from(timeOffRequests)
		.where(
			and(
				eq(timeOffRequests.id, id),
				eq(timeOffRequests.staffId, ctx.staff.id),
			),
		)
		.limit(1)
	if (!row) return fail(404, 'not_found')
	// Taking back a decided request is the manager's call.
	if (row.status !== 'pending') return fail(409, 'already_decided')
	const { scopeIds } = await assignedScopes(ctx.db, ctx.staff.id)
	const cancelled = await cancelTimeOff(writeContext(ctx, scopeIds), id)
	if (!cancelled.ok) return cancelled
	return ok(toMyTimeOff({ ...row, status: 'cancelled' }))
}

export async function createMyAvailability(
	ctx: SelfContext,
	input: AvailabilityCreate,
): Promise<ScheduleResult<MyAvailabilityView[]>> {
	const capped = await underPendingCap(ctx, input.rows.length)
	if (!capped.ok) return capped
	const { scopeIds } = await assignedScopes(ctx.db, ctx.staff.id)
	const created = await createAvailability(writeContext(ctx, scopeIds), {
		...input,
		staffId: ctx.staff.id,
		submission: 'staff_request',
	})
	if (!created.ok) return created
	const ids = created.value.map((row) => row.id)
	const rows = await ctx.db
		.select()
		.from(staffAvailability)
		.where(inArray(staffAvailability.id, ids))
	return ok(rows.map(toMyAvailability))
}

export async function cancelMyAvailability(
	ctx: SelfContext,
	id: string,
): Promise<ScheduleResult<MyAvailabilityView>> {
	if (!isOpaqueId(id)) return fail(404, 'not_found')
	const [row] = await ctx.db
		.select()
		.from(staffAvailability)
		.where(
			and(
				eq(staffAvailability.id, id),
				eq(staffAvailability.staffId, ctx.staff.id),
			),
		)
		.limit(1)
	if (!row) return fail(404, 'not_found')
	if (row.status !== 'pending') return fail(409, 'already_decided')
	const { scopeIds } = await assignedScopes(ctx.db, ctx.staff.id)
	const cancelled = await cancelAvailability(writeContext(ctx, scopeIds), id)
	if (!cancelled.ok) return cancelled
	return ok(toMyAvailability({ ...row, status: 'cancelled' }))
}

// ---------------------------------------------------------------------------
// Swap, cover and drop
// ---------------------------------------------------------------------------

/** The person's own upcoming published shift, or why it is not one. */
async function ownUpcomingShift(
	ctx: SelfContext,
	shiftId: unknown,
): Promise<ScheduleResult<typeof shifts.$inferSelect>> {
	if (!isOpaqueId(shiftId)) return fail(404, 'not_found')
	const [shift] = await ctx.db
		.select()
		.from(shifts)
		.where(eq(shifts.id, shiftId))
		.limit(1)
	// Someone else's shift reads the same as one that does not exist.
	if (!shift || shift.staffId !== ctx.staff.id) return fail(404, 'not_found')
	if (shift.status !== 'published') return fail(409, 'not_published')
	if (shift.startsAt <= ctx.now) return fail(409, 'shift_started')
	return ok(shift)
}

const SWAP_WINDOW_DAYS = 14

/** Teammates a person may ask to take or swap a shift (a name, never contact details). */
async function colleagues(
	ctx: SelfContext,
	scopeId: string,
): Promise<StaffMember[]> {
	const rows = await ctx.db
		.select({ member: staffMembers })
		.from(staffMembers)
		.innerJoin(
			staffScopeAssignments,
			eq(staffScopeAssignments.staffId, staffMembers.id),
		)
		.where(
			and(
				eq(staffScopeAssignments.scopeId, scopeId),
				eq(staffScopeAssignments.active, true),
				eq(staffMembers.status, 'active'),
				ne(staffMembers.id, ctx.staff.id),
			),
		)
		.orderBy(asc(staffMembers.firstName), asc(staffMembers.lastName))
		.limit(150)
	return rows.map((row) => row.member)
}

export async function loadMyTeammates(
	ctx: SelfContext,
	shiftId: string,
): Promise<ScheduleResult<MyTeammatesView>> {
	const own = await ownUpcomingShift(ctx, shiftId)
	if (!own.ok) return own
	const shift = own.value
	const info = await scopeInfo(ctx, shift.scopeId)
	const people = await colleagues(ctx, shift.scopeId)
	const canSwap = info.visibility === 'team'
	let swapCandidates: MyTeammatesView['swapCandidates'] = []
	if (canSwap && people.length > 0) {
		const rows = await ctx.db
			.select({
				shift: shifts,
				positionName: staffPositions.name,
				positionNameAr: staffPositions.nameAr,
			})
			.from(shifts)
			.leftJoin(staffPositions, eq(staffPositions.id, shifts.positionId))
			.where(
				and(
					eq(shifts.scopeId, shift.scopeId),
					eq(shifts.status, 'published'),
					inArray(
						shifts.staffId,
						people.map((p) => p.id),
					),
					gte(shifts.startsAt, ctx.now),
					between(
						shifts.localDate,
						addDays(shift.localDate, -SWAP_WINDOW_DAYS),
						addDays(shift.localDate, SWAP_WINDOW_DAYS),
					),
				),
			)
			.orderBy(asc(shifts.startsAt))
			.limit(150)
		swapCandidates = rows.flatMap((row) =>
			row.shift.staffId
				? [
						{
							id: row.shift.id,
							staffId: row.shift.staffId,
							startsAt: row.shift.startsAt,
							endsAt: row.shift.endsAt,
							localDate: row.shift.localDate,
							timeZone: row.shift.timeZone,
							positionName: row.positionName,
							positionNameAr: row.positionNameAr,
						},
					]
				: [],
		)
	}
	return ok({
		teammates: people.map((p) => ({ id: p.id, name: shortName(p) })),
		swapCandidates,
		canSwap,
	})
}

export async function createMyShiftRequest(
	ctx: SelfContext,
	input: ShiftRequestCreate,
): Promise<ScheduleResult<MyShiftRequestView>> {
	const own = await ownUpcomingShift(ctx, input.shiftId)
	if (!own.ok) return own
	const shift = own.value
	const capped = await underPendingCap(ctx)
	if (!capped.ok) return capped

	if (input.kind !== 'drop') {
		const info = await scopeInfo(ctx, shift.scopeId)
		if (input.kind === 'swap' && info.visibility !== 'team') {
			return fail(403, 'swap_not_allowed')
		}
		// The other person has to be someone who works at this scope now.
		const people = await colleagues(ctx, shift.scopeId)
		if (!people.some((p) => p.id === input.targetStaffId)) {
			return fail(422, 'staff_not_found')
		}
	}
	const { scopeIds } = await assignedScopes(ctx.db, ctx.staff.id)
	const created = await createShiftRequest(writeContext(ctx, scopeIds), {
		...input,
		requesterStaffId: ctx.staff.id,
		submission: 'staff_request',
	})
	if (!created.ok) return created
	const [view] = await myShiftRequests(
		ctx,
		and(eq(shiftRequests.id, created.value.request.id)),
	)
	return ok(view!)
}

export async function cancelMyShiftRequest(
	ctx: SelfContext,
	id: string,
): Promise<ScheduleResult<MyShiftRequestView>> {
	if (!isOpaqueId(id)) return fail(404, 'not_found')
	const [mine] = await myShiftRequests(ctx, and(eq(shiftRequests.id, id)))
	if (!mine) return fail(404, 'not_found')
	if (mine.status !== 'pending') return fail(409, 'already_decided')
	const { scopeIds } = await assignedScopes(ctx.db, ctx.staff.id)
	const cancelled = await cancelShiftRequest(writeContext(ctx, scopeIds), id)
	if (!cancelled.ok) return cancelled
	return ok({ ...mine, status: 'cancelled' })
}

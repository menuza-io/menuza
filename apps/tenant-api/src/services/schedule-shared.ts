import {
	and,
	type AnyColumn,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	lt,
	ne,
	or,
	type SQL,
	sql,
} from 'drizzle-orm'
import {
	type AvailabilityWindow,
	type ConflictShift,
	costUnitsToMinor,
	detectPersonConflicts,
	estimatePerShift,
	type LaborPolicyView,
	laborPolicyToRules,
	type LaborRules,
	paidMinutesOf,
	type PersonConflictContext,
	type PersonJob,
	type ScheduleConflict,
	type ScheduleShiftView,
	type ShiftEstimate,
	type ShiftViewState,
	startOfLocalDay,
	type TimeOffWindow,
	weekStartFor,
	addDays,
} from '@repo/staffing'
import {
	scheduleSettings,
	shifts,
	staffAvailability,
	staffJobs,
	staffScopeAssignments,
	staffMembers,
	staffPositions,
	timeOffRequests,
	type ShiftDraftPatch,
	type ShiftRow,
	type StaffJob,
	type StaffScopeAssignment,
	type StaffMember,
	type StaffPosition,
} from '@repo/tenant-db'
import { inJsonList } from '../lib/chunked-in.ts'
import { getScopeFacts } from '../lib/scope-context.ts'
import { type ScopeAccess, type StaffAuth } from '../lib/staff-auth.ts'
import { OPAQUE_ID_PATTERN } from '../lib/staff-http.ts'
import { resolvePolicy } from './labor-policy-service.ts'
import { type StaffDb } from './staff-audit.ts'
import {
	fail,
	type MoneyAccess,
	ok,
	type TimesheetResult,
} from './timesheet-shared.ts'

/**
 * What the schedule services share: the request context, the failure
 * vocabulary, a scope's frame (time zone, week start, labor rules), the
 * "effective" shift (the published fields with a pending edit laid over them),
 * and the one pipeline that turns shifts into what a manager sees: warnings,
 * paid minutes, overtime and (with the pay grant) an estimated cost.
 *
 * Everything that is judged (overlap, overtime, rest, availability, time off)
 * is judged here, through the same `@repo/staffing` functions the unit tests
 * cover, so a week view, a single write and a recommendation cannot disagree.
 */

export type ScheduleContext = {
	db: StaffDb
	auth: StaffAuth
	scope: ScopeAccess
	ipHash: string | null
	/** Injectable clock: the server's "now". */
	now: number
}

export type ScheduleResult<T> = TimesheetResult<T>
export { fail, ok }

const DAY_MS = 24 * 60 * 60 * 1000
/** Most rows loaded for one list: a bigger set asks the caller to narrow. */
export const MAX_LIST_ROWS = 500
/** Ids per `IN (...)` query, comfortably under SQLite's variable limit. */
const ID_CHUNK = 90

export function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size))
	}
	return out
}

export function isOpaqueId(value: unknown): value is string {
	return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export const DEFAULT_MIN_REST_MINUTES = 480

export async function loadScheduleSettings(db: StaffDb) {
	const [row] = await db
		.select()
		.from(scheduleSettings)
		.where(eq(scheduleSettings.id, 'org'))
		.limit(1)
	return {
		minRestMinutes: row?.minRestMinutes ?? DEFAULT_MIN_REST_MINUTES,
		timeOffMinNoticeDays: row?.timeOffMinNoticeDays ?? 0,
		updatedAt: row?.updatedAt ?? null,
	}
}

// ---------------------------------------------------------------------------
// Scope frame
// ---------------------------------------------------------------------------

export type ScopeFrame = {
	scopeId: string
	timeZone: string
	policy: LaborPolicyView
	rules: LaborRules
	weekStartsOn: number
	minRestMinutes: number
}

/**
 * Resolves and caches the frame of each scope a request touches. The time
 * zone comes from the control plane (scope facts), else the labor policy,
 * else the zone a shift at the scope was written in; with none of them the
 * scope is refused rather than guessed.
 */
export class FrameCache {
	private readonly frames = new Map<string, ScopeFrame | null>()
	private settings: Promise<{ minRestMinutes: number }> | null = null

	constructor(
		private readonly ctx: Pick<ScheduleContext, 'db' | 'auth' | 'now'>,
	) {}

	async get(
		scopeId: string,
		fallbackTimeZone?: string,
	): Promise<ScopeFrame | null> {
		const cached = this.frames.get(scopeId)
		if (cached !== undefined) return cached
		const policy = await resolvePolicy(this.ctx.db, scopeId)
		const facts = await getScopeFacts(
			this.ctx.auth.orgId,
			scopeId,
			this.ctx.now,
		)
		let timeZone = facts?.timeZone ?? policy.timeZone ?? null
		if (!timeZone) {
			const [latest] = await this.ctx.db
				.select({ timeZone: shifts.timeZone })
				.from(shifts)
				.where(eq(shifts.scopeId, scopeId))
				.orderBy(sql`${shifts.createdAt} desc`)
				.limit(1)
			timeZone = latest?.timeZone ?? fallbackTimeZone ?? null
		}
		if (!timeZone) {
			this.frames.set(scopeId, null)
			return null
		}
		this.settings ??= loadScheduleSettings(this.ctx.db)
		const frame: ScopeFrame = {
			scopeId,
			timeZone,
			policy,
			rules: laborPolicyToRules(policy),
			weekStartsOn: policy.weekStartsOn,
			minRestMinutes: (await this.settings).minRestMinutes,
		}
		this.frames.set(scopeId, frame)
		return frame
	}
}

/**
 * The frame of a scope named by a request. Outside the token's scopes the
 * answer is 404 (reads: a scoped manager cannot probe other scopes) or 403
 * (writes naming a scope in the body, as the roster does).
 */
export async function requireFrame(
	ctx: ScheduleContext,
	frames: FrameCache,
	scopeId: unknown,
	denied: 'not_found' | 'scope_out_of_scope',
): Promise<ScheduleResult<ScopeFrame>> {
	if (!isOpaqueId(scopeId)) return fail(404, 'not_found')
	if (!ctx.scope.allows(scopeId)) {
		return denied === 'not_found'
			? fail(404, 'not_found')
			: fail(403, 'scope_out_of_scope')
	}
	const frame = await frames.get(scopeId)
	if (!frame) return fail(409, 'time_zone_unknown')
	return ok(frame)
}

/** The first date of the workweek `date` falls in. */
export function snapWeekStart(date: string, frame: ScopeFrame): string {
	return weekStartFor(date, frame.weekStartsOn)
}

// ---------------------------------------------------------------------------
// Effective shifts
// ---------------------------------------------------------------------------

export type PublishedFields = NonNullable<ScheduleShiftView['published']>

export type EffectiveShift = {
	row: ShiftRow
	id: string
	scopeId: string
	staffId: string | null
	positionId: string | null
	startsAt: number
	endsAt: number
	localDate: string
	timeZone: string
	unpaidBreakMinutes: number
	notes: string | null
	state: ShiftViewState
	/** A pending removal: the shift still runs until the week is published. */
	cancelPending: boolean
	/** The live published fields, when a pending edit differs from them. */
	published: PublishedFields | null
}

export function publishedFieldsOf(row: ShiftRow): PublishedFields {
	return {
		staffId: row.staffId,
		positionId: row.positionId,
		startsAt: row.startsAt,
		endsAt: row.endsAt,
		unpaidBreakMinutes: row.unpaidBreakMinutes,
		notes: row.notes,
	}
}

/** The shift as the manager sees it: published fields with a pending edit on top. */
export function effectiveShift(row: ShiftRow): EffectiveShift {
	const patch: ShiftDraftPatch | null =
		row.status === 'published' ? (row.draftPatch ?? null) : null
	const cancelPending = patch?.cancel === true
	const edited = patch !== null && Object.keys(patch).length > 0
	const base = {
		row,
		id: row.id,
		scopeId: row.scopeId,
		timeZone: row.timeZone,
		cancelPending,
	}
	if (row.status !== 'published' || !patch) {
		return {
			...base,
			staffId: row.staffId,
			positionId: row.positionId,
			startsAt: row.startsAt,
			endsAt: row.endsAt,
			localDate: row.localDate,
			unpaidBreakMinutes: row.unpaidBreakMinutes,
			notes: row.notes,
			state: row.status === 'draft' ? 'draft' : 'published',
			published: null,
		}
	}
	return {
		...base,
		staffId: patch.staffId !== undefined ? patch.staffId : row.staffId,
		positionId:
			patch.positionId !== undefined ? patch.positionId : row.positionId,
		startsAt: patch.startsAt ?? row.startsAt,
		endsAt: patch.endsAt ?? row.endsAt,
		localDate: patch.localDate ?? row.localDate,
		unpaidBreakMinutes: patch.unpaidBreakMinutes ?? row.unpaidBreakMinutes,
		notes: patch.notes !== undefined ? patch.notes : row.notes,
		state: cancelPending ? 'cancel_pending' : edited ? 'changed' : 'published',
		published: publishedFieldsOf(row),
	}
}

/** Shifts that count: not cancelled and not waiting to be removed. */
export function isLive(shift: EffectiveShift): boolean {
	return shift.row.status !== 'cancelled' && !shift.cancelPending
}

/**
 * The patch that turns the published shift into `next`, or `null` when `next`
 * equals what is published. Times travel together (start, end and date).
 */
export function diffToPatch(
	row: ShiftRow,
	next: {
		staffId: string | null
		positionId: string | null
		startsAt: number
		endsAt: number
		localDate: string
		unpaidBreakMinutes: number
		notes: string | null
	},
): ShiftDraftPatch | null {
	const patch: ShiftDraftPatch = {}
	if (next.staffId !== row.staffId) patch.staffId = next.staffId
	if (next.positionId !== row.positionId) patch.positionId = next.positionId
	if (next.startsAt !== row.startsAt || next.endsAt !== row.endsAt) {
		patch.startsAt = next.startsAt
		patch.endsAt = next.endsAt
		patch.localDate = next.localDate
	}
	if (next.unpaidBreakMinutes !== row.unpaidBreakMinutes) {
		patch.unpaidBreakMinutes = next.unpaidBreakMinutes
	}
	if (next.notes !== row.notes) patch.notes = next.notes
	return Object.keys(patch).length > 0 ? patch : null
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type JobWithPosition = { job: StaffJob; position: StaffPosition }

export type PersonRecord = {
	member: StaffMember
	/** Active assignments only. */
	assignments: StaffScopeAssignment[]
	scopeIds: Set<string>
	jobs: JobWithPosition[]
}

export async function loadPeople(
	db: StaffDb,
	staffIds: readonly string[],
): Promise<Map<string, PersonRecord>> {
	const people = new Map<string, PersonRecord>()
	const ids = [...new Set(staffIds)]
	for (const part of chunk(ids, ID_CHUNK)) {
		const members = await db
			.select()
			.from(staffMembers)
			.where(inArray(staffMembers.id, part))
		for (const member of members) {
			people.set(member.id, {
				member,
				assignments: [],
				scopeIds: new Set(),
				jobs: [],
			})
		}
		const assignments = await db
			.select()
			.from(staffScopeAssignments)
			.where(
				and(
					inArray(staffScopeAssignments.staffId, part),
					eq(staffScopeAssignments.active, true),
				),
			)
		for (const assignment of assignments) {
			const person = people.get(assignment.staffId)
			if (!person) continue
			person.assignments.push(assignment)
			person.scopeIds.add(assignment.scopeId)
		}
		const jobs = await db
			.select({ job: staffJobs, position: staffPositions })
			.from(staffJobs)
			.innerJoin(staffPositions, eq(staffPositions.id, staffJobs.positionId))
			.where(inArray(staffJobs.staffId, part))
		for (const row of jobs) {
			people.get(row.job.staffId)?.jobs.push(row)
		}
	}
	return people
}

/**
 * A `staff_id` predicate limiting a list to people a scoped token can see
 * (assigned at one of its scopes), optionally to one scope. Unrestricted
 * tokens without a scope filter get no predicate.
 */
export function visibleStaffWhere(
	db: StaffDb,
	scope: ScopeAccess,
	column: AnyColumn,
	scopeId?: string,
): SQL | undefined {
	if (scope.unrestricted && scopeId === undefined) return undefined
	const where = [eq(staffScopeAssignments.active, true)]
	if (scopeId !== undefined) {
		where.push(eq(staffScopeAssignments.scopeId, scopeId))
	}
	const scoped = scope.where(staffScopeAssignments.scopeId)
	if (scoped) where.push(scoped)
	// bounded: a subquery, never bound values
	return inArray(
		column,
		db
			.select({ id: staffScopeAssignments.staffId })
			.from(staffScopeAssignments)
			.where(and(...where)),
	)
}

/** Whether a person may be seen and scheduled by a token with this scope. */
export function personVisible(
	scope: ScopeAccess,
	person: Pick<PersonRecord, 'scopeIds'>,
): boolean {
	return scope.unrestricted || scope.allowsAny(person.scopeIds)
}

/**
 * The pay row that prices a shift: the one for its position at its scope in
 * force on its date; with no position (or none held) the person's primary pay
 * row there. `null` means the shift cannot be priced.
 */
export function pricingJob(
	jobs: readonly JobWithPosition[],
	scopeId: string,
	positionId: string | null,
	localDate: string,
): JobWithPosition | null {
	const inForce = jobs.filter(
		({ job }) =>
			job.scopeId === scopeId &&
			job.effectiveFrom <= localDate &&
			(job.effectiveTo === null || job.effectiveTo >= localDate),
	)
	if (positionId !== null) {
		const exact = inForce.find(({ job }) => job.positionId === positionId)
		if (exact) return exact
	}
	return inForce.find(({ job }) => job.isPrimary) ?? inForce[0] ?? null
}

export function personJobsForConflicts(
	jobs: readonly JobWithPosition[],
): PersonJob[] {
	return jobs.map(({ job }) => ({
		scopeId: job.scopeId,
		positionId: job.positionId,
		effectiveFrom: job.effectiveFrom,
		effectiveTo: job.effectiveTo,
	}))
}

export async function loadApprovedTimeOff(
	db: StaffDb,
	staffIds: readonly string[],
	fromDate: string,
	toDate: string,
): Promise<Map<string, TimeOffWindow[]>> {
	const out = new Map<string, TimeOffWindow[]>()
	for (const part of chunk([...new Set(staffIds)], ID_CHUNK)) {
		const rows = await db
			.select()
			.from(timeOffRequests)
			.where(
				and(
					inArray(timeOffRequests.staffId, part),
					eq(timeOffRequests.status, 'approved'),
					sql`${timeOffRequests.startDate} <= ${toDate}`,
					sql`${timeOffRequests.endDate} >= ${fromDate}`,
				),
			)
		for (const row of rows) {
			const list = out.get(row.staffId) ?? []
			list.push({
				id: row.id,
				startDate: row.startDate,
				endDate: row.endDate,
				allDay: row.allDay,
				startMinute: row.startMinute,
				endMinute: row.endMinute,
			})
			out.set(row.staffId, list)
		}
	}
	return out
}

export async function loadApprovedAvailability(
	db: StaffDb,
	staffIds: readonly string[],
): Promise<Map<string, AvailabilityWindow[]>> {
	const out = new Map<string, AvailabilityWindow[]>()
	for (const part of chunk([...new Set(staffIds)], ID_CHUNK)) {
		const rows = await db
			.select()
			.from(staffAvailability)
			.where(
				and(
					inArray(staffAvailability.staffId, part),
					eq(staffAvailability.status, 'approved'),
				),
			)
		for (const row of rows) {
			const list = out.get(row.staffId) ?? []
			list.push({
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
			})
			out.set(row.staffId, list)
		}
	}
	return out
}

/**
 * A person's shifts (never cancelled) that touch `[fromMs, toMs)` by their
 * stored times or by a pending edit's times, across every scope.
 */
export async function loadShiftsInRange(
	db: StaffDb,
	staffIds: readonly string[],
	fromMs: number,
	toMs: number,
): Promise<ShiftRow[]> {
	const out: ShiftRow[] = []
	const patchStart = sql<number>`json_extract(${shifts.draftPatch}, '$.startsAt')`
	const patchEnd = sql<number>`json_extract(${shifts.draftPatch}, '$.endsAt')`
	// One bound JSON array per predicate (two parameters in all), however
	// many people: a chunk of ids used in both predicates would double the
	// bound parameters of the statement past the Durable Object limit.
	const ids = [...new Set(staffIds)]
	if (ids.length > 0) {
		out.push(
			...(await db
				.select()
				.from(shifts)
				.where(
					and(
						or(
							inJsonList(shifts.staffId, ids),
							// A pending reassignment moves a shift onto these people.
							inJsonList(
								sql`json_extract(${shifts.draftPatch}, '$.staffId')`,
								ids,
							),
						),
						ne(shifts.status, 'cancelled'),
						or(
							and(lt(shifts.startsAt, toMs), gt(shifts.endsAt, fromMs)),
							and(
								isNotNull(shifts.draftPatch),
								lt(patchStart, toMs),
								gt(patchEnd, fromMs),
							),
						),
					),
				)),
		)
	}
	// A shift matched through both columns arrives once.
	return [...new Map(out.map((row) => [row.id, row])).values()]
}

export async function loadShiftsByIds(
	db: StaffDb,
	ids: readonly string[],
): Promise<ShiftRow[]> {
	const out: ShiftRow[] = []
	for (const part of chunk([...new Set(ids)], ID_CHUNK)) {
		out.push(
			...(await db.select().from(shifts).where(inArray(shifts.id, part))),
		)
	}
	return out
}

/** Rows of a scope whose stored or pending date falls in `[from, to]`. */
export async function loadScopeShifts(
	db: StaffDb,
	scopeId: string,
	fromDate: string,
	toDate: string,
): Promise<ShiftRow[]> {
	const patchDate = sql<string>`json_extract(${shifts.draftPatch}, '$.localDate')`
	return db
		.select()
		.from(shifts)
		.where(
			and(
				eq(shifts.scopeId, scopeId),
				ne(shifts.status, 'cancelled'),
				or(
					and(
						sql`${shifts.localDate} >= ${fromDate}`,
						sql`${shifts.localDate} <= ${toDate}`,
						isNull(sql`json_extract(${shifts.draftPatch}, '$.localDate')`),
					),
					and(
						isNotNull(shifts.draftPatch),
						sql`${patchDate} >= ${fromDate}`,
						sql`${patchDate} <= ${toDate}`,
					),
				),
			),
		)
}

// ---------------------------------------------------------------------------
// Analysis: warnings, overtime and cost for a set of shifts
// ---------------------------------------------------------------------------

export type AnalyzedShift = ConflictShift & {
	rateMinor: number | null
	currency: string | null
	overtimeExempt: boolean
	staffId: string
}

export type PersonAnalysis = {
	staffId: string
	person: PersonRecord | null
	/** Every live shift of the person around the targets, across scopes. */
	shifts: AnalyzedShift[]
	conflicts: ScheduleConflict[]
	estimates: Map<string, ShiftEstimate>
}

export function toAnalyzed(
	shift: EffectiveShift,
	person: PersonRecord | null,
): AnalyzedShift {
	const priced = person
		? pricingJob(person.jobs, shift.scopeId, shift.positionId, shift.localDate)
		: null
	return {
		id: shift.id,
		staffId: shift.staffId as string,
		scopeId: shift.scopeId,
		positionId: shift.positionId,
		startsAt: shift.startsAt,
		endsAt: shift.endsAt,
		localDate: shift.localDate,
		timeZone: shift.timeZone,
		unpaidBreakMinutes: shift.unpaidBreakMinutes,
		rateMinor: priced
			? (priced.job.rateMinor ?? priced.position.defaultRateMinor ?? null)
			: null,
		currency: priced ? priced.job.currency : null,
		overtimeExempt: priced ? priced.job.overtimeExempt : false,
	}
}

/** The instants around a set of shifts that hold every workweek they touch. */
export function neighbourhoodBounds(
	targets: readonly EffectiveShift[],
	frame: ScopeFrame,
): { fromMs: number; toMs: number } {
	let first = Infinity
	let last = -Infinity
	let firstDate = ''
	let lastDate = ''
	for (const shift of targets) {
		if (shift.startsAt < first) {
			first = shift.startsAt
			firstDate = shift.localDate
		}
		if (shift.endsAt > last) {
			last = shift.endsAt
			lastDate = shift.localDate
		}
	}
	const from = startOfLocalDay(
		addDays(weekStartFor(firstDate, frame.weekStartsOn), -1),
		frame.timeZone,
	)
	const to = startOfLocalDay(
		addDays(weekStartFor(lastDate, frame.weekStartsOn), 9),
		frame.timeZone,
	)
	return { fromMs: from, toMs: Math.max(to, last + DAY_MS) }
}

/** The instants around one workweek that hold the shifts it can interact with. */
export function weekNeighbourhood(
	weekStart: string,
	frame: ScopeFrame,
): { fromMs: number; toMs: number } {
	return {
		fromMs: startOfLocalDay(addDays(weekStart, -1), frame.timeZone),
		toMs: startOfLocalDay(addDays(weekStart, 9), frame.timeZone),
	}
}

export function conflictContextOf(
	person: PersonRecord | null,
	timeOff: readonly TimeOffWindow[],
	availability: readonly AvailabilityWindow[],
): PersonConflictContext {
	return {
		status: person?.member.status ?? 'terminated',
		assignedScopeIds: person?.scopeIds ?? new Set(),
		jobs: person ? personJobsForConflicts(person.jobs) : [],
		timeOff,
		availability,
	}
}

/**
 * Judges every assigned shift among `targets` (all at one scope, `frame`).
 * Each person's other shifts, at every scope the token can see, take part in
 * overlap, rest and overtime but are not reported on.
 */
export async function analyzePeople(
	ctx: ScheduleContext,
	frame: ScopeFrame,
	targets: readonly EffectiveShift[],
	people?: Map<string, PersonRecord>,
): Promise<Map<string, PersonAnalysis>> {
	const analyses = new Map<string, PersonAnalysis>()
	const assigned = targets.filter(
		(shift) => shift.staffId !== null && isLive(shift),
	)
	if (assigned.length === 0) return analyses

	const staffIds = [...new Set(assigned.map((s) => s.staffId as string))]
	const records = people ?? (await loadPeople(ctx.db, staffIds))
	const bounds = neighbourhoodBounds(assigned, frame)
	const around = await loadShiftsInRange(
		ctx.db,
		staffIds,
		bounds.fromMs,
		bounds.toMs,
	)
	const dates = assigned.map((s) => s.localDate).sort()
	const fromDate = addDays(weekStartFor(dates[0]!, frame.weekStartsOn), -7)
	const toDate = addDays(
		weekStartFor(dates[dates.length - 1]!, frame.weekStartsOn),
		14,
	)
	const timeOff = await loadApprovedTimeOff(ctx.db, staffIds, fromDate, toDate)
	const availability = await loadApprovedAvailability(ctx.db, staffIds)

	const targetIds = new Set(assigned.map((s) => s.id))
	for (const staffId of staffIds) {
		const person = records.get(staffId) ?? null
		const mine = new Map<string, EffectiveShift>()
		for (const row of around) {
			const effective = effectiveShift(row)
			if (effective.staffId !== staffId || !isLive(effective)) continue
			// Shifts at scopes the token cannot see stay out of view.
			if (
				effective.scopeId !== frame.scopeId &&
				!ctx.scope.allows(effective.scopeId)
			) {
				continue
			}
			mine.set(effective.id, effective)
		}
		for (const target of assigned) {
			if (target.staffId === staffId) mine.set(target.id, target)
		}
		const analyzed = [...mine.values()].map((s) => toAnalyzed(s, person))
		const only = new Set([...mine.keys()].filter((id) => targetIds.has(id)))
		const conflicts = detectPersonConflicts({
			shifts: analyzed,
			person: conflictContextOf(
				person,
				timeOff.get(staffId) ?? [],
				availability.get(staffId) ?? [],
			),
			rules: frame.rules,
			minRestMinutes: frame.minRestMinutes,
			only,
		})
		analyses.set(staffId, {
			staffId,
			person,
			shifts: analyzed,
			conflicts,
			estimates: estimatePerShift(analyzed, frame.rules, frame.timeZone),
		})
	}
	return analyses
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function costOf(estimate: ShiftEstimate | undefined): {
	costMinor: number | null
	currency: string | null
} {
	if (!estimate) return { costMinor: null, currency: null }
	const currencies = Object.keys(estimate.costUnitsByCurrency)
	if (currencies.length === 0) return { costMinor: null, currency: null }
	// A shift is priced from one pay row, so it has one currency.
	const currency = currencies.sort()[0]!
	return {
		costMinor: costUnitsToMinor(estimate.costUnitsByCurrency[currency]!),
		currency,
	}
}

export function toShiftView(
	shift: EffectiveShift,
	analysis: PersonAnalysis | undefined,
	money: MoneyAccess,
): ScheduleShiftView {
	const conflicts = (analysis?.conflicts ?? []).filter(
		(c) => c.shiftId === shift.id,
	)
	const view: ScheduleShiftView = {
		id: shift.id,
		scopeId: shift.scopeId,
		staffId: shift.staffId,
		positionId: shift.positionId,
		startsAt: shift.startsAt,
		endsAt: shift.endsAt,
		localDate: shift.localDate,
		timeZone: shift.timeZone,
		unpaidBreakMinutes: shift.unpaidBreakMinutes,
		paidMinutes: paidMinutesOf(shift),
		notes: shift.notes,
		state: shift.state,
		published: shift.published,
		version: shift.row.version,
		conflicts,
	}
	if (money.person) {
		const cost = costOf(analysis?.estimates.get(shift.id))
		view.costMinor = cost.costMinor
		view.currency = cost.currency
	}
	return view
}

/** The manager's view of shifts, in the order given. */
export async function buildShiftViews(
	ctx: ScheduleContext,
	frames: FrameCache,
	rows: readonly ShiftRow[],
	money: MoneyAccess,
): Promise<ScheduleShiftView[]> {
	const effective = rows.map(effectiveShift)
	const byScope = new Map<string, EffectiveShift[]>()
	for (const shift of effective) {
		const list = byScope.get(shift.scopeId) ?? []
		list.push(shift)
		byScope.set(shift.scopeId, list)
	}
	const analyses = new Map<string, Map<string, PersonAnalysis>>()
	for (const [scopeId, group] of byScope) {
		const frame = await frames.get(scopeId, group[0]!.timeZone)
		if (!frame) continue
		analyses.set(scopeId, await analyzePeople(ctx, frame, group))
	}
	return effective.map((shift) =>
		toShiftView(
			shift,
			shift.staffId
				? analyses.get(shift.scopeId)?.get(shift.staffId)
				: undefined,
			money,
		),
	)
}

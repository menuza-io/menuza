import {
	and,
	between,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
} from 'drizzle-orm'
import {
	type ReportDefinition,
	type ReportRecord,
	type ReportSubject,
	ON_TIME_GRACE_MINUTES,
	referencedFieldIds,
	resolveTimeframeRange,
	timeframeLoadWindow,
} from '@repo/reports'
import {
	addDays,
	businessDateOf,
	datesInRange,
	STAFFING_PERMISSIONS as P,
	type LaborSummaryView,
	zonedLocalToUtc,
	parseDate,
} from '@repo/staffing'
import {
	hiringApplications,
	shifts,
	staffMembers,
	staffPositions,
	timeEntries,
	type HiringApplicationRow,
	type ShiftRow,
	type TenantDatabase,
} from '@repo/tenant-db'
import { getScopeFacts } from '../lib/scope-context.ts'
import { scopeToScopes, type StaffAuth } from '../lib/staff-auth.ts'
import {
	bucketBusinessDate,
	businessRangeSeconds,
	loadOrderBuckets,
} from './labor-data.ts'
import { buildLaborSummary, type LaborContext } from './labor-service.ts'
import { writeStaffAudit } from './staff-audit.ts'
import {
	buildLiveCards,
	cardPayMinor,
	moneyAccess,
	selectCardRows,
} from './timesheet-shared.ts'
import { FrameCache } from './schedule-shared.ts'

/**
 * Report records for the staff subjects: `time_entries`, `shifts`,
 * `labor_daily` and `applications`. They read the regional tenant database
 * only, apply the token's scope limit on every query, and build their
 * figures with the same functions the timesheets and the labor summary use
 * (`buildLiveCards`, `computeLaborSummary`), so a report can never disagree
 * with the screen it summarises.
 *
 * Nothing here checks a feature flag or a role: the App mints a token that
 * lists a staff subject only when the flag is on and the person holds the
 * permission, and the route checks the token before calling in.
 */

/** Most time cards one report reads; the most recent are kept. */
export const TIME_ENTRY_REPORT_MAX_ROWS = 10_000
/** Most shifts one report reads; the most recent are kept. */
export const SHIFT_REPORT_MAX_ROWS = 20_000
/** Longest span of days one daily labor report builds per scope. */
export const LABOR_REPORT_MAX_DAYS = 366

export type LoadedRecords = { records: ReportRecord[]; truncated: boolean }

export type StaffReportContext = {
	db: TenantDatabase
	auth: StaffAuth
	/** The server's clock in epoch milliseconds. */
	now: number
}

/**
 * The staffing grants a verified analytics token stands for. The reports token
 * lists the subjects the App decided to allow; this is what they mean to the
 * shared staffing services.
 */
export function staffAuthFromSubjects(input: {
	orgId: string
	userId: string
	subjects: readonly string[]
	scopeIds: readonly string[] | null
}): StaffAuth {
	const grants = new Set<StaffAuth['grants'][number]>()
	const has = (subject: string) => input.subjects.includes(subject)
	if (has('time_entries')) {
		grants.add(P.READ_TIMESHEET)
		grants.add(P.READ_STAFF)
	}
	if (has('shifts')) {
		grants.add(P.READ_SCHEDULE)
		grants.add(P.READ_STAFF)
	}
	if (has('labor_daily')) grants.add(P.READ_LABOR)
	if (has('staff_pay')) grants.add(P.READ_STAFF_PAY)
	if (has('applications')) grants.add(P.READ_HIRING)
	return {
		orgId: input.orgId,
		userId: input.userId,
		scope: 'labor',
		grants: [...grants],
		scopeIds: input.scopeIds,
		impersonated: false,
	}
}

/** The local dates a loader must read to cover a timeframe in any zone. */
function loadDates(definition: ReportDefinition, now: number) {
	const window = timeframeLoadWindow(
		definition.timeframe.preset,
		new Date(now),
		definition.timeframe,
	)
	return {
		startMs: window.start?.getTime() ?? null,
		endMs: window.end.getTime(),
		// A day either side covers every zone's local date.
		fromDate: window.start
			? addDays(window.start.toISOString().slice(0, 10), -1)
			: null,
		toDate: addDays(window.end.toISOString().slice(0, 10), 1),
	}
}

class ScopeNames {
	private readonly facts = new Map<
		string,
		Promise<{ name: string; timeZone: string | null }>
	>()
	constructor(
		private readonly orgId: string,
		private readonly now: number,
	) {}
	get(scopeId: string, fallbackTimeZone?: string) {
		let entry = this.facts.get(scopeId)
		if (!entry) {
			entry = getScopeFacts(this.orgId, scopeId, this.now).then((facts) => ({
				name: facts?.name || scopeId,
				timeZone: facts?.timeZone ?? null,
			}))
			this.facts.set(scopeId, entry)
		}
		return entry.then((value) => ({
			name: value.name,
			timeZone: value.timeZone ?? fallbackTimeZone ?? 'UTC',
		}))
	}
}

const personName = (first: string, last: string) => `${first} ${last}`.trim()

// ---------------------------------------------------------------------------
// Time cards
// ---------------------------------------------------------------------------

export type ShiftStart = {
	id: string
	staffId: string | null
	startsAt: number
}

/**
 * Whether a person arrived on time for the shift they were scheduled on:
 * the shift the card is linked to, else the shift of the same person that
 * starts closest to the clock-in on the card's date. No shift means the card
 * was unscheduled. Early arrivals are on time.
 */
export function arrivalOf(
	card: {
		shiftId: string | null
		staffId: string
		localDate: string
		clockInAt: number
	},
	index: {
		byId: ReadonlyMap<string, ShiftStart>
		byStaffDate: ReadonlyMap<string, readonly ShiftStart[]>
	},
): { arrival: 'on_time' | 'late' | 'unscheduled'; lateMinutes: number | null } {
	let shift: ShiftStart | undefined = card.shiftId
		? index.byId.get(card.shiftId)
		: undefined
	if (!shift) {
		const candidates = index.byStaffDate.get(
			`${card.staffId}|${card.localDate}`,
		)
		for (const candidate of candidates ?? []) {
			if (
				!shift ||
				Math.abs(candidate.startsAt - card.clockInAt) <
					Math.abs(shift.startsAt - card.clockInAt)
			) {
				shift = candidate
			}
		}
	}
	if (!shift) return { arrival: 'unscheduled', lateMinutes: null }
	const late = Math.round((card.clockInAt - shift.startsAt) / 60_000)
	return late > ON_TIME_GRACE_MINUTES
		? { arrival: 'late', lateMinutes: late }
		: { arrival: 'on_time', lateMinutes: null }
}

async function loadShiftIndex(
	db: TenantDatabase,
	scopeWhere: ReturnType<typeof scopeToScopes>,
	staffIds: readonly string[],
	fromDate: string,
	toDate: string,
) {
	const byId = new Map<string, ShiftStart>()
	const byStaffDate = new Map<string, ShiftStart[]>()
	for (let i = 0; i < staffIds.length; i += 400) {
		const rows = await db
			.select({
				id: shifts.id,
				staffId: shifts.staffId,
				startsAt: shifts.startsAt,
				localDate: shifts.localDate,
			})
			.from(shifts)
			.where(
				and(
					inArray(shifts.staffId, staffIds.slice(i, i + 400)),
					eq(shifts.status, 'published'),
					isNull(shifts.cancelledAt),
					between(shifts.localDate, fromDate, toDate),
					scopeWhere.where(shifts.scopeId),
				),
			)
		for (const row of rows) {
			const shift = { id: row.id, staffId: row.staffId, startsAt: row.startsAt }
			byId.set(row.id, shift)
			if (!row.staffId) continue
			const key = `${row.staffId}|${row.localDate}`
			const list = byStaffDate.get(key) ?? []
			list.push(shift)
			byStaffDate.set(key, list)
		}
	}
	return { byId, byStaffDate }
}

export async function loadTimeEntryRecords(
	ctx: StaffReportContext,
	definition: ReportDefinition,
	maxRows = TIME_ENTRY_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	const scope = scopeToScopes(ctx.auth)
	const dates = loadDates(definition, ctx.now)
	const rows = await selectCardRows(
		ctx.db,
		and(
			dates.fromDate
				? between(timeEntries.localDate, dates.fromDate, dates.toDate)
				: lte(timeEntries.localDate, dates.toDate),
			scope.where(timeEntries.scopeId),
		),
		maxRows + 1,
		'desc',
	)
	const truncated = rows.length > maxRows
	const kept = truncated ? rows.slice(0, maxRows) : rows
	if (kept.length === 0) return { records: [], truncated }

	const localDates = kept.map((row) => row.entry.localDate).sort()
	const first = localDates[0]!
	const last = localDates.at(-1)!
	const lives = await buildLiveCards({ db: ctx.db, now: ctx.now }, kept, {
		fromDate: first,
		toDate: last,
	})
	const money = moneyAccess(ctx.auth)
	const shiftIndex = await loadShiftIndex(
		ctx.db,
		scope,
		[...new Set(kept.map((row) => row.entry.staffId))],
		addDays(first, -1),
		addDays(last, 1),
	)
	const names = new ScopeNames(ctx.auth.orgId, ctx.now)
	const records: ReportRecord[] = []
	for (const live of lives) {
		const { entry, figures } = live
		const scope = await names.get(entry.scopeId, entry.timeZone)
		const arrival = arrivalOf(entry, shiftIndex)
		const record: ReportRecord = {
			clockInAt: new Date(entry.clockInAt),
			clockOutAt: entry.clockOutAt === null ? null : new Date(entry.clockOutAt),
			employee: personName(live.staff.firstName, live.staff.lastName),
			position: live.positionName ?? '',
			scope: scope.name,
			status: live.status,
			arrival: arrival.arrival,
			lateMinutes: arrival.lateMinutes,
			edited: live.issues.includes('edited'),
			paidMinutes: figures.paidMinutes,
			regularMinutes: figures.regularMinutes,
			overtimeMinutes: figures.overtimeMinutes + figures.doubleTimeMinutes,
			breakMinutes: figures.unpaidBreakMinutes,
			// Cards close in the scope's own zone: a day is the scope's day.
			timeZone: entry.timeZone,
		}
		// Wages are left off the record without the pay grant, whatever the
		// definition asks for; the route refuses it as well.
		if (money.person) {
			const pay = cardPayMinor(figures)
			record.cost = pay === null ? null : pay / 100
			record.currency = (entry.currency ?? '').toUpperCase()
		}
		records.push(record)
	}
	return { records, truncated }
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export function shiftRecord(
	row: Pick<
		ShiftRow,
		| 'startsAt'
		| 'endsAt'
		| 'unpaidBreakMinutes'
		| 'staffId'
		| 'status'
		| 'timeZone'
	>,
	names: { employee: string; position: string; scope: string },
): ReportRecord {
	return {
		startsAt: new Date(row.startsAt),
		endsAt: new Date(row.endsAt),
		employee: names.employee,
		position: names.position,
		scope: names.scope,
		status: row.status === 'published' ? 'published' : 'draft',
		openShift: row.staffId === null,
		scheduledMinutes: Math.max(
			0,
			Math.round((row.endsAt - row.startsAt) / 60_000) - row.unpaidBreakMinutes,
		),
		timeZone: row.timeZone,
	}
}

export async function loadShiftRecords(
	ctx: StaffReportContext,
	definition: ReportDefinition,
	maxRows = SHIFT_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	const scope = scopeToScopes(ctx.auth)
	const dates = loadDates(definition, ctx.now)
	// Shifts are planned ahead, so a "last 30 days" report may still want the
	// whole window; the end is not capped at now here (the engine does that).
	const rows = await ctx.db
		.select({
			shift: shifts,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
			positionName: staffPositions.name,
		})
		.from(shifts)
		.leftJoin(staffMembers, eq(staffMembers.id, shifts.staffId))
		.leftJoin(staffPositions, eq(staffPositions.id, shifts.positionId))
		.where(
			and(
				isNull(shifts.cancelledAt),
				dates.fromDate
					? between(shifts.localDate, dates.fromDate, dates.toDate)
					: lte(shifts.localDate, dates.toDate),
				scope.where(shifts.scopeId),
			),
		)
		.orderBy(shifts.startsAt)
		.limit(maxRows + 1)
	const truncated = rows.length > maxRows
	const kept = truncated ? rows.slice(0, maxRows) : rows
	const names = new ScopeNames(ctx.auth.orgId, ctx.now)
	const records: ReportRecord[] = []
	for (const row of kept) {
		const scope = await names.get(row.shift.scopeId, row.shift.timeZone)
		records.push(
			shiftRecord(row.shift, {
				employee: row.firstName
					? personName(row.firstName, row.lastName ?? '')
					: '',
				position: row.positionName ?? '',
				scope: scope.name,
			}),
		)
	}
	return { records, truncated }
}

// ---------------------------------------------------------------------------
// Daily labor
// ---------------------------------------------------------------------------

export type DailyScheduled = { minutes: number; shifts: number }

/**
 * One record per scope and business day from a labor summary, the
 * scheduled hours of that scope, and its order tips. Built from the summary
 * the Labor screen shows, so a report and the screen agree to the cent.
 *
 * Money stays in one currency per record. The currency is the one the day's
 * sales are in (else the wage currency); wages in another currency are never
 * converted, so they leave `laborCost` empty and set `currencyMismatch`, and
 * the engine leaves that day out of every share and counts it as excluded.
 * Wages count only in a currency that has wages somewhere in the range, the
 * same rule as the screen's share.
 */
export function laborDailyRecords(input: {
	scopeName: string
	summary: LaborSummaryView
	scheduled: ReadonlyMap<string, DailyScheduled>
	/** Order tips in minor units by `date|currency`. */
	tips?: ReadonlyMap<string, number>
	workdayStartMinute?: number
}): ReportRecord[] {
	const { summary } = input
	const costCurrencies = new Set<string>()
	for (const day of summary.days) {
		for (const row of day.money) {
			if (row.costMinor > 0) costCurrencies.add(row.currency)
		}
	}
	const records: ReportRecord[] = []
	for (const day of summary.days) {
		const scheduled = input.scheduled.get(day.date)
		const priced = day.money.filter(
			(row) => row.costMinor > 0 || (row.salesMinor ?? 0) > 0,
		)
		const withSales = day.money.find((row) => (row.salesMinor ?? 0) > 0)
		const primary = withSales ?? day.money.find((row) => row.costMinor > 0)
		const active =
			day.cards > 0 ||
			day.paidMinutes > 0 ||
			(scheduled?.shifts ?? 0) > 0 ||
			priced.length > 0
		if (!active) continue

		const currency = primary?.currency ?? day.money[0]?.currency ?? ''
		const wagesHere = primary
			? primary.costMinor > 0 || costCurrencies.has(primary.currency)
			: false
		const salesMinor = day.hasSales
			? (primary?.salesMinor ?? (day.money.length === 0 ? 0 : null))
			: null
		const mismatch = priced.length > 1
		const scheduledMinutes = scheduled?.minutes ?? 0
		const tipMinor = input.tips?.get(`${day.date}|${currency}`) ?? 0
		records.push({
			date: new Date(
				zonedLocalToUtc(
					parseDate(day.date).year,
					parseDate(day.date).month,
					parseDate(day.date).day,
					0,
					0,
					summary.timeZone,
				),
			),
			scope: input.scopeName,
			salesSource: summary.salesSource,
			paidMinutes: day.paidMinutes,
			overtimeMinutes: day.overtimeMinutes,
			scheduledMinutes,
			varianceMinutes: day.paidMinutes - scheduledMinutes,
			shifts: scheduled?.shifts ?? 0,
			clockIns: day.cards,
			people: day.people,
			laborCost:
				wagesHere && primary && !mismatch ? primary.costMinor / 100 : null,
			sales: salesMinor === null ? null : salesMinor / 100,
			tips: tipMinor / 100,
			currencyMismatch: mismatch,
			currency,
			timeZone: summary.timeZone,
		})
	}
	return records
}

/** The dates a scope's labor report covers, clamped to a year. */
export function laborReportRange(
	definition: ReportDefinition,
	now: number,
	timeZone: string,
	workdayStartMinute: number,
): { from: string; to: string; clamped: boolean } {
	const range = resolveTimeframeRange(
		definition.timeframe.preset,
		new Date(now),
		definition.timeframe,
		timeZone,
	)
	const to = businessDateOf(range.end.getTime(), timeZone, workdayStartMinute)
	let from = range.start
		? businessDateOf(range.start.getTime(), timeZone, workdayStartMinute)
		: addDays(to, -(LABOR_REPORT_MAX_DAYS - 1))
	let clamped = false
	if (datesInRange(from, to).length > LABOR_REPORT_MAX_DAYS || from > to) {
		from = addDays(to, -(LABOR_REPORT_MAX_DAYS - 1))
		clamped = true
	}
	return { from, to, clamped }
}

async function laborScopeIds(ctx: StaffReportContext): Promise<string[]> {
	const scope = scopeToScopes(ctx.auth)
	if (!scope.unrestricted) return [...(ctx.auth.scopeIds ?? [])].sort()
	const [fromCards, fromShifts] = await Promise.all([
		ctx.db.selectDistinct({ scopeId: timeEntries.scopeId }).from(timeEntries),
		ctx.db.selectDistinct({ scopeId: shifts.scopeId }).from(shifts),
	])
	return [
		...new Set([...fromCards, ...fromShifts].map((row) => row.scopeId)),
	].sort()
}

async function loadScheduled(
	db: TenantDatabase,
	scopeId: string,
	from: string,
	to: string,
) {
	const rows = await db
		.select({
			localDate: shifts.localDate,
			startsAt: shifts.startsAt,
			endsAt: shifts.endsAt,
			unpaidBreakMinutes: shifts.unpaidBreakMinutes,
		})
		.from(shifts)
		.where(
			and(
				eq(shifts.scopeId, scopeId),
				eq(shifts.status, 'published'),
				isNull(shifts.cancelledAt),
				isNotNull(shifts.staffId),
				between(shifts.localDate, from, to),
			),
		)
	const byDate = new Map<string, DailyScheduled>()
	for (const row of rows) {
		const entry = byDate.get(row.localDate) ?? { minutes: 0, shifts: 0 }
		entry.minutes += Math.max(
			0,
			Math.round((row.endsAt - row.startsAt) / 60_000) - row.unpaidBreakMinutes,
		)
		entry.shifts += 1
		byDate.set(row.localDate, entry)
	}
	return byDate
}

async function loadOrderTips(
	ctx: StaffReportContext,
	scopeId: string,
	range: { from: string; to: string },
	timeZone: string,
	workdayStartMinute: number,
) {
	const { fromSeconds, toSeconds } = businessRangeSeconds(
		range.from,
		range.to,
		timeZone,
		workdayStartMinute,
	)
	const buckets = await loadOrderBuckets(
		ctx.db,
		scopeId,
		fromSeconds,
		toSeconds,
		workdayStartMinute,
	)
	const tips = new Map<string, number>()
	for (const bucket of buckets) {
		const date = bucketBusinessDate(bucket.bucket, timeZone, workdayStartMinute)
		if (date < range.from || date > range.to) continue
		const key = `${date}|${bucket.currency}`
		tips.set(key, (tips.get(key) ?? 0) + bucket.tipMinor)
	}
	return tips
}

export async function loadLaborDailyRecords(
	ctx: StaffReportContext,
	subject: ReportSubject,
	definition: ReportDefinition,
): Promise<LoadedRecords> {
	const scope = scopeToScopes(ctx.auth)
	const wantsTips = referencedFieldIds(subject, definition).has('tips')
	const scopeIds = await laborScopeIds(ctx)
	const frames = new FrameCache({
		db: ctx.db,
		auth: ctx.auth,
		now: ctx.now,
	})
	const laborCtx: LaborContext = {
		db: ctx.db,
		auth: ctx.auth,
		scope,
		ipHash: null,
		now: ctx.now,
	}
	const names = new ScopeNames(ctx.auth.orgId, ctx.now)
	const records: ReportRecord[] = []
	let truncated = false
	for (const scopeId of scopeIds) {
		if (!scope.allows(scopeId)) continue
		const frame = await frames.get(scopeId)
		if (!frame) continue
		const workdayStartMinute = frame.rules.workdayStartMinute
		const range = laborReportRange(
			definition,
			ctx.now,
			frame.timeZone,
			workdayStartMinute,
		)
		const built = await buildLaborSummary(laborCtx, {
			scopeId,
			from: range.from,
			to: range.to,
		})
		if (!built.ok) continue
		if (built.value.truncated || range.clamped) truncated = true
		const facts = await names.get(scopeId, frame.timeZone)
		records.push(
			...laborDailyRecords({
				scopeName: facts.name,
				summary: built.value,
				scheduled: await loadScheduled(ctx.db, scopeId, range.from, range.to),
				tips: wantsTips
					? await loadOrderTips(
							ctx,
							scopeId,
							range,
							frame.timeZone,
							workdayStartMinute,
						)
					: undefined,
				workdayStartMinute,
			}),
		)
	}
	return { records, truncated }
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

/** Most applications one report reads; the most recent are kept. */
export const APPLICATION_REPORT_MAX_ROWS = 10_000

/**
 * One record per application: when it came in, for which job and where, its
 * stage, where the applicant found the job, and how many days it took to reach
 * a decision. No name, contact detail or answer is read: the funnel is about
 * the pipeline, not the people. The token's scope limit applies, so a
 * manager limited to some scopes never counts another scope's
 * applicants (and organization-wide jobs count only for all-scope tokens).
 */
export function applicationRecord(
	row: Pick<
		HiringApplicationRow,
		| 'createdAt'
		| 'positionName'
		| 'postingTitle'
		| 'stage'
		| 'source'
		| 'hiredAt'
		| 'declinedAt'
	>,
	names: { scope: string; timeZone: string },
): ReportRecord {
	const decidedAt =
		row.stage === 'hired'
			? row.hiredAt
			: row.stage === 'declined'
				? row.declinedAt
				: null
	return {
		appliedAt: new Date(row.createdAt),
		position: row.positionName || row.postingTitle,
		scope: names.scope,
		stage: row.stage,
		source: row.source,
		daysToDecision:
			decidedAt === null
				? null
				: Math.max(0, Math.round((decidedAt - row.createdAt) / 86_400_000)),
		timeZone: names.timeZone,
	}
}

export async function loadApplicationRecords(
	ctx: StaffReportContext,
	definition: ReportDefinition,
	maxRows = APPLICATION_REPORT_MAX_ROWS,
): Promise<LoadedRecords> {
	const scope = scopeToScopes(ctx.auth)
	const dates = loadDates(definition, ctx.now)
	const rows = await ctx.db
		.select({
			createdAt: hiringApplications.createdAt,
			positionName: hiringApplications.positionName,
			postingTitle: hiringApplications.postingTitle,
			stage: hiringApplications.stage,
			source: hiringApplications.source,
			hiredAt: hiringApplications.hiredAt,
			declinedAt: hiringApplications.declinedAt,
			scopeId: hiringApplications.scopeId,
		})
		.from(hiringApplications)
		.where(
			and(
				dates.startMs !== null
					? gte(hiringApplications.createdAt, dates.startMs)
					: undefined,
				lte(hiringApplications.createdAt, dates.endMs),
				scope.unrestricted
					? undefined
					: scope.whereAnyOf(
							hiringApplications.scopeId,
							hiringApplications.interestedScopeIds,
						),
			),
		)
		.orderBy(desc(hiringApplications.createdAt))
		.limit(maxRows + 1)
	const truncated = rows.length > maxRows
	const kept = truncated ? rows.slice(0, maxRows) : rows
	const names = new ScopeNames(ctx.auth.orgId, ctx.now)
	const records: ReportRecord[] = []
	for (const row of kept) {
		const facts = row.scopeId
			? await names.get(row.scopeId)
			: { name: '', timeZone: 'UTC' }
		records.push(
			applicationRecord(row, {
				scope: facts.name,
				timeZone: facts.timeZone,
			}),
		)
	}
	return { records, truncated }
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * One audit row per report run over staff data, written before the answer
 * leaves: a run that cannot be recorded does not disclose anything. The row
 * carries the subject and counts, never names or amounts.
 */
export async function auditStaffReportRun(
	ctx: StaffReportContext,
	input: {
		subject: string
		rows: number
		readsPay: boolean
		ipHash?: string | null
	},
) {
	await writeStaffAudit(ctx.db, ctx.auth, input.ipHash ?? null, {
		action: 'report.run',
		entityType: 'report',
		sensitivity: input.readsPay ? 'pay' : 'standard',
		changes: { subject: input.subject, rows: input.rows },
	})
}

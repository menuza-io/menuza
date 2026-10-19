import { and, asc, between, desc, eq, inArray, isNull } from 'drizzle-orm'
import {
	addDays,
	computeEntryFigures,
	costUnitsToMinor,
	type EntryFigures,
	hasBlockingIssue,
	type LaborPolicyView,
	laborPolicyToRules,
	needsReview,
	type TimesheetBreak,
	type TimesheetCard,
	type TimesheetFiltersEcho,
	type TimesheetLabor,
	type TimesheetMinutes,
	type TimesheetPerson,
	type TimesheetPersonMoney,
	type TimesheetStatus,
	type TimesheetTotals,
	type CacheContext,
	type EntryIssueCode,
	STAFFING_PERMISSIONS as P,
} from '@repo/staffing'
import {
	staffMembers,
	staffPositions,
	timeEntries,
	type TimeBreakRow,
	type TimeEntry,
} from '@repo/tenant-db'
import {
	hasGrant,
	type ScopeAccess,
	type StaffAuth,
} from '../lib/staff-auth.ts'
import { resolvePolicy } from './labor-policy-service.ts'
import { type StaffDb } from './staff-audit.ts'
import { entryToInput, issuesForEntry, loadBreaks } from './time-entry-calc.ts'
import { queryInChunks } from '../lib/chunked-in.ts'

/**
 * What the timesheet views and writes share: who may see money, the live card
 * pipeline (issues, status and figures recomputed through the shared time math
 * at read time, never trusted from a stale cache), and the failure vocabulary.
 */

export type TimesheetContext = {
	db: StaffDb
	auth: StaffAuth
	scope: ScopeAccess
	ipHash: string | null
	/** Injectable clock: the server's "now". */
	now: number
}

export type TimesheetFailure = {
	ok: false
	status: 400 | 403 | 404 | 409 | 422
	error: string
	extra?: Record<string, unknown>
}
export type TimesheetResult<T> = { ok: true; value: T } | TimesheetFailure

export const ok = <T>(value: T): TimesheetResult<T> => ({ ok: true, value })
export const fail = (
	status: TimesheetFailure['status'],
	error: string,
	extra?: Record<string, unknown>,
): TimesheetFailure => ({
	ok: false,
	status,
	error,
	...(extra ? { extra } : {}),
})

// ---------------------------------------------------------------------------
// Money access
// ---------------------------------------------------------------------------

export type MoneyAccess = {
	/** Per-person rates, pay and tips: `read:staff_pay:any`. */
	person: boolean
	/** Aggregate labor cost: `read:labor:any`, or anyone who can see each wage. */
	labor: boolean
}

/**
 * Money is omitted, not hidden: without the grant the keys are absent from the
 * response. Individual figures need the pay grant; an aggregate needs the labor
 * grant (or the pay grant, since the person could add the wages up anyway).
 */
export function moneyAccess(
	auth: Pick<StaffAuth, 'grants' | 'impersonated'>,
): MoneyAccess {
	// An impersonated (support) session never sees wages, whatever its token
	// carries: the token layer already strips the pay grants, and this keeps the
	// aggregate labor grant from slipping through.
	if (auth.impersonated) return { person: false, labor: false }
	const person = hasGrant(auth, P.READ_STAFF_PAY)
	return { person, labor: person || hasGrant(auth, P.READ_LABOR) }
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
/** Overtime is per workweek, so figures need the cards around the range. */
export const FIGURE_NEIGHBOURHOOD_DAYS = 8
/** Most cards one view returns; a bigger range asks to be narrowed. */
export const MAX_VIEW_CARDS = 2000
export { DAY_MS }

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export class PolicyCache {
	private readonly byScope = new Map<string, LaborPolicyView>()
	constructor(private readonly db: StaffDb) {}
	async get(scopeId: string): Promise<LaborPolicyView> {
		let policy = this.byScope.get(scopeId)
		if (!policy) {
			policy = await resolvePolicy(this.db, scopeId)
			this.byScope.set(scopeId, policy)
		}
		return policy
	}
}

// ---------------------------------------------------------------------------
// Live cards
// ---------------------------------------------------------------------------

export type CardStaff = {
	firstName: string
	lastName: string
	firstNameAr: string | null
	lastNameAr: string | null
	employeeNumber: string | null
	terminated: boolean
}

export type LiveCard = {
	entry: TimeEntry
	staff: CardStaff
	positionName: string | null
	positionNameAr: string | null
	breaks: TimeBreakRow[]
	issues: EntryIssueCode[]
	status: TimesheetStatus
	figures: EntryFigures
	figuresChanged: boolean
}

/** What a manager sees: approval and lock are final; otherwise the live issues decide. */
export function effectiveStatus(
	entry: Pick<TimeEntry, 'status' | 'clockOutAt' | 'reviewedAt'>,
	issues: readonly string[],
): TimesheetStatus {
	if (entry.status === 'locked' || entry.status === 'approved') {
		return entry.status
	}
	if (entry.clockOutAt === null) return 'open'
	const reviewed = entry.reviewedAt !== null && !hasBlockingIssue(issues)
	return needsReview(issues) && !reviewed ? 'needs_review' : 'closed'
}

export type CardRow = {
	entry: TimeEntry
	staff: CardStaff
	positionName: string | null
	positionNameAr: string | null
}

/** Cards of one filter set, in a stable order. The caller adds the `where`. */
export async function selectCardRows(
	db: StaffDb,
	where: ReturnType<typeof and>,
	limit: number,
	/** `desc` keeps the most recent cards when a limit cuts the list (reports). */
	direction: 'asc' | 'desc' = 'asc',
): Promise<CardRow[]> {
	const rows = await db
		.select({
			entry: timeEntries,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
			firstNameAr: staffMembers.firstNameAr,
			lastNameAr: staffMembers.lastNameAr,
			employeeNumber: staffMembers.employeeNumber,
			staffStatus: staffMembers.status,
			positionName: staffPositions.name,
			positionNameAr: staffPositions.nameAr,
		})
		.from(timeEntries)
		.innerJoin(staffMembers, eq(staffMembers.id, timeEntries.staffId))
		.leftJoin(staffPositions, eq(staffPositions.id, timeEntries.positionId))
		.where(and(isNull(timeEntries.voidedAt), where))
		.orderBy(
			...(direction === 'asc'
				? [asc(timeEntries.localDate), asc(timeEntries.clockInAt)]
				: [desc(timeEntries.localDate), desc(timeEntries.clockInAt)]),
		)
		.limit(limit)
	return rows.map((row) => ({
		entry: row.entry,
		staff: {
			firstName: row.firstName,
			lastName: row.lastName,
			firstNameAr: row.firstNameAr,
			lastNameAr: row.lastNameAr,
			employeeNumber: row.employeeNumber,
			terminated: row.staffStatus === 'terminated',
		},
		positionName: row.positionName ?? null,
		positionNameAr: row.positionNameAr ?? null,
	}))
}

function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size))
	return out
}

const SAME_MINUTES = (a: EntryFigures, entry: TimeEntry) =>
	a.regularMinutes === entry.regularMinutes &&
	a.overtimeMinutes === entry.overtimeMinutes &&
	a.doubleTimeMinutes === entry.doubleTimeMinutes &&
	a.holidayMinutes === entry.holidayMinutes &&
	a.paidMinutes === entry.paidMinutes &&
	a.unpaidBreakMinutes === entry.unpaidBreakMinutes

/**
 * Turns card rows into live cards. Figures are computed per person over every
 * non-voided card within the neighbourhood of the viewed dates, whatever
 * scope or filter, because overtime depends on the whole workweek (and, if
 * the policy says so, on every scope).
 */
export async function buildLiveCards(
	ctx: Pick<TimesheetContext, 'db' | 'now'>,
	rows: readonly CardRow[],
	window: { fromDate: string; toDate: string },
	policies = new PolicyCache(ctx.db),
): Promise<LiveCard[]> {
	if (rows.length === 0) return []

	const staffIds = [...new Set(rows.map((row) => row.entry.staffId))]
	const neighbourhood: TimeEntry[] = []
	for (const ids of chunk(staffIds, 90)) {
		neighbourhood.push(
			...(await queryInChunks(ids, (chunk) =>
				ctx.db
					.select()
					.from(timeEntries)
					.where(
						and(
							isNull(timeEntries.voidedAt),
							inArray(timeEntries.staffId, chunk),
							between(
								timeEntries.localDate,
								addDays(window.fromDate, -FIGURE_NEIGHBOURHOOD_DAYS),
								addDays(window.toDate, FIGURE_NEIGHBOURHOOD_DAYS),
							),
						),
					),
			)),
		)
	}
	// Cards outside the date window (a card moved by a business-day rule) are
	// still part of their own person's week.
	const known = new Set(neighbourhood.map((entry) => entry.id))
	for (const row of rows) {
		if (!known.has(row.entry.id)) neighbourhood.push(row.entry)
	}

	const breaksByEntry = await loadBreaks(
		ctx.db,
		neighbourhood.map((entry) => entry.id),
	)

	const contexts = new Map<string, CacheContext>()
	for (const entry of neighbourhood) {
		if (contexts.has(entry.scopeId)) continue
		contexts.set(entry.scopeId, {
			rules: laborPolicyToRules(await policies.get(entry.scopeId)),
			timeZone: entry.timeZone,
		})
	}

	const byStaff = new Map<string, TimeEntry[]>()
	for (const entry of neighbourhood) {
		const list = byStaff.get(entry.staffId) ?? []
		list.push(entry)
		byStaff.set(entry.staffId, list)
	}
	const figures = new Map<string, EntryFigures>()
	for (const entries of byStaff.values()) {
		const computed = computeEntryFigures(
			entries.map((entry) =>
				entryToInput(entry, breaksByEntry.get(entry.id) ?? []),
			),
			(scopeId) => contexts.get(scopeId)!,
			ctx.now,
		)
		for (const [id, value] of computed) figures.set(id, value)
	}

	const cards: LiveCard[] = []
	for (const row of rows) {
		const breaks = breaksByEntry.get(row.entry.id) ?? []
		const policy = await policies.get(row.entry.scopeId)
		const issues = issuesForEntry(row.entry, breaks, policy, [], ctx.now)
		const live = figures.get(row.entry.id)!
		const frozen =
			row.entry.status === 'approved' || row.entry.status === 'locked'
		cards.push({
			...row,
			breaks: breaks.filter((b) => b.voidedAt === null),
			issues,
			status: effectiveStatus(row.entry, issues),
			figures: live,
			figuresChanged: frozen && !SAME_MINUTES(live, row.entry),
		})
	}
	return cards
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function toMinutes(figures: EntryFigures): TimesheetMinutes {
	return {
		regularMinutes: figures.regularMinutes,
		overtimeMinutes: figures.overtimeMinutes,
		doubleTimeMinutes: figures.doubleTimeMinutes,
		holidayMinutes: figures.holidayMinutes,
		paidMinutes: figures.paidMinutes,
		unpaidBreakMinutes: figures.unpaidBreakMinutes,
	}
}

function toBreak(row: TimeBreakRow): TimesheetBreak {
	return {
		id: row.id,
		kind: row.kind,
		paid: row.paid,
		startAt: row.startAt,
		endAt: row.endAt,
	}
}

export function cardPayMinor(figures: EntryFigures): number | null {
	if (figures.costUnits === 0 && figures.unpricedMinutes > 0) return null
	return costUnitsToMinor(figures.costUnits)
}

export function toTimesheetCard(
	live: LiveCard,
	access: MoneyAccess,
): TimesheetCard {
	const { entry } = live
	const card: TimesheetCard = {
		id: entry.id,
		staffId: entry.staffId,
		scopeId: entry.scopeId,
		positionId: entry.positionId,
		positionName: live.positionName,
		positionNameAr: live.positionNameAr,
		timeZone: entry.timeZone,
		localDate: entry.localDate,
		clockInAt: entry.clockInAt,
		clockOutAt: entry.clockOutAt,
		status: live.status,
		issues: live.issues,
		reviewed: entry.reviewedAt !== null,
		edited: live.issues.includes('edited'),
		clockOutKind: entry.clockOutKind,
		breaks: live.breaks.map(toBreak),
		minutes: toMinutes(live.figures),
		figuresChanged: live.figuresChanged,
		managerNote: entry.managerNote,
		version: entry.version,
		approvedAt: entry.approvedAt,
		lockedAt: entry.lockedAt,
	}
	if (access.person) {
		card.money = {
			estimate: true,
			currency: entry.currency,
			rateMinor: entry.rateMinor,
			payMinor: cardPayMinor(live.figures),
			cashTipsMinor: entry.cashTipsMinor,
			creditTipsMinor: entry.creditTipsMinor,
		}
	}
	return card
}

export const emptyTotals = (): TimesheetTotals => ({
	regularMinutes: 0,
	overtimeMinutes: 0,
	doubleTimeMinutes: 0,
	holidayMinutes: 0,
	paidMinutes: 0,
	unpaidBreakMinutes: 0,
	cards: 0,
	open: 0,
	needsReview: 0,
	approved: 0,
	locked: 0,
})

export function addToTotals(totals: TimesheetTotals, card: TimesheetCard) {
	totals.regularMinutes += card.minutes.regularMinutes
	totals.overtimeMinutes += card.minutes.overtimeMinutes
	totals.doubleTimeMinutes += card.minutes.doubleTimeMinutes
	totals.holidayMinutes += card.minutes.holidayMinutes
	totals.paidMinutes += card.minutes.paidMinutes
	totals.unpaidBreakMinutes += card.minutes.unpaidBreakMinutes
	totals.cards += 1
	if (card.status === 'open') totals.open += 1
	if (card.status === 'needs_review') totals.needsReview += 1
	if (card.status === 'approved') totals.approved += 1
	if (card.status === 'locked') totals.locked += 1
}

function addMoney(
	target: Record<string, number>,
	currency: string,
	minor: number,
) {
	if (minor === 0) return
	target[currency] = (target[currency] ?? 0) + minor
}

/** Tips without a currency (no pay row) are grouped under this key. */
export const UNKNOWN_CURRENCY = 'unknown'

export type PersonAggregate = {
	person: TimesheetPerson
	/** Unrounded cost units by currency, for exact totals. */
	costUnits: Map<string, number>
}

/**
 * Groups live cards by person (ordered by name) and totals them. Money is
 * built only when `access.person`; the unrounded cost units are always kept so
 * the labor total can be rounded once.
 */
export function groupByPerson(
	lives: readonly LiveCard[],
	access: MoneyAccess,
): PersonAggregate[] {
	const people = new Map<string, PersonAggregate>()
	for (const live of lives) {
		const { entry } = live
		let aggregate = people.get(entry.staffId)
		if (!aggregate) {
			aggregate = {
				person: {
					staffId: entry.staffId,
					...live.staff,
					cards: [],
					totals: emptyTotals(),
					...(access.person
						? {
								money: {
									estimate: true,
									payMinorByCurrency: {},
									cashTipsMinorByCurrency: {},
									creditTipsMinorByCurrency: {},
									unpricedMinutes: 0,
								} satisfies TimesheetPersonMoney,
							}
						: {}),
				},
				costUnits: new Map(),
			}
			people.set(entry.staffId, aggregate)
		}
		const card = toTimesheetCard(live, access)
		aggregate.person.cards.push(card)
		addToTotals(aggregate.person.totals, card)
		if (live.figures.costUnits > 0 && live.figures.costCurrency) {
			aggregate.costUnits.set(
				live.figures.costCurrency,
				(aggregate.costUnits.get(live.figures.costCurrency) ?? 0) +
					live.figures.costUnits,
			)
		}
		const money = aggregate.person.money
		if (money) {
			money.unpricedMinutes += live.figures.unpricedMinutes
			const currency = entry.currency ?? UNKNOWN_CURRENCY
			addMoney(money.cashTipsMinorByCurrency, currency, entry.cashTipsMinor)
			addMoney(money.creditTipsMinorByCurrency, currency, entry.creditTipsMinor)
		}
	}
	const list = [...people.values()]
	for (const aggregate of list) {
		if (aggregate.person.money) {
			for (const [currency, units] of aggregate.costUnits) {
				aggregate.person.money.payMinorByCurrency[currency] =
					costUnitsToMinor(units)
			}
		}
		aggregate.person.cards.sort(
			(a, b) => a.clockInAt - b.clockInAt || a.id.localeCompare(b.id),
		)
	}
	list.sort(
		(a, b) =>
			a.person.lastName.localeCompare(b.person.lastName) ||
			a.person.firstName.localeCompare(b.person.firstName) ||
			a.person.staffId.localeCompare(b.person.staffId),
	)
	return list
}

export function viewTotals(
	people: readonly PersonAggregate[],
): TimesheetTotals {
	const totals = emptyTotals()
	for (const { person } of people) {
		for (const card of person.cards) addToTotals(totals, card)
	}
	return totals
}

/** Labor cost of the whole view, rounded once per currency from exact units. */
export function laborOf(
	people: readonly PersonAggregate[],
	lives: readonly LiveCard[],
	access: MoneyAccess,
): TimesheetLabor | undefined {
	if (!access.labor) return undefined
	const units = new Map<string, number>()
	for (const { costUnits } of people) {
		for (const [currency, value] of costUnits) {
			units.set(currency, (units.get(currency) ?? 0) + value)
		}
	}
	const payMinorByCurrency: Record<string, number> = {}
	for (const [currency, value] of units) {
		payMinorByCurrency[currency] = costUnitsToMinor(value)
	}
	return {
		estimate: true,
		payMinorByCurrency,
		unpricedMinutes: lives.reduce((s, l) => s + l.figures.unpricedMinutes, 0),
	}
}

export type CardFilters = {
	scopeId?: string
	positionId?: string
	staffId?: string
	status?: TimesheetStatus
}

export function echoFilters(filters: CardFilters): TimesheetFiltersEcho {
	return {
		scopeId: filters.scopeId ?? null,
		positionId: filters.positionId ?? null,
		staffId: filters.staffId ?? null,
		status: filters.status ?? null,
	}
}

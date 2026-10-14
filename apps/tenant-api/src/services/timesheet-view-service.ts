import { and, between, desc, eq, gte, inArray, not, sql } from 'drizzle-orm'
import {
	businessDateOf,
	neutralizeCsvCell,
	nextPayPeriod,
	type PayPeriod,
	type PayPeriodConfig,
	payPeriodAnchorProblem,
	payPeriodFor,
	type PayPeriodSettings,
	type PayPeriodSettingsView,
	type PayrollSummary,
	type PayrollSummaryRow,
	payrollSummaryTable,
	previousPayPeriod,
	type EntryIssueCode,
	REVIEW_ISSUES,
	type TimesheetCardDetail,
	type TimesheetDayView,
	type TimesheetEditLogEntry,
	type TimesheetExport,
	type TimesheetPayPeriod,
	type TimesheetPeriodView,
	type TimesheetPunchRow,
	type TimesheetReviewView,
	type TimesheetStatus,
	type TimesheetView,
	timeCardsTable,
	timesheetTableToCsv,
	type CardCsvRow,
	TIMESHEET_REVIEW_LOOKBACK_DAYS,
} from '@repo/staffing'
import {
	staffingSettings,
	timeEntries,
	timeEntryEdits,
	timePunches,
	type TimeEntryEdit,
} from '@repo/tenant-db'
import { OPAQUE_ID_PATTERN } from '../lib/staff-http.ts'
import { getDefaultPolicy } from './labor-policy-service.ts'
import { type StaffDb, writeStaffAudit } from './staff-audit.ts'
import {
	buildLiveCards,
	type CardFilters,
	DAY_MS,
	echoFilters,
	fail,
	groupByPerson,
	laborOf,
	type LiveCard,
	MAX_VIEW_CARDS,
	moneyAccess,
	type MoneyAccess,
	ok,
	PolicyCache,
	selectCardRows,
	toTimesheetCard,
	type TimesheetContext,
	type TimesheetResult,
	viewTotals,
} from './timesheet-shared.ts'
import { getSettings } from './staff-service.ts'

/**
 * Read side of the timesheets: day view, pay-period view, needs-review queue,
 * one card with its edit log, the payroll summary and the CSV export. Every
 * read applies the token's scope limit in SQL (an out-of-scope limit id
 * answers 404, never an empty list that would confirm it exists), recomputes
 * issues and figures through the shared time math, and omits money unless the
 * token holds the grant. A view that carries money writes one audit row.
 */

// ---------------------------------------------------------------------------
// Pay periods
// ---------------------------------------------------------------------------

export async function payPeriodConfig(
	db: StaffDb,
	scopeId?: string | null,
): Promise<PayPeriodConfig> {
	const settings = await getSettings(db)
	const policy = scopeId
		? await new PolicyCache(db).get(scopeId)
		: await getDefaultPolicy(db)
	return {
		type: settings.payPeriod as PayPeriodConfig['type'],
		anchor: settings.payPeriodAnchor,
		weekStartsOn: policy?.weekStartsOn ?? 1,
	}
}

export function describePeriod(
	period: PayPeriod,
	config: PayPeriodConfig,
): TimesheetPayPeriod {
	return {
		type: period.type,
		start: period.start,
		end: period.end,
		days: period.days,
		previousStart: previousPayPeriod(period, config).start,
		nextStart: nextPayPeriod(period, config).start,
	}
}

export async function getPayPeriodSettings(
	ctx: TimesheetContext,
): Promise<PayPeriodSettingsView> {
	const config = await payPeriodConfig(ctx.db)
	const today = businessDateOf(ctx.now, 'UTC')
	return {
		payPeriod: config.type,
		payPeriodAnchor: config.anchor,
		current: describePeriod(payPeriodFor(today, config), config),
	}
}

export async function updatePayPeriodSettings(
	ctx: TimesheetContext,
	input: PayPeriodSettings,
): Promise<TimesheetResult<PayPeriodSettingsView>> {
	// The cadence is organization-wide: a manager limited to some scopes
	// cannot change it for the others.
	if (!ctx.scope.unrestricted) return fail(403, 'unrestricted_scope_required')
	if (payPeriodAnchorProblem(input.payPeriod, input.payPeriodAnchor)) {
		return fail(422, 'invalid_pay_period', {
			problems: [{ path: 'payPeriodAnchor', code: 'anchor_day_unsupported' }],
		})
	}
	await ctx.db.transaction(async (tx) => {
		const before = await getSettings(tx)
		if (
			before.payPeriod === input.payPeriod &&
			before.payPeriodAnchor === input.payPeriodAnchor
		) {
			return
		}
		await tx
			.update(staffingSettings)
			.set({
				payPeriod: input.payPeriod,
				payPeriodAnchor: input.payPeriodAnchor,
				updatedBy: ctx.auth.userId,
				updatedAt: ctx.now,
			})
			.where(eq(staffingSettings.id, 'org'))
		await writeStaffAudit(tx, ctx.auth, ctx.ipHash, {
			action: 'timesheet.pay_period.updated',
			entityType: 'settings',
			entityId: 'org',
			changes: {
				payPeriod: { before: before.payPeriod, after: input.payPeriod },
				payPeriodAnchor: {
					before: before.payPeriodAnchor,
					after: input.payPeriodAnchor,
				},
			},
		})
	})
	return ok(await getPayPeriodSettings(ctx))
}

// ---------------------------------------------------------------------------
// Shared view assembly
// ---------------------------------------------------------------------------

function scopeCheck(ctx: TimesheetContext, filters: CardFilters) {
	if (filters.scopeId !== undefined) {
		if (
			!OPAQUE_ID_PATTERN.test(filters.scopeId) ||
			!ctx.scope.allows(filters.scopeId)
		) {
			return fail(404, 'not_found')
		}
	}
	return null
}

function filterLives(
	lives: LiveCard[],
	status: TimesheetStatus | undefined,
): LiveCard[] {
	return status ? lives.filter((live) => live.status === status) : lives
}

/** One audit row for a list that disclosed money; the read fails if it cannot be written. */
async function auditPayRead(
	ctx: TimesheetContext,
	access: MoneyAccess,
	view: string,
	detail: Record<string, unknown>,
) {
	if (!access.person) return
	await writeStaffAudit(ctx.db, ctx.auth, ctx.ipHash, {
		action: 'timesheet.pay.read',
		entityType: 'timesheet',
		sensitivity: 'pay',
		changes: { view, ...detail },
	})
}

async function assembleView(
	ctx: TimesheetContext,
	lives: LiveCard[],
	filters: CardFilters,
	truncated: boolean,
): Promise<TimesheetView> {
	const access = moneyAccess(ctx.auth)
	const people = groupByPerson(lives, access)
	const labor = laborOf(people, lives, access)
	return {
		serverNow: ctx.now,
		people: people.map((p) => p.person),
		totals: viewTotals(people),
		filters: echoFilters(filters),
		truncated,
		...(labor ? { labor } : {}),
	}
}

export type RangeFilters = CardFilters & { fromDate: string; toDate: string }

export async function loadRange(
	ctx: TimesheetContext,
	filters: RangeFilters,
): Promise<{ lives: LiveCard[]; truncated: boolean }> {
	const rows = await selectCardRows(
		ctx.db,
		and(
			between(timeEntries.localDate, filters.fromDate, filters.toDate),
			ctx.scope.where(timeEntries.scopeId),
			filters.scopeId ? eq(timeEntries.scopeId, filters.scopeId) : undefined,
			filters.positionId
				? eq(timeEntries.positionId, filters.positionId)
				: undefined,
			filters.staffId ? eq(timeEntries.staffId, filters.staffId) : undefined,
		),
		MAX_VIEW_CARDS + 1,
	)
	const truncated = rows.length > MAX_VIEW_CARDS
	const lives = await buildLiveCards(
		ctx,
		truncated ? rows.slice(0, MAX_VIEW_CARDS) : rows,
		{ fromDate: filters.fromDate, toDate: filters.toDate },
	)
	return { lives: filterLives(lives, filters.status), truncated }
}

// ---------------------------------------------------------------------------
// Day and period
// ---------------------------------------------------------------------------

export async function loadDayView(
	ctx: TimesheetContext,
	query: CardFilters & { date: string },
): Promise<TimesheetResult<TimesheetDayView>> {
	const denied = scopeCheck(ctx, query)
	if (denied) return denied
	const { lives, truncated } = await loadRange(ctx, {
		...query,
		fromDate: query.date,
		toDate: query.date,
	})
	const view = await assembleView(ctx, lives, query, truncated)
	await auditPayRead(ctx, moneyAccess(ctx.auth), 'day', {
		date: query.date,
		cards: lives.length,
	})
	return ok({ ...view, date: query.date })
}

/** Resolves `date` or `periodStart` to a pay period; a start that is not one is refused. */
export async function resolvePeriod(
	ctx: TimesheetContext,
	query: { date?: string; periodStart?: string; scopeId?: string },
): Promise<TimesheetResult<{ period: PayPeriod; config: PayPeriodConfig }>> {
	const config = await payPeriodConfig(ctx.db, query.scopeId)
	const anchorDate =
		query.periodStart ?? query.date ?? businessDateOf(ctx.now, 'UTC')
	const period = payPeriodFor(anchorDate, config)
	if (query.periodStart && period.start !== query.periodStart) {
		return fail(422, 'invalid_pay_period')
	}
	return ok({ period, config })
}

export async function loadPeriodView(
	ctx: TimesheetContext,
	query: CardFilters & { date?: string; periodStart?: string },
): Promise<TimesheetResult<TimesheetPeriodView>> {
	const denied = scopeCheck(ctx, query)
	if (denied) return denied
	const resolved = await resolvePeriod(ctx, query)
	if (!resolved.ok) return resolved
	const { period, config } = resolved.value
	const { lives, truncated } = await loadRange(ctx, {
		...query,
		fromDate: period.start,
		toDate: period.end,
	})
	const view = await assembleView(ctx, lives, query, truncated)
	await auditPayRead(ctx, moneyAccess(ctx.auth), 'period', {
		periodStart: period.start,
		periodEnd: period.end,
		cards: lives.length,
	})
	return ok({ ...view, period: describePeriod(period, config) })
}

// ---------------------------------------------------------------------------
// Needs-review queue
// ---------------------------------------------------------------------------

const REVIEW_SET = new Set<string>(REVIEW_ISSUES)

/**
 * Cards that need a manager: closed cards with a review issue that nobody has
 * dealt with, and cards still open past the long-shift limit. Issues are judged
 * live, so a changed policy or a passing clock moves cards in and out.
 */
export async function loadReviewQueue(
	ctx: TimesheetContext,
	query: { scopeId?: string; staffId?: string; lookbackDays?: number },
): Promise<TimesheetResult<TimesheetReviewView>> {
	const denied = scopeCheck(ctx, query)
	if (denied) return denied
	const lookbackDays =
		query.lookbackDays ?? TIMESHEET_REVIEW_LOOKBACK_DAYS.default
	const since = ctx.now - lookbackDays * DAY_MS
	const rows = await selectCardRows(
		ctx.db,
		and(
			not(inArray(timeEntries.status, ['approved', 'locked'])),
			gte(timeEntries.clockInAt, since),
			ctx.scope.where(timeEntries.scopeId),
			query.scopeId ? eq(timeEntries.scopeId, query.scopeId) : undefined,
			query.staffId ? eq(timeEntries.staffId, query.staffId) : undefined,
		),
		MAX_VIEW_CARDS + 1,
	)
	const truncated = rows.length > MAX_VIEW_CARDS
	const all = await buildLiveCards(
		ctx,
		truncated ? rows.slice(0, MAX_VIEW_CARDS) : rows,
		{
			fromDate: businessDateOf(since, 'UTC'),
			toDate: businessDateOf(ctx.now, 'UTC'),
		},
	)
	const queue = all.filter(
		(live) =>
			live.status === 'needs_review' ||
			(live.status === 'open' && live.issues.includes('missing_clock_out')),
	)
	const byIssue: Partial<Record<EntryIssueCode, number>> = {}
	for (const live of queue) {
		for (const issue of live.issues) {
			if (REVIEW_SET.has(issue)) byIssue[issue] = (byIssue[issue] ?? 0) + 1
		}
	}
	const view = await assembleView(ctx, queue, query, truncated)
	await auditPayRead(ctx, moneyAccess(ctx.auth), 'review', {
		cards: queue.length,
	})
	return ok({ ...view, byIssue })
}

// ---------------------------------------------------------------------------
// One card
// ---------------------------------------------------------------------------

const MONEY_KEYS = ['cashTipsMinor', 'creditTipsMinor', 'rateMinor', 'currency']

/** Edit-log snapshots carry tips and the rate; readers without the pay grant never see them. */
export function stripMoneyFromSnapshot(
	snapshot: unknown,
): Record<string, unknown> | null {
	if (snapshot === null || typeof snapshot !== 'object') return null
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(snapshot)) {
		if (!MONEY_KEYS.includes(key)) out[key] = value
	}
	return out
}

export function toEditLogEntry(
	row: TimeEntryEdit,
	access: MoneyAccess,
): TimesheetEditLogEntry {
	const clean = (value: unknown) =>
		access.person
			? ((value as Record<string, unknown> | null) ?? null)
			: stripMoneyFromSnapshot(value)
	return {
		id: row.id,
		entryId: row.entryId,
		editorId: row.editorId,
		via: row.via,
		action: row.action,
		reason: row.reason,
		before: clean(row.before),
		after: clean(row.after),
		hoursDeltaMinutes: row.hoursDeltaMinutes,
		createdAt: row.createdAt,
	}
}

export async function loadCardById(
	ctx: TimesheetContext,
	id: string,
): Promise<LiveCard | null> {
	if (!OPAQUE_ID_PATTERN.test(id)) return null
	const rows = await selectCardRows(
		ctx.db,
		and(eq(timeEntries.id, id), ctx.scope.where(timeEntries.scopeId)),
		1,
	)
	const row = rows[0]
	if (!row) return null
	const [live] = await buildLiveCards(ctx, [row], {
		fromDate: row.entry.localDate,
		toDate: row.entry.localDate,
	})
	return live ?? null
}

export async function loadCardDetail(
	ctx: TimesheetContext,
	id: string,
): Promise<TimesheetResult<TimesheetCardDetail>> {
	const live = await loadCardById(ctx, id)
	if (!live) return fail(404, 'not_found')
	const access = moneyAccess(ctx.auth)
	const edits = await ctx.db
		.select()
		.from(timeEntryEdits)
		.where(eq(timeEntryEdits.entryId, live.entry.id))
		.orderBy(desc(timeEntryEdits.createdAt), sql`rowid desc`)
	const punchRows = await ctx.db
		.select()
		.from(timePunches)
		.where(
			and(
				eq(timePunches.entryId, live.entry.id),
				eq(timePunches.outcome, 'accepted'),
			),
		)
		.orderBy(timePunches.serverAt)
	const punches: TimesheetPunchRow[] = punchRows.map((row) => ({
		id: row.id,
		kind: row.kind,
		effectiveAt: row.effectiveAt,
		serverAt: row.serverAt,
		source: row.source,
		flags: row.flags,
	}))
	await auditPayRead(ctx, access, 'card', { entryId: live.entry.id })
	return ok({
		serverNow: ctx.now,
		person: {
			staffId: live.entry.staffId,
			...live.staff,
		},
		card: toTimesheetCard(live, access),
		edits: edits.map((row) => toEditLogEntry(row, access)),
		punches,
	})
}

// ---------------------------------------------------------------------------
// Payroll summary and export
// ---------------------------------------------------------------------------

type SummaryQuery = CardFilters & { date?: string; periodStart?: string }

export async function loadPayrollSummary(
	ctx: TimesheetContext,
	query: SummaryQuery,
): Promise<TimesheetResult<PayrollSummary>> {
	const denied = scopeCheck(ctx, query)
	if (denied) return denied
	const resolved = await resolvePeriod(ctx, query)
	if (!resolved.ok) return resolved
	const { period, config } = resolved.value
	const { lives, truncated } = await loadRange(ctx, {
		...query,
		fromDate: period.start,
		toDate: period.end,
	})
	const access = moneyAccess(ctx.auth)
	const policies = new PolicyCache(ctx.db)
	const people = groupByPerson(lives, access)
	const labor = laborOf(people, lives, access)

	// A card still needs a decision unless approval is off for its scope and
	// nothing is wrong with it.
	const awaiting = new Map<string, number>()
	for (const live of lives) {
		if (live.status === 'approved' || live.status === 'locked') continue
		const policy = await policies.get(live.entry.scopeId)
		const needsDecision =
			policy.timesheetApprovalMode !== 'none' ||
			live.status === 'open' ||
			live.status === 'needs_review'
		if (needsDecision) {
			awaiting.set(
				live.entry.staffId,
				(awaiting.get(live.entry.staffId) ?? 0) + 1,
			)
		}
	}

	const rows: PayrollSummaryRow[] = people.map(({ person }) => {
		const row: PayrollSummaryRow = {
			staffId: person.staffId,
			employeeNumber: person.employeeNumber,
			firstName: person.firstName,
			lastName: person.lastName,
			cards: person.totals.cards,
			regularMinutes: person.totals.regularMinutes,
			overtimeMinutes: person.totals.overtimeMinutes,
			doubleTimeMinutes: person.totals.doubleTimeMinutes,
			holidayMinutes: person.totals.holidayMinutes,
			paidMinutes: person.totals.paidMinutes,
			unpaidBreakMinutes: person.totals.unpaidBreakMinutes,
			unapprovedCards: awaiting.get(person.staffId) ?? 0,
		}
		if (person.money) {
			const seen = new Set<string>()
			const ratesMinor: Array<{ currency: string; rateMinor: number }> = []
			for (const card of person.cards) {
				const money = card.money
				if (!money || money.rateMinor === null || money.currency === null) {
					continue
				}
				const key = `${money.currency}:${money.rateMinor}`
				if (seen.has(key)) continue
				seen.add(key)
				ratesMinor.push({
					currency: money.currency,
					rateMinor: money.rateMinor,
				})
			}
			row.money = {
				estimate: true,
				ratesMinor: ratesMinor.sort(
					(a, b) =>
						a.currency.localeCompare(b.currency) || a.rateMinor - b.rateMinor,
				),
				payMinorByCurrency: person.money.payMinorByCurrency,
				cashTipsMinorByCurrency: person.money.cashTipsMinorByCurrency,
				creditTipsMinorByCurrency: person.money.creditTipsMinorByCurrency,
				unpricedMinutes: person.money.unpricedMinutes,
			}
		}
		return row
	})

	const totals = rows.reduce(
		(sum, row) => ({
			cards: sum.cards + row.cards,
			regularMinutes: sum.regularMinutes + row.regularMinutes,
			overtimeMinutes: sum.overtimeMinutes + row.overtimeMinutes,
			doubleTimeMinutes: sum.doubleTimeMinutes + row.doubleTimeMinutes,
			holidayMinutes: sum.holidayMinutes + row.holidayMinutes,
			paidMinutes: sum.paidMinutes + row.paidMinutes,
			unpaidBreakMinutes: sum.unpaidBreakMinutes + row.unpaidBreakMinutes,
			unapprovedCards: sum.unapprovedCards + row.unapprovedCards,
		}),
		{
			cards: 0,
			regularMinutes: 0,
			overtimeMinutes: 0,
			doubleTimeMinutes: 0,
			holidayMinutes: 0,
			paidMinutes: 0,
			unpaidBreakMinutes: 0,
			unapprovedCards: 0,
		},
	)

	await auditPayRead(ctx, access, 'payroll_summary', {
		periodStart: period.start,
		periodEnd: period.end,
		people: rows.length,
	})
	return ok({
		serverNow: ctx.now,
		period: describePeriod(period, config),
		filters: echoFilters(query),
		rows,
		totals,
		// A cut-off view cannot vouch for the cards it left out.
		readyForPayroll: totals.unapprovedCards === 0 && !truncated,
		truncated,
		...(labor ? { labor } : {}),
	})
}

export async function buildExport(
	ctx: TimesheetContext,
	query: SummaryQuery & { kind: 'cards' | 'summary' },
): Promise<TimesheetResult<TimesheetExport>> {
	const denied = scopeCheck(ctx, query)
	if (denied) return denied
	const resolved = await resolvePeriod(ctx, query)
	if (!resolved.ok) return resolved
	const { period } = resolved.value
	const access = moneyAccess(ctx.auth)
	const includeMoney = access.person
	const stem = `${period.start}_${period.end}`

	let table
	let filename: string
	if (query.kind === 'summary') {
		// `loadPayrollSummary` writes its own pay-read audit row; the export row
		// below records the act of exporting.
		const summary = await loadPayrollSummary(ctx, query)
		if (!summary.ok) return summary
		// A payroll file that silently drops cards is worse than none.
		if (summary.value.truncated) return fail(422, 'range_too_large')
		table = payrollSummaryTable(summary.value.rows, { includeMoney })
		filename = `payroll-summary_${stem}.csv`
	} else {
		const { lives, truncated } = await loadRange(ctx, {
			...query,
			fromDate: period.start,
			toDate: period.end,
		})
		if (truncated) return fail(422, 'range_too_large')
		const people = groupByPerson(lives, access)
		const rows: CardCsvRow[] = people.flatMap(({ person }) =>
			person.cards.map((card) => ({ person, card })),
		)
		table = timeCardsTable(rows, { includeMoney })
		filename = `time-cards_${stem}.csv`
		await auditPayRead(ctx, access, 'export_cards', {
			periodStart: period.start,
			periodEnd: period.end,
			cards: rows.length,
		})
	}

	await writeStaffAudit(ctx.db, ctx.auth, ctx.ipHash, {
		action: 'timesheet.exported',
		entityType: 'timesheet',
		scopeId: query.scopeId ?? null,
		sensitivity: includeMoney ? 'pay' : 'standard',
		changes: {
			kind: query.kind,
			periodStart: period.start,
			periodEnd: period.end,
			rows: table.rows.length,
			includesMoney: includeMoney,
		},
	})

	return ok({
		filename,
		kind: query.kind,
		rowCount: table.rows.length,
		includesMoney: includeMoney,
		headers: table.headers,
		// Neutralized here too, so a client that builds its own file from the
		// rows is safe by default. The step is idempotent: the CSV builder
		// neutralizes again without double-prefixing.
		rows: table.rows.map((row) =>
			row.map((cell) =>
				typeof cell === 'string' ? neutralizeCsvCell(cell) : cell,
			),
		),
		csv: timesheetTableToCsv(table),
	})
}

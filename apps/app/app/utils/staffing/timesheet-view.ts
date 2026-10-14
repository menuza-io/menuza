import {
	addDays,
	formatDate,
	hasBlockingIssue,
	localParts,
	parseDate,
	REVIEW_ISSUES,
	TIMESHEET_STATUSES,
	type TimesheetStatus,
} from '@repo/staffing'
import { staffDisplayName } from './staff-format.ts'
import {
	type TimesheetCardRow,
	type TimesheetPersonInfo,
	type TimesheetPersonRow,
} from './timesheet-types.ts'

/**
 * Pure helpers behind the Timesheets screens: what the address bar says, how
 * cards are flattened, grouped and totalled, and which bulk actions a card can
 * take. Nothing here touches the network, the DOM or a clock.
 */

// ---------------------------------------------------------------------------
// Address bar state
// ---------------------------------------------------------------------------

export const TIMESHEET_VIEWS = ['day', 'period', 'review', 'summary'] as const
export type TimesheetViewName = (typeof TIMESHEET_VIEWS)[number]

export const TIMESHEET_GROUPS = ['person', 'date', 'position'] as const
export type TimesheetGroup = (typeof TIMESHEET_GROUPS)[number]

export type TimesheetSearch = {
	view: TimesheetViewName
	/** A business date; the pay period views show the period that holds it. */
	date: string
	group: TimesheetGroup
	/** `all` or an id. */
	scopeId: string
	positionId: string
	status: 'all' | TimesheetStatus
	/**
	 * Free text over names, payroll IDs and positions, applied in the browser.
	 * It is never read from or written to the address bar: a name typed here
	 * would travel to the US app server in every page and data request URL.
	 * The screen keeps it in its own state.
	 */
	q: string
}

export const DEFAULT_VIEW: TimesheetViewName = 'period'

export function isValidDate(value: string | null | undefined): value is string {
	if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
	const [year, month, day] = value.split('-').map(Number) as [
		number,
		number,
		number,
	]
	const probe = new Date(Date.UTC(year, month - 1, day))
	return (
		probe.getUTCFullYear() === year &&
		probe.getUTCMonth() === month - 1 &&
		probe.getUTCDate() === day
	)
}

/** Day cards group by person; a range reads best by person too. */
export function defaultGroup(): TimesheetGroup {
	return 'person'
}

function pick<T extends string>(
	value: string | null,
	allowed: readonly T[],
	fallback: T,
): T {
	return (allowed as readonly string[]).includes(value ?? '')
		? (value as T)
		: fallback
}

/** Reads the address bar; anything unknown or malformed falls back to a default. */
export function parseTimesheetSearch(
	params: URLSearchParams,
	today: string,
): TimesheetSearch {
	const date = params.get('date')
	const view = pick(params.get('view'), TIMESHEET_VIEWS, DEFAULT_VIEW)
	let group = pick(params.get('group'), TIMESHEET_GROUPS, defaultGroup())
	// A single day has one date, so grouping by date would be one group.
	if (view === 'day' && group === 'date') group = 'person'
	return {
		view,
		date: isValidDate(date) ? date : today,
		group,
		scopeId: params.get('scope') || 'all',
		positionId: params.get('position') || 'all',
		status: pick(
			params.get('status'),
			['all', ...TIMESHEET_STATUSES] as const,
			'all',
		),
		q: '',
	}
}

/** Writes `patch` over the current address bar, leaving defaults out of it. */
export function writeTimesheetSearch(
	current: URLSearchParams,
	patch: Partial<TimesheetSearch>,
	today: string,
): URLSearchParams {
	const next = { ...parseTimesheetSearch(current, today), ...patch }
	if (next.view === 'day' && next.group === 'date') next.group = 'person'
	const out = new URLSearchParams()
	if (next.view !== DEFAULT_VIEW) out.set('view', next.view)
	if (next.date !== today) out.set('date', next.date)
	if (next.group !== defaultGroup()) out.set('group', next.group)
	if (next.scopeId !== 'all') out.set('scope', next.scopeId)
	if (next.positionId !== 'all') out.set('position', next.positionId)
	if (next.status !== 'all') out.set('status', next.status)
	return out
}

/** The query string the regional API wants for the filters it applies itself. */
export function serverFilters(search: TimesheetSearch): URLSearchParams {
	const params = new URLSearchParams()
	if (search.scopeId !== 'all') params.set('scopeId', search.scopeId)
	if (search.positionId !== 'all') params.set('positionId', search.positionId)
	if (search.status !== 'all') params.set('status', search.status)
	return params
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** The calendar date of an instant in `timeZone`, as `YYYY-MM-DD`. */
export function calendarDateOf(at: number, timeZone: string): string {
	try {
		const p = localParts(at, timeZone)
		return formatDate(p.year, p.month, p.day)
	} catch {
		const d = new Date(at)
		return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
	}
}

/** `HH:MM` (24 hour) of an instant in `timeZone`: what a time input holds. */
export function timeInputOf(at: number, timeZone: string): string {
	const p = localParts(at, timeZone)
	return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
}

function dateAsUtc(date: string): Date {
	const { year, month, day } = parseDate(date)
	return new Date(Date.UTC(year, month - 1, day, 12))
}

/** "Mon, Mar 2" in the viewer's language; the date is a calendar date, not an instant. */
export function formatDateLabel(
	date: string,
	locale: string,
	options: Intl.DateTimeFormatOptions = {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	},
): string {
	try {
		return new Intl.DateTimeFormat(locale, {
			...options,
			timeZone: 'UTC',
		}).format(dateAsUtc(date))
	} catch {
		return date
	}
}

/** "Mar 2 – Mar 15, 2026". */
export function formatPeriodLabel(
	start: string,
	end: string,
	locale: string,
): string {
	try {
		const format = new Intl.DateTimeFormat(locale, {
			month: 'short',
			day: 'numeric',
			year: 'numeric',
			timeZone: 'UTC',
		})
		return format.formatRange(dateAsUtc(start), dateAsUtc(end))
	} catch {
		return `${start} – ${end}`
	}
}

/** Today's business date where the workplace is. */
export function todayIn(now: number, timeZone: string): string {
	return calendarDateOf(now, timeZone)
}

export function shiftDate(date: string, days: number): string {
	return addDays(date, days)
}

/** Whole calendar days between two instants' local dates (0 when same day). */
export function dayOffset(from: number, to: number, timeZone: string): number {
	const a = parseDate(calendarDateOf(from, timeZone))
	const b = parseDate(calendarDateOf(to, timeZone))
	return Math.round(
		(Date.UTC(b.year, b.month - 1, b.day) -
			Date.UTC(a.year, a.month - 1, a.day)) /
			86_400_000,
	)
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** 450 minutes -> "7.50". Payroll reads decimal hours. */
export function formatHours(minutes: number, locale = 'en'): string {
	try {
		return new Intl.NumberFormat(locale, {
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(Math.round((minutes / 60) * 100) / 100)
	} catch {
		return (Math.round((minutes / 60) * 100) / 100).toFixed(2)
	}
}

// ---------------------------------------------------------------------------
// Rows, totals and groups
// ---------------------------------------------------------------------------

export type TimesheetRow = {
	person: TimesheetPersonInfo
	card: TimesheetCardRow
}

export function flattenRows(
	people: readonly TimesheetPersonRow[],
): TimesheetRow[] {
	return people.flatMap((person) => {
		const { cards, ...info } = person
		return cards.map((card) => ({
			person: {
				staffId: info.staffId,
				firstName: info.firstName,
				lastName: info.lastName,
				firstNameAr: info.firstNameAr,
				lastNameAr: info.lastNameAr,
				employeeNumber: info.employeeNumber,
				terminated: info.terminated,
			},
			card,
		}))
	})
}

export function positionLabel(
	card: Pick<TimesheetCardRow, 'positionName' | 'positionNameAr'>,
	locale: string,
): string | null {
	if (locale.startsWith('ar')) return card.positionNameAr ?? card.positionName
	return card.positionName
}

/** Case-insensitive match over name, payroll ID and position. Empty matches all. */
export function filterRows(
	rows: readonly TimesheetRow[],
	query: string,
	locale: string,
): TimesheetRow[] {
	const needle = query.trim().toLocaleLowerCase()
	if (!needle) return [...rows]
	return rows.filter(({ person, card }) => {
		const haystack = [
			person.firstName,
			person.lastName,
			person.firstNameAr,
			person.lastNameAr,
			`${person.firstName} ${person.lastName}`,
			person.employeeNumber,
			positionLabel(card, locale),
		]
			.filter(Boolean)
			.join(' ')
			.toLocaleLowerCase()
		return haystack.includes(needle)
	})
}

export type MoneyByCurrency = Record<string, number>

export type RowTotals = {
	cards: number
	open: number
	needsReview: number
	approved: number
	locked: number
	paidMinutes: number
	regularMinutes: number
	overtimeMinutes: number
	doubleTimeMinutes: number
	holidayMinutes: number
	unpaidBreakMinutes: number
	/** Present only when any card carried money (the viewer holds the pay grant). */
	payMinorByCurrency: MoneyByCurrency | null
	/** Worked minutes with no rate: left out of the pay figure, said out loud. */
	unpricedMinutes: number
}

export function emptyRowTotals(): RowTotals {
	return {
		cards: 0,
		open: 0,
		needsReview: 0,
		approved: 0,
		locked: 0,
		paidMinutes: 0,
		regularMinutes: 0,
		overtimeMinutes: 0,
		doubleTimeMinutes: 0,
		holidayMinutes: 0,
		unpaidBreakMinutes: 0,
		payMinorByCurrency: null,
		unpricedMinutes: 0,
	}
}

export function sumCards(cards: readonly TimesheetCardRow[]): RowTotals {
	const totals = emptyRowTotals()
	for (const card of cards) {
		totals.cards += 1
		if (card.status === 'open') totals.open += 1
		if (card.status === 'needs_review') totals.needsReview += 1
		if (card.status === 'approved') totals.approved += 1
		if (card.status === 'locked') totals.locked += 1
		totals.paidMinutes += card.minutes.paidMinutes
		totals.regularMinutes += card.minutes.regularMinutes
		totals.overtimeMinutes += card.minutes.overtimeMinutes
		totals.doubleTimeMinutes += card.minutes.doubleTimeMinutes
		totals.holidayMinutes += card.minutes.holidayMinutes
		totals.unpaidBreakMinutes += card.minutes.unpaidBreakMinutes
		if (card.money) {
			totals.payMinorByCurrency ??= {}
			if (card.money.payMinor === null || card.money.currency === null) {
				totals.unpricedMinutes += card.minutes.paidMinutes
			} else {
				const code = card.money.currency
				totals.payMinorByCurrency[code] =
					(totals.payMinorByCurrency[code] ?? 0) + card.money.payMinor
			}
		}
	}
	return totals
}

export type RowGroup = {
	/** Stable key: staff id, date, or position id (`none` for no position). */
	key: string
	by: TimesheetGroup
	/** Person for a person group, date for a date group, name for a position group. */
	person: TimesheetPersonInfo | null
	date: string | null
	positionName: string | null
	rows: TimesheetRow[]
	totals: RowTotals
}

function byName(a: TimesheetPersonInfo, b: TimesheetPersonInfo): number {
	return (
		`${a.lastName} ${a.firstName}`.localeCompare(
			`${b.lastName} ${b.firstName}`,
		) || a.staffId.localeCompare(b.staffId)
	)
}

function byTime(a: TimesheetRow, b: TimesheetRow): number {
	return (
		a.card.clockInAt - b.card.clockInAt || a.card.id.localeCompare(b.card.id)
	)
}

/** Groups rows for display. Order is stable: people by name, dates ascending, positions by name. */
export function groupRows(
	rows: readonly TimesheetRow[],
	by: TimesheetGroup,
	locale: string,
): RowGroup[] {
	const groups = new Map<string, RowGroup>()
	for (const row of rows) {
		const position = positionLabel(row.card, locale)
		const key =
			by === 'person'
				? row.person.staffId
				: by === 'date'
					? row.card.localDate
					: (row.card.positionId ?? 'none')
		let group = groups.get(key)
		if (!group) {
			group = {
				key,
				by,
				person: by === 'person' ? row.person : null,
				date: by === 'date' ? row.card.localDate : null,
				positionName: by === 'position' ? position : null,
				rows: [],
				totals: emptyRowTotals(),
			}
			groups.set(key, group)
		}
		group.rows.push(row)
	}
	const list = [...groups.values()]
	for (const group of list) {
		group.rows.sort(
			by === 'person'
				? byTime
				: by === 'date'
					? (a, b) => byName(a.person, b.person) || byTime(a, b)
					: (a, b) =>
							a.card.localDate.localeCompare(b.card.localDate) ||
							byName(a.person, b.person) ||
							byTime(a, b),
		)
		group.totals = sumCards(group.rows.map((row) => row.card))
	}
	list.sort((a, b) => {
		if (by === 'person') return byName(a.person!, b.person!)
		if (by === 'date') return a.date!.localeCompare(b.date!)
		const an = a.positionName ?? '￿'
		const bn = b.positionName ?? '￿'
		return an.localeCompare(bn) || a.key.localeCompare(b.key)
	})
	return list
}

export function displayName(person: TimesheetPersonInfo, locale: string) {
	return staffDisplayName(person, locale)
}

// ---------------------------------------------------------------------------
// Which actions a card can take
// ---------------------------------------------------------------------------

/** What the scope's labor rules say about approving. `unknown`: the viewer cannot read the rules. */
export type ApprovalMode = 'none' | 'approve' | 'approve_lock' | 'unknown'

export function approvalModeFor(
	policies: {
		default: { timesheetApprovalMode: string } | null
		scopes: ReadonlyArray<{
			scopeId: string | null
			timesheetApprovalMode: string
		}>
	} | null,
	scopeId: string,
): ApprovalMode {
	if (!policies) return 'unknown'
	const own = policies.scopes.find((row) => row.scopeId === scopeId)
	const mode = (own ?? policies.default)?.timesheetApprovalMode ?? 'none'
	return mode === 'approve' || mode === 'approve_lock' ? mode : 'none'
}

export type CardActions = {
	approve: boolean
	lock: boolean
	unlock: boolean
	reopen: boolean
	review: boolean
	edit: boolean
}

export function cardActions(
	card: Pick<TimesheetCardRow, 'status' | 'issues' | 'clockOutAt'>,
	mode: ApprovalMode,
	can: { approve: boolean; update: boolean },
): CardActions {
	const blocking = hasBlockingIssue(card.issues) || card.clockOutAt === null
	const approvalOn = mode !== 'none'
	return {
		approve:
			can.approve &&
			approvalOn &&
			!blocking &&
			(card.status === 'closed' || card.status === 'needs_review'),
		lock:
			can.approve &&
			card.status === 'approved' &&
			mode !== 'approve' &&
			mode !== 'none',
		unlock: can.approve && card.status === 'locked',
		reopen: can.approve && card.status === 'approved',
		review: can.update && card.status === 'needs_review' && !blocking,
		edit: can.update && card.status !== 'approved' && card.status !== 'locked',
	}
}

/** Closed, clean cards: what "approve everything that is ready" takes. */
export function isReadyToApprove(
	card: Pick<TimesheetCardRow, 'status' | 'issues' | 'clockOutAt'>,
): boolean {
	return (
		card.status === 'closed' &&
		card.clockOutAt !== null &&
		!hasBlockingIssue(card.issues)
	)
}

export type BatchOp = 'approve' | 'lock' | 'unlock' | 'reopen'

export function summarizeBatch(
	results: ReadonlyArray<{ ok: boolean; code?: string }>,
): { done: number; skipped: number; codes: Record<string, number> } {
	const codes: Record<string, number> = {}
	let done = 0
	for (const result of results) {
		if (result.ok) done += 1
		else
			codes[result.code ?? 'failed'] = (codes[result.code ?? 'failed'] ?? 0) + 1
	}
	return { done, skipped: results.length - done, codes }
}

/** Splits `items` into batches of at most `size` (the API takes 200 at a time). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = []
	for (let i = 0; i < items.length; i += size)
		out.push(items.slice(i, i + size))
	return out
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/** Issues a manager must look at: the shared package owns the list. */
export const REVIEW_ISSUE_SET: ReadonlySet<string> = new Set(REVIEW_ISSUES)

export function isReviewIssue(code: string): boolean {
	return REVIEW_ISSUE_SET.has(code)
}

/** Review issues first, in the order the shared package lists them, then information. */
export function sortIssues(issues: readonly string[]): string[] {
	return [...issues].sort(
		(a, b) => Number(isReviewIssue(b)) - Number(isReviewIssue(a)),
	)
}

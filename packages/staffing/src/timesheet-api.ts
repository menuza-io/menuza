import { z } from 'zod'
import { type CsvCell } from './csv.ts'
import { type EntryIssueCode } from './punch-policy.ts'
import { BREAK_KINDS, type BreakKind } from './labor-policy.ts'
import { LOCAL_TIME_PATTERN } from './timesheet-times.ts'
import { localDateSchema } from './schemas.ts'

/**
 * Request and response contracts for the timesheets, served under
 * `/operator/timeclock/timesheets`. App code and tenant-api import the same
 * schemas. Request schemas are `.strict()`: an unknown key is a 400. Responses
 * that carry money mark it `estimate: true` and leave the money out entirely
 * (the keys are absent, not zero) when the token lacks the grant.
 */

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

const instantSchema = z.number().int().min(0).max(4_102_444_800_000)
const timeOfDaySchema = z.string().regex(LOCAL_TIME_PATTERN, 'Use HH:MM')

/** A reason must say something: not blank, not only invisible characters. */
export const timesheetReasonSchema = z
	.string()
	.trim()
	.min(1)
	.max(500)
	.refine((value) => /[\p{L}\p{N}]/u.test(value), 'Say what changed and why')

const tipSchema = z.number().int().min(0).max(10_000_000)

export const TIMESHEET_STATUSES = [
	'open',
	'closed',
	'needs_review',
	'approved',
	'locked',
] as const
export type TimesheetStatus = (typeof TIMESHEET_STATUSES)[number]

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const filterShape = {
	scopeId: idSchema.optional(),
	positionId: idSchema.optional(),
	staffId: idSchema.optional(),
	status: z.enum(TIMESHEET_STATUSES).optional(),
}

export const timesheetDayQuerySchema = z
	.object({ date: localDateSchema, ...filterShape })
	.strict()
export type TimesheetDayQuery = z.infer<typeof timesheetDayQuerySchema>

/** `date` picks the period that contains it; `periodStart` must be a period start. */
export const timesheetPeriodQuerySchema = z
	.object({
		date: localDateSchema.optional(),
		periodStart: localDateSchema.optional(),
		...filterShape,
	})
	.strict()
	.refine(
		(q) => !(q.date && q.periodStart),
		'Use date or periodStart, not both',
	)
export type TimesheetPeriodQuery = z.infer<typeof timesheetPeriodQuerySchema>

export const TIMESHEET_REVIEW_LOOKBACK_DAYS = { default: 60, max: 180 } as const

export const timesheetReviewQuerySchema = z
	.object({
		scopeId: idSchema.optional(),
		staffId: idSchema.optional(),
		lookbackDays: z.coerce
			.number()
			.int()
			.min(1)
			.max(TIMESHEET_REVIEW_LOOKBACK_DAYS.max)
			.default(TIMESHEET_REVIEW_LOOKBACK_DAYS.default),
	})
	.strict()
export type TimesheetReviewQuery = z.infer<typeof timesheetReviewQuerySchema>

export const TIMESHEET_EXPORT_KINDS = ['cards', 'summary'] as const
export const timesheetExportQuerySchema = z
	.object({
		date: localDateSchema.optional(),
		periodStart: localDateSchema.optional(),
		kind: z.enum(TIMESHEET_EXPORT_KINDS).default('cards'),
		scopeId: idSchema.optional(),
		positionId: idSchema.optional(),
		staffId: idSchema.optional(),
	})
	.strict()
	.refine(
		(q) => !(q.date && q.periodStart),
		'Use date or periodStart, not both',
	)
export type TimesheetExportQuery = z.infer<typeof timesheetExportQuerySchema>

// ---------------------------------------------------------------------------
// Card writes
// ---------------------------------------------------------------------------

const breakInputSchema = z.union([
	z
		.object({
			kind: z.enum(BREAK_KINDS).default('meal'),
			startAt: instantSchema,
			endAt: instantSchema,
		})
		.strict(),
	z
		.object({
			kind: z.enum(BREAK_KINDS).default('meal'),
			startTime: timeOfDaySchema,
			endTime: timeOfDaySchema,
		})
		.strict(),
])
export type TimeCardBreakInput = z.infer<typeof breakInputSchema>

/** Breaks are `paid` by the scope's break rules for their kind, never by the caller. */
const breaksSchema = z.array(breakInputSchema).max(12)

type TimesMode = 'instants' | 'local' | 'none' | 'mixed'

/** Which way a body gave its times: instants, local time of day, or neither. */
export function cardTimesMode(body: {
	clockInAt?: number
	clockOutAt?: number
	date?: string
	startTime?: string
	endTime?: string
}): TimesMode {
	const instants = body.clockInAt !== undefined || body.clockOutAt !== undefined
	const local =
		body.date !== undefined ||
		body.startTime !== undefined ||
		body.endTime !== undefined
	if (instants && local) return 'mixed'
	if (instants) return 'instants'
	if (local) return 'local'
	return 'none'
}

export const timeCardCreateSchema = z
	.object({
		staffId: idSchema,
		scopeId: idSchema,
		/** Required when the person holds more than one role at the scope. */
		positionId: idSchema.optional(),
		clockInAt: instantSchema.optional(),
		clockOutAt: instantSchema.optional(),
		date: localDateSchema.optional(),
		startTime: timeOfDaySchema.optional(),
		endTime: timeOfDaySchema.optional(),
		breaks: breaksSchema.default([]),
		cashTipsMinor: tipSchema.optional(),
		creditTipsMinor: tipSchema.optional(),
		managerNote: z.string().trim().max(1000).optional(),
		reason: timesheetReasonSchema,
	})
	.strict()
	.superRefine((body, ctx) => {
		const mode = cardTimesMode(body)
		const complete =
			mode === 'instants'
				? body.clockInAt !== undefined && body.clockOutAt !== undefined
				: mode === 'local'
					? body.date !== undefined &&
						body.startTime !== undefined &&
						body.endTime !== undefined
					: false
		if (!complete) {
			ctx.addIssue({
				code: 'custom',
				path: ['clockInAt'],
				message:
					'Give clockInAt and clockOutAt, or date with startTime and endTime',
			})
		}
	})
export type TimeCardCreate = z.infer<typeof timeCardCreateSchema>

export const timeCardUpdateSchema = z
	.object({
		/** The card version the editor last saw. */
		expectedVersion: z.number().int().min(1),
		positionId: idSchema.optional(),
		clockInAt: instantSchema.optional(),
		clockOutAt: instantSchema.optional(),
		date: localDateSchema.optional(),
		startTime: timeOfDaySchema.optional(),
		endTime: timeOfDaySchema.optional(),
		/** Replaces every break on the card. */
		breaks: breaksSchema.optional(),
		cashTipsMinor: tipSchema.optional(),
		creditTipsMinor: tipSchema.optional(),
		/** `null` clears the note. */
		managerNote: z.string().trim().max(1000).nullable().optional(),
		reason: timesheetReasonSchema,
	})
	.strict()
	.superRefine((body, ctx) => {
		const mode = cardTimesMode(body)
		if (mode === 'mixed') {
			ctx.addIssue({
				code: 'custom',
				path: ['date'],
				message: 'Give instants or local times, not both',
			})
		}
		if (
			mode === 'local' &&
			!(
				body.date !== undefined &&
				body.startTime !== undefined &&
				body.endTime !== undefined
			)
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['date'],
				message: 'Local times need date, startTime and endTime',
			})
		}
	})
export type TimeCardUpdate = z.infer<typeof timeCardUpdateSchema>

export const timeCardVoidSchema = z
	.object({
		expectedVersion: z.number().int().min(1),
		reason: timesheetReasonSchema,
	})
	.strict()
export type TimeCardVoid = z.infer<typeof timeCardVoidSchema>

export const timeCardReviewSchema = z
	.object({
		expectedVersion: z.number().int().min(1),
		note: z.string().trim().max(500).optional(),
	})
	.strict()
export type TimeCardReview = z.infer<typeof timeCardReviewSchema>

export const TIMESHEET_BATCH_MAX = 200

const batchEntriesSchema = z
	.array(z.object({ id: idSchema, version: z.number().int().min(1) }).strict())
	.min(1)
	.max(TIMESHEET_BATCH_MAX)
	.refine(
		(entries) =>
			new Set(entries.map((entry) => entry.id)).size === entries.length,
		'Each card once',
	)

export const timesheetApproveSchema = z
	.object({
		entries: batchEntriesSchema,
		note: z.string().trim().max(500).optional(),
	})
	.strict()
export type TimesheetApprove = z.infer<typeof timesheetApproveSchema>

/** Unlock and reopen undo a manager's decision, so they say why. */
export const timesheetReopenSchema = z
	.object({ entries: batchEntriesSchema, reason: timesheetReasonSchema })
	.strict()
export type TimesheetReopen = z.infer<typeof timesheetReopenSchema>

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

/** Stable machine codes for what a timesheet request can be refused with. */
export const TIMESHEET_ERROR_CODES = [
	'not_found',
	'stale_version',
	'card_locked',
	'card_approved',
	'in_future',
	'overlaps_existing',
	'ends_before_start',
	'too_long',
	'invalid_position',
	'position_required',
	'break_outside_card',
	'breaks_overlap',
	'breaks_need_clock_out',
	'open_card',
	'time_zone_unavailable',
	'pay_grant_required',
	'nothing_to_change',
	'needs_fix',
	'approval_not_enabled',
	'lock_not_enabled',
	'not_approved',
	'not_locked',
	'already_approved',
	'already_locked',
	'range_too_large',
	'invalid_pay_period',
] as const
export type TimesheetErrorCode = (typeof TIMESHEET_ERROR_CODES)[number]

/** Issues that make a card unfit to approve or mark reviewed until it is fixed. */
export const BLOCKING_ISSUES = [
	'missing_clock_out',
	'open_break',
	'negative_duration',
] as const satisfies readonly EntryIssueCode[]

export function hasBlockingIssue(issues: readonly string[]): boolean {
	return issues.some((issue) =>
		(BLOCKING_ISSUES as readonly string[]).includes(issue),
	)
}

export type TimesheetMinutes = {
	regularMinutes: number
	overtimeMinutes: number
	doubleTimeMinutes: number
	holidayMinutes: number
	/** Paid worked minutes: elapsed minus unpaid breaks. */
	paidMinutes: number
	unpaidBreakMinutes: number
}

/** Money for one card. Present only when the token holds the pay grant. */
export type TimesheetCardMoney = {
	/** Always true: estimates, never payroll. */
	estimate: true
	currency: string | null
	/** Hourly rate snapshot taken when the card was opened. */
	rateMinor: number | null
	/** Estimated pay for the card, overtime premiums included. */
	payMinor: number | null
	cashTipsMinor: number
	creditTipsMinor: number
}

export type TimesheetBreak = {
	id: string
	kind: BreakKind
	paid: boolean
	startAt: number
	endAt: number | null
}

export type TimesheetCard = {
	id: string
	staffId: string
	scopeId: string
	positionId: string | null
	positionName: string | null
	positionNameAr: string | null
	/** Scope time zone, fixed when the card was created; times display in it. */
	timeZone: string
	/** Business date of the clock-in. */
	localDate: string
	clockInAt: number
	clockOutAt: number | null
	status: TimesheetStatus
	issues: EntryIssueCode[]
	/** A manager has looked at the card since its last change. */
	reviewed: boolean
	/** The card was changed by a manager (or created by one). */
	edited: boolean
	clockOutKind: string | null
	breaks: TimesheetBreak[]
	/** Figures from the shared time math; open cards are measured to now. */
	minutes: TimesheetMinutes
	/**
	 * True when the card is approved or locked and its frozen figures no longer
	 * match what the shared math gives today (for example a neighbouring card
	 * moved overtime). Unlock and review before paying.
	 */
	figuresChanged: boolean
	managerNote: string | null
	version: number
	approvedAt: number | null
	lockedAt: number | null
	/** Absent without `read:staff_pay:any`. */
	money?: TimesheetCardMoney
}

export type TimesheetTotals = TimesheetMinutes & {
	cards: number
	open: number
	needsReview: number
	approved: number
	locked: number
}

/** Per-person money. Present only with the pay grant. */
export type TimesheetPersonMoney = {
	estimate: true
	payMinorByCurrency: Record<string, number>
	cashTipsMinorByCurrency: Record<string, number>
	creditTipsMinorByCurrency: Record<string, number>
	/** Worked minutes without a rate, so left out of the pay figure. */
	unpricedMinutes: number
}

export type TimesheetPerson = {
	staffId: string
	firstName: string
	lastName: string
	firstNameAr: string | null
	lastNameAr: string | null
	employeeNumber: string | null
	terminated: boolean
	cards: TimesheetCard[]
	totals: TimesheetTotals
	money?: TimesheetPersonMoney
}

/** Labor cost across the whole view. Needs the labor or the pay grant. */
export type TimesheetLabor = {
	estimate: true
	payMinorByCurrency: Record<string, number>
	unpricedMinutes: number
}

export type TimesheetFiltersEcho = {
	scopeId: string | null
	positionId: string | null
	staffId: string | null
	status: TimesheetStatus | null
}

export type TimesheetPayPeriod = {
	type: string
	start: string
	end: string
	days: number
	previousStart: string
	nextStart: string
}

export type TimesheetView = {
	serverNow: number
	people: TimesheetPerson[]
	totals: TimesheetTotals
	filters: TimesheetFiltersEcho
	/** More than the response limit matched; narrow the filters. */
	truncated: boolean
	labor?: TimesheetLabor
}

export type TimesheetDayView = TimesheetView & { date: string }
export type TimesheetPeriodView = TimesheetView & {
	period: TimesheetPayPeriod
}
export type TimesheetReviewView = TimesheetView & {
	/** Cards in the queue, by issue code. */
	byIssue: Partial<Record<EntryIssueCode, number>>
}

export type TimesheetEditLogEntry = {
	id: string
	entryId: string
	/** Opaque operator id, or a system actor. */
	editorId: string
	via: string
	action: string
	reason: string
	before: Record<string, unknown> | null
	after: Record<string, unknown> | null
	/** Change in paid minutes this edit made; negative when it cut hours. */
	hoursDeltaMinutes: number | null
	createdAt: number
}

export type TimesheetPunchRow = {
	id: string
	kind: string
	effectiveAt: number | null
	serverAt: number
	source: string
	flags: string[]
}

export type TimesheetCardDetail = {
	serverNow: number
	person: Omit<TimesheetPerson, 'cards' | 'totals' | 'money'>
	card: TimesheetCard
	edits: TimesheetEditLogEntry[]
	punches: TimesheetPunchRow[]
}

export type TimesheetWriteResult = {
	/** The card after the change; null once it was voided. */
	card: TimesheetCard | null
	edit: TimesheetEditLogEntry
	/** True when the edit cut the person's paid hours (they are told). */
	reducedHours: boolean
}

export type TimesheetBatchResult = {
	results: Array<{
		id: string
		ok: boolean
		/** Present when `ok` is false. */
		code?: TimesheetErrorCode
		version?: number
		status?: TimesheetStatus
	}>
	changed: number
	skipped: number
}

export type PayrollSummaryRow = {
	staffId: string
	employeeNumber: string | null
	firstName: string
	lastName: string
	cards: number
	regularMinutes: number
	overtimeMinutes: number
	doubleTimeMinutes: number
	holidayMinutes: number
	paidMinutes: number
	unpaidBreakMinutes: number
	/** Cards still waiting to be approved (open, needs review, closed). */
	unapprovedCards: number
	/** Money: present only with the pay grant. */
	money?: {
		estimate: true
		/** The distinct hourly rates the person's cards carry, per currency. */
		ratesMinor: Array<{ currency: string; rateMinor: number }>
		payMinorByCurrency: Record<string, number>
		cashTipsMinorByCurrency: Record<string, number>
		creditTipsMinorByCurrency: Record<string, number>
		unpricedMinutes: number
	}
}

export type PayrollSummary = {
	serverNow: number
	period: TimesheetPayPeriod
	filters: TimesheetFiltersEcho
	rows: PayrollSummaryRow[]
	totals: TimesheetMinutes & { cards: number; unapprovedCards: number }
	/** Every card in the range is approved or locked. */
	readyForPayroll: boolean
	truncated: boolean
	labor?: TimesheetLabor
}

export type TimesheetExport = {
	filename: string
	kind: 'cards' | 'summary'
	rowCount: number
	/** Money columns are included only with the pay grant. */
	includesMoney: boolean
	headers: string[]
	rows: CsvCell[][]
	/** The same rows as formula-safe CSV text, UTF-8 with a byte order mark. */
	csv: string
}

export type PayPeriodSettingsView = {
	payPeriod: string
	payPeriodAnchor: string | null
	current: TimesheetPayPeriod
}

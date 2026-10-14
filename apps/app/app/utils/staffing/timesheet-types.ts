import {
	BREAK_KINDS,
	PAY_PERIOD_TYPES,
	type TIMESHEET_ERROR_CODES,
	TIMESHEET_STATUSES,
} from '@repo/staffing'
import { z } from 'zod'

/**
 * Shapes returned by `/operator/timeclock/timesheets`, parsed in the browser.
 * They mirror the response types in `@repo/staffing` (`timesheet-api.ts`);
 * `timesheet-types.test.ts` parses fixtures typed with those types so a drift
 * fails there. Issue codes stay plain strings here: an issue added on a newer
 * node must never make an older screen refuse the whole page.
 *
 * Money keys are optional on purpose: the server leaves them out (they are not
 * zero) when the token lacks the pay grant.
 */

const minorByCurrency = z.record(z.string(), z.number())

const minutesSchema = z.object({
	regularMinutes: z.number(),
	overtimeMinutes: z.number(),
	doubleTimeMinutes: z.number(),
	holidayMinutes: z.number(),
	paidMinutes: z.number(),
	unpaidBreakMinutes: z.number(),
})

export const timesheetBreakSchema = z.object({
	id: z.string(),
	kind: z.enum(BREAK_KINDS),
	paid: z.boolean(),
	startAt: z.number(),
	endAt: z.number().nullable(),
})
export type TimesheetBreakRow = z.infer<typeof timesheetBreakSchema>

const cardMoneySchema = z.object({
	estimate: z.literal(true),
	currency: z.string().nullable(),
	rateMinor: z.number().nullable(),
	payMinor: z.number().nullable(),
	cashTipsMinor: z.number(),
	creditTipsMinor: z.number(),
})

export const timesheetCardSchema = z.object({
	id: z.string(),
	staffId: z.string(),
	scopeId: z.string(),
	positionId: z.string().nullable(),
	positionName: z.string().nullable(),
	positionNameAr: z.string().nullable(),
	timeZone: z.string(),
	localDate: z.string(),
	clockInAt: z.number(),
	clockOutAt: z.number().nullable(),
	status: z.enum(TIMESHEET_STATUSES),
	issues: z.array(z.string()),
	reviewed: z.boolean(),
	edited: z.boolean(),
	clockOutKind: z.string().nullable(),
	breaks: z.array(timesheetBreakSchema),
	minutes: minutesSchema,
	figuresChanged: z.boolean(),
	managerNote: z.string().nullable(),
	version: z.number(),
	approvedAt: z.number().nullable(),
	lockedAt: z.number().nullable(),
	money: cardMoneySchema.optional(),
})
export type TimesheetCardRow = z.infer<typeof timesheetCardSchema>

const totalsSchema = minutesSchema.extend({
	cards: z.number(),
	open: z.number(),
	needsReview: z.number(),
	approved: z.number(),
	locked: z.number(),
})

const personMoneySchema = z.object({
	estimate: z.literal(true),
	payMinorByCurrency: minorByCurrency,
	cashTipsMinorByCurrency: minorByCurrency,
	creditTipsMinorByCurrency: minorByCurrency,
	unpricedMinutes: z.number(),
})

const personBase = z.object({
	staffId: z.string(),
	firstName: z.string(),
	lastName: z.string(),
	firstNameAr: z.string().nullable(),
	lastNameAr: z.string().nullable(),
	employeeNumber: z.string().nullable(),
	terminated: z.boolean(),
})
export type TimesheetPersonInfo = z.infer<typeof personBase>

export const timesheetPersonSchema = personBase.extend({
	cards: z.array(timesheetCardSchema),
	totals: totalsSchema,
	money: personMoneySchema.optional(),
})
export type TimesheetPersonRow = z.infer<typeof timesheetPersonSchema>

const laborSchema = z.object({
	estimate: z.literal(true),
	payMinorByCurrency: minorByCurrency,
	unpricedMinutes: z.number(),
})

const filtersEchoSchema = z.object({
	scopeId: z.string().nullable(),
	positionId: z.string().nullable(),
	staffId: z.string().nullable(),
	status: z.enum(TIMESHEET_STATUSES).nullable(),
})

const viewBase = z.object({
	serverNow: z.number(),
	people: z.array(timesheetPersonSchema),
	totals: totalsSchema,
	filters: filtersEchoSchema,
	truncated: z.boolean(),
	labor: laborSchema.optional(),
})

export const payPeriodSchema = z.object({
	type: z.string(),
	start: z.string(),
	end: z.string(),
	days: z.number(),
	previousStart: z.string(),
	nextStart: z.string(),
})
export type PayPeriodRow = z.infer<typeof payPeriodSchema>

export const dayViewSchema = viewBase.extend({ date: z.string() })
export const periodViewSchema = viewBase.extend({ period: payPeriodSchema })
export const reviewViewSchema = viewBase.extend({
	byIssue: z.record(z.string(), z.number()),
})
export type TimesheetViewData = z.infer<typeof viewBase>
export type TimesheetPeriodData = z.infer<typeof periodViewSchema>
export type TimesheetReviewData = z.infer<typeof reviewViewSchema>

export const editLogEntrySchema = z.object({
	id: z.string(),
	entryId: z.string(),
	editorId: z.string(),
	via: z.string(),
	action: z.string(),
	reason: z.string(),
	before: z.record(z.string(), z.unknown()).nullable(),
	after: z.record(z.string(), z.unknown()).nullable(),
	hoursDeltaMinutes: z.number().nullable(),
	createdAt: z.number(),
})
export type EditLogRow = z.infer<typeof editLogEntrySchema>

export const punchRowSchema = z.object({
	id: z.string(),
	kind: z.string(),
	effectiveAt: z.number().nullable(),
	serverAt: z.number(),
	source: z.string(),
	flags: z.array(z.string()),
})
export type PunchRow = z.infer<typeof punchRowSchema>

export const cardDetailSchema = z.object({
	serverNow: z.number(),
	person: personBase,
	card: timesheetCardSchema,
	edits: z.array(editLogEntrySchema),
	punches: z.array(punchRowSchema),
})
export type CardDetail = z.infer<typeof cardDetailSchema>

export const writeResultSchema = z.object({
	card: timesheetCardSchema.nullable(),
	edit: editLogEntrySchema,
	reducedHours: z.boolean(),
})
export type WriteResult = z.infer<typeof writeResultSchema>

export const batchResultSchema = z.object({
	results: z.array(
		z.object({
			id: z.string(),
			ok: z.boolean(),
			code: z.string().optional(),
			version: z.number().optional(),
			status: z.string().optional(),
		}),
	),
	changed: z.number(),
	skipped: z.number(),
})
export type BatchResult = z.infer<typeof batchResultSchema>

const summaryMoneySchema = z.object({
	estimate: z.literal(true),
	ratesMinor: z.array(
		z.object({ currency: z.string(), rateMinor: z.number() }),
	),
	payMinorByCurrency: minorByCurrency,
	cashTipsMinorByCurrency: minorByCurrency,
	creditTipsMinorByCurrency: minorByCurrency,
	unpricedMinutes: z.number(),
})

export const summaryRowSchema = z.object({
	staffId: z.string(),
	employeeNumber: z.string().nullable(),
	firstName: z.string(),
	lastName: z.string(),
	cards: z.number(),
	regularMinutes: z.number(),
	overtimeMinutes: z.number(),
	doubleTimeMinutes: z.number(),
	holidayMinutes: z.number(),
	paidMinutes: z.number(),
	unpaidBreakMinutes: z.number(),
	unapprovedCards: z.number(),
	money: summaryMoneySchema.optional(),
})
export type SummaryRow = z.infer<typeof summaryRowSchema>

export const payrollSummarySchema = z.object({
	serverNow: z.number(),
	period: payPeriodSchema,
	filters: filtersEchoSchema,
	rows: z.array(summaryRowSchema),
	totals: minutesSchema.extend({
		cards: z.number(),
		unapprovedCards: z.number(),
	}),
	readyForPayroll: z.boolean(),
	truncated: z.boolean(),
	labor: laborSchema.optional(),
})
export type PayrollSummaryData = z.infer<typeof payrollSummarySchema>

const csvCell = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const exportSchema = z.object({
	filename: z.string(),
	kind: z.enum(['cards', 'summary']),
	rowCount: z.number(),
	includesMoney: z.boolean(),
	headers: z.array(z.string()),
	rows: z.array(z.array(csvCell)),
	csv: z.string(),
})
export type ExportData = z.infer<typeof exportSchema>

export const payPeriodSettingsSchema = z.object({
	payPeriod: z.enum(PAY_PERIOD_TYPES).catch('weekly'),
	payPeriodAnchor: z.string().nullable(),
	current: payPeriodSchema,
})
export type PayPeriodSettingsData = z.infer<typeof payPeriodSettingsSchema>

/** Only the part of `GET /policies` the timesheets read: who approves. */
export const approvalPoliciesSchema = z.object({
	default: z.object({ timesheetApprovalMode: z.string() }).nullable(),
	scopes: z.array(
		z.object({
			scopeId: z.string().nullable(),
			timesheetApprovalMode: z.string(),
		}),
	),
})

/** Codes the timesheet API answers with, narrowed for message lookups. */
export type TimesheetErrorCodeName = (typeof TIMESHEET_ERROR_CODES)[number]

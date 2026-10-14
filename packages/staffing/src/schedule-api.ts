import { z } from 'zod'
import { type SalesSource, type TargetStatus } from './labor-api.ts'
import { type PublicationNotification } from './schedule-publish.ts'
import { hhmmSchema, minuteOfDayFromHhmm } from './schedule-time.ts'
import {
	currencySchema,
	localDateSchema as calendarDateSchema,
	positionColorKeySchema,
} from './schemas.ts'

/**
 * Wire contracts of `/operator/schedule`: request schemas (shared by the App
 * and tenant-api), the stable conflict vocabulary, and the response shapes.
 * No UI strings: conflict codes are keys the App translates.
 */

/** Earliest and latest date the schedule accepts (week math stays inside four-digit years). */
export const SCHEDULE_MIN_DATE = '2000-01-01'
export const SCHEDULE_MAX_DATE = '2099-12-31'

/** A real calendar date inside the schedule's supported range. */
const localDateSchema = calendarDateSchema.refine(
	(value) => value >= SCHEDULE_MIN_DATE && value <= SCHEDULE_MAX_DATE,
	`Date must be between ${SCHEDULE_MIN_DATE} and ${SCHEDULE_MAX_DATE}`,
)

const idSchema = z.string().min(1).max(64)
const noteSchema = z.string().trim().max(500)

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Conflicts are warnings. They are reported with the shift that caused them and
 * never stop a write. The codes are stable: the App maps each to a message.
 */
export const SCHEDULE_CONFLICT_CODES = [
	/** The person has another shift that overlaps this one. */
	'overlap',
	/** Approved time off covers part of the shift. */
	'time_off',
	/** The shift falls outside approved availability or inside a blocked window. */
	'unavailable',
	/** Scheduled paid time reaches overtime under the scope's labor policy. */
	'overtime',
	/** Less than the minimum rest since the person's previous shift. */
	'min_rest',
	/** The person holds no pay row for the shift's position at the scope. */
	'position_mismatch',
	/** The person has no active assignment at the shift's scope. */
	'not_at_scope',
	/** The person's roster status is on leave. */
	'staff_on_leave',
] as const
export type ScheduleConflictCode = (typeof SCHEDULE_CONFLICT_CODES)[number]

export type ScheduleConflict = {
	code: ScheduleConflictCode
	shiftId: string
	/** The other shift, time-off request or availability row involved. */
	relatedId?: string
	/** Local date the conflict falls on, where one applies. */
	date?: string
	/** Numbers only (minutes, never names or money). */
	detail?: Record<string, number>
}

/** What a manager sees for a shift: a draft, live, edited since publish, or about to be removed. */
export const SHIFT_VIEW_STATES = [
	'draft',
	'published',
	'changed',
	'cancel_pending',
] as const
export type ShiftViewState = (typeof SHIFT_VIEW_STATES)[number]

export const SCHEDULE_NOTIFY_MODES = ['everyone', 'changed', 'nobody'] as const
export const scheduleNotifyModeSchema = z.enum(SCHEDULE_NOTIFY_MODES)
export type ScheduleNotifyMode = z.infer<typeof scheduleNotifyModeSchema>

/** Most shifts one request may create or one week may hold. */
export const SCHEDULE_MAX_DATES_PER_CREATE = 31
export const SCHEDULE_MAX_SHIFTS_PER_WEEK = 2500
export const SCHEDULE_MAX_TEMPLATE_SLOTS = 500

/** Trailing weeks the demand guide looks at. */
export const DEMAND_TRAILING_WEEKS = 8

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export const shiftCreateSchema = z
	.object({
		scopeId: idSchema,
		/** Null or absent creates an open shift. */
		staffId: idSchema.nullable().optional(),
		positionId: idSchema.nullable().optional(),
		/** One shift is created for each date (the "apply to" days). */
		dates: z.array(localDateSchema).min(1).max(SCHEDULE_MAX_DATES_PER_CREATE),
		startTime: hhmmSchema,
		/** At or before the start means the next day (an overnight shift). */
		endTime: hhmmSchema,
		unpaidBreakMinutes: z.number().int().min(0).max(720).default(0),
		notes: noteSchema.nullable().optional(),
	})
	.strict()
	.refine((body) => new Set(body.dates).size === body.dates.length, {
		message: 'Dates must be unique',
		path: ['dates'],
	})
export type ShiftCreate = z.infer<typeof shiftCreateSchema>

export const shiftUpdateSchema = z
	.object({
		/** Optimistic concurrency: the shift version the editor was looking at. */
		expectedVersion: z.number().int().min(1).optional(),
		date: localDateSchema.optional(),
		startTime: hhmmSchema.optional(),
		endTime: hhmmSchema.optional(),
		positionId: idSchema.nullable().optional(),
		/** Null makes the shift open. */
		staffId: idSchema.nullable().optional(),
		unpaidBreakMinutes: z.number().int().min(0).max(720).optional(),
		notes: noteSchema.nullable().optional(),
	})
	.strict()
	.refine(
		(body) => (body.startTime === undefined) === (body.endTime === undefined),
		{
			message: 'Give the start and the end together',
			path: ['endTime'],
		},
	)
	.refine(
		(body) =>
			body.date !== undefined ||
			body.startTime !== undefined ||
			body.positionId !== undefined ||
			body.staffId !== undefined ||
			body.unpaidBreakMinutes !== undefined ||
			body.notes !== undefined,
		{ message: 'Nothing to change' },
	)
export type ShiftUpdate = z.infer<typeof shiftUpdateSchema>

export const shiftAssignSchema = z
	.object({
		staffId: idSchema,
		expectedVersion: z.number().int().min(1).optional(),
	})
	.strict()

export const shiftUnassignSchema = z
	.object({ expectedVersion: z.number().int().min(1).optional() })
	.strict()

export const shiftDeleteQuerySchema = z.object({
	expectedVersion: z.coerce.number().int().min(1).optional(),
})

// ---------------------------------------------------------------------------
// Week, copy, templates, recommend, publish, demand
// ---------------------------------------------------------------------------

export const weekQuerySchema = z.object({
	scopeId: idSchema,
	/** Any date in the week; the server snaps it to the scope's week start. */
	date: localDateSchema,
})
export type WeekQuery = z.infer<typeof weekQuerySchema>

/** Which shifts of the source week a copy or recommendation takes. */
export const scheduleScopeSchema = z.discriminatedUnion('mode', [
	z.object({ mode: z.literal('all') }),
	z.object({
		mode: z.literal('positions'),
		positionIds: z.array(idSchema).min(1).max(100),
	}),
	z.object({
		mode: z.literal('people'),
		staffIds: z.array(idSchema).min(1).max(500),
	}),
])
export type ScheduleScope = z.infer<typeof scheduleScopeSchema>

export const weekCopySchema = z
	.object({
		scopeId: idSchema,
		fromWeekStart: localDateSchema,
		toWeekStart: localDateSchema,
		scope: scheduleScopeSchema.default({ mode: 'all' }),
		/** Open shifts of the source week come along (people scopes never copy them). */
		includeOpenShifts: z.boolean().default(true),
	})
	.strict()
export type WeekCopy = z.infer<typeof weekCopySchema>

export const templateCreateSchema = z
	.object({
		scopeId: idSchema,
		name: z.string().trim().min(1).max(60),
		/** The template is made from this week of the scope's current schedule. */
		fromWeekStart: localDateSchema,
		scope: scheduleScopeSchema.default({ mode: 'all' }),
		/** Keep who works each slot; off makes every slot an open shift. */
		keepAssignments: z.boolean().default(true),
	})
	.strict()
export type TemplateCreate = z.infer<typeof templateCreateSchema>

export const templateApplySchema = z
	.object({
		weekStart: localDateSchema,
		/** `open` turns every slot into an open shift. */
		assignments: z.enum(['keep', 'open']).default('keep'),
	})
	.strict()
export type TemplateApply = z.infer<typeof templateApplySchema>

export const templateListQuerySchema = z.object({ scopeId: idSchema })

export const recommendSchema = z
	.object({
		scopeId: idSchema,
		baseWeekStart: localDateSchema,
		targetWeekStart: localDateSchema,
		scope: scheduleScopeSchema.default({ mode: 'all' }),
		/** False returns the proposal without writing anything. */
		apply: z.boolean().default(false),
	})
	.strict()
export type Recommend = z.infer<typeof recommendSchema>

/** Why a recommended shift was left open instead of keeping its person. */
export const RECOMMEND_OPEN_REASONS = [
	'time_off',
	'unavailable',
	'overlap',
	'inactive',
	'not_at_scope',
	'position_mismatch',
] as const
export type RecommendOpenReason = (typeof RECOMMEND_OPEN_REASONS)[number]

export const publishSchema = z
	.object({
		scopeId: idSchema,
		weekStart: localDateSchema,
		notifyMode: scheduleNotifyModeSchema.default('changed'),
		/** Week version the manager was looking at (stale publishes are refused). */
		expectedVersion: z.number().int().min(0).optional(),
	})
	.strict()
export type Publish = z.infer<typeof publishSchema>

export const publicationsQuerySchema = z.object({
	scopeId: idSchema,
	weekStart: localDateSchema.optional(),
})

export const demandQuerySchema = z.object({
	scopeId: idSchema,
	date: localDateSchema,
})

export const scheduleSettingsUpdateSchema = z
	.object({
		/** Zero switches the minimum rest warning off. */
		minRestMinutes: z.number().int().min(0).max(1440).optional(),
		timeOffMinNoticeDays: z.number().int().min(0).max(120).optional(),
	})
	.strict()
	.refine(
		(body) =>
			body.minRestMinutes !== undefined ||
			body.timeOffMinNoticeDays !== undefined,
		{ message: 'Nothing to change' },
	)
export type ScheduleSettingsUpdate = z.infer<
	typeof scheduleSettingsUpdateSchema
>

// ---------------------------------------------------------------------------
// Time off and availability
// ---------------------------------------------------------------------------

export const TIME_OFF_CATEGORIES = ['unpaid', 'pto', 'sick'] as const
export const timeOffCategorySchema = z.enum(TIME_OFF_CATEGORIES)

/**
 * A manager entering a request for someone is final (`manager_entered`:
 * approved at once). `staff_request` records a request the person made, which
 * waits for a decision. Staff cannot sign in to submit one themselves yet.
 */
export const SCHEDULE_SUBMISSIONS = [
	'manager_entered',
	'staff_request',
] as const
export const scheduleSubmissionSchema = z.enum(SCHEDULE_SUBMISSIONS)

export const SCHEDULE_REQUEST_STATUSES = [
	'pending',
	'approved',
	'rejected',
	'cancelled',
] as const
export const scheduleRequestStatusSchema = z.enum(SCHEDULE_REQUEST_STATUSES)

/** A time that may be "24:00", the exclusive end of a day. */
export const availabilityTimeSchema = z
	.string()
	.regex(/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/, 'Use the format HH:MM (24 hour)')

export function minuteOfDayFromAvailabilityTime(value: string): number {
	return value === '24:00' ? 1440 : minuteOfDayFromHhmm(value)
}

export const timeOffCreateSchema = z
	.object({
		staffId: idSchema,
		category: timeOffCategorySchema.default('unpaid'),
		startDate: localDateSchema,
		endDate: localDateSchema,
		allDay: z.boolean().default(true),
		/** Partial day only (one date): when the time off starts and ends. */
		startTime: availabilityTimeSchema.optional(),
		endTime: availabilityTimeSchema.optional(),
		note: noteSchema.nullable().optional(),
		submission: scheduleSubmissionSchema.default('manager_entered'),
	})
	.strict()
	.superRefine((body, ctx) => {
		if (body.endDate < body.startDate) {
			ctx.addIssue({
				code: 'custom',
				path: ['endDate'],
				message: 'End date must not be before the start date',
			})
		}
		if (body.allDay) {
			if (body.startTime !== undefined || body.endTime !== undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['startTime'],
					message: 'A whole-day request has no times',
				})
			}
			return
		}
		if (body.startTime === undefined || body.endTime === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['startTime'],
				message: 'A part-day request needs a start and an end time',
			})
			return
		}
		if (body.startDate !== body.endDate) {
			ctx.addIssue({
				code: 'custom',
				path: ['endDate'],
				message: 'A part-day request covers one date',
			})
		}
		if (
			minuteOfDayFromAvailabilityTime(body.endTime) <=
			minuteOfDayFromAvailabilityTime(body.startTime)
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['endTime'],
				message: 'The end must be after the start',
			})
		}
	})
export type TimeOffCreate = z.infer<typeof timeOffCreateSchema>

export const timeOffListQuerySchema = z.object({
	staffId: idSchema.optional(),
	status: scheduleRequestStatusSchema.optional(),
	/** Requests overlapping this window (inclusive local dates). */
	from: localDateSchema.optional(),
	to: localDateSchema.optional(),
	/** Only people assigned at this scope. */
	scopeId: idSchema.optional(),
	limit: z.coerce.number().int().min(1).max(500).default(200),
})
export type TimeOffListQuery = z.infer<typeof timeOffListQuerySchema>

export const scheduleDecisionSchema = z
	.object({
		decision: z.enum(['approve', 'reject']),
		note: noteSchema.optional(),
	})
	.strict()
export type ScheduleDecision = z.infer<typeof scheduleDecisionSchema>

export const AVAILABILITY_KINDS = ['weekly', 'one_off'] as const
export const AVAILABILITY_WINDOWS = ['available', 'unavailable'] as const

export const availabilityRowSchema = z
	.object({
		kind: z.enum(AVAILABILITY_KINDS),
		/** 0 = Sunday ... 6 = Saturday; weekly rows only. */
		weekday: z.number().int().min(0).max(6).optional(),
		/** One-off rows only. */
		date: localDateSchema.optional(),
		availability: z.enum(AVAILABILITY_WINDOWS),
		allDay: z.boolean().default(true),
		startTime: availabilityTimeSchema.optional(),
		endTime: availabilityTimeSchema.optional(),
		/** Weekly rows: the dates the pattern holds for. */
		effectiveFrom: localDateSchema.optional(),
		effectiveTo: localDateSchema.optional(),
		note: noteSchema.nullable().optional(),
	})
	.strict()
	.superRefine((row, ctx) => {
		if (row.kind === 'weekly') {
			if (row.weekday === undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['weekday'],
					message: 'A weekly row needs a weekday',
				})
			}
			if (row.date !== undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['date'],
					message: 'A weekly row has no date',
				})
			}
		} else {
			if (row.date === undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['date'],
					message: 'A one-off row needs a date',
				})
			}
			if (row.weekday !== undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['weekday'],
					message: 'A one-off row has no weekday',
				})
			}
			if (row.effectiveFrom !== undefined || row.effectiveTo !== undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['effectiveFrom'],
					message: 'A one-off row has no effective dates',
				})
			}
		}
		if (
			row.effectiveFrom !== undefined &&
			row.effectiveTo !== undefined &&
			row.effectiveTo < row.effectiveFrom
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['effectiveTo'],
				message: 'End date must not be before the start date',
			})
		}
		if (row.allDay) {
			if (row.startTime !== undefined || row.endTime !== undefined) {
				ctx.addIssue({
					code: 'custom',
					path: ['startTime'],
					message: 'An all-day row has no times',
				})
			}
			return
		}
		if (row.startTime === undefined || row.endTime === undefined) {
			ctx.addIssue({
				code: 'custom',
				path: ['startTime'],
				message: 'A timed row needs a start and an end',
			})
			return
		}
		if (
			minuteOfDayFromAvailabilityTime(row.endTime) <=
			minuteOfDayFromAvailabilityTime(row.startTime)
		) {
			ctx.addIssue({
				code: 'custom',
				path: ['endTime'],
				message: 'The end must be after the start',
			})
		}
	})
export type AvailabilityRowInput = z.infer<typeof availabilityRowSchema>

export const availabilityCreateSchema = z
	.object({
		staffId: idSchema,
		rows: z.array(availabilityRowSchema).min(1).max(50),
		submission: scheduleSubmissionSchema.default('manager_entered'),
		/**
		 * Weekly rows replace the person's earlier approved weekly pattern when
		 * they are approved (the earlier rows become superseded).
		 */
		replaceWeekly: z.boolean().default(false),
	})
	.strict()
export type AvailabilityCreate = z.infer<typeof availabilityCreateSchema>

export const availabilityDecisionSchema = z
	.object({
		ids: z.array(idSchema).min(1).max(50),
		decision: z.enum(['approve', 'reject']),
		note: noteSchema.optional(),
	})
	.strict()

export const availabilityListQuerySchema = z.object({
	staffId: idSchema.optional(),
	status: z
		.enum(['pending', 'approved', 'rejected', 'cancelled', 'superseded'])
		.optional(),
	scopeId: idSchema.optional(),
	limit: z.coerce.number().int().min(1).max(500).default(200),
})

// ---------------------------------------------------------------------------
// Swap, cover and drop requests
// ---------------------------------------------------------------------------

export const SHIFT_REQUEST_KINDS = ['swap', 'cover', 'drop'] as const
export const shiftRequestKindSchema = z.enum(SHIFT_REQUEST_KINDS)

export const shiftRequestCreateSchema = z
	.object({
		kind: shiftRequestKindSchema,
		shiftId: idSchema,
		requesterStaffId: idSchema,
		/** Swap: the person trading. Cover: the person taking the shift. */
		targetStaffId: idSchema.optional(),
		/** Swap only: the shift the requester takes in return. */
		targetShiftId: idSchema.optional(),
		note: noteSchema.nullable().optional(),
		submission: scheduleSubmissionSchema.default('staff_request'),
	})
	.strict()
	.superRefine((body, ctx) => {
		if (body.kind === 'swap') {
			if (!body.targetStaffId || !body.targetShiftId) {
				ctx.addIssue({
					code: 'custom',
					path: ['targetShiftId'],
					message: 'A swap needs the other person and their shift',
				})
			}
		} else if (body.kind === 'cover') {
			if (!body.targetStaffId) {
				ctx.addIssue({
					code: 'custom',
					path: ['targetStaffId'],
					message: 'A cover needs the person taking the shift',
				})
			}
			if (body.targetShiftId) {
				ctx.addIssue({
					code: 'custom',
					path: ['targetShiftId'],
					message: 'Only a swap names a second shift',
				})
			}
		} else if (body.targetStaffId || body.targetShiftId) {
			ctx.addIssue({
				code: 'custom',
				path: ['targetStaffId'],
				message: 'A drop names nobody else',
			})
		}
	})
export type ShiftRequestCreate = z.infer<typeof shiftRequestCreateSchema>

export const shiftRequestListQuerySchema = z.object({
	status: scheduleRequestStatusSchema.optional(),
	kind: shiftRequestKindSchema.optional(),
	scopeId: idSchema.optional(),
	limit: z.coerce.number().int().min(1).max(500).default(200),
})

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export type ScheduleShiftView = {
	id: string
	scopeId: string
	/** Null is an open shift. The effective value: a pending edit shows. */
	staffId: string | null
	positionId: string | null
	startsAt: number
	endsAt: number
	localDate: string
	timeZone: string
	unpaidBreakMinutes: number
	/** Paid minutes: the length minus the unpaid break. */
	paidMinutes: number
	notes: string | null
	state: ShiftViewState
	/** The published fields, when a pending edit differs from them. */
	published: {
		staffId: string | null
		positionId: string | null
		startsAt: number
		endsAt: number
		unpaidBreakMinutes: number
		notes: string | null
	} | null
	version: number
	conflicts: ScheduleConflict[]
	/** Estimated cost of the shift in minor units; only with the pay grant. */
	costMinor?: number | null
	currency?: string | null
}

export type SchedulePersonView = {
	id: string
	firstName: string
	lastName: string
	firstNameAr: string | null
	lastNameAr: string | null
	status: string
	/** Positions the person holds a pay row for at this scope. */
	positionIds: string[]
	showInSchedule: boolean
	eligibleOpenShifts: boolean
	/** Paid minutes scheduled this week across the days of the week. */
	weekMinutes: number
	overtimeMinutes: number
	/** Estimated pay this week at this scope; only with the pay grant. */
	weekCostMinor?: Record<string, number>
}

export type ScheduleOverlay = {
	staffId: string
	timeOff: Array<{
		id: string
		status: 'pending' | 'approved'
		category: string
		startDate: string
		endDate: string
		allDay: boolean
		startMinute: number | null
		endMinute: number | null
	}>
	availability: Array<{
		id: string
		kind: 'weekly' | 'one_off'
		weekday: number | null
		date: string | null
		availability: 'available' | 'unavailable'
		allDay: boolean
		startMinute: number | null
		endMinute: number | null
		effectiveFrom: string | null
		effectiveTo: string | null
	}>
}

export type ScheduleDayFooter = {
	date: string
	/** Paid minutes worked on this local date (minutes after midnight count here). */
	minutes: number
	overtimeMinutes: number
	/** People with paid time on the date. */
	headcount: number
	openShifts: number
	/** Paid minutes of open shifts that start on this date. */
	openMinutes: number
	/** Estimated cost by currency; only with the labor grant. */
	costMinorByCurrency?: Record<string, number>
}

export type ScheduleLaborTarget = {
	/** The scope's target labor share in basis points, when one is set. */
	targetBp: number | null
	/**
	 * Where the guide sales come from. Online orders alone are not all of a
	 * the whole business's sales, so that source is never judged against the target.
	 */
	salesSource: SalesSource
	/** The sales cover everything the scope sells (manual, or online-only). */
	salesComplete: boolean
	/** Only when true may a share be shown as within or over its target. */
	targetColoring: boolean
	/** The guide sales of each day of the week, by currency (minor units). */
	days: Array<{
		date: string
		guideSalesMinorByCurrency: Record<string, number>
	}>
	currencies: Array<{
		currency: string
		costMinor: number
		/** Guide sales: the median of the same weekdays over recent weeks. */
		guideSalesMinor: number
		/** Cost as a share of guide sales, in basis points. Null without sales. */
		laborBp: number | null
		/** Cost the target would allow against the guide sales. */
		allowedCostMinor: number | null
		/** Present only when the sales are complete and a target is set. */
		targetStatus?: TargetStatus
	}>
}

export type ScheduleWeekView = {
	/** Always true: figures are estimates, never payroll. */
	estimate: true
	scopeId: string
	timeZone: string
	weekStart: string
	weekEnd: string
	weekStartsOn: number
	dates: string[]
	/** Times the week was published. */
	version: number
	lastPublishedAt: number | null
	/** Drafts plus published shifts with an unpublished edit or removal. */
	unpublishedCount: number
	people: SchedulePersonView[]
	shifts: ScheduleShiftView[]
	overlays: ScheduleOverlay[]
	footers: ScheduleDayFooter[]
	totals: {
		minutes: number
		overtimeMinutes: number
		openShifts: number
		openMinutes: number
		costMinorByCurrency?: Record<string, number>
		/** Worked minutes with no pay rate, so no cost figure. */
		unpricedMinutes?: number
	}
	laborTarget?: ScheduleLaborTarget
	/** Time-off requests and availability rows still waiting for a decision. */
	pending: { timeOff: number; availability: number; shiftRequests: number }
	positions: Array<{
		id: string
		name: string
		nameAr: string | null
		colorKey: z.infer<typeof positionColorKeySchema>
	}>
	currencies: Array<z.infer<typeof currencySchema>>
}

export type DemandDay = {
	date: string
	weekday: number
	/** Median paid and active online orders for each local hour, 0 to 23. */
	hours: number[]
	totalOrders: number
	/** Median daily online sales by currency (minor units). Only with the labor grant. */
	salesMinorByCurrency?: Record<string, number>
}

export type DemandGuide = {
	/** A guide from past orders, not a forecast. */
	kind: 'guide'
	estimate: true
	source: 'online_orders'
	statistic: 'median'
	weeks: number
	windowStart: string
	windowEnd: string
	/** Days in the window with at least one counted order. */
	daysWithOrders: number
	timeZone: string
	days: DemandDay[]
}

export type SchedulePublicationView = {
	id: string
	scopeId: string
	weekStart: string
	version: number
	notifyMode: ScheduleNotifyMode
	summary: Record<string, number>
	publishedBy: string
	publishedAt: number
	changes: Array<{
		shiftId: string
		kind: 'created' | 'changed' | 'cancelled'
		staffId: string | null
		previousStaffId?: string | null
	}>
	/** Who the publication meant to tell, and who could not be reached. */
	notification: PublicationNotification | null
}

// ---------------------------------------------------------------------------
// Write results and request views
// ---------------------------------------------------------------------------

export type ScheduleSettingsView = {
	minRestMinutes: number
	timeOffMinNoticeDays: number
	updatedAt: number | null
}

export type ShiftDeleteResult =
	| { state: 'deleted'; id: string }
	| { state: 'cancel_pending'; shift: ScheduleShiftView }

export type ShiftWriteResult = {
	/** The shifts written, as the manager sees them, each with its warnings. */
	shifts: ScheduleShiftView[]
}

export type PlanCounts = {
	created: number
	skippedDuplicates: number
	/** Shifts left out because their time could not be placed. */
	skippedUnplaceable: number
	/** Shifts made open because their person has left or cannot be found. */
	openedForInactive: number
}

export type CopyResult = PlanCounts & { weekStart: string }

export type ShiftTemplateView = {
	id: string
	scopeId: string
	name: string
	slotCount: number
	createdAt: number
	updatedAt: number
}

export type RecommendedShiftView = {
	staffId: string | null
	positionId: string | null
	localDate: string
	startsAt: number
	endsAt: number
	unpaidBreakMinutes: number
	openReason?: RecommendOpenReason
	/** The person the base shift had, when it was opened. */
	previousStaffId?: string | null
}

export type RecommendResult = {
	estimate: true
	applied: boolean
	scopeId: string
	weekStart: string
	shifts: RecommendedShiftView[]
	counts: {
		total: number
		/** Shifts left open because their person could not keep them. */
		opened: number
		skippedDuplicates: number
		skippedUnplaceable: number
		/** Shifts written (zero for a proposal). */
		created: number
	}
}

export type PublishResult = {
	publication: SchedulePublicationView
	week: { version: number; unpublishedCount: number }
}

export type RequestWarningCode = 'short_notice' | 'over_daily_limit'

export type RequestWarning = { code: RequestWarningCode; detail?: number }

export type TimeOffView = {
	id: string
	staffId: string
	category: z.infer<typeof timeOffCategorySchema>
	startDate: string
	endDate: string
	allDay: boolean
	startMinute: number | null
	endMinute: number | null
	note: string | null
	status: z.infer<typeof scheduleRequestStatusSchema>
	source: 'manager' | 'staff'
	decidedBy: string | null
	decidedAt: number | null
	decisionNote: string | null
	createdAt: number
	/** Never blocks: short notice and a full day are the approver's call. */
	warnings: RequestWarning[]
}

export type AvailabilityView = {
	id: string
	staffId: string
	kind: (typeof AVAILABILITY_KINDS)[number]
	weekday: number | null
	date: string | null
	availability: (typeof AVAILABILITY_WINDOWS)[number]
	allDay: boolean
	startMinute: number | null
	endMinute: number | null
	effectiveFrom: string | null
	effectiveTo: string | null
	note: string | null
	status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'superseded'
	source: 'manager' | 'staff'
	decidedBy: string | null
	decidedAt: number | null
	decisionNote: string | null
	createdAt: number
}

export type ShiftRequestView = {
	id: string
	kind: (typeof SHIFT_REQUEST_KINDS)[number]
	shiftId: string
	scopeId: string
	localDate: string
	requesterStaffId: string
	targetStaffId: string | null
	targetShiftId: string | null
	note: string | null
	status: z.infer<typeof scheduleRequestStatusSchema>
	source: 'manager' | 'staff'
	decidedBy: string | null
	decidedAt: number | null
	decisionNote: string | null
	createdAt: number
}

/** The stable failure vocabulary of `/operator/schedule`. */
export const SCHEDULE_ERROR_CODES = [
	'not_found',
	'scope_out_of_scope',
	'time_zone_unknown',
	'staff_not_found',
	'staff_terminated',
	'position_not_found',
	'invalid_shift_time',
	'break_exceeds_shift',
	'week_full',
	'stale_shift',
	'stale_week',
	'shift_cancelled',
	'cancel_pending',
	'not_published',
	'nothing_to_publish',
	'same_week',
	'template_name_taken',
	'empty_template',
	'request_pending',
	'too_many_slots',
	'already_decided',
	'request_stale',
	'not_your_shift',
	'superseded',
	'email_disabled',
	'resend_too_soon',
] as const
export type ScheduleErrorCode = (typeof SCHEDULE_ERROR_CODES)[number]

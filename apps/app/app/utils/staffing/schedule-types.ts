import {
	AVAILABILITY_KINDS,
	AVAILABILITY_WINDOWS,
	SCHEDULE_CONFLICT_CODES,
	SCHEDULE_NOTIFY_MODES,
	SALES_SOURCES,
	SCHEDULE_REQUEST_STATUSES,
	SHIFT_REQUEST_KINDS,
	SHIFT_VIEW_STATES,
	TARGET_STATUSES,
	TIME_OFF_CATEGORIES,
} from '@repo/staffing'
import { z } from 'zod'

/**
 * Shapes returned by `/operator/schedule`, parsed in the browser. They mirror
 * the response types in `@repo/staffing` (`schedule-api.ts`);
 * `schedule-types.test.ts` parses fixtures typed with those types so a drift
 * fails there. Codes that a newer node may add (conflict codes, error codes)
 * stay lenient where a strict enum would make an older screen refuse a whole
 * week. Money keys are optional on purpose: the server leaves them out (they
 * are not zero) when the token lacks the pay or labor grant.
 */

const minorByCurrency = z.record(z.string(), z.number())

export const conflictSchema = z.object({
	code: z.string(),
	shiftId: z.string(),
	relatedId: z.string().optional(),
	date: z.string().optional(),
	detail: z.record(z.string(), z.number()).optional(),
})
export type ScheduleConflictRow = z.infer<typeof conflictSchema>

const publishedFieldsSchema = z.object({
	staffId: z.string().nullable(),
	positionId: z.string().nullable(),
	startsAt: z.number(),
	endsAt: z.number(),
	unpaidBreakMinutes: z.number(),
	notes: z.string().nullable(),
})

export const shiftSchema = z.object({
	id: z.string(),
	scopeId: z.string(),
	staffId: z.string().nullable(),
	positionId: z.string().nullable(),
	startsAt: z.number(),
	endsAt: z.number(),
	localDate: z.string(),
	timeZone: z.string(),
	unpaidBreakMinutes: z.number(),
	paidMinutes: z.number(),
	notes: z.string().nullable(),
	state: z.enum(SHIFT_VIEW_STATES),
	published: publishedFieldsSchema.nullable(),
	version: z.number(),
	conflicts: z.array(conflictSchema),
	costMinor: z.number().nullable().optional(),
	currency: z.string().nullable().optional(),
})
export type ScheduleShiftRow = z.infer<typeof shiftSchema>

export const personSchema = z.object({
	id: z.string(),
	firstName: z.string(),
	lastName: z.string(),
	firstNameAr: z.string().nullable(),
	lastNameAr: z.string().nullable(),
	status: z.string(),
	positionIds: z.array(z.string()),
	showInSchedule: z.boolean(),
	eligibleOpenShifts: z.boolean(),
	weekMinutes: z.number(),
	overtimeMinutes: z.number(),
	weekCostMinor: minorByCurrency.optional(),
})
export type SchedulePersonRow = z.infer<typeof personSchema>

const overlayTimeOffSchema = z.object({
	id: z.string(),
	status: z.enum(['pending', 'approved']),
	category: z.string(),
	startDate: z.string(),
	endDate: z.string(),
	allDay: z.boolean(),
	startMinute: z.number().nullable(),
	endMinute: z.number().nullable(),
})

const overlayAvailabilitySchema = z.object({
	id: z.string(),
	kind: z.enum(AVAILABILITY_KINDS),
	weekday: z.number().nullable(),
	date: z.string().nullable(),
	availability: z.enum(AVAILABILITY_WINDOWS),
	allDay: z.boolean(),
	startMinute: z.number().nullable(),
	endMinute: z.number().nullable(),
	effectiveFrom: z.string().nullable(),
	effectiveTo: z.string().nullable(),
})

export const overlaySchema = z.object({
	staffId: z.string(),
	timeOff: z.array(overlayTimeOffSchema),
	availability: z.array(overlayAvailabilitySchema),
})
export type ScheduleOverlayRow = z.infer<typeof overlaySchema>

export const dayFooterSchema = z.object({
	date: z.string(),
	minutes: z.number(),
	overtimeMinutes: z.number(),
	headcount: z.number(),
	openShifts: z.number(),
	openMinutes: z.number(),
	costMinorByCurrency: minorByCurrency.optional(),
})
export type ScheduleDayFooterRow = z.infer<typeof dayFooterSchema>

const laborTargetSchema = z.object({
	targetBp: z.number().nullable(),
	salesSource: z.enum(SALES_SOURCES),
	/** The sales cover everything the scope sells (entered, or online-only). */
	salesComplete: z.boolean(),
	/** Only when true may a share be shown as within or over its target. */
	targetColoring: z.boolean(),
	days: z.array(
		z.object({
			date: z.string(),
			guideSalesMinorByCurrency: z.record(z.string(), z.number()),
		}),
	),
	currencies: z.array(
		z.object({
			currency: z.string(),
			costMinor: z.number(),
			guideSalesMinor: z.number(),
			laborBp: z.number().nullable(),
			allowedCostMinor: z.number().nullable(),
			targetStatus: z.enum(TARGET_STATUSES).optional(),
		}),
	),
})
export type ScheduleLaborTargetRow = z.infer<typeof laborTargetSchema>

export const schedulePositionSchema = z.object({
	id: z.string(),
	name: z.string(),
	nameAr: z.string().nullable(),
	colorKey: z.string(),
})
export type SchedulePositionRow = z.infer<typeof schedulePositionSchema>

export const weekViewSchema = z.object({
	estimate: z.literal(true),
	scopeId: z.string(),
	timeZone: z.string(),
	weekStart: z.string(),
	weekEnd: z.string(),
	weekStartsOn: z.number(),
	dates: z.array(z.string()),
	version: z.number(),
	lastPublishedAt: z.number().nullable(),
	unpublishedCount: z.number(),
	people: z.array(personSchema),
	shifts: z.array(shiftSchema),
	overlays: z.array(overlaySchema),
	footers: z.array(dayFooterSchema),
	totals: z.object({
		minutes: z.number(),
		overtimeMinutes: z.number(),
		openShifts: z.number(),
		openMinutes: z.number(),
		costMinorByCurrency: minorByCurrency.optional(),
		unpricedMinutes: z.number().optional(),
	}),
	laborTarget: laborTargetSchema.optional(),
	pending: z.object({
		timeOff: z.number(),
		availability: z.number(),
		shiftRequests: z.number(),
	}),
	positions: z.array(schedulePositionSchema),
	currencies: z.array(z.string()),
})
export type ScheduleWeek = z.infer<typeof weekViewSchema>

export const demandSchema = z.object({
	kind: z.literal('guide'),
	estimate: z.literal(true),
	source: z.string(),
	statistic: z.string(),
	weeks: z.number(),
	windowStart: z.string(),
	windowEnd: z.string(),
	daysWithOrders: z.number(),
	timeZone: z.string(),
	days: z.array(
		z.object({
			date: z.string(),
			weekday: z.number(),
			hours: z.array(z.number()),
			totalOrders: z.number(),
			salesMinorByCurrency: minorByCurrency.optional(),
		}),
	),
})
export type ScheduleDemand = z.infer<typeof demandSchema>

export const NOT_REACHED_REASON_VALUES = [
	'no_email',
	'inactive',
	'email_disabled',
] as const

const notReachedSchema = z.array(
	z.object({
		staffId: z.string(),
		// An unknown reason from a newer node still renders, as a generic line.
		reason: z.string(),
	}),
)

export const publicationNotificationSchema = z.object({
	mode: z.enum(SCHEDULE_NOTIFY_MODES),
	recipients: z.number(),
	queued: z.number(),
	notReached: notReachedSchema,
})
export type PublicationNotificationRow = z.infer<
	typeof publicationNotificationSchema
>

export const publicationSchema = z.object({
	id: z.string(),
	scopeId: z.string(),
	weekStart: z.string(),
	version: z.number(),
	notifyMode: z.enum(SCHEDULE_NOTIFY_MODES),
	summary: z.record(z.string(), z.number()),
	publishedBy: z.string(),
	publishedAt: z.number(),
	changes: z.array(
		z.object({
			shiftId: z.string(),
			kind: z.enum(['created', 'changed', 'cancelled']),
			staffId: z.string().nullable(),
			previousStaffId: z.string().nullable().optional(),
		}),
	),
	notification: publicationNotificationSchema.nullable().optional(),
})
export type SchedulePublicationRow = z.infer<typeof publicationSchema>

export const publicationsSchema = z.array(publicationSchema)

export const publishResultSchema = z.object({
	publication: publicationSchema,
	week: z.object({ version: z.number(), unpublishedCount: z.number() }),
})
export type PublishResultRow = z.infer<typeof publishResultSchema>

export const shiftWriteSchema = z.object({ shifts: z.array(shiftSchema) })
export type ShiftWriteRow = z.infer<typeof shiftWriteSchema>

export const shiftDeleteSchema = z.discriminatedUnion('state', [
	z.object({ state: z.literal('deleted'), id: z.string() }),
	z.object({ state: z.literal('cancel_pending'), shift: shiftSchema }),
])
export type ShiftDeleteRow = z.infer<typeof shiftDeleteSchema>

const planCountsSchema = z.object({
	created: z.number(),
	skippedDuplicates: z.number(),
	skippedUnplaceable: z.number(),
	openedForInactive: z.number(),
})

export const copyResultSchema = planCountsSchema.extend({
	weekStart: z.string(),
})
export type CopyResultRow = z.infer<typeof copyResultSchema>

export const templateSchema = z.object({
	id: z.string(),
	scopeId: z.string(),
	name: z.string(),
	slotCount: z.number(),
	createdAt: z.number(),
	updatedAt: z.number(),
})
export type ScheduleTemplateRow = z.infer<typeof templateSchema>
export const templatesSchema = z.array(templateSchema)

export const recommendSchema = z.object({
	estimate: z.literal(true),
	applied: z.boolean(),
	scopeId: z.string(),
	weekStart: z.string(),
	shifts: z.array(
		z.object({
			staffId: z.string().nullable(),
			positionId: z.string().nullable(),
			localDate: z.string(),
			startsAt: z.number(),
			endsAt: z.number(),
			unpaidBreakMinutes: z.number(),
			openReason: z.string().optional(),
			previousStaffId: z.string().nullable().optional(),
		}),
	),
	counts: z.object({
		total: z.number(),
		opened: z.number(),
		skippedDuplicates: z.number(),
		skippedUnplaceable: z.number(),
		created: z.number(),
	}),
})
export type RecommendRow = z.infer<typeof recommendSchema>

export const requestWarningSchema = z.object({
	code: z.string(),
	detail: z.number().optional(),
})

export const timeOffSchema = z.object({
	id: z.string(),
	staffId: z.string(),
	category: z.enum(TIME_OFF_CATEGORIES),
	startDate: z.string(),
	endDate: z.string(),
	allDay: z.boolean(),
	startMinute: z.number().nullable(),
	endMinute: z.number().nullable(),
	note: z.string().nullable(),
	status: z.enum(SCHEDULE_REQUEST_STATUSES),
	source: z.enum(['manager', 'staff']),
	decidedBy: z.string().nullable(),
	decidedAt: z.number().nullable(),
	decisionNote: z.string().nullable(),
	createdAt: z.number(),
	warnings: z.array(requestWarningSchema),
})
export type TimeOffRow = z.infer<typeof timeOffSchema>
export const timeOffListSchema = z.array(timeOffSchema)

export const availabilitySchema = z.object({
	id: z.string(),
	staffId: z.string(),
	kind: z.enum(AVAILABILITY_KINDS),
	weekday: z.number().nullable(),
	date: z.string().nullable(),
	availability: z.enum(AVAILABILITY_WINDOWS),
	allDay: z.boolean(),
	startMinute: z.number().nullable(),
	endMinute: z.number().nullable(),
	effectiveFrom: z.string().nullable(),
	effectiveTo: z.string().nullable(),
	note: z.string().nullable(),
	status: z.enum([
		'pending',
		'approved',
		'rejected',
		'cancelled',
		'superseded',
	]),
	source: z.enum(['manager', 'staff']),
	decidedBy: z.string().nullable(),
	decidedAt: z.number().nullable(),
	decisionNote: z.string().nullable(),
	createdAt: z.number(),
})
export type AvailabilityRow = z.infer<typeof availabilitySchema>
export const availabilityListSchema = z.array(availabilitySchema)

export const shiftRequestSchema = z.object({
	id: z.string(),
	kind: z.enum(SHIFT_REQUEST_KINDS),
	shiftId: z.string(),
	scopeId: z.string(),
	localDate: z.string(),
	requesterStaffId: z.string(),
	targetStaffId: z.string().nullable(),
	targetShiftId: z.string().nullable(),
	note: z.string().nullable(),
	status: z.enum(SCHEDULE_REQUEST_STATUSES),
	source: z.enum(['manager', 'staff']),
	decidedBy: z.string().nullable(),
	decidedAt: z.number().nullable(),
	decisionNote: z.string().nullable(),
	createdAt: z.number(),
})
export type ShiftRequestRow = z.infer<typeof shiftRequestSchema>
export const shiftRequestListSchema = z.array(shiftRequestSchema)

/** A swap, cover or drop decision: the request and any shifts it changed. */
export const shiftRequestResultSchema = z.object({
	request: shiftRequestSchema,
	shifts: z.array(shiftSchema),
})

export const scheduleSettingsSchema = z.object({
	minRestMinutes: z.number(),
	timeOffMinNoticeDays: z.number(),
	updatedAt: z.number().nullable(),
})

/** Conflict codes this screen knows how to word; others fall back to a generic line. */
export const KNOWN_CONFLICT_CODES: ReadonlySet<string> = new Set(
	SCHEDULE_CONFLICT_CODES,
)

export const noticesSchema = z.object({
	publicationId: z.string(),
	mode: z.enum(SCHEDULE_NOTIFY_MODES),
	current: z.boolean(),
	emailEnabled: z.boolean(),
	notices: z.array(
		z.object({
			staffId: z.string(),
			state: z.enum(['pending', 'sent', 'failed', 'not_sent']),
			reason: z.string().nullable(),
			round: z.number(),
			sentAt: z.number().nullable(),
		}),
	),
	notReached: notReachedSchema,
})
export type NoticesRow = z.infer<typeof noticesSchema>

export const resendResultSchema = z.object({
	queued: z.number(),
	notReached: notReachedSchema,
})
export type ResendResultRow = z.infer<typeof resendResultSchema>

export const linkStatusSchema = z.object({
	staffId: z.string(),
	active: z.boolean(),
	createdAt: z.number().nullable(),
	lastUsedAt: z.number().nullable(),
	expiresAt: z.number().nullable(),
})
export type LinkStatusRow = z.infer<typeof linkStatusSchema>

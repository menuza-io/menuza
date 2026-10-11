import { z } from 'zod'

// Mirrors the regional responses in apps/tenant-api/src/services/staffing-*.ts.
export const positionSchema = z.object({
	id: z.string(),
	name: z.string(),
	colorKey: z.string(),
	sortOrder: z.number(),
	archived: z.boolean(),
})
export type Position = z.infer<typeof positionSchema>

export const assignmentSchema = z.object({
	locationId: z.string(),
	positionId: z.string(),
	isPrimary: z.boolean(),
	// Present only when the credential carries `canViewPay`.
	rateCents: z.number().nullable().optional(),
	currency: z.string().nullable().optional(),
})

export const staffSchema = z.object({
	id: z.string(),
	userId: z.string().nullable(),
	firstName: z.string(),
	lastName: z.string(),
	email: z.string().nullable(),
	phone: z.string().nullable(),
	status: z.enum(['active', 'terminated']),
	hiredOn: z.string().nullable(),
	terminatedOn: z.string().nullable(),
	terminationReason: z.string().nullable(),
	note: z.string(),
	hasPin: z.boolean(),
	assignments: z.array(assignmentSchema),
	createdAt: z.string(),
	updatedAt: z.string(),
})
export type Staff = z.infer<typeof staffSchema>

export const settingsSchema = z.object({
	weekStart: z.enum(['monday', 'sunday']),
	weeklyHoursThreshold: z.number().nullable(),
	lateGraceMinutes: z.number(),
})
export type Settings = z.infer<typeof settingsSchema>

export const contextSchema = z.object({
	settings: settingsSchema,
	positions: z.array(positionSchema),
	access: z.object({
		areas: z.object({
			staff: z.enum(['read', 'write']).optional(),
			schedule: z.enum(['read', 'write']).optional(),
			timeclock: z.enum(['read', 'write']).optional(),
		}),
		canViewPay: z.boolean(),
		locationIds: z.array(z.string()).nullable(),
	}),
})

export const staffEventSchema = z.object({
	id: z.string(),
	kind: z.string(),
	actorRef: z.string(),
	detail: z.unknown(),
	at: z.string(),
})

const publishedShiftSchema = z.object({
	staffId: z.string().nullable(),
	positionId: z.string().nullable(),
	localDate: z.string(),
	startTime: z.string(),
	endTime: z.string(),
	unpaidBreakMinutes: z.number(),
	note: z.string(),
})

export const shiftSchema = z.object({
	id: z.string(),
	locationId: z.string(),
	staffId: z.string().nullable(),
	positionId: z.string().nullable(),
	localDate: z.string(),
	startTime: z.string(),
	endTime: z.string(),
	startAt: z.string(),
	endAt: z.string(),
	timeZone: z.string(),
	unpaidBreakMinutes: z.number(),
	note: z.string(),
	state: z.enum(['draft', 'published', 'changed', 'removed']),
	published: publishedShiftSchema.nullable(),
	publishedAt: z.string().nullable(),
})
export type Shift = z.infer<typeof shiftSchema>

export const publicationSchema = z.object({
	id: z.string(),
	weekStart: z.string(),
	publishedBy: z.string(),
	publishedAt: z.string(),
	shiftCount: z.number(),
	changedCount: z.number(),
	notifiedCount: z.number(),
	notNotifiedCount: z.number(),
})
export type Publication = z.infer<typeof publicationSchema>

export const scheduleStaffSchema = z.object({
	id: z.string(),
	firstName: z.string(),
	lastName: z.string(),
	status: z.enum(['active', 'terminated']),
	hasEmail: z.boolean(),
	positionIds: z.array(z.string()),
	assignedHere: z.boolean(),
})
export type ScheduleStaff = z.infer<typeof scheduleStaffSchema>

export const scheduleSchema = z.object({
	locationId: z.string(),
	timeZone: z.string(),
	weekStart: z.string(),
	settings: settingsSchema,
	positions: z.array(positionSchema.omit({ sortOrder: true })),
	staff: z.array(scheduleStaffSchema),
	shifts: z.array(shiftSchema),
	elsewhere: z.array(
		z.object({
			id: z.string(),
			staffId: z.string().nullable(),
			startAt: z.string(),
			endAt: z.string(),
		}),
	),
	unpublishedCount: z.number(),
	publications: z.array(publicationSchema),
})
export type Schedule = z.infer<typeof scheduleSchema>

export const publishResultSchema = z.object({
	publicationId: z.string(),
	changedCount: z.number(),
	shiftCount: z.number(),
	notified: z.number(),
	notNotified: z.array(
		z.object({
			staffId: z.string(),
			name: z.string(),
			reason: z.enum(['no_email', 'email_disabled', 'send_failed', 'not_sent']),
		}),
	),
})
export type PublishResult = z.infer<typeof publishResultSchema>

export const kioskSchema = z.object({
	id: z.string(),
	name: z.string(),
	locationId: z.string(),
	createdAt: z.string(),
	createdBy: z.string(),
	lastSeenAt: z.string().nullable(),
	lockedUntil: z.string().nullable(),
	revokedAt: z.string().nullable(),
})
export type Kiosk = z.infer<typeof kioskSchema>

export const kioskListSchema = z.object({
	kiosks: z.array(kioskSchema),
	kioskEnabled: z.boolean(),
})

export const pairingSchema = z.object({
	pairing: z.object({ code: z.string(), expiresAt: z.string() }),
})

export const pinResultSchema = z.object({
	result: z.object({ pin: z.string(), generated: z.boolean() }),
})

export const timeEntrySchema = z.object({
	id: z.string(),
	staffId: z.string(),
	locationId: z.string(),
	positionId: z.string().nullable(),
	shiftId: z.string().nullable(),
	localDate: z.string(),
	timeZone: z.string(),
	clockInAt: z.string(),
	clockOutAt: z.string().nullable(),
	source: z.enum(['kiosk', 'manager']),
	deviceId: z.string().nullable(),
	unpaidBreakMinutes: z.number(),
	note: z.string(),
	approvedAt: z.string().nullable(),
	approvedBy: z.string().nullable(),
	paidMinutes: z.number(),
	issues: z.array(z.enum(['missing_clock_out', 'unscheduled', 'late'])),
	scheduled: z
		.object({
			startAt: z.string(),
			endAt: z.string(),
			positionId: z.string().nullable(),
		})
		.nullable(),
	edited: z.boolean(),
})
export type TimeEntry = z.infer<typeof timeEntrySchema>

export const weekTotalSchema = z.object({
	staffId: z.string(),
	weekStart: z.string(),
	paidMinutes: z.number(),
	regularMinutes: z.number(),
	overThresholdMinutes: z.number(),
})
export type WeekTotal = z.infer<typeof weekTotalSchema>

export const timesheetSchema = z.object({
	locationId: z.string(),
	timeZone: z.string(),
	from: z.string(),
	to: z.string(),
	settings: settingsSchema,
	positions: z.array(positionSchema.omit({ sortOrder: true })),
	staff: z.array(
		z.object({
			id: z.string(),
			firstName: z.string(),
			lastName: z.string(),
			status: z.enum(['active', 'terminated']),
			positionIds: z.array(z.string()),
			assignedHere: z.boolean(),
		}),
	),
	entries: z.array(timeEntrySchema),
	weeks: z.array(weekTotalSchema),
	devices: z.record(z.string(), z.string()),
})
export type Timesheet = z.infer<typeof timesheetSchema>
export type TimesheetStaff = Timesheet['staff'][number]

// Kiosk punches record a subset of these fields.
const entrySnapshotSchema = z.object({
	positionId: z.string().nullable().optional(),
	localDate: z.string().optional(),
	clockInAt: z.string().optional(),
	clockOutAt: z.string().nullable().optional(),
	unpaidBreakMinutes: z.number().optional(),
	note: z.string().optional(),
})
export type EntrySnapshot = z.infer<typeof entrySnapshotSchema>

export const entryHistorySchema = z.object({
	history: z.object({
		events: z.array(
			z.object({
				id: z.string(),
				kind: z.string(),
				actorType: z.enum(['operator', 'kiosk']),
				actorRef: z.string(),
				before: entrySnapshotSchema.nullable(),
				after: entrySnapshotSchema.nullable(),
				reason: z.string().nullable(),
				at: z.string(),
			}),
		),
		devices: z.record(z.string(), z.string()),
	}),
})
export type EntryHistory = z.infer<typeof entryHistorySchema>['history']

export const approveResultSchema = z.object({
	result: z.object({
		approved: z.number(),
		skipped: z.array(
			z.object({
				id: z.string(),
				reason: z.enum(['not_found', 'open', 'already_approved']),
			}),
		),
	}),
})

const laborDaySchema = z.object({
	date: z.string(),
	workedMinutes: z.number(),
	scheduledMinutes: z.number(),
	laborCents: z.number().nullable(),
	scheduledLaborCents: z.number().nullable(),
	salesCents: z.number().nullable(),
	orderCount: z.number(),
	laborPercent: z.number().nullable(),
})

export const laborSummarySchema = z.object({
	summary: z.object({
		locationId: z.string(),
		timeZone: z.string(),
		from: z.string(),
		to: z.string(),
		currency: z.string().nullable(),
		mixedCurrency: z.boolean(),
		days: z.array(laborDaySchema),
		totals: laborDaySchema.omit({ date: true }).extend({
			scheduledLaborPercent: z.number().nullable(),
		}),
		openEntries: z.number(),
		unratedWorkedMinutes: z.number(),
		unratedScheduledMinutes: z.number(),
		generatedAt: z.string(),
	}),
})
export type LaborSummary = z.infer<typeof laborSummarySchema>['summary']

export function formatCents(locale: string, cents: number, currency: string) {
	try {
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
		}).format(cents / 100)
	} catch {
		return `${(cents / 100).toFixed(2)} ${currency}`
	}
}

export function formatPercent(locale: string, percent: number) {
	return new Intl.NumberFormat(locale, {
		style: 'percent',
		maximumFractionDigits: 1,
	}).format(percent / 100)
}

/** A UTC instant shown on the location's clock, not the viewer's. */
export function formatZonedTime(locale: string, iso: string, timeZone: string) {
	return new Intl.DateTimeFormat(locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone,
	}).format(new Date(iso))
}

export function formatZonedDateTime(
	locale: string,
	iso: string,
	timeZone: string,
) {
	return new Intl.DateTimeFormat(locale, {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
		timeZone,
	}).format(new Date(iso))
}

/** Control-plane location metadata App passes to staffing pages. */
export type StaffingLocation = {
	id: string
	name: string
	timezone: string
	isActive: boolean
	currency: string
}

/**
 * Shift dates and times are the location's wall clock. Formatting them as UTC
 * keeps the viewer's own time zone out of the picture.
 */
export function formatWallDate(
	locale: string,
	localDate: string,
	options: Intl.DateTimeFormatOptions = {
		weekday: 'short',
		month: 'short',
		day: 'numeric',
	},
) {
	return new Intl.DateTimeFormat(locale, {
		...options,
		timeZone: 'UTC',
	}).format(new Date(`${localDate}T00:00:00Z`))
}

export function formatWallTime(locale: string, time: string) {
	return new Intl.DateTimeFormat(locale, {
		hour: 'numeric',
		minute: '2-digit',
		timeZone: 'UTC',
	}).format(new Date(`1970-01-01T${time}:00Z`))
}

export function formatHours(locale: string, minutes: number) {
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(
		minutes / 60,
	)
}

export function staffName(staff: Pick<Staff, 'firstName' | 'lastName'>) {
	return [staff.firstName, staff.lastName].filter(Boolean).join(' ')
}

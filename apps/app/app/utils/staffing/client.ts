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

/** Control-plane location metadata App passes to staffing pages. */
export type StaffingLocation = {
	id: string
	name: string
	timezone: string
	isActive: boolean
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

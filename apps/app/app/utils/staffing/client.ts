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

/** Control-plane location metadata App passes to staffing pages. */
export type StaffingLocation = {
	id: string
	name: string
	timezone: string
	isActive: boolean
}

export function staffName(staff: Pick<Staff, 'firstName' | 'lastName'>) {
	return [staff.firstName, staff.lastName].filter(Boolean).join(' ')
}

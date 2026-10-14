import {
	currencySchema,
	payTypeSchema,
	positionColorKeySchema,
	staffStatusSchema,
	workerTypeSchema,
} from '@repo/staffing'
import { z } from 'zod'

/**
 * Shapes returned by `/operator/staff`, parsed in the browser. They mirror the
 * serializers in `apps/tenant-api/src/services/staff-service.ts`. Pay fields are
 * optional because the server omits them without the pay grant.
 */

const nullableText = z.string().nullable()

export const staffMemberSchema = z.object({
	id: z.string(),
	status: staffStatusSchema,
	workerType: workerTypeSchema,
	firstName: z.string(),
	lastName: z.string(),
	firstNameAr: nullableText,
	lastNameAr: nullableText,
	email: nullableText,
	phone: nullableText,
	userId: nullableText,
	employeeNumber: nullableText,
	locale: z.string(),
	hiredDate: nullableText,
	terminatedAt: z.number().nullable(),
	terminationReason: nullableText,
	eligibleForRehire: z.boolean().nullable(),
	primaryScopeId: nullableText,
	createdAt: z.number(),
	updatedAt: z.number(),
})
export type StaffMemberRow = z.infer<typeof staffMemberSchema>

export const staffAssignmentSchema = z.object({
	id: z.string(),
	staffId: z.string(),
	scopeId: z.string(),
	isPrimary: z.boolean(),
	showInSchedule: z.boolean(),
	eligibleOpenShifts: z.boolean(),
	includeInClockErrors: z.boolean(),
	canWaiveBreaks: z.boolean(),
	active: z.boolean(),
	hasPin: z.boolean(),
	pinSetAt: z.number().nullable(),
})
export type StaffAssignmentRow = z.infer<typeof staffAssignmentSchema>

export const currentRateSchema = z.object({
	payType: payTypeSchema,
	rateMinor: z.number().nullable(),
	annualSalaryMinor: z.number().nullable(),
	currency: currencySchema,
})
export type CurrentRate = z.infer<typeof currentRateSchema>

export const staffListRowSchema = staffMemberSchema.extend({
	assignments: z.array(staffAssignmentSchema),
	positionIds: z.array(z.string()),
	currentRate: currentRateSchema.nullable().optional(),
})
export type StaffListRow = z.infer<typeof staffListRowSchema>

export const staffListSchema = z.object({
	staff: z.array(staffListRowSchema),
	total: z.number(),
	limit: z.number(),
	offset: z.number(),
})

export const staffJobSchema = z.object({
	id: z.string(),
	staffId: z.string(),
	scopeId: z.string(),
	positionId: z.string(),
	isPrimary: z.boolean(),
	effectiveFrom: z.string(),
	effectiveTo: nullableText,
	payType: payTypeSchema.optional(),
	rateMinor: z.number().nullable().optional(),
	annualSalaryMinor: z.number().nullable().optional(),
	currency: currencySchema.optional(),
	overtimeExempt: z.boolean().optional(),
	tipEligible: z.boolean().optional(),
	changeReason: nullableText.optional(),
})
export type StaffJobRow = z.infer<typeof staffJobSchema>

export const staffPrivateSchema = z.object({
	dateOfBirth: nullableText,
	addressLine1: nullableText,
	addressLine2: nullableText,
	city: nullableText,
	region: nullableText,
	postalCode: nullableText,
	country: nullableText,
	emergencyContactName: nullableText,
	emergencyContactPhone: nullableText,
	emergencyContactRelation: nullableText,
})
export type StaffPrivateRow = z.infer<typeof staffPrivateSchema>

export const staffDetailSchema = z.object({
	staff: staffMemberSchema,
	assignments: z.array(staffAssignmentSchema),
	jobs: z.array(staffJobSchema),
	private: staffPrivateSchema.partial().nullable().optional(),
	restricted: z.object({ pay: z.boolean(), private: z.boolean() }).optional(),
})
export type StaffDetail = z.infer<typeof staffDetailSchema>

export const positionSchema = z.object({
	id: z.string(),
	name: z.string(),
	nameAr: nullableText,
	area: nullableText,
	colorKey: positionColorKeySchema.catch('neutral'),
	tipEligible: z.boolean(),
	archivedAt: z.number().nullable(),
	defaultRateMinor: z.number().nullable().optional(),
	currency: currencySchema.nullable().optional(),
})
export type StaffPositionRow = z.infer<typeof positionSchema>

export const positionsSchema = z.object({ positions: z.array(positionSchema) })
export const positionResultSchema = z.object({ position: positionSchema })

export const noteSchema = z.object({
	id: z.string(),
	staffId: z.string(),
	authorId: nullableText,
	body: z.string(),
	createdAt: z.number(),
})
export type StaffNoteRow = z.infer<typeof noteSchema>
export const notesSchema = z.object({ notes: z.array(noteSchema) })

export const pinResultSchema = z.object({
	pin: z.string(),
	assignmentId: z.string(),
	pinSetAt: z.number(),
})

export const staffResultSchema = z.object({ staff: staffMemberSchema })
export const jobResultSchema = z.object({ job: staffJobSchema })
export const assignmentResultSchema = z.object({
	assignment: staffAssignmentSchema,
})
export const createResultSchema = z.object({
	created: z.boolean(),
	staff: staffMemberSchema,
	assignments: z.array(staffAssignmentSchema),
})

export const bulkResultSchema = z.object({
	results: z.array(
		z.discriminatedUnion('status', [
			z.object({
				index: z.number(),
				status: z.literal('created'),
				staffId: z.string(),
			}),
			z.object({
				index: z.number(),
				status: z.literal('existing'),
				staffId: z.string(),
			}),
			z.object({
				index: z.number(),
				status: z.literal('invalid'),
				error: z.string(),
			}),
			z.object({
				index: z.number(),
				status: z.literal('conflict'),
				error: z.string(),
			}),
		]),
	),
	summary: z.object({
		created: z.number(),
		existing: z.number(),
		invalid: z.number(),
		conflict: z.number(),
	}),
})
export type BulkResult = z.infer<typeof bulkResultSchema>

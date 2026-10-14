import { z } from 'zod'
import {
	currencySchema,
	localDateSchema,
	moneyMinorSchema,
	payTypeSchema,
	positionColorKeySchema,
	staffMemberInputSchema,
	workerTypeSchema,
} from './schemas.ts'

/**
 * Request and response contracts for `/operator/staff` on tenant-api. App code
 * and tenant-api import the same schemas so the browser, the mint route and the
 * regional node cannot drift apart. Every request schema is `.strict()`: an
 * unknown key is a 400, never silently ignored, so a client cannot smuggle
 * fields such as `userId` or `status` through a route that does not own them.
 */

const idSchema = z.string().min(1).max(64)
const optionalText = (max: number) => z.string().trim().max(max)

const memberFields = staffMemberInputSchema.omit({
	hiredAt: true,
	primaryScopeId: true,
}).shape

export const staffAssignmentInputSchema = z
	.object({
		scopeId: idSchema,
		isPrimary: z.boolean().default(false),
		showInSchedule: z.boolean().default(true),
		eligibleOpenShifts: z.boolean().default(true),
		includeInClockErrors: z.boolean().default(true),
		canWaiveBreaks: z.boolean().default(false),
	})
	.strict()
export type StaffAssignmentInput = z.infer<typeof staffAssignmentInputSchema>

export const staffAssignmentUpdateSchema = z
	.object({
		isPrimary: z.boolean(),
		showInSchedule: z.boolean(),
		eligibleOpenShifts: z.boolean(),
		includeInClockErrors: z.boolean(),
		canWaiveBreaks: z.boolean(),
		active: z.boolean(),
	})
	.partial()
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type StaffAssignmentUpdate = z.infer<typeof staffAssignmentUpdateSchema>

/** A new staff member. Contact details are optional; no login is implied. */
export const staffCreateSchema = z
	.object({
		...memberFields,
		hiredDate: localDateSchema.optional(),
		assignments: z.array(staffAssignmentInputSchema).max(25).default([]),
	})
	.strict()
export type StaffCreateInput = z.infer<typeof staffCreateSchema>

/**
 * One row of an import. `userId` is the opaque control-plane user id of the
 * member being imported; a second import of the same id returns the existing
 * row instead of creating a duplicate.
 */
export const staffImportRowSchema = staffCreateSchema
	.extend({ userId: idSchema.optional() })
	.strict()
export type StaffImportRow = z.infer<typeof staffImportRowSchema>

export const STAFF_BULK_MAX_ROWS = 200

/**
 * Rows are validated one by one on the server so a single bad row never fails
 * the batch; only the envelope is checked here.
 */
export const staffBulkEnvelopeSchema = z
	.object({ members: z.array(z.unknown()).min(1).max(STAFF_BULK_MAX_ROWS) })
	.strict()

export type StaffBulkRowResult =
	| { index: number; status: 'created' | 'existing'; staffId: string }
	| { index: number; status: 'invalid'; error: string }
	| { index: number; status: 'conflict'; error: string }

export const staffUpdateSchema = z
	.object({
		firstName: memberFields.firstName,
		lastName: memberFields.lastName,
		firstNameAr: optionalText(80).nullable(),
		lastNameAr: optionalText(80).nullable(),
		email: z.string().trim().toLowerCase().email().max(254).nullable(),
		phone: memberFields.phone.unwrap().nullable(),
		workerType: workerTypeSchema,
		employeeNumber: optionalText(40).nullable(),
		locale: z.enum(['en', 'ar']),
		hiredDate: localDateSchema.nullable(),
		primaryScopeId: idSchema.nullable(),
		/** Only these two are settable here; termination has its own route. */
		status: z.enum(['active', 'on_leave']),
	})
	.partial()
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type StaffUpdateInput = z.infer<typeof staffUpdateSchema>

export const staffPrivateUpdateSchema = z
	.object({
		dateOfBirth: localDateSchema.nullable(),
		addressLine1: optionalText(120).nullable(),
		addressLine2: optionalText(120).nullable(),
		city: optionalText(80).nullable(),
		region: optionalText(80).nullable(),
		postalCode: optionalText(20).nullable(),
		country: optionalText(2).nullable(),
		emergencyContactName: optionalText(100).nullable(),
		emergencyContactPhone: memberFields.phone.unwrap().nullable(),
		emergencyContactRelation: optionalText(60).nullable(),
	})
	.partial()
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type StaffPrivateUpdate = z.infer<typeof staffPrivateUpdateSchema>

export const staffTerminateSchema = z
	.object({
		reason: z.string().trim().min(1).max(500),
		/** Last day of employment in the scope timezone; defaults to today (UTC). */
		effectiveDate: localDateSchema.optional(),
		eligibleForRehire: z.boolean().default(true),
	})
	.strict()
export type StaffTerminateInput = z.infer<typeof staffTerminateSchema>

export const staffRehireSchema = z
	.object({
		reason: z.string().trim().min(1).max(500),
		/** Required to rehire someone who was marked not eligible. */
		overrideIneligible: z.boolean().default(false),
	})
	.strict()
export type StaffRehireInput = z.infer<typeof staffRehireSchema>

export const staffNoteInputSchema = z
	.object({ body: z.string().trim().min(1).max(2000) })
	.strict()

export const staffPositionCreateSchema = z
	.object({
		name: z.string().trim().min(1).max(60),
		nameAr: optionalText(60).optional(),
		area: optionalText(60).optional(),
		colorKey: positionColorKeySchema.default('neutral'),
		defaultRateMinor: moneyMinorSchema.optional(),
		currency: currencySchema.optional(),
		tipEligible: z.boolean().default(false),
	})
	.strict()
	.refine((value) => value.defaultRateMinor === undefined || value.currency, {
		message: 'A default rate needs a currency',
		path: ['currency'],
	})
export type StaffPositionCreate = z.infer<typeof staffPositionCreateSchema>

export const staffPositionUpdateSchema = z
	.object({
		name: z.string().trim().min(1).max(60),
		nameAr: optionalText(60).nullable(),
		area: optionalText(60).nullable(),
		colorKey: positionColorKeySchema,
		defaultRateMinor: moneyMinorSchema.nullable(),
		currency: currencySchema.nullable(),
		tipEligible: z.boolean(),
		archived: z.boolean(),
	})
	.partial()
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type StaffPositionUpdate = z.infer<typeof staffPositionUpdateSchema>

/** Assign a position at a scope. Pay fields need the pay grant on the token. */
export const staffJobCreateSchema = z
	.object({
		scopeId: idSchema,
		positionId: idSchema,
		payType: payTypeSchema.default('hourly'),
		rateMinor: moneyMinorSchema.nullable().default(null),
		annualSalaryMinor: moneyMinorSchema.nullable().default(null),
		currency: currencySchema,
		overtimeExempt: z.boolean().default(false),
		tipEligible: z.boolean().default(false),
		isPrimary: z.boolean().default(false),
		effectiveFrom: localDateSchema,
	})
	.strict()
	.refine((job) => job.payType !== 'salary' || job.annualSalaryMinor !== null, {
		message: 'Salary jobs need an annual salary',
		path: ['annualSalaryMinor'],
	})
export type StaffJobCreate = z.infer<typeof staffJobCreateSchema>

/**
 * A rate change never edits a row: the open job is closed the day before
 * `effectiveFrom` and a new row is inserted.
 */
export const staffRateChangeSchema = z
	.object({
		effectiveFrom: localDateSchema,
		payType: payTypeSchema.optional(),
		rateMinor: moneyMinorSchema.nullable().optional(),
		annualSalaryMinor: moneyMinorSchema.nullable().optional(),
		overtimeExempt: z.boolean().optional(),
		tipEligible: z.boolean().optional(),
		reason: z.string().trim().min(1).max(300),
	})
	.strict()
export type StaffRateChange = z.infer<typeof staffRateChangeSchema>

/** `pin` omitted means the server generates one. */
export const staffPinSetSchema = z
	.object({ pin: z.string().min(1).max(12).optional() })
	.strict()

export const STAFF_PAY_PERIODS = [
	'weekly',
	'biweekly',
	'semimonthly',
	'monthly',
] as const
export const STAFF_CONTACT_LEVELS = ['full', 'minimal'] as const

export const staffingSettingsUpdateSchema = z
	.object({
		pinLength: z.number().int().min(4).max(6),
		payPeriod: z.enum(STAFF_PAY_PERIODS),
		contactLevel: z.enum(STAFF_CONTACT_LEVELS),
		retentionDaysPunchCoordinates: z.number().int().min(1).max(3650).nullable(),
		retentionDaysDeclinedApplicants: z
			.number()
			.int()
			.min(1)
			.max(3650)
			.nullable(),
	})
	.partial()
	.strict()
	.refine((value) => Object.keys(value).length > 0, 'Nothing to update')
export type StaffingSettingsUpdate = z.infer<
	typeof staffingSettingsUpdateSchema
>

export const staffListQuerySchema = z.object({
	q: z
		.string()
		.trim()
		.min(1)
		.max(80)
		// Control characters (a NUL would truncate a LIKE pattern) are not search text.
		.refine(
			(value) =>
				![...value].some((char) => {
					const code = char.codePointAt(0)!
					return code < 0x20 || code === 0x7f
				}),
			'Invalid search text',
		)
		.optional(),
	status: z.enum(['invited', 'active', 'on_leave', 'terminated']).optional(),
	scopeId: idSchema.optional(),
	positionId: idSchema.optional(),
	/**
	 * `pay` adds each person's current rate to the list. It is ignored (not an
	 * error) for tokens without the pay grant, so a client can always ask.
	 */
	include: z.enum(['pay']).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(50),
	offset: z.coerce.number().int().min(0).max(100_000).default(0),
})
export type StaffListQuery = z.infer<typeof staffListQuerySchema>

/** Audit events are written in the regional database only. */
export const STAFF_AUDIT_SENSITIVITIES = ['standard', 'pay', 'private'] as const
export type StaffAuditSensitivity = (typeof STAFF_AUDIT_SENSITIVITIES)[number]

import { z } from 'zod'
import {
	STAFFING_PERMISSION_LIST,
	type StaffingPermission,
} from './permissions.ts'

/** Calendar date in the scope timezone, `YYYY-MM-DD`, and a real date. */
export const localDateSchema = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
	.refine((value) => {
		const [y, m, d] = value.split('-').map(Number) as [number, number, number]
		const date = new Date(Date.UTC(y, m - 1, d))
		return (
			date.getUTCFullYear() === y &&
			date.getUTCMonth() === m - 1 &&
			date.getUTCDate() === d
		)
	}, 'Not a real calendar date')

export function isValidTimeZone(value: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value })
		return true
	} catch {
		return false
	}
}

/** IANA time zone name such as `America/Chicago` or `Asia/Riyadh`. */
export const timeZoneSchema = z
	.string()
	.min(1)
	.max(64)
	.refine(isValidTimeZone, 'Unknown time zone')

/** Whole minutes. Durations are never stored as fractional hours. */
export const minutesSchema = z
	.number()
	.int()
	.min(0)
	.max(60 * 24 * 31)

/** Integer minor units (cents, halalas). Never floats. */
export const moneyMinorSchema = z.number().int().min(0).max(100_000_000_00)

/** Multipliers as integer basis points: 10000 = 1x, 15000 = 1.5x. */
export const basisPointsSchema = z.number().int().min(10_000).max(40_000)

export const STAFFING_CURRENCIES = ['USD', 'CAD', 'SAR'] as const
export const currencySchema = z.enum(STAFFING_CURRENCIES)
export type StaffingCurrency = z.infer<typeof currencySchema>

/** E.164 phone number, for example `+966512345678`. */
export const e164PhoneSchema = z
	.string()
	.regex(/^\+[1-9]\d{6,14}$/, 'Use international format, e.g. +14155550123')

export const STAFF_STATUSES = [
	'invited',
	'active',
	'on_leave',
	'terminated',
] as const
export const staffStatusSchema = z.enum(STAFF_STATUSES)
export type StaffStatus = z.infer<typeof staffStatusSchema>

export const WORKER_TYPES = ['employee', 'contractor'] as const
export const workerTypeSchema = z.enum(WORKER_TYPES)
export type WorkerType = z.infer<typeof workerTypeSchema>

export const PAY_TYPES = ['hourly', 'salary'] as const
export const payTypeSchema = z.enum(PAY_TYPES)
export type PayType = z.infer<typeof payTypeSchema>

const nameSchema = z.string().trim().min(1).max(80)

/**
 * Input for creating or editing a staff member. Contact details are optional:
 * staff do not need a login or an email to appear on a schedule or clock in.
 */
export const staffMemberInputSchema = z.object({
	firstName: nameSchema,
	lastName: nameSchema,
	firstNameAr: z.string().trim().max(80).optional(),
	lastNameAr: z.string().trim().max(80).optional(),
	email: z.string().trim().toLowerCase().email().max(254).optional(),
	phone: e164PhoneSchema.optional(),
	workerType: workerTypeSchema.default('employee'),
	employeeNumber: z.string().trim().max(40).optional(),
	locale: z.enum(['en', 'ar']).default('en'),
	hiredAt: localDateSchema.optional(),
	primaryScopeId: z.string().min(1).max(64).optional(),
})
export type StaffMemberInput = z.infer<typeof staffMemberInputSchema>

/**
 * Position colors are theme-token keys, never raw hex values, so they follow
 * light and dark themes and pass the design-system lint rules.
 */
export const POSITION_COLOR_KEYS = [
	'neutral',
	'red',
	'orange',
	'amber',
	'green',
	'teal',
	'blue',
	'violet',
	'pink',
] as const
export const positionColorKeySchema = z.enum(POSITION_COLOR_KEYS)

export const positionInputSchema = z.object({
	name: z.string().trim().min(1).max(60),
	nameAr: z.string().trim().max(60).optional(),
	area: z.string().trim().max(60).optional(),
	colorKey: positionColorKeySchema.default('neutral'),
	defaultRateMinor: moneyMinorSchema.optional(),
	tipEligible: z.boolean().default(false),
})
export type PositionInput = z.infer<typeof positionInputSchema>

/**
 * One effective-dated pay row. Rates are never updated in place: a change
 * closes the open row and inserts a new one.
 */
export const staffJobInputSchema = z
	.object({
		scopeId: z.string().min(1).max(64),
		positionId: z.string().min(1).max(64),
		payType: payTypeSchema,
		rateMinor: moneyMinorSchema.nullable().default(null),
		annualSalaryMinor: moneyMinorSchema.nullable().default(null),
		currency: currencySchema,
		overtimeExempt: z.boolean().default(false),
		tipEligible: z.boolean().default(false),
		effectiveFrom: localDateSchema,
		effectiveTo: localDateSchema.nullable().default(null),
	})
	.refine(
		(job) => job.effectiveTo === null || job.effectiveTo >= job.effectiveFrom,
		{
			message: 'End date must not be before start date',
			path: ['effectiveTo'],
		},
	)
	.refine((job) => job.payType !== 'salary' || job.annualSalaryMinor !== null, {
		message: 'Salary jobs need an annual salary',
		path: ['annualSalaryMinor'],
	})
export type StaffJobInput = z.infer<typeof staffJobInputSchema>

/** Tokens the App mints for the staffing browser-to-regional-node calls. */
export const STAFFING_SCOPES = [
	'staff',
	'schedule',
	'timeclock',
	'labor',
	'hiring',
] as const
export const staffingScopeSchema = z.enum(STAFFING_SCOPES)
export type StaffingScope = z.infer<typeof staffingScopeSchema>

const staffingPermissionSchema = z.custom<StaffingPermission>(
	(value) =>
		typeof value === 'string' &&
		(STAFFING_PERMISSION_LIST as string[]).includes(value),
	'Unknown staffing permission',
)

/**
 * Audience of staffing operator tokens. Distinct from the generic
 * `tenant-api-operator` audience so a staffing token cannot be replayed against
 * orders, mailbox, or call routes, and none of those tokens can reach the staff
 * routes. The same `TENANT_OPERATOR_TOKEN` secret signs both.
 */
export const STAFFING_TOKEN_AUDIENCE = 'tenant-api-staff-operator'
/** JOSE `typ` header of staffing operator tokens. */
export const STAFFING_TOKEN_TYP = 'staff+jwt'

export const staffingTokenClaimsSchema = z.object({
	aud: z.literal(STAFFING_TOKEN_AUDIENCE),
	role: z.literal('operator'),
	/** Data region the App resolved for the org; a node in another region refuses. */
	region: z.enum(['us', 'ksa']).optional(),
	/** Organization id; tenant-api rejects a mismatch with the node's org. */
	orgId: z.string().min(1),
	/** Operator user id (a control-plane id, never staff data). */
	sub: z.string().min(1),
	scope: staffingScopeSchema,
	grants: z.array(staffingPermissionSchema),
	/** `null` means every scope; an array restricts to those scope ids. */
	scopeIds: z.array(z.string().min(1)).nullable(),
	/** True when minted for an impersonated session (read-only, no pay). */
	impersonated: z.boolean().default(false),
})
export type StaffingTokenClaims = z.infer<typeof staffingTokenClaimsSchema>

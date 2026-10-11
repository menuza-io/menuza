import { z } from 'zod'
import { localDateSchema, WEEK_STARTS } from './time.ts'

export const STAFF_STATUSES = ['active', 'terminated'] as const
export type StaffStatus = (typeof STAFF_STATUSES)[number]

/** Fixed palette keys; UI maps them to theme tokens, never raw colors. */
export const POSITION_COLOR_KEYS = [
	'gray',
	'red',
	'orange',
	'yellow',
	'green',
	'teal',
	'blue',
	'purple',
	'pink',
] as const
export type PositionColorKey = (typeof POSITION_COLOR_KEYS)[number]

const id = z.string().trim().min(1).max(64)
const PHONE_RE = /^\+?[\d\s().-]{6,32}$/
const emptyToNull = (value: unknown) =>
	typeof value === 'string' && value.trim() === '' ? null : value

export const staffEmailSchema = z.preprocess(
	emptyToNull,
	z.string().trim().toLowerCase().email().max(254).nullable(),
)
export const staffPhoneSchema = z.preprocess(
	emptyToNull,
	z.string().trim().regex(PHONE_RE, { message: 'invalid_phone' }).nullable(),
)

export const staffAssignmentSchema = z.object({
	locationId: id,
	positionId: id,
	isPrimary: z.boolean().default(false),
})

export const staffMemberInputSchema = z.object({
	firstName: z.string().trim().min(1).max(80),
	lastName: z.string().trim().max(80).default(''),
	email: staffEmailSchema.default(null),
	phone: staffPhoneSchema.default(null),
	hiredOn: z.preprocess(emptyToNull, localDateSchema.nullable()).default(null),
	note: z.string().trim().max(2000).default(''),
	assignments: z.array(staffAssignmentSchema).max(50).default([]),
})
export type StaffMemberInput = z.infer<typeof staffMemberInputSchema>

export const staffTerminationSchema = z.object({
	terminatedOn: localDateSchema,
	reason: z.string().trim().max(500).default(''),
})

export const positionInputSchema = z.object({
	name: z.string().trim().min(1).max(60),
	colorKey: z.enum(POSITION_COLOR_KEYS).default('gray'),
})

export const staffingSettingsSchema = z.object({
	weekStart: z.enum(WEEK_STARTS).default('monday'),
	weeklyHoursThreshold: z.number().min(1).max(168).nullable().default(40),
	lateGraceMinutes: z.number().int().min(0).max(120).default(5),
})
export type StaffingSettings = z.infer<typeof staffingSettingsSchema>

/** At most one primary position per location. */
export function normalizeAssignments(
	assignments: readonly z.infer<typeof staffAssignmentSchema>[],
) {
	const seen = new Set<string>()
	const primaryAt = new Set<string>()
	const result: z.infer<typeof staffAssignmentSchema>[] = []
	for (const assignment of assignments) {
		const key = `${assignment.locationId}\u0000${assignment.positionId}`
		if (seen.has(key)) continue
		seen.add(key)
		const isPrimary =
			assignment.isPrimary && !primaryAt.has(assignment.locationId)
		if (isPrimary) primaryAt.add(assignment.locationId)
		result.push({ ...assignment, isPrimary })
	}
	for (const locationId of new Set(result.map((item) => item.locationId))) {
		if (primaryAt.has(locationId)) continue
		const first = result.find((item) => item.locationId === locationId)
		if (first) first.isPrimary = true
	}
	return result
}

export const ROSTER_IMPORT_MAX_ROWS = 200

export type RosterImportError =
	| 'name_required'
	| 'invalid_email'
	| 'invalid_phone'
	| 'duplicate_email'
	| 'too_many_rows'

export type RosterImportRow = {
	line: number
	firstName: string
	lastName: string
	email: string | null
	phone: string | null
	positionName: string | null
}

/**
 * Parses pasted lines of `name, email, phone, position` (comma- or tab-
 * separated; trailing columns optional). Returns codes, not UI strings.
 */
export function parseRosterPaste(text: string) {
	const rows: RosterImportRow[] = []
	const errors: { line: number; code: RosterImportError }[] = []
	const emails = new Set<string>()
	const lines = text.split(/\r?\n/)
	for (const [index, raw] of lines.entries()) {
		const line = index + 1
		if (!raw.trim()) continue
		const cells = raw
			.split(raw.includes('\t') ? '\t' : ',')
			.map((cell) => cell.trim())
		const [name = '', email = '', phone = '', position = ''] = cells
		if (rows.length === 0 && errors.length === 0 && /^name$/i.test(name)) {
			continue
		}
		if (rows.length >= ROSTER_IMPORT_MAX_ROWS) {
			errors.push({ line, code: 'too_many_rows' })
			break
		}
		const [firstName = '', ...rest] = name.split(/\s+/).filter(Boolean)
		if (!firstName || firstName.length > 80) {
			errors.push({ line, code: 'name_required' })
			continue
		}
		const parsedEmail = staffEmailSchema.safeParse(email)
		if (!parsedEmail.success) {
			errors.push({ line, code: 'invalid_email' })
			continue
		}
		const parsedPhone = staffPhoneSchema.safeParse(phone)
		if (!parsedPhone.success) {
			errors.push({ line, code: 'invalid_phone' })
			continue
		}
		if (parsedEmail.data) {
			if (emails.has(parsedEmail.data)) {
				errors.push({ line, code: 'duplicate_email' })
				continue
			}
			emails.add(parsedEmail.data)
		}
		rows.push({
			line,
			firstName,
			lastName: rest.join(' ').slice(0, 80),
			email: parsedEmail.data,
			phone: parsedPhone.data,
			positionName: position.slice(0, 60) || null,
		})
	}
	return { rows, errors }
}

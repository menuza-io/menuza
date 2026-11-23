import { z } from 'zod'

/**
 * Menuza contacts (#272): who looks after a restaurant. Assignment gives no
 * access of any kind; it only names a person and routes support requests.
 */

export const ASSIGNMENT_ROLES = [
	'launch_specialist',
	'account_manager',
	'support',
] as const
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number]

export const ASSIGNMENT_ROLE_LABELS: Record<AssignmentRole, string> = {
	launch_specialist: 'Launch specialist',
	account_manager: 'Account manager',
	support: 'Support',
}

export function isAssignmentRole(value: unknown): value is AssignmentRole {
	return (
		typeof value === 'string' &&
		(ASSIGNMENT_ROLES as readonly string[]).includes(value)
	)
}

/** `all` is every location; otherwise the location id. */
export const ALL_LOCATIONS = 'all'

export function scopeKeyFor(locationId: string | null | undefined): string {
	return locationId ? locationId : ALL_LOCATIONS
}

export const assignSchema = z.strictObject({
	role: z.enum(ASSIGNMENT_ROLES),
	adminUserId: z.string().trim().min(1).max(64),
	/** Empty or `all` means every location. */
	locationId: z
		.string()
		.trim()
		.max(64)
		.optional()
		.transform((value) => (!value || value === ALL_LOCATIONS ? null : value)),
})

export type OpenAssignment = {
	role: string
	scopeKey: string
	adminUserId: string
}

/**
 * The contact a restaurant's request goes to first: the support contact for the
 * location, else for all locations, then the account manager, then the launch
 * specialist. Null when nobody is assigned.
 */
export function pickSupportContact<T extends OpenAssignment>(
	assignments: readonly T[],
	locationId?: string | null,
): T | null {
	for (const role of ['support', 'account_manager', 'launch_specialist']) {
		const ofRole = assignments.filter((row) => row.role === role)
		const scoped = locationId
			? ofRole.find((row) => row.scopeKey === locationId)
			: undefined
		const general = ofRole.find((row) => row.scopeKey === ALL_LOCATIONS)
		const found = scoped ?? general
		if (found) return found
	}
	return null
}

/** The only fields the restaurant sees about its contact. */
export type PublicSupportContact = {
	firstName: string
	imageObjectKey: string | null
}

export function firstNameOf(
	name: string | null | undefined,
	fallback: string,
): string {
	const first = name?.trim().split(/\s+/)[0]
	return first || fallback
}

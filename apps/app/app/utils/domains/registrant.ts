import { z } from 'zod'
import { type RegistrantContact } from './adapters.server.ts'

/**
 * The business contact a domain is registered to (#183): ICANN needs the real
 * legal owner. Operator data: stored encrypted, shared only with the registrar.
 */
const text = (max = 120) => z.string().trim().min(1).max(max)

export const RegistrantContactSchema = z.object({
	firstName: text(60),
	lastName: text(60),
	organization: text(120),
	email: z.string().trim().toLowerCase().email().max(254),
	phone: z
		.string()
		.trim()
		.regex(/^\+?[0-9][0-9 ().-]{5,20}$/u),
	address1: text(120),
	address2: z.string().trim().max(120).optional(),
	city: text(80),
	state: text(80),
	postalCode: text(20),
	country: z
		.string()
		.trim()
		.toUpperCase()
		.regex(/^[A-Z]{2}$/u),
}) satisfies z.ZodType<RegistrantContact, unknown>

export function parseRegistrantContact(input: unknown) {
	return RegistrantContactSchema.safeParse(input)
}

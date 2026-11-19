import { z } from 'zod'

/**
 * The details the legal pages are filled with (#89), kept as JSON in
 * `Organization.legalContact`: the company that runs the website, how to reach
 * it, the country (which privacy rules apply) and the operator's own refund
 * and booking wording. Business data, not guest data.
 */
export const LegalContactSchema = z.object({
	legalName: z.string().trim().max(160).default(''),
	email: z.string().trim().max(200).default(''),
	phone: z.string().trim().max(60).default(''),
	address: z.string().trim().max(300).default(''),
	/** ISO 3166-1 alpha-2, or empty. */
	country: z
		.string()
		.trim()
		.toUpperCase()
		.max(2)
		.refine((value) => value === '' || /^[A-Z]{2}$/.test(value), {
			message: 'Use a two letter country code',
		})
		.default(''),
	refundText: z.string().trim().max(1500).default(''),
	reservationText: z.string().trim().max(1500).default(''),
})

export type LegalContact = z.infer<typeof LegalContactSchema>

export const EMPTY_LEGAL_CONTACT: LegalContact = {
	legalName: '',
	email: '',
	phone: '',
	address: '',
	country: '',
	refundText: '',
	reservationText: '',
}

export function parseLegalContact(
	raw: string | null | undefined,
): LegalContact {
	if (!raw) return { ...EMPTY_LEGAL_CONTACT }
	try {
		const parsed = LegalContactSchema.safeParse(JSON.parse(raw))
		return parsed.success ? parsed.data : { ...EMPTY_LEGAL_CONTACT }
	} catch {
		return { ...EMPTY_LEGAL_CONTACT }
	}
}

export function serializeLegalContact(contact: LegalContact) {
	return JSON.stringify(LegalContactSchema.parse(contact))
}

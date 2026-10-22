import { z } from 'zod'

export const VAT_NUMBER_MAX_LENGTH = 32

/**
 * Tax-inclusive pricing and the seller's VAT registration number for a
 * restaurant location, as submitted by the location editor. Shared by the
 * create and edit actions.
 *
 * - `taxInclusive`: menu prices already include tax (required in Saudi Arabia,
 *   the EU and the UK). Missing means false, so older forms keep exclusive tax.
 * - `vatNumber`: trimmed, letters and digits only, at most 32 characters; an
 *   empty value clears it. KSA numbers are 15 digits, but that is not enforced
 *   so other countries' formats fit.
 */
export const locationTaxInputFields = {
	taxInclusive: z.preprocess(
		(val) => val === 'true' || val === true,
		z.boolean(),
	),
	vatNumber: z.preprocess(
		(val) => (typeof val === 'string' ? val.trim() : val),
		z
			.string()
			.max(
				VAT_NUMBER_MAX_LENGTH,
				`VAT number must be at most ${VAT_NUMBER_MAX_LENGTH} characters`,
			)
			.regex(/^[A-Za-z0-9]*$/, 'VAT number may only contain letters and digits')
			.optional()
			.transform((val) => val || null),
	),
}

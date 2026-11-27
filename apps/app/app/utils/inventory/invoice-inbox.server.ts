import { and, db, eq, isNull, OrganizationLocation } from '@repo/database'

/**
 * The code in a location's supplier invoice address,
 * `invoices+<code>@<inbox domain>` (#503). It is random and unguessable enough
 * that a stranger cannot pick a restaurant's address, and it is the only thing
 * the control plane keeps about the feature: the mail, its files and its
 * sender are stored in the location's own region.
 */

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
export const INVOICE_CODE_LENGTH = 12

/** Largest multiple of the alphabet size that fits a byte: bytes at or above it are redrawn, so every letter is equally likely. */
const UNBIASED_LIMIT = 256 - (256 % ALPHABET.length)

export function generateInvoiceInboxCode(random = crypto): string {
	let code = ''
	const bytes = new Uint8Array(INVOICE_CODE_LENGTH * 2)
	while (code.length < INVOICE_CODE_LENGTH) {
		random.getRandomValues(bytes)
		for (const byte of bytes) {
			if (byte >= UNBIASED_LIMIT) continue
			code += ALPHABET[byte % ALPHABET.length]!
			if (code.length === INVOICE_CODE_LENGTH) break
		}
	}
	return code
}

/** A unique-index collision (the one failure worth another try). */
const isUniqueViolation = (error: unknown) =>
	/UNIQUE|constraint/i.test(
		[
			error instanceof Error ? error.message : String(error),
			error instanceof Error && error.cause instanceof Error
				? error.cause.message
				: '',
		].join(' '),
	)

/** The location's code, made on first use. Null when the location is not the organization's. */
export async function ensureInvoiceInboxCode(input: {
	organizationId: string
	locationId: string
}): Promise<string | null> {
	const [location] = await db
		.select({ code: OrganizationLocation.invoiceInboxCode })
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, input.locationId),
				eq(OrganizationLocation.organizationId, input.organizationId),
			),
		)
		.limit(1)
	if (!location) return null
	if (location.code) return location.code
	for (let attempt = 0; attempt < 5; attempt++) {
		const code = generateInvoiceInboxCode()
		try {
			const updated = await db
				.update(OrganizationLocation)
				.set({ invoiceInboxCode: code })
				.where(
					and(
						eq(OrganizationLocation.id, input.locationId),
						isNull(OrganizationLocation.invoiceInboxCode),
					),
				)
				.returning({ code: OrganizationLocation.invoiceInboxCode })
			if (updated[0]?.code) return updated[0].code
			// Someone else set it first.
			const [again] = await db
				.select({ code: OrganizationLocation.invoiceInboxCode })
				.from(OrganizationLocation)
				.where(eq(OrganizationLocation.id, input.locationId))
				.limit(1)
			return again?.code ?? null
		} catch (error) {
			// A code that was already taken (unique index): try another. Anything else
			// (an outage, a timeout, a schema mismatch) is a real failure: say so,
			// with ids only, never the code.
			if (!isUniqueViolation(error)) {
				console.error('invoice inbox code could not be saved', {
					organizationId: input.organizationId,
					locationId: input.locationId,
				})
				throw error
			}
		}
	}
	return null
}

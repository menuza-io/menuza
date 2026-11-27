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

export function generateInvoiceInboxCode(random = crypto): string {
	const bytes = new Uint8Array(INVOICE_CODE_LENGTH)
	random.getRandomValues(bytes)
	return Array.from(
		bytes,
		(byte) => ALPHABET[byte % ALPHABET.length]!,
	).join('')
}

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
		} catch {
			// A code that was already taken (unique index): try another.
		}
	}
	return null
}

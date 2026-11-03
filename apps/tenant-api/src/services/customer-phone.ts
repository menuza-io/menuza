import { customers, type TenantDatabase } from '@repo/tenant-db'
import { eq, inArray } from 'drizzle-orm'
import { legacyPhoneForms } from '../lib/phone.ts'

/**
 * The customer for an E.164 number. Rows written before phone normalization
 * may hold the number without `+` or in national form, so when no row has the
 * E.164 form the legacy forms are tried (exact match always wins). The row is
 * rewritten to E.164 after a successful verify (`upgradeLegacyPhone`).
 */
export async function findCustomerByPhone(db: TenantDatabase, phone: string) {
	const exact = await db
		.select()
		.from(customers)
		.where(eq(customers.phone, phone))
		.get()
	if (exact) return exact
	const legacy = legacyPhoneForms(phone)
	if (legacy.length === 0) return undefined
	const rows = await db
		.select()
		.from(customers)
		.where(inArray(customers.phone, legacy)) // bounded: at most four forms
		.all()
	// Oldest row first: it is the original account, not a later duplicate.
	return rows.sort(
		(a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
	)[0]
}

/**
 * Moves a legacy-format row to E.164. A UNIQUE collision (another row already
 * holds the E.164 form) is left alone: the two rows are never merged here.
 */
export async function upgradeLegacyPhone(
	db: TenantDatabase,
	customer: { id: string; phone: string | null },
	phone: string,
) {
	if (customer.phone === phone) return
	try {
		await db
			.update(customers)
			.set({ phone })
			.where(eq(customers.id, customer.id))
			.run()
	} catch (error) {
		console.warn(
			'Could not rewrite legacy phone to E.164 (kept as stored):',
			error instanceof Error ? error.message : 'unknown error',
		)
	}
}

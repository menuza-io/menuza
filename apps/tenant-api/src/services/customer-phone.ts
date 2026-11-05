import { customers, type TenantDatabase } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'

/**
 * The customer for an E.164 number. Phones are always stored normalized, so
 * this is an exact match: a row stored in another form (digits only, national
 * format) belongs to whatever number that form means, never to this one.
 */
export async function findCustomerByPhone(db: TenantDatabase, phone: string) {
	return db.select().from(customers).where(eq(customers.phone, phone)).get()
}

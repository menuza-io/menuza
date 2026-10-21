import {
	customers,
	getTenantDbOrgId,
	rsvGuests,
	rsvReservations,
	type TenantDatabase,
} from '@repo/tenant-db'
import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm'
import { withSetupWrite } from '../lib/reservations-write.ts'
import { type DbOrTx } from './rsv-guest-service.ts'

/**
 * The guest <-> customer link (ADR 048, "Linking rule").
 *
 * `rsv_guests.customer_id` is set ONLY when a customer's VERIFIED phone (the
 * owner proved control with an OTP) equals the guest's `phone_e164`, and the
 * customer owns no other guest (unique partial index). Nothing here ever
 * links on an unverified phone, a name or an email: anyone can type a phone
 * number into a booking form. Nothing here creates a `customers` row either.
 *
 * Every function is idempotent (guarded updates, `customer_id IS NULL`) and
 * never logs a phone number, name or email: ids and counts only.
 */

type LinkableGuest = {
	id: string
	customerId: string | null
	phoneE164: string | null
	erasedAt: number | null
	mergedIntoId: string | null
}

async function customerOwnsGuest(
	tx: DbOrTx,
	customerId: string,
): Promise<boolean> {
	const owner = await tx
		.select({ id: rsvGuests.id })
		.from(rsvGuests)
		.where(eq(rsvGuests.customerId, customerId))
		.get()
	return owner !== undefined
}

/** Guarded link of one guest to one customer; true when the row changed. */
async function applyLink(
	tx: DbOrTx,
	guestId: string,
	customerId: string,
	now: number,
): Promise<boolean> {
	const updated = await tx
		.update(rsvGuests)
		.set({ customerId, updatedAt: now })
		.where(and(eq(rsvGuests.id, guestId), isNull(rsvGuests.customerId)))
		.returning({ id: rsvGuests.id })
	if (updated.length === 0) return false
	// The guest's earlier bookings belong to the same signed-in person.
	await tx
		.update(rsvReservations)
		.set({ customerId })
		.where(
			and(
				eq(rsvReservations.guestId, guestId),
				isNull(rsvReservations.customerId),
			),
		)
	return true
}

/**
 * Links one live guest to the verified customer that owns its phone, if any.
 * Returns the customer id when the guest is (now) linked.
 */
export async function linkGuestToVerifiedCustomer(
	tx: DbOrTx,
	guest: LinkableGuest,
	now: number = Date.now(),
): Promise<string | null> {
	if (guest.customerId) return guest.customerId
	if (guest.erasedAt !== null || guest.mergedIntoId !== null) return null
	if (!guest.phoneE164) return null
	const customer = await tx
		.select({ id: customers.id })
		.from(customers)
		.where(
			and(
				eq(customers.phone, guest.phoneE164),
				eq(customers.phoneVerified, true),
			),
		)
		.get()
	if (!customer) return null
	if (await customerOwnsGuest(tx, customer.id)) return null
	return (await applyLink(tx, guest.id, customer.id, now)) ? customer.id : null
}

/**
 * Called when a customer's phone has just been verified: links the live guest
 * that carries the same phone (most recent visit first when several do). Never
 * throws into sign-in: a failure is swallowed and counted by the caller's log.
 */
export async function linkVerifiedCustomerToGuest(
	db: TenantDatabase,
	customerId: string,
	opts?: { orgId?: string; now?: number },
): Promise<{ linkedGuestId: string | null }> {
	try {
		const orgId = opts?.orgId ?? getTenantDbOrgId(db) ?? undefined
		return await withSetupWrite(
			db,
			async (tx) => {
				const customer = await tx
					.select({ phone: customers.phone, verified: customers.phoneVerified })
					.from(customers)
					.where(eq(customers.id, customerId))
					.get()
				if (!customer?.phone || !customer.verified) {
					return { linkedGuestId: null }
				}
				if (await customerOwnsGuest(tx, customerId)) {
					return { linkedGuestId: null }
				}
				const candidates = await tx
					.select({
						id: rsvGuests.id,
						customerId: rsvGuests.customerId,
						phoneE164: rsvGuests.phoneE164,
						erasedAt: rsvGuests.erasedAt,
						mergedIntoId: rsvGuests.mergedIntoId,
					})
					.from(rsvGuests)
					.where(
						and(
							eq(rsvGuests.phoneE164, customer.phone),
							isNull(rsvGuests.customerId),
							isNull(rsvGuests.mergedIntoId),
							isNull(rsvGuests.erasedAt),
						),
					)
					.orderBy(
						sql`${rsvGuests.lastVisitAt} IS NULL`,
						sql`${rsvGuests.lastVisitAt} DESC`,
						sql`${rsvGuests.updatedAt} DESC`,
						asc(rsvGuests.id),
					)
					.limit(1)
					.all()
				const guest = candidates[0]
				if (!guest) return { linkedGuestId: null }
				const linked = await linkGuestToVerifiedCustomer(
					tx,
					guest,
					opts?.now ?? Date.now(),
				)
				return { linkedGuestId: linked ? guest.id : null }
			},
			orgId,
		)
	} catch (error) {
		console.error(
			'[reservations] guest link at verification failed',
			error instanceof Error ? error.name : 'error',
		)
		return { linkedGuestId: null }
	}
}

export type LinkGuestsSummary = {
	/** Guests newly linked to a verified customer. */
	linked: number
	/** Verified customers that already own a guest (nothing to do). */
	alreadyLinked: number
	/** Extra guests sharing the phone of a customer that just got its best match. */
	skippedTies: number
}

const LINK_CUSTOMER_BATCH = 200

/**
 * Idempotent maintenance pass: for every verified customer with a phone that
 * owns no guest yet, links the live guest with the same phone (the one with
 * the latest visit when several share it; the others are skipped and counted).
 * Safe to re-run and to run concurrently with bookings (guarded updates).
 */
export async function linkGuestsToCustomers(
	db: TenantDatabase,
	opts?: { orgId?: string; now?: number },
): Promise<LinkGuestsSummary> {
	const orgId = opts?.orgId ?? getTenantDbOrgId(db) ?? undefined
	const now = opts?.now ?? Date.now()
	const summary: LinkGuestsSummary = {
		linked: 0,
		alreadyLinked: 0,
		skippedTies: 0,
	}
	let cursor = ''
	for (;;) {
		const batch = await withSetupWrite(
			db,
			async (tx) => {
				const verified = await tx
					.select({ id: customers.id, phone: customers.phone })
					.from(customers)
					.where(
						and(
							eq(customers.phoneVerified, true),
							sql`${customers.phone} IS NOT NULL`,
							gt(customers.id, cursor),
						),
					)
					.orderBy(asc(customers.id))
					.limit(LINK_CUSTOMER_BATCH)
					.all()
				const out: LinkGuestsSummary & { last: string | null } = {
					linked: 0,
					alreadyLinked: 0,
					skippedTies: 0,
					last: verified.at(-1)?.id ?? null,
				}
				for (const customer of verified) {
					if (await customerOwnsGuest(tx, customer.id)) {
						out.alreadyLinked += 1
						continue
					}
					const candidates = await tx
						.select({
							id: rsvGuests.id,
							customerId: rsvGuests.customerId,
							phoneE164: rsvGuests.phoneE164,
							erasedAt: rsvGuests.erasedAt,
							mergedIntoId: rsvGuests.mergedIntoId,
						})
						.from(rsvGuests)
						.where(
							and(
								eq(rsvGuests.phoneE164, customer.phone!),
								isNull(rsvGuests.customerId),
								isNull(rsvGuests.mergedIntoId),
								isNull(rsvGuests.erasedAt),
							),
						)
						.orderBy(
							sql`${rsvGuests.lastVisitAt} IS NULL`,
							sql`${rsvGuests.lastVisitAt} DESC`,
							sql`${rsvGuests.updatedAt} DESC`,
							asc(rsvGuests.id),
						)
						.all()
					const [best, ...rest] = candidates
					if (!best) continue
					if (await linkGuestToVerifiedCustomer(tx, best, now)) {
						out.linked += 1
						out.skippedTies += rest.length
					}
				}
				return out
			},
			orgId,
		)
		summary.linked += batch.linked
		summary.alreadyLinked += batch.alreadyLinked
		summary.skippedTies += batch.skippedTies
		if (!batch.last) break
		cursor = batch.last
	}
	return summary
}

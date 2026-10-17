import { rsvReservationEvents } from '@repo/tenant-db'
import { and, asc, inArray } from 'drizzle-orm'
import { queryInChunks } from '../lib/chunked-in.ts'
import { type DbOrTx } from './rsv-guest-service.ts'

/**
 * The contact a guest typed for one public booking. Public requests never edit
 * an existing guest profile (anyone can type someone else's phone number), so
 * what was typed for THIS booking lives on the booking's first event and
 * messages and the manage page use it instead of the profile.
 */
export type BookingContact = {
	firstName: string
	lastName: string
	email: string | null
}

export function bookingContactData(input: {
	firstName: string
	lastName: string
	email?: string | null
}): { contact: BookingContact } {
	return {
		contact: {
			firstName: input.firstName.trim(),
			lastName: input.lastName.trim(),
			email: input.email?.trim().toLowerCase() || null,
		},
	}
}

function parseContact(data: unknown): BookingContact | null {
	const raw = (data as { contact?: Partial<BookingContact> } | null)?.contact
	if (!raw || typeof raw.firstName !== 'string') return null
	return {
		firstName: raw.firstName,
		lastName: typeof raw.lastName === 'string' ? raw.lastName : '',
		email: typeof raw.email === 'string' && raw.email ? raw.email : null,
	}
}

/** Reservations booked by an operator or older ones have no entry: use the profile. */
export async function loadBookingContacts(
	tx: DbOrTx,
	reservationIds: readonly string[],
): Promise<Map<string, BookingContact>> {
	const out = new Map<string, BookingContact>()
	if (reservationIds.length === 0) return out
	const rows = await queryInChunks([...new Set(reservationIds)], (chunk) =>
		tx
			.select({
				reservationId: rsvReservationEvents.reservationId,
				data: rsvReservationEvents.data,
			})
			.from(rsvReservationEvents)
			.where(
				and(
					inArray(rsvReservationEvents.reservationId, chunk),
					inArray(rsvReservationEvents.type, ['created', 'requested']),
				),
			)
			.orderBy(asc(rsvReservationEvents.at)),
	)
	for (const row of rows) {
		const contact = parseContact(row.data)
		if (contact && !out.has(row.reservationId))
			out.set(row.reservationId, contact)
	}
	return out
}

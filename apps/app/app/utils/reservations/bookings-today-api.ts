import { z } from 'zod'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

const num = z.number().catch(0)

const bookingsTodaySchema = z.object({
	locationId: z.string().catch(''),
	businessDate: z.string().catch(''),
	totalParties: num,
	totalCovers: num,
	counts: z.record(z.string(), z.number()).catch({}),
	coversByService: z
		.array(
			z.object({
				serviceId: z.string().nullable().catch(null),
				name: z.string().nullable().catch(null),
				parties: num,
				covers: num,
			}),
		)
		.catch([]),
	waitlistCount: num,
	nextArrivals: z
		.array(
			z.object({
				reservationId: z.string(),
				time: z.string().catch(''),
				partySize: num,
				firstName: z.string().catch(''),
				status: z.string().catch(''),
			}),
		)
		.catch([]),
})

export type BookingsToday = z.infer<typeof bookingsTodaySchema>

export const BOOKINGS_TODAY_PATH = '/operator/reservations/book/today'

/** The block reads this straight from tenant-api with a short-lived `book` token. */
export async function fetchBookingsToday(
	client: ReservationsScopedClient,
	locationId: string,
	signal?: AbortSignal,
): Promise<BookingsToday> {
	const raw = await client.request<unknown>(BOOKINGS_TODAY_PATH, {
		query: { locationId },
		signal,
	})
	return bookingsTodaySchema.parse(raw)
}

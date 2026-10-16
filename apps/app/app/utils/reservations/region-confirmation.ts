import { z } from 'zod'

export const reservationsSummarySchema = z.object({
	reservations: z.number().int().min(0),
	upcomingReservations: z.number().int().min(0),
	byStatus: z
		.object({
			pending: z.number().int().min(0).default(0),
			booked: z.number().int().min(0).default(0),
			confirmed: z.number().int().min(0).default(0),
			arrived: z.number().int().min(0).default(0),
			seated: z.number().int().min(0).default(0),
			finished: z.number().int().min(0).default(0),
			cancelled: z.number().int().min(0).default(0),
			no_show: z.number().int().min(0).default(0),
			declined: z.number().int().min(0).default(0),
			expired: z.number().int().min(0).default(0),
		})
		.optional(),
	guests: z.number().int().min(0),
	waitlistEntries: z.number().int().min(0),
	tables: z.number().int().min(0),
	experiences: z.number().int().min(0),
	payments: z.number().int().min(0),
	auditEntries: z.number().int().min(0),
})

export type ReservationsSummary = z.infer<typeof reservationsSummarySchema>

export function summaryHasReservationsData(
	summary: ReservationsSummary | null,
): boolean {
	if (!summary) return false
	return (
		summary.reservations > 0 ||
		summary.upcomingReservations > 0 ||
		summary.guests > 0 ||
		summary.waitlistEntries > 0 ||
		summary.tables > 0 ||
		summary.experiences > 0 ||
		summary.payments > 0
	)
}

/**
 * Whether the region switch needs a typed confirmation. An unknown summary
 * counts as "might hold reservations data": the guard fails closed.
 */
export function requiresReservationsConfirmation(
	summary: ReservationsSummary | null,
): boolean {
	return summary === null || summaryHasReservationsData(summary)
}

/** The admin must type the organization's slug (case and outer spaces ignored). */
export function reservationsConfirmationMatches(
	typed: string | null | undefined,
	slug: string,
): boolean {
	if (!typed || !slug) return false
	return typed.trim().toLowerCase() === slug.trim().toLowerCase()
}

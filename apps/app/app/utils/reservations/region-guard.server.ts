import { z } from 'zod'
import {
	requiresReservationsConfirmation,
	reservationsConfirmationMatches,
	reservationsSummarySchema,
	type ReservationsSummary,
} from './region-confirmation.ts'
import { postRegionalReservationsInternal } from './regional-internal.server.ts'

const internalSummaryRequestSchema = z.object({
	orgId: z.string().trim().min(1),
})

/**
 * Counts for the organization's current region, or `null` when unknown.
 * Zero guest PII crosses the US <-> regional boundary.
 */
export async function fetchReservationsSummary({
	organizationId,
	dataRegion,
}: {
	organizationId: string
	dataRegion: string
}): Promise<ReservationsSummary | null> {
	try {
		const response = await postRegionalReservationsInternal({
			dataRegion,
			path: 'summary',
			body: internalSummaryRequestSchema.parse({ orgId: organizationId }),
			timeoutMs: 8_000,
		})
		if (!response.ok) return null
		const parsed = reservationsSummarySchema.safeParse(await response.json())
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

export type ReservationsRegionGuardDecision =
	| { allowed: true; summary: ReservationsSummary | null }
	| { allowed: false; summary: ReservationsSummary | null }

/** Decides whether a confirmed region switch may proceed. */
export function evaluateReservationsRegionGuard({
	summary,
	typedConfirmation,
	slug,
}: {
	summary: ReservationsSummary | null
	typedConfirmation: string | null | undefined
	slug: string
}): ReservationsRegionGuardDecision {
	if (!requiresReservationsConfirmation(summary)) {
		return { allowed: true, summary }
	}
	return {
		allowed: reservationsConfirmationMatches(typedConfirmation, slug),
		summary,
	}
}

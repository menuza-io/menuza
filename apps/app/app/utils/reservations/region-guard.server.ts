import { z } from 'zod'
import {
	locationReservationsSummarySchema,
	requiresReservationsConfirmation,
	reservationsConfirmationMatches,
	reservationsSummarySchema,
	type LocationReservationsSummary,
	type ReservationsSummary,
} from './region-confirmation.ts'
import { postRegionalReservationsInternal } from './regional-internal.server.ts'

const internalSummaryRequestSchema = z.object({
	orgId: z.string().trim().min(1),
})

const internalLocationSummaryRequestSchema = z.object({
	orgId: z.string().trim().min(1),
	locationId: z.string().trim().min(1),
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

export async function fetchLocationReservationsSummary({
	organizationId,
	dataRegion,
	locationId,
}: {
	organizationId: string
	dataRegion: string
	locationId: string
}): Promise<LocationReservationsSummary | null> {
	try {
		const response = await postRegionalReservationsInternal({
			dataRegion,
			path: 'location-summary',
			body: internalLocationSummaryRequestSchema.parse({
				orgId: organizationId,
				locationId,
			}),
			timeoutMs: 8_000,
		})
		if (!response.ok) return null
		const parsed = locationReservationsSummarySchema.safeParse(
			await response.json(),
		)
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

export type LocationDeleteGuardDecision =
	| {
			allowed: true
			status: 200
			futureReservations: 0
			summary: LocationReservationsSummary | null
	  }
	| {
			allowed: false
			status: 409 | 503
			error: string
			futureReservations: number
			summary: LocationReservationsSummary | null
	  }

export async function checkLocationReservationsDeleteGuard({
	organizationId,
	dataRegion,
	hasProvisionedDb,
	locationId,
}: {
	organizationId: string
	dataRegion: string | null | undefined
	hasProvisionedDb: boolean | null | undefined
	locationId: string
}): Promise<LocationDeleteGuardDecision> {
	if (!hasProvisionedDb) {
		return {
			allowed: true,
			status: 200,
			futureReservations: 0,
			summary: null,
		}
	}
	const region = dataRegion === 'ksa' ? 'ksa' : 'us'
	const summary = await fetchLocationReservationsSummary({
		organizationId,
		dataRegion: region,
		locationId,
	})
	if (!summary) {
		return {
			allowed: false,
			status: 503,
			error:
				'Could not reach the regional reservation service to verify future reservations. Try again once the region is reachable.',
			futureReservations: 0,
			summary: null,
		}
	}
	const futureCount =
		summary.activeFutureReservations ?? summary.futureReservations
	if (futureCount > 0 || summary.canDelete === false) {
		return {
			allowed: false,
			status: 409,
			error: `Cannot delete this location while it has ${futureCount} active future ${futureCount === 1 ? 'reservation' : 'reservations'}. Cancel or move them first.`,
			futureReservations: futureCount,
			summary,
		}
	}
	return {
		allowed: true,
		status: 200,
		futureReservations: 0,
		summary,
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

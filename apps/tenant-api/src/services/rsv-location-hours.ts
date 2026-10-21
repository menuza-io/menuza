import {
	type LocationHours,
	type ReservationsContext,
} from '@repo/reservations'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { resolveReservationOrgId } from '../lib/reservations-write.ts'
import { type DbOrTx } from './rsv-guest-service.ts'

/** Location facts from the non-PII context as `LocationHours` (the single source of "when are we open"). */
export function locationHoursFromFacts(
	facts: Pick<
		ReservationsContext['locations'][number],
		'timeZone' | 'isActive' | 'storeHours' | 'specialHours'
	>,
): LocationHours {
	return {
		timeZone: facts.timeZone,
		// Tolerant of older context payloads: only an explicit `false` closes.
		isActive: facts.isActive !== false,
		storeHours: facts.storeHours ?? null,
		specialHours: facts.specialHours ?? null,
	}
}

export function locationHoursFromContext(
	context: ReservationsContext | null | undefined,
	locationId: string,
): LocationHours | null {
	const facts = context?.locations.find((l) => l.id === locationId)
	return facts ? locationHoursFromFacts(facts) : null
}

/**
 * Hours of one location from the cached control-plane context. Fails open:
 * no org id, no context (never fetched or expired) or an unknown location all
 * return `null`, which means "behave as reservations-only".
 */
export async function loadLocationHours(
	db: DbOrTx,
	locationId: string,
): Promise<LocationHours | null> {
	const orgId = resolveReservationOrgId(db)
	if (!orgId) return null
	try {
		return locationHoursFromContext(
			await getReservationsContext(orgId),
			locationId,
		)
	} catch {
		return null
	}
}

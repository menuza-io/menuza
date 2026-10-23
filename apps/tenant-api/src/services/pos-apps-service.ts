import { type PosDeviceApps } from '@repo/common/pos-orders'
import { type ReservationsContext } from '@repo/reservations'
import { type PosDevice } from '@repo/tenant-db'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { getStaffingFeatures } from '../lib/scope-context.ts'

/**
 * Station apps beside the till. Each needs the terminal's own setting and the
 * organization's flag; the till itself sells regardless.
 *
 * The time clock stays usable when App cannot be asked (an unknown flag counts
 * as on): people must be able to clock in during an outage, and a manager
 * turns a terminal's clock off on the terminal itself. Reservations need the
 * flags to mint a token at all, so an unknown flag counts as off.
 */

export type TimeclockGate =
	| { ok: true }
	| { ok: false; code: 'timeclock_not_enabled' | 'timeclock_disabled' }

export async function timeclockGate(
	orgId: string,
	device: PosDevice,
	now = Date.now(),
): Promise<TimeclockGate> {
	if (!device.timeclockEnabled)
		return { ok: false, code: 'timeclock_not_enabled' }
	const flags = await getStaffingFeatures(orgId, now).catch(() => null)
	if (flags && (!flags.features.enabled || !flags.features.timeclock)) {
		return { ok: false, code: 'timeclock_disabled' }
	}
	return { ok: true }
}

export type ReservationsGate =
	| { ok: true; context: ReservationsContext; locationId: string }
	| {
			ok: false
			code:
				| 'reservations_not_enabled'
				| 'reservations_disabled'
				| 'location_required'
				| 'sign_in_required'
				| 'service_unavailable'
	  }

export async function reservationsGate(
	orgId: string,
	device: PosDevice,
): Promise<ReservationsGate> {
	if (!device.reservationsEnabled) {
		return { ok: false, code: 'reservations_not_enabled' }
	}
	// Guest details on a shared tablet are only ever shown to a signed-in person.
	if (!device.signInRequired) return { ok: false, code: 'sign_in_required' }
	const locationId = device.locationId
	if (!locationId) return { ok: false, code: 'location_required' }
	const context = await getReservationsContext(orgId).catch(() => null)
	if (!context) return { ok: false, code: 'service_unavailable' }
	if (!context.features.enabled) {
		return { ok: false, code: 'reservations_disabled' }
	}
	const location = context.locations.find((l) => l.id === locationId)
	if (!location || !location.isActive) {
		return { ok: false, code: 'location_required' }
	}
	return { ok: true, context, locationId }
}

/** What `/pos/me` tells the till to show. */
export async function deviceApps(
	orgId: string,
	device: PosDevice,
): Promise<PosDeviceApps> {
	const [timeclock, reservations] = await Promise.all([
		device.timeclockEnabled
			? timeclockGate(orgId, device).then((gate) => gate.ok)
			: false,
		device.reservationsEnabled
			? reservationsGate(orgId, device).then((gate) => gate.ok)
			: false,
	])
	return { timeclock, reservations }
}

import { type PosDeviceApps } from '@repo/common/pos-orders'
import { type ReservationsContext } from '@repo/reservations'
import { type PosDevice } from '@repo/tenant-db'
import { isKioskEnabled } from '../lib/kiosk-auth.ts'
import { getReservationsContext } from '../lib/reservations-context.ts'
import { getStaffingFeatures } from '../lib/scope-context.ts'

/**
 * Station apps beside the till. Each needs the terminal's own setting and the
 * organization's flag; the till itself sells regardless.
 *
 * A flag this node cannot read is never taken as on: a live punch then answers
 * 503 and the till keeps it as an offline punch. A punch made offline (sent
 * later) is accepted when the till offered the clock at the time it was made:
 * the terminal's switch was on, or was turned off only after. A flag this node
 * cannot read does not hold a replay (the punch already happened), but a flag
 * known to be off does, and so does the regional kill switch; the till keeps
 * those punches and tries again (both are pause codes to it).
 */

export type TimeclockGate =
	| { ok: true }
	| {
			ok: false
			status: 403 | 409 | 503
			code:
				| 'timeclock_not_enabled'
				| 'timeclock_was_off'
				| 'timeclock_disabled'
				| 'kiosk_disabled'
				| 'service_unavailable'
	  }

export async function timeclockGate(
	orgId: string,
	device: PosDevice,
	/** Set for a punch the till saved offline: when it was made (null if it did not say). */
	options: { now?: number; offlineReplay?: { at: number | null } | null } = {},
): Promise<TimeclockGate> {
	if (!isKioskEnabled())
		return { ok: false, status: 503, code: 'kiosk_disabled' }
	const replayAt = options.offlineReplay?.at ?? null
	const replay = Boolean(options.offlineReplay)
	const offeredThen =
		device.timeclockEnabled ||
		(replay &&
			replayAt !== null &&
			device.timeclockDisabledAt !== null &&
			replayAt < device.timeclockDisabledAt)
	if (!offeredThen) {
		// A punch saved offline after the clock was switched off here will never
		// count: a final answer, so the till lists it for a manager instead of
		// holding it (and everything behind it) for good.
		if (replay) return { ok: false, status: 409, code: 'timeclock_was_off' }
		return { ok: false, status: 403, code: 'timeclock_not_enabled' }
	}
	const flags = await getStaffingFeatures(orgId, options.now).catch(() => null)
	if (!flags) {
		if (replay) return { ok: true }
		return { ok: false, status: 503, code: 'service_unavailable' }
	}
	if (!flags.features.enabled || !flags.features.timeclock) {
		return { ok: false, status: 403, code: 'timeclock_disabled' }
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
				| 'reservations_needs_location'
				| 'reservations_needs_sign_in'
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
	if (!device.signInRequired)
		return { ok: false, code: 'reservations_needs_sign_in' }
	const locationId = device.locationId
	if (!locationId) return { ok: false, code: 'reservations_needs_location' }
	const context = await getReservationsContext(orgId).catch(() => null)
	if (!context) return { ok: false, code: 'service_unavailable' }
	if (!context.features.enabled) {
		return { ok: false, code: 'reservations_disabled' }
	}
	const location = context.locations.find((l) => l.id === locationId)
	if (!location || !location.isActive) {
		return { ok: false, code: 'reservations_needs_location' }
	}
	return { ok: true, context, locationId }
}

/**
 * What `/pos/me` tells the till to show. An app whose flag cannot be read right
 * now is left out, and the till keeps what it last knew: a short App outage
 * must not pull the host stand away mid-service.
 */
export async function deviceApps(
	orgId: string,
	device: PosDevice,
): Promise<Partial<PosDeviceApps>> {
	const apps: Partial<PosDeviceApps> = {}
	if (!device.timeclockEnabled) apps.timeclock = false
	else {
		const gate = await timeclockGate(orgId, device)
		if (gate.ok) apps.timeclock = true
		else if (
			gate.code !== 'service_unavailable' &&
			gate.code !== 'kiosk_disabled'
		)
			apps.timeclock = false
	}
	if (!device.reservationsEnabled) apps.reservations = false
	else {
		const gate = await reservationsGate(orgId, device)
		if (gate.ok) apps.reservations = true
		else if (gate.code !== 'service_unavailable') apps.reservations = false
	}
	return apps
}

import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { brand } from '@repo/config/brand'
import { type PosReservationsTokenResponse } from '@repo/common/pos-orders'
import {
	maxTokenTtlSeconds,
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
	reservationsTokenClaimsSchema,
	type ReservationsPermission,
} from '@repo/reservations'
import {
	authenticatePosDevice,
	isPosHashUnavailable,
	posError,
	posUnavailableResponse,
	type PosAuth,
} from '../lib/pos-auth.ts'
import { verifyPosStaffSession } from '../lib/pos-staff-session.ts'
import { rsvAuditLog } from '@repo/tenant-db'
import { and, eq, gte } from 'drizzle-orm'
import { getNodeRegion } from '../lib/region.ts'
import { getOperatorToken } from '../lib/secrets.ts'
import { reservationsGate } from '../services/pos-apps-service.ts'
import { touchDevice } from '../services/pos-service.ts'

/**
 * `/pos/reservations`: the host stand on a paired Station terminal.
 *
 * The till never gets its own reservations surface. It trades its device secret
 * plus a signed-in person's session (`lib/pos-staff-session.ts`) for the same
 * short-lived `rsv+jwt` App mints for an operator, and then calls the existing
 * `/operator/reservations/book/*` routes with it, so every check there (scope,
 * grants, location, version, idempotency) applies unchanged.
 *
 * What a till token can do is fixed here, not chosen by the tablet: the `book`
 * scope only (day of service, waitlist), at the terminal's own location only.
 * Only people on the host roster get a token; it carries the host grants
 * (names, party, tables, status). A host with guest details also reads full
 * contact details, notes and allergies; without that, phone numbers are
 * masked and emails dropped (`lib/reservations-station.ts`). The token is marked
 * `channel: station` with the terminal's id, so the guestbook stays shut
 * (`stationMayCall`), and lives five minutes. No setup, payments or reports.
 * The subject is `staff:<id>`, so the reservation history names who did what.
 */
export const posReservationsRoutes = new Hono()

/** Test seam: token clock (epoch seconds). */
export const posReservationsDeps = {
	nowSeconds: () => Math.floor(Date.now() / 1000),
}

/** A till's host token lives five minutes and is renewed while the stand is open. */
export const STATION_TOKEN_TTL_SECONDS = 5 * 60

const HOST_GRANTS: readonly ReservationsPermission[] = [
	RESERVATIONS_PERMISSIONS.READ_RESERVATION,
	RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
]

/**
 * Records the host stand opening for a person at a till. Best effort: the
 * audit trail must not take the stand down mid-service, so a failed write is
 * logged (ids only) and the token is still issued.
 */
async function recordHostStandOpened(
	db: PosAuth['db'],
	entry: {
		subject: string
		deviceId: string
		locationId: string
		guestDetails: boolean
		since: number
		at: number
	},
) {
	try {
		const recent = await db
			.select({ changes: rsvAuditLog.changes })
			.from(rsvAuditLog)
			.where(
				and(
					// Location first: the log's index is (location_id, at).
					eq(rsvAuditLog.locationId, entry.locationId),
					gte(rsvAuditLog.at, entry.since),
					eq(rsvAuditLog.action, 'station.host_stand_opened'),
					eq(rsvAuditLog.entityId, entry.deviceId),
					eq(rsvAuditLog.actorId, entry.subject),
				),
			)
		if (recent.some((r) => r.changes?.guestDetails === entry.guestDetails))
			return
		await db.insert(rsvAuditLog).values({
			id: `aud_${crypto.randomUUID()}`,
			at: entry.at,
			actorKind: 'operator',
			actorId: entry.subject,
			locationId: entry.locationId,
			action: 'station.host_stand_opened',
			entityType: 'pos_device',
			entityId: entry.deviceId,
			changes: { guestDetails: entry.guestDetails },
		})
	} catch (error) {
		console.error(
			'Host stand audit failed',
			entry.deviceId,
			error instanceof Error ? error.name : 'unknown',
		)
	}
}

posReservationsRoutes.post('/token', async (c) => {
	const authed = await authenticatePosDevice(c)
	if ('error' in authed) return authed.error
	const { pos } = authed
	try {
		const gate = await reservationsGate(pos.orgId, pos.device)
		if (!gate.ok) {
			return posError(
				gate.code === 'service_unavailable' ? 503 : 403,
				gate.code,
			)
		}
		const staff = await verifyPosStaffSession(c, pos)
		if ('error' in staff) return staff.error
		// Taking orders is not running the host stand: someone who manages
		// reservations puts people on the host roster (Settings, Terminals).
		if (!staff.session.host) return posError(403, 'not_a_host')

		const operatorSecret = getOperatorToken()
		if (!operatorSecret || operatorSecret.length < 16) {
			return posUnavailableResponse()
		}
		const region = getNodeRegion()
		if (region !== gate.context.dataRegion) {
			return posError(503, 'service_unavailable')
		}

		const canReadGuest = staff.session.guestDetails
		const grants = [...HOST_GRANTS]
		// Short on a shared tablet: a revoked terminal or a removed person stops
		// within minutes, whatever the operator ceiling allows.
		const ttlSeconds = Math.min(
			STATION_TOKEN_TTL_SECONDS,
			maxTokenTtlSeconds(
				canReadGuest
					? [...grants, RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST]
					: grants,
				false,
			),
		)
		const iat = posReservationsDeps.nowSeconds()
		const exp = iat + ttlSeconds
		const subject = `staff:${staff.session.staffId}`
		const claims = {
			aud: RESERVATIONS_TOKEN_AUDIENCE,
			role: 'operator' as const,
			region,
			orgId: pos.orgId,
			sub: subject,
			scope: 'book' as const,
			grants,
			locationIds: [gate.locationId],
			features: gate.context.features,
			impersonated: false,
			channel: 'station' as const,
			deviceId: pos.device.id,
			iat,
			exp,
		}
		reservationsTokenClaimsSchema.parse(claims)
		const {
			aud: ignoredAudience,
			sub: ignoredSubject,
			iat: ignoredIat,
			exp: ignoredExp,
			...payload
		} = claims
		const token = await new SignJWT(
			canReadGuest ? { ...payload, canReadGuest: true } : payload,
		)
			.setProtectedHeader({ alg: 'HS256', typ: RESERVATIONS_TOKEN_TYP })
			.setAudience(RESERVATIONS_TOKEN_AUDIENCE)
			.setIssuer(brand.shortName)
			.setSubject(subject)
			.setIssuedAt(iat)
			.setExpirationTime(exp)
			.sign(new TextEncoder().encode(operatorSecret))

		// Who opened the host stand at which till, and whether with guest details:
		// once per sign-in (and again if the guest grant changes), not per renewal.
		await recordHostStandOpened(pos.db, {
			subject,
			deviceId: pos.device.id,
			locationId: gate.locationId,
			guestDetails: canReadGuest,
			since: staff.session.signedInAt,
			at: iat * 1000,
		})
		await touchDevice(pos.db, pos.device).catch(() => {})
		const response: PosReservationsTokenResponse = {
			token,
			expiresAt: exp * 1000,
			locationId: gate.locationId,
			canReadGuest,
			features: {
				waitlist: gate.context.features.waitlist,
				online: gate.context.features.online,
			},
		}
		return c.json(response, 200, { 'Cache-Control': 'private, no-store' })
	} catch (error) {
		if (isPosHashUnavailable(error)) return posUnavailableResponse()
		console.error(
			'POS reservations token failed',
			error instanceof Error ? error.message : error,
		)
		return posError(500, 'internal_error')
	}
})

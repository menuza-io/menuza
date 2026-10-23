import { and, eq } from 'drizzle-orm'
import { type Context } from 'hono'
import { jwtVerify, SignJWT } from 'jose'
import { brand } from '@repo/config/brand'
import {
	POS_STAFF_SESSION_HEADER,
	posStaffDisplayName,
	type PosStaff,
} from '@repo/common/pos-orders'
import {
	posHosts,
	posManagers,
	staffMembers,
	staffScopeAssignments,
} from '@repo/tenant-db'
import { posError, type PosAuth } from './pos-auth.ts'
import { hmacHash } from './secrets.ts'

/**
 * Proof that a person signed in with their PIN on one paired terminal. The till
 * holds it in memory for the signed-in session and sends it with Station app
 * calls that act as that person (reservations), so the server never has to
 * trust a staff id the tablet names.
 *
 * Signed with a key derived from `AUTH_HMAC_SECRET`, distinct from every
 * operator, staffing and customer token (its own `typ` and audience). It is
 * bound to the organization and the terminal, and each use re-checks that the
 * person is still active there, so removing someone or revoking the terminal
 * ends it at once. It is never accepted anywhere but `/pos/*`.
 */

export const POS_STAFF_SESSION_TYP = 'pos-staff+jwt'
export const POS_STAFF_SESSION_AUDIENCE = 'tenant-api-pos-staff'
/** A shift's length: the till drops it sooner, whenever it locks. */
export const POS_STAFF_SESSION_TTL_SECONDS = 12 * 60 * 60

type SessionClaims = {
	orgId: string
	deviceId: string
	role: 'cashier' | 'manager'
}

function sessionKey(): Uint8Array {
	// A derived key, so this token can never be confused with anything else
	// signed from the same secret.
	return new TextEncoder().encode(hmacHash('pos-staff-session:v1'))
}

export async function mintPosStaffSession(
	input: {
		orgId: string
		deviceId: string
		staffId: string
		role: 'cashier' | 'manager'
	},
	nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ token: string; expiresAt: number }> {
	const exp = nowSeconds + POS_STAFF_SESSION_TTL_SECONDS
	const claims: SessionClaims = {
		orgId: input.orgId,
		deviceId: input.deviceId,
		role: input.role,
	}
	const token = await new SignJWT(claims)
		.setProtectedHeader({ alg: 'HS256', typ: POS_STAFF_SESSION_TYP })
		.setAudience(POS_STAFF_SESSION_AUDIENCE)
		.setIssuer(brand.shortName)
		.setSubject(input.staffId)
		.setIssuedAt(nowSeconds)
		.setExpirationTime(exp)
		.sign(sessionKey())
	return { token, expiresAt: exp * 1000 }
}

export type PosStaffSession = {
	staff: PosStaff
	staffId: string
	/** From the manager roster now, not from the token. */
	role: 'cashier' | 'manager'
	/** On the host roster now: may run the host stand. */
	host: boolean
	/** On the host roster with guest details: full contacts, allergies, notes. */
	guestDetails: boolean
	/** When the person signed in (epoch ms): one sign-in, one audit entry. */
	signedInAt: number
}

const sessionInvalid = () => posError(401, 'staff_session_invalid')

/**
 * The signed-in person behind a terminal request, or a 401 the till answers by
 * asking for the PIN again. Order: the token (signature, type, audience,
 * expiry), its organization and terminal against the authenticated device, then
 * the person's active assignment at the terminal's workplace.
 */
export async function verifyPosStaffSession(
	c: Context,
	pos: PosAuth,
): Promise<{ session: PosStaffSession } | { error: Response }> {
	const token = c.req.header(POS_STAFF_SESSION_HEADER)?.trim()
	if (!token) return { error: posError(401, 'staff_session_required') }

	let payload: Record<string, unknown> & { iat?: number }
	try {
		const verified = await jwtVerify(token, sessionKey(), {
			audience: POS_STAFF_SESSION_AUDIENCE,
			issuer: brand.shortName,
			algorithms: ['HS256'],
			clockTolerance: 5,
		})
		if (verified.protectedHeader.typ !== POS_STAFF_SESSION_TYP) {
			return { error: sessionInvalid() }
		}
		payload = verified.payload as Record<string, unknown>
	} catch {
		return { error: sessionInvalid() }
	}

	const staffId = typeof payload.sub === 'string' ? payload.sub : ''
	if (
		!staffId ||
		payload.orgId !== pos.orgId ||
		payload.deviceId !== pos.device.id
	) {
		return { error: sessionInvalid() }
	}

	const [row] = await pos.db
		.select({
			id: staffMembers.id,
			firstName: staffMembers.firstName,
			lastName: staffMembers.lastName,
			pinSetAt: staffScopeAssignments.pinSetAt,
			pinLookup: staffScopeAssignments.pinLookup,
		})
		.from(staffScopeAssignments)
		.innerJoin(staffMembers, eq(staffMembers.id, staffScopeAssignments.staffId))
		.where(
			and(
				eq(staffScopeAssignments.staffId, staffId),
				eq(staffScopeAssignments.scopeId, pos.device.scopeId),
				eq(staffScopeAssignments.active, true),
				eq(staffMembers.status, 'active'),
			),
		)
		.limit(1)
	if (!row) return { error: sessionInvalid() }
	// A cleared PIN ends it too: the person has no way to sign in any more.
	if (row.pinLookup === null) return { error: sessionInvalid() }
	// A PIN changed after this sign-in ends it: the old PIN proved nothing.
	if (
		row.pinSetAt !== null &&
		typeof payload.iat === 'number' &&
		row.pinSetAt > payload.iat * 1000
	) {
		return { error: sessionInvalid() }
	}

	const [[manager], [host]] = await Promise.all([
		pos.db
			.select({ id: posManagers.staffId })
			.from(posManagers)
			.where(eq(posManagers.staffId, staffId))
			.limit(1),
		pos.db
			.select({ id: posHosts.staffId, guestDetails: posHosts.guestDetails })
			.from(posHosts)
			.where(eq(posHosts.staffId, staffId))
			.limit(1),
	])
	return {
		session: {
			staffId,
			staff: {
				id: staffId,
				name: posStaffDisplayName(row.firstName, row.lastName),
			},
			role: manager ? 'manager' : 'cashier',
			host: Boolean(host),
			guestDetails: host?.guestDetails === true,
			signedInAt: typeof payload.iat === 'number' ? payload.iat * 1000 : 0,
		},
	}
}

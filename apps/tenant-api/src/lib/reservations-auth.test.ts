import { brand } from '@repo/config/brand'
import {
	RESERVATIONS_PERMISSIONS,
	RESERVATIONS_TOKEN_AUDIENCE,
	RESERVATIONS_TOKEN_TYP,
} from '@repo/reservations'
import { STAFFING_TOKEN_AUDIENCE, STAFFING_TOKEN_TYP } from '@repo/staffing'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { describe, expect, it } from 'vitest'
import {
	filterReservationsLocations,
	requireReservationsLocation,
	verifyReservationsOperatorToken,
} from './reservations-auth.ts'
import { getRsvAuth, rsvGuard } from './reservations-guard.ts'

const SECRET = 'test-tenant-operator-token-32chars!!'
const ORG_ID = 'clw9x0a12000008l00rsvorg1'

async function signToken(
	overrides: Record<string, unknown> = {},
	headerOverrides: { typ?: string; alg?: string } = {},
	secret = SECRET,
) {
	const now = Math.floor(Date.now() / 1000)
	const payload = {
		role: 'operator',
		region: 'us',
		orgId: ORG_ID,
		scope: 'book',
		grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION],
		locationIds: ['loc_soho'],
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			payments: true,
			experiences: true,
			voice: false,
		},
		impersonated: false,
		...overrides,
	}

	return new SignJWT(payload)
		.setProtectedHeader({
			alg: 'HS256',
			typ: headerOverrides.typ ?? RESERVATIONS_TOKEN_TYP,
		})
		.setAudience(
			(overrides.aud as string | undefined) ?? RESERVATIONS_TOKEN_AUDIENCE,
		)
		.setIssuer(brand.shortName)
		.setSubject((overrides.sub as string | undefined) ?? 'user_123')
		.setIssuedAt((overrides.iat as number | undefined) ?? now)
		.setExpirationTime((overrides.exp as number | undefined) ?? now + 900)
		.sign(new TextEncoder().encode(secret))
}

describe('verifyReservationsOperatorToken & rsvGuard (VAL-FND-017)', () => {
	it('verifies a valid rsv+jwt token and extracts scope, grants, locationIds, and features', async () => {
		const token = await signToken()
		const res = await verifyReservationsOperatorToken(`Bearer ${token}`, {
			secret: SECRET,
			expectedRegion: 'us',
		})
		expect(res.ok).toBe(true)
		if (!res.ok) return
		expect(res.context.orgId).toBe(ORG_ID)
		expect(res.context.userId).toBe('user_123')
		expect(res.context.scope).toBe('book')
		expect(
			res.context.grants.has(RESERVATIONS_PERMISSIONS.READ_RESERVATION),
		).toBe(true)
		expect(res.context.locationIds?.has('loc_soho')).toBe(true)
	})

	it('holds a token that can read guest PII to the 5-minute lifetime, not 15', async () => {
		const now = Math.floor(Date.now() / 1000)
		const long = await signToken({ canReadGuest: true, exp: now + 900 })
		const rejected = await verifyReservationsOperatorToken(`Bearer ${long}`, {
			secret: SECRET,
			expectedRegion: 'us',
		})
		expect(rejected).toMatchObject({ ok: false, status: 401 })
		const short = await signToken({ canReadGuest: true, exp: now + 300 })
		const accepted = await verifyReservationsOperatorToken(`Bearer ${short}`, {
			secret: SECRET,
			expectedRegion: 'us',
		})
		expect(accepted.ok).toBe(true)
		if (!accepted.ok) return
		expect(
			accepted.context.grants.has(
				RESERVATIONS_PERMISSIONS.READ_RESERVATION_GUEST,
			),
		).toBe(true)
		// Without the claim a 15-minute token is still fine.
		const plain = await signToken({ exp: now + 900 })
		expect(
			(
				await verifyReservationsOperatorToken(`Bearer ${plain}`, {
					secret: SECRET,
					expectedRegion: 'us',
				})
			).ok,
		).toBe(true)
	})

	it('rejects missing, wrong-secret, expired, staffing (staff+jwt), and customer tokens with 401', async () => {
		const missing = await verifyReservationsOperatorToken(undefined, {
			secret: SECRET,
			expectedRegion: 'us',
		})
		expect(missing).toEqual({
			ok: false,
			status: 401,
			error: 'Missing bearer token',
		})

		const wrongSecretToken = await signToken(
			{},
			{},
			'wrong-secret-32chars-long-enough!',
		)
		const wrongSecret = await verifyReservationsOperatorToken(
			`Bearer ${wrongSecretToken}`,
			{ secret: SECRET, expectedRegion: 'us' },
		)
		expect(wrongSecret.ok).toBe(false)
		if (!wrongSecret.ok) expect(wrongSecret.status).toBe(401)

		const now = Math.floor(Date.now() / 1000)
		const expiredToken = await signToken({ iat: now - 1000, exp: now - 100 })
		const expired = await verifyReservationsOperatorToken(
			`Bearer ${expiredToken}`,
			{ secret: SECRET, expectedRegion: 'us' },
		)
		expect(expired.ok).toBe(false)
		if (!expired.ok) expect(expired.status).toBe(401)

		// Cross-module replay: staffing token (typ: staff+jwt, aud: tenant-api-staff-operator)
		const staffToken = await signToken(
			{ aud: STAFFING_TOKEN_AUDIENCE },
			{ typ: STAFFING_TOKEN_TYP },
		)
		const staffReplay = await verifyReservationsOperatorToken(
			`Bearer ${staffToken}`,
			{ secret: SECRET, expectedRegion: 'us' },
		)
		expect(staffReplay.ok).toBe(false)
		if (!staffReplay.ok) expect(staffReplay.status).toBe(401)

		// Wrong typ header even with reservations audience
		const wrongTypToken = await signToken({}, { typ: STAFFING_TOKEN_TYP })
		const wrongTyp = await verifyReservationsOperatorToken(
			`Bearer ${wrongTypToken}`,
			{ secret: SECRET, expectedRegion: 'us' },
		)
		expect(wrongTyp).toEqual({
			ok: false,
			status: 401,
			error: 'Invalid reservations operator token type',
		})
	})

	it('rejects region mismatch with 403', async () => {
		const ksaToken = await signToken({ region: 'ksa' })
		const res = await verifyReservationsOperatorToken(`Bearer ${ksaToken}`, {
			secret: SECRET,
			expectedRegion: 'us',
		})
		expect(res).toEqual({
			ok: false,
			status: 403,
			error: 'region_mismatch',
		})
	})

	it('enforces locationIds scoping and null (all locations) in requireReservationsLocation', async () => {
		const scopedToken = await signToken({ locationIds: ['loc_soho'] })
		const scopedRes = await verifyReservationsOperatorToken(
			`Bearer ${scopedToken}`,
			{ secret: SECRET, expectedRegion: 'us' },
		)
		expect(scopedRes.ok).toBe(true)
		if (!scopedRes.ok) return

		const allowed = requireReservationsLocation(scopedRes.context, 'loc_soho')
		expect(allowed).toEqual({ ok: true, locationId: 'loc_soho' })

		const denied = requireReservationsLocation(scopedRes.context, 'loc_uptown')
		expect(denied.ok).toBe(false)
		if (!denied.ok) expect(denied.response.status).toBe(403)

		const filtered = filterReservationsLocations(scopedRes.context, [
			{ locationId: 'loc_soho', name: 'SoHo' },
			{ locationId: 'loc_uptown', name: 'Uptown' },
		])
		expect(filtered).toEqual([{ locationId: 'loc_soho', name: 'SoHo' }])

		// All locations (locationIds: null)
		const allToken = await signToken({ locationIds: null })
		const allRes = await verifyReservationsOperatorToken(`Bearer ${allToken}`, {
			secret: SECRET,
			expectedRegion: 'us',
		})
		expect(allRes.ok).toBe(true)
		if (!allRes.ok) return
		expect(requireReservationsLocation(allRes.context, 'loc_uptown')).toEqual({
			ok: true,
			locationId: 'loc_uptown',
		})
	})

	it('rsvGuard enforces scope, grants (including implied), feature flags, and impersonated write restrictions', async () => {
		const { applyVarlockEnv } = await import('./secrets.ts')
		applyVarlockEnv({ TENANT_OPERATOR_TOKEN: SECRET, DATA_REGION: 'us' })

		const app = new Hono()
		app.get(
			'/waitlist',
			rsvGuard({
				scope: 'book',
				feature: 'waitlist',
				grant: RESERVATIONS_PERMISSIONS.READ_RESERVATION,
			}),
			(c) => {
				const ctx = getRsvAuth(c)
				return c.json({ orgId: ctx.orgId })
			},
		)
		app.post(
			'/book',
			rsvGuard({
				scope: 'book',
				write: true,
				grant: RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION,
			}),
			(c) => c.json({ ok: true }),
		)

		// 1. Implied grant: UPDATE_RESERVATION satisfies READ_RESERVATION on GET /waitlist
		const updateToken = await signToken({
			scope: 'book',
			grants: [RESERVATIONS_PERMISSIONS.UPDATE_RESERVATION],
		})
		const okRes = await app.request('http://localhost/waitlist', {
			headers: { Authorization: `Bearer ${updateToken}` },
		})
		expect(okRes.status).toBe(200)

		// 2. Feature flag off -> 404
		const waitlistOffToken = await signToken({
			features: {
				enabled: true,
				online: false,
				waitlist: false,
				payments: false,
				experiences: false,
				voice: false,
			},
		})
		const flagOffRes = await app.request('http://localhost/waitlist', {
			headers: { Authorization: `Bearer ${waitlistOffToken}` },
		})
		expect(flagOffRes.status).toBe(404)

		// 3. Wrong scope -> 403
		const setupScopeToken = await signToken({
			scope: 'setup',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION_SETTINGS],
		})
		const wrongScopeRes = await app.request('http://localhost/waitlist', {
			headers: { Authorization: `Bearer ${setupScopeToken}` },
		})
		expect(wrongScopeRes.status).toBe(403)

		// 4. Impersonated token with 5-min TTL on write route -> 403
		const now = Math.floor(Date.now() / 1000)
		const impersonatedToken = await signToken({
			scope: 'book',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION],
			impersonated: true,
			iat: now,
			exp: now + 300,
		})
		const impRes = await app.request('http://localhost/book', {
			method: 'POST',
			headers: { Authorization: `Bearer ${impersonatedToken}` },
		})
		expect(impRes.status).toBe(403)

		// 5. Impersonated token with 15-min TTL (exceeding 5-min cap) -> 401
		const overLongImpersonatedToken = await signToken({
			scope: 'book',
			grants: [RESERVATIONS_PERMISSIONS.READ_RESERVATION],
			impersonated: true,
			iat: now,
			exp: now + 900,
		})
		const overLongRes = await app.request('http://localhost/waitlist', {
			headers: { Authorization: `Bearer ${overLongImpersonatedToken}` },
		})
		expect(overLongRes.status).toBe(401)
	})
})

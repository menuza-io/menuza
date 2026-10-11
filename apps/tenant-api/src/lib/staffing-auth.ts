import { type Context } from 'hono'
import { jwtVerify } from 'jose'
import { ENV } from 'varlock/env'
import { type z } from 'zod'
import { brand } from '@repo/config/brand'
import {
	type StaffingAccessLevel,
	type StaffingArea,
	type StaffingTokenClaims,
	staffingTokenAllows,
	staffingTokenClaimsSchema,
} from '@repo/staffing'
import { TENANT_ORG_ID_PATTERN } from '@repo/tenant-db'

import { findActiveOrganizationById } from './origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from './region.ts'
import { getBearerToken, getOperatorToken } from './secrets.ts'

export type StaffingAuth = {
	orgId: string
	/** Opaque control-plane user id from the token subject. */
	actorRef: string
	claims: StaffingTokenClaims
}

export const noStoreHeaders = { 'Cache-Control': 'private, no-store' }

function fail(status: number, error: string, message?: string) {
	return {
		error: Response.json(message ? { error, message } : { error }, {
			status,
			headers: noStoreHeaders,
		}),
	}
}

/**
 * Verifies a `staffing` operator JWT from App and the organization's region.
 * Each route names the area and level it needs; a token for another scope
 * (orders, mailbox, phone calls) never reaches staffing data, and a read
 * claim never writes.
 */
export async function authenticateStaffing(
	c: Context,
	area: StaffingArea,
	level: StaffingAccessLevel,
): Promise<{ auth: StaffingAuth } | { error: Response }> {
	const token = getBearerToken(c.req.header('Authorization'))
	if (!token) return fail(401, 'Unauthorized')
	const operatorToken = getOperatorToken()
	if (operatorToken.length < 16) return fail(503, 'Not configured')

	let payload: Record<string, unknown>
	try {
		const verified = await jwtVerify(
			token,
			new TextEncoder().encode(operatorToken),
			{ audience: 'tenant-api-operator', issuer: brand.shortName },
		)
		payload = verified.payload as Record<string, unknown>
	} catch {
		return fail(401, 'Unauthorized')
	}

	const orgId = payload.orgId
	const subject = payload.sub
	if (
		typeof orgId !== 'string' ||
		!TENANT_ORG_ID_PATTERN.test(orgId) ||
		typeof subject !== 'string' ||
		subject.length === 0 ||
		subject.length > 64
	) {
		return fail(401, 'Unauthorized')
	}
	if (payload.role !== 'operator') return fail(403, 'Invalid role')
	const claims = staffingTokenClaimsSchema.safeParse({
		scope: payload.scope,
		areas: payload.areas,
		locationIds: payload.locationIds,
		locations: payload.locations,
		canViewPay: payload.canViewPay,
	})
	if (!claims.success) return fail(403, 'Missing staffing scope')
	if (!staffingTokenAllows(claims.data, area, level)) {
		return fail(
			403,
			level === 'write' ? 'Write access required' : 'Access denied',
		)
	}

	const organization = await findActiveOrganizationById(orgId)
	if (!organization) return fail(404, 'Organization not found')
	if (!orgMatchesNodeRegion(organization.dataRegion)) {
		return fail(
			409,
			'region_mismatch',
			`Organization dataRegion "${organization.dataRegion}" does not match this node ("${getNodeRegion()}")`,
		)
	}
	if (!organization.hasProvisionedDb) {
		return fail(404, 'Organization is not provisioned in this region')
	}
	return { auth: { orgId, actorRef: subject, claims: claims.data } }
}

export type StaffingKillSwitch =
	'STAFFING_KIOSK_ENABLED' | 'STAFFING_EMAIL_ENABLED'

/** Node-level kill switches. Unset means on; only an explicit off disables. */
export function staffingSwitchEnabled(name: StaffingKillSwitch) {
	const raw =
		process.env[name] ?? (ENV as Record<string, unknown> | undefined)?.[name]
	if (raw === undefined || raw === null || raw === '') return true
	if (raw === false) return false
	return !['false', '0', 'off', 'no'].includes(String(raw).trim().toLowerCase())
}

export function databaseUnavailable(c: Context, orgId: string, error: unknown) {
	console.error(
		`Staffing request failed for org ${orgId}:`,
		error instanceof Error ? error.message : error,
	)
	return c.json({ error: 'Tenant Database unavailable' }, 500, noStoreHeaders)
}

export type StaffingResult<T> =
	{ ok: true; data: T } | { ok: false; status: 400 | 404 | 409; code: string }

export async function readJson(c: Context) {
	return c.req.json().catch(() => null) as Promise<unknown>
}

export function invalid(c: Context, error: z.ZodError) {
	return c.json(
		{ error: 'invalid_input', issues: error.issues.slice(0, 5) },
		400,
		noStoreHeaders,
	)
}

export function respond<T>(c: Context, result: StaffingResult<T>, key: string) {
	if (!result.ok) {
		return c.json({ error: result.code }, result.status, noStoreHeaders)
	}
	return c.json({ [key]: result.data }, 200, noStoreHeaders)
}

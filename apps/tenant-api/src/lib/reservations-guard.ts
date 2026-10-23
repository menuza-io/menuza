import {
	and,
	db as controlPlaneDb,
	eq as cpEq,
	Organization,
} from '@repo/database'
import {
	type ReservationsFeatureState,
	type ReservationsPermission,
	type ReservationsScope,
} from '@repo/reservations'
import { type Context, type MiddlewareHandler } from 'hono'
import { ENV } from 'varlock/env'
import { json } from './http.ts'
import { findActiveOrganizationById } from './origin.ts'
import { getNodeRegion, orgMatchesNodeRegion } from './region.ts'
import {
	type ReservationsOperatorContext,
	requireAnyReservationsGrant,
	requireReservationsFeatureFlag,
	requireReservationsGrant,
	requireReservationsLocation,
	requireReservationsScope,
	verifyReservationsOperatorToken,
} from './reservations-auth.ts'

const RSV_AUTH_KEY = 'rsvAuth'

export type RsvGuardOptions = {
	scope?: ReservationsScope | readonly ReservationsScope[]
	grant?: ReservationsPermission
	anyOf?: readonly ReservationsPermission[]
	feature?: keyof ReservationsFeatureState
	/** When true, rejects impersonated tokens (`403 impersonated_read_only`). */
	write?: boolean
}

/**
 * Route-level middleware for `/operator/reservations/*`:
 *  1. Verifies the `rsv+jwt` bearer token (`aud: 'tenant-api-reservations-operator'`)
 *     and checks that `region` matches this node's `DATA_REGION`.
 *  2. Enforces `features.enabled` (404 when off) and any optional sub-feature flag.
 *  3. Enforces the required token `scope` (when specified).
 *  4. Rejects impersonated sessions on `write: true` routes.
 *  5. Enforces `grant` or `anyOf` (with implied permission expansion).
 */
export function rsvGuard(options: RsvGuardOptions = {}): MiddlewareHandler {
	return async (c, next) => {
		const verified = await verifyReservationsOperatorToken(
			c.req.header('Authorization'),
		)
		if (!verified.ok) {
			return Response.json(
				{ error: verified.error },
				{ status: verified.status },
			)
		}

		const ctx = verified.context

		const featureDenied = requireReservationsFeatureFlag(
			ctx,
			options.feature ?? 'enabled',
		)
		if (featureDenied) return featureDenied

		if (options.scope) {
			const scopeDenied = requireReservationsScope(ctx, options.scope)
			if (scopeDenied) return scopeDenied
		}

		if (options.write && ctx.impersonated) {
			return Response.json(
				{
					error: 'impersonated_read_only',
					message: 'Write operations are disabled during impersonation',
				},
				{ status: 403 },
			)
		}

		if (options.grant) {
			const denied = requireReservationsGrant(ctx, options.grant)
			if (denied) return denied
		} else if (options.anyOf && options.anyOf.length > 0) {
			const denied = requireAnyReservationsGrant(ctx, options.anyOf)
			if (denied) return denied
		}

		// A Station till runs the host stand and nothing else: never the guestbook.
		if (ctx.channel === 'station' && !stationMayCall(c.req.path)) {
			return Response.json(
				{ error: 'not_for_station', message: 'Not available at a till' },
				{ status: 403 },
			)
		}

		const requestedOrgId =
			c.req.query('orgId')?.trim() || c.req.header('X-Org-Id')?.trim()
		if (requestedOrgId && requestedOrgId !== ctx.orgId) {
			return Response.json(
				{
					error: 'org_mismatch',
					message: 'Token orgId does not match requested organization',
				},
				{ status: 403 },
			)
		}

		const requestedLocationId =
			c.req.param('locationId')?.trim() || c.req.query('locationId')?.trim()
		if (requestedLocationId) {
			const locCheck = requireReservationsLocation(ctx, requestedLocationId)
			if (!locCheck.ok) return locCheck.response
		}

		c.set(RSV_AUTH_KEY, ctx)
		await next()
	}
}

/** The day of service and the waitlist; not guest search or guest history. */
export function stationMayCall(path: string): boolean {
	return (
		path.startsWith('/operator/reservations/book/') &&
		!path.startsWith('/operator/reservations/book/guests')
	)
}

/** The auth context, if a guard on this request set one (for after-the-fact middleware). */
export function peekRsvAuth(c: Context): ReservationsOperatorContext | null {
	return (
		(c.get(RSV_AUTH_KEY) as ReservationsOperatorContext | undefined) ?? null
	)
}

export function getRsvAuth(c: Context): ReservationsOperatorContext {
	const value = c.get(RSV_AUTH_KEY) as ReservationsOperatorContext | undefined
	if (!value) {
		throw new Error('getRsvAuth called outside rsvGuard middleware')
	}
	return value
}

export async function findActiveReservationsOrganization(orgId: string) {
	let org = await findActiveOrganizationById(orgId)
	if (
		!org &&
		ENV.NODE_ENV === 'development' &&
		ENV.TENANT_API_RUNTIME !== 'workers'
	) {
		try {
			const [dbOrg] = await controlPlaneDb
				.select({
					id: Organization.id,
					slug: Organization.slug,
					customDomain: Organization.customDomain,
					hasProvisionedDb: Organization.hasProvisionedDb,
					dataRegion: Organization.dataRegion,
				})
				.from(Organization)
				.where(
					and(cpEq(Organization.id, orgId), cpEq(Organization.active, true)),
				)
				.limit(1)
			if (dbOrg) {
				org = {
					...dbOrg,
					dataRegion: dbOrg.dataRegion === 'ksa' ? 'ksa' : 'us',
				}
			}
		} catch {
			// Ignore fallback error
		}
	}
	return org
}

export async function ensureActiveOrgInNodeRegion(ctx: {
	orgId: string
}): Promise<Response | null> {
	const org = await findActiveReservationsOrganization(ctx.orgId)
	const provisioned = Boolean(org?.hasProvisionedDb)
	if (!org || !provisioned) {
		return json({ error: 'not_found', message: 'Organization not found' }, 404)
	}
	if (!orgMatchesNodeRegion(org.dataRegion)) {
		return json(
			{
				error: 'region_mismatch',
				message: `Organization dataRegion "${org.dataRegion}" does not match node "${getNodeRegion()}"`,
			},
			403,
		)
	}
	return null
}

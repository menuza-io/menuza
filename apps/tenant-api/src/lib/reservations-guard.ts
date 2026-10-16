import {
	type ReservationsFeatureState,
	type ReservationsPermission,
	type ReservationsScope,
} from '@repo/reservations'
import { type Context, type MiddlewareHandler } from 'hono'
import {
	type ReservationsOperatorContext,
	requireAnyReservationsGrant,
	requireReservationsFeatureFlag,
	requireReservationsGrant,
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

		c.set(RSV_AUTH_KEY, ctx)
		await next()
	}
}

export function getRsvAuth(c: Context): ReservationsOperatorContext {
	const value = c.get(RSV_AUTH_KEY) as ReservationsOperatorContext | undefined
	if (!value) {
		throw new Error('getRsvAuth called outside rsvGuard middleware')
	}
	return value
}

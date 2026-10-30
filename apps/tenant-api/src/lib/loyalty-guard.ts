import { type LoyaltyPermission, type LoyaltyScope } from '@repo/loyalty'
import { type Context, type MiddlewareHandler } from 'hono'
import { json, NO_STORE } from './http.ts'
import {
	type LoyaltyOperatorContext,
	requireLoyaltyFeature,
	requireLoyaltyGrant,
	requireLoyaltyScope,
	verifyLoyaltyOperatorToken,
} from './loyalty-auth.ts'
import { lookupActiveOrganization } from './origin.ts'
import { orgMatchesNodeRegion } from './region.ts'

const LOYALTY_AUTH_KEY = 'loyaltyAuth'

export type LoyaltyGuardOptions = {
	/** Token scope(s) allowed on the route. */
	scope: LoyaltyScope | readonly LoyaltyScope[]
	/** Permission the token must carry (implied reads already expanded). */
	grant: LoyaltyPermission
	/**
	 * Reconciliation routes pass true: refunds, review decisions, requeues and
	 * balance repair keep working with the organization flag off and the node
	 * kill switch on, so switching loyalty off never strands a sale or a
	 * redemption already in flight.
	 */
	reconcile?: boolean
	/**
	 * Read-only routes pass true: the node kill switch stops new work, not
	 * reads, so operators can still open a member to record a QR tab refund
	 * or follow a review. The organization flag still applies.
	 */
	read?: boolean
}

/**
 * Route-level middleware for `/operator/loyalty/*`:
 *  1. Verifies the `lty+jwt` bearer token (signature, typ, audience, region,
 *     TTL, grants for scope — see `verifyLoyaltyOperatorToken`).
 *  2. Unless `reconcile`, enforces `loyalty.enabled` (from the token's
 *     features claim) and, unless `read`, the kill switch (always read live).
 *  3. Enforces the route's scope and grant.
 *  4. Confirms the organization is still active, provisioned and on this node
 *     (a control-plane outage answers 503, never 404, so operators retry).
 */
export function loyaltyGuard(options: LoyaltyGuardOptions): MiddlewareHandler {
	return async (c, next) => {
		const verified = await verifyLoyaltyOperatorToken(
			c.req.header('Authorization'),
		)
		if (!verified.ok) {
			return Response.json(
				{ error: verified.error, code: verified.error },
				{ status: verified.status, headers: NO_STORE },
			)
		}
		const ctx = verified.context

		if (!options.reconcile) {
			const featureDenied = requireLoyaltyFeature(ctx, 'enabled', {
				killSwitch: !options.read,
			})
			if (featureDenied) return featureDenied
		}

		const scopeDenied = requireLoyaltyScope(ctx, options.scope)
		if (scopeDenied) return scopeDenied
		const grantDenied = requireLoyaltyGrant(ctx, options.grant)
		if (grantDenied) return grantDenied

		const lookup = await lookupActiveOrganization(ctx.orgId)
		if (lookup.status === 'unavailable') {
			return json({ error: 'loyalty_unavailable' }, 503)
		}
		if (
			lookup.status !== 'found' ||
			!lookup.organization.hasProvisionedDb ||
			!orgMatchesNodeRegion(lookup.organization.dataRegion)
		) {
			return json({ error: 'not_found' }, 404)
		}

		c.set(LOYALTY_AUTH_KEY, ctx)
		await next()
	}
}

/** The verified operator context; only defined inside `loyaltyGuard`. */
export function getLoyaltyAuth(c: Context): LoyaltyOperatorContext {
	const value = c.get(LOYALTY_AUTH_KEY) as LoyaltyOperatorContext | undefined
	if (!value) {
		throw new Error('getLoyaltyAuth called outside loyaltyGuard middleware')
	}
	return value
}

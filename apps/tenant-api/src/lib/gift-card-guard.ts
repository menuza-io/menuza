import {
	type GiftCardFeatures,
	type GiftCardPermission,
	type GiftCardScope,
} from '@repo/common/gift-cards'
import { getTenantDb } from '@repo/tenant-db'
import { type Context, type MiddlewareHandler } from 'hono'
import {
	hasGiftCardOperatorGrant,
	type GiftCardOperatorContext,
	verifyGiftCardOperatorToken,
} from './gift-card-auth.ts'
import { giftCardDeny } from './gift-card-http.ts'
import { isGiftCardsKillSwitchOn } from './gift-card-switches.ts'
import { lookupActiveOrganization } from './origin.ts'
import { orgMatchesNodeRegion } from './region.ts'

const AUTH_KEY = 'giftCardAuth'

export type GiftCardGuardOptions = {
	/** Token scope(s) allowed on the route. */
	scope: GiftCardScope | readonly GiftCardScope[]
	/** Permission the token must carry (implied reads expanded). */
	grant: GiftCardPermission
	/** A child flag the route also needs on top of `gift_cards.enabled`. */
	feature?: Exclude<keyof GiftCardFeatures, 'enabled'>
	/**
	 * Routes that only read (list, detail, reports) keep working while the node
	 * kill switch is on; a route that sells, charges or adjusts does not.
	 */
	readOnly?: boolean
}

/**
 * Route-level middleware for `/operator/gift-cards/*`:
 *  1. verifies the `gft+jwt` bearer token (signature, typ, audience, region,
 *     lifetime, grants for scope);
 *  2. the node kill switch (live) answers 503 `gift_cards_unavailable` unless
 *     the route is read-only;
 *  3. the token's `features.enabled` claim must be on (403 `gift_cards_disabled`);
 *  4. enforces the scope and grant (403 `forbidden`), refuses any change from
 *     an impersonated token, then the route's child flag (403 `feature_disabled`);
 *  5. confirms the organization is still active, provisioned and on this node
 *     (a control-plane outage answers 503, never 404, so clients retry).
 */
export function giftCardGuard(
	options: GiftCardGuardOptions,
): MiddlewareHandler {
	const allowedScopes: readonly GiftCardScope[] = Array.isArray(options.scope)
		? options.scope
		: [options.scope as GiftCardScope]
	const changes = options.grant.startsWith('update:')
	return async (c, next) => {
		const verified = await verifyGiftCardOperatorToken(
			c.req.header('Authorization'),
		)
		if (!verified.ok) {
			return giftCardDeny(verified.status, verified.code, {
				reason: verified.reason,
			})
		}
		const ctx = verified.context
		if (!options.readOnly && isGiftCardsKillSwitchOn()) {
			return giftCardDeny(503, 'gift_cards_unavailable')
		}
		if (!ctx.features.enabled) return giftCardDeny(403, 'gift_cards_disabled')
		if (!allowedScopes.includes(ctx.scope)) {
			return giftCardDeny(403, 'forbidden', { reason: 'scope' })
		}
		if (changes && ctx.impersonated) {
			return giftCardDeny(403, 'forbidden', { reason: 'impersonated' })
		}
		if (!hasGiftCardOperatorGrant(ctx, options.grant)) {
			return giftCardDeny(403, 'forbidden', {
				reason: 'grant',
				required: options.grant,
			})
		}
		if (options.feature && !ctx.features[options.feature]) {
			return giftCardDeny(403, 'feature_disabled', { feature: options.feature })
		}
		const lookup = await lookupActiveOrganization(ctx.orgId)
		if (lookup.status === 'unavailable') {
			return giftCardDeny(503, 'gift_cards_unavailable')
		}
		if (
			lookup.status !== 'found' ||
			!lookup.organization.hasProvisionedDb ||
			!orgMatchesNodeRegion(lookup.organization.dataRegion)
		) {
			return giftCardDeny(404, 'not_found')
		}
		await getTenantDb(ctx.orgId, { createIfMissing: true })
		c.set(AUTH_KEY, ctx)
		await next()
	}
}

/** The verified operator context; only defined inside `giftCardGuard`. */
export function getGiftCardAuth(c: Context): GiftCardOperatorContext {
	const value = c.get(AUTH_KEY) as GiftCardOperatorContext | undefined
	if (!value) {
		throw new Error('getGiftCardAuth called outside giftCardGuard middleware')
	}
	return value
}

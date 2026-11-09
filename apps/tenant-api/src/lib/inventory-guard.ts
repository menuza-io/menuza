import {
	type InventoryFeatures,
	type InventoryPermission,
	type InventoryScope,
} from '@repo/inventory'
import { type Context, type MiddlewareHandler } from 'hono'
import {
	hasInventoryOperatorGrant,
	type InventoryOperatorContext,
	verifyInventoryOperatorToken,
} from './inventory-auth.ts'
import { syncLocationSettings } from '../services/inventory-location-settings.ts'
import { inventoryDeny } from './inventory-http.ts'
import { isInventoryKillSwitchOn } from './inventory-switches.ts'
import { lookupActiveOrganization } from './origin.ts'
import { orgMatchesNodeRegion } from './region.ts'

export { requireInventoryLocation } from './inventory-auth.ts'

const INVENTORY_AUTH_KEY = 'inventoryAuth'

export type InventoryGuardOptions = {
	/** Token scope(s) allowed on the route. */
	scope: InventoryScope | readonly InventoryScope[]
	/** Permission the token must carry (implied reads expanded). */
	grant: InventoryPermission
	/**
	 * A child flag the route also needs on top of `inventory.enabled` (read from
	 * the token's `features` claim): `purchasing` for levels, orders and
	 * suggestions. Off answers 403 `feature_disabled`.
	 */
	feature?: Exclude<keyof InventoryFeatures, 'enabled'>
}

/**
 * Route-level middleware for `/operator/inventory/*`:
 *  1. Verifies the `inv+jwt` bearer token (signature, typ, audience, region,
 *     lifetime, grants for scope; see `verifyInventoryOperatorToken`).
 *  2. The node kill switch (read live) answers 503 `inventory_unavailable`.
 *  3. The token's `features.enabled` claim must be on (403
 *     `inventory_disabled`).
 *  4. Enforces the route's scope and grant (403 `forbidden`), and refuses
 *     any change from an impersonated token, then the route's child flag
 *     (403 `feature_disabled`).
 *  5. Confirms the organization is still active, provisioned and on this
 *     node (a control-plane outage answers 503, never 404, so clients retry).
 *
 * Routes that take a location also call `requireInventoryLocation`.
 */
export function inventoryGuard(
	options: InventoryGuardOptions,
): MiddlewareHandler {
	const allowedScopes: readonly InventoryScope[] = Array.isArray(options.scope)
		? options.scope
		: [options.scope as InventoryScope]
	const changes = options.grant.startsWith('update:')
	return async (c, next) => {
		const verified = await verifyInventoryOperatorToken(
			c.req.header('Authorization'),
		)
		if (!verified.ok) {
			return inventoryDeny(verified.status, verified.code, {
				reason: verified.reason,
			})
		}
		const ctx = verified.context

		if (isInventoryKillSwitchOn()) {
			return inventoryDeny(503, 'inventory_unavailable')
		}
		if (!ctx.features.enabled) return inventoryDeny(403, 'inventory_disabled')

		if (!allowedScopes.includes(ctx.scope)) {
			return inventoryDeny(403, 'forbidden', { reason: 'scope' })
		}
		if (changes && ctx.impersonated) {
			return inventoryDeny(403, 'forbidden', { reason: 'impersonated' })
		}
		if (!hasInventoryOperatorGrant(ctx, options.grant)) {
			return inventoryDeny(403, 'forbidden', {
				reason: 'grant',
				required: options.grant,
			})
		}

		if (options.feature && !ctx.features[options.feature]) {
			return inventoryDeny(403, 'feature_disabled', {
				feature: options.feature,
			})
		}

		const lookup = await lookupActiveOrganization(ctx.orgId)
		if (lookup.status === 'unavailable') {
			return inventoryDeny(503, 'inventory_unavailable')
		}
		if (
			lookup.status !== 'found' ||
			!lookup.organization.hasProvisionedDb ||
			!orgMatchesNodeRegion(lookup.organization.dataRegion)
		) {
			return inventoryDeny(404, 'not_found')
		}

		// Keep the region's copy of the locations' money and days current.
		await syncLocationSettings(ctx.orgId)
		c.set(INVENTORY_AUTH_KEY, ctx)
		await next()
	}
}

/** The verified operator context; only defined inside `inventoryGuard`. */
export function getInventoryAuth(c: Context): InventoryOperatorContext {
	const value = c.get(INVENTORY_AUTH_KEY) as
		InventoryOperatorContext | undefined
	if (!value) {
		throw new Error('getInventoryAuth called outside inventoryGuard middleware')
	}
	return value
}

import {
	hasInventoryGrant,
	INVENTORY_PERMISSIONS,
	inventoryStatusQuerySchema,
	updateInventorySettingsSchema,
	updateLocationSpendingLimitsSchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { json } from '../lib/http.ts'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import {
	canSeeInventoryCost,
	inventoryDeny,
	inventoryErrorResponse,
	readOptionalIdempotencyKey,
} from '../lib/inventory-http.ts'
import {
	APPROVE_EXTRA_GRANT,
	inventoryCaller,
	parseBody,
	parseQuery,
	respond,
} from '../lib/inventory-route.ts'
import { hashInventoryRequest } from '../lib/inventory-write.ts'
import { operatorInventoryCountsRoutes } from './operator-inventory-counts.ts'
import { operatorInventoryGroupsRoutes } from './operator-inventory-groups.ts'
import { operatorInventoryImportsRoutes } from './operator-inventory-imports.ts'
import { operatorInventoryItemsRoutes } from './operator-inventory-items.ts'
import { operatorInventoryLevelsRoutes } from './operator-inventory-levels.ts'
import { operatorInventoryMergeRoutes } from './operator-inventory-merge.ts'
import { operatorInventoryOrdersRoutes } from './operator-inventory-orders.ts'
import { operatorInventoryPlacesRoutes } from './operator-inventory-places.ts'
import { operatorInventoryPrepRoutes } from './operator-inventory-prep.ts'
import { operatorInventoryPurchasingRoutes } from './operator-inventory-purchasing.ts'
import { operatorInventoryRecipesRoutes } from './operator-inventory-recipes.ts'
import { operatorInventoryRepeatOrdersRoutes } from './operator-inventory-repeat-orders.ts'
import { operatorInventorySetupChecksRoutes } from './operator-inventory-setup-checks.ts'
import { operatorInventorySoldOutRoutes } from './operator-inventory-sold-out.ts'
import { operatorInventoryTodayRoutes } from './operator-inventory-today.ts'
import { operatorInventoryTransfersRoutes } from './operator-inventory-transfers.ts'
import { operatorInventoryWasteRoutes } from './operator-inventory-waste.ts'
import {
	listLocationSettings,
	updateLocationSpendingLimits,
} from '../services/inventory-location-settings.ts'
import {
	getInventorySettings,
	getInventoryStatus,
	updateInventorySettings,
} from '../services/inventory-settings-service.ts'

/**
 * Operator inventory routes (`/operator/inventory/*`), called from the App in
 * the operator's browser with a short-lived `inv+jwt` (see `inventoryGuard`).
 * Settings and the setup status live here; the rest are mounted from the
 * `operator-inventory-*` files: items, storage areas and count lists,
 * counts, waste, purchasing (suppliers, deliveries, credit messages, invoice
 * photos and price alerts), levels, orders, Today and recipes (recipes, plate
 * costs, dishes without a recipe, recording a batch). Writes send
 * `expectedVersion` (409 `stale_version`), creates a client-made `clientId`
 * (a replay answers the first result). Money fields are left out for tokens
 * without `read:inventory_cost:any` (`respond` in `lib/inventory-route.ts`).
 */
export const operatorInventoryRoutes = new Hono()

operatorInventoryRoutes.route('/', operatorInventoryItemsRoutes)
operatorInventoryRoutes.route('/', operatorInventoryImportsRoutes)
operatorInventoryRoutes.route('/', operatorInventoryGroupsRoutes)
operatorInventoryRoutes.route('/', operatorInventoryMergeRoutes)
operatorInventoryRoutes.route('/', operatorInventorySetupChecksRoutes)
operatorInventoryRoutes.route('/', operatorInventoryPlacesRoutes)
operatorInventoryRoutes.route('/', operatorInventoryCountsRoutes)
operatorInventoryRoutes.route('/', operatorInventoryWasteRoutes)
operatorInventoryRoutes.route('/', operatorInventoryPurchasingRoutes)
operatorInventoryRoutes.route('/', operatorInventoryLevelsRoutes)
operatorInventoryRoutes.route('/', operatorInventoryOrdersRoutes)
operatorInventoryRoutes.route('/', operatorInventoryRepeatOrdersRoutes)
operatorInventoryRoutes.route('/', operatorInventoryTodayRoutes)
operatorInventoryRoutes.route('/', operatorInventoryRecipesRoutes)
operatorInventoryRoutes.route('/', operatorInventorySoldOutRoutes)
operatorInventoryRoutes.route('/', operatorInventoryPrepRoutes)
operatorInventoryRoutes.route('/', operatorInventoryTransfersRoutes)

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY

operatorInventoryRoutes.get(
	'/settings',
	inventoryGuard({ scope: ['read', 'write'], grant: READ }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const db = await getTenantDb(ctx.orgId)
			const settings = await getInventorySettings(db, ctx.region)
			// Read-only money and day settings of the locations the token covers.
			const locations = await listLocationSettings(db, ctx.locationIds, {
				cost: canSeeInventoryCost(ctx.grants),
			})
			return respond(ctx, { ...settings, locations })
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryRoutes.put(
	'/settings',
	inventoryGuard({ scope: 'write', grant: UPDATE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			// Settings apply to every location (the target food cost, who may
			// receive on a Station, the count day), so a token limited to some
			// locations may not change them.
			if (ctx.locationIds !== null) {
				return inventoryDeny(403, 'location_forbidden', {
					reason: 'organization_wide',
				})
			}
			const body = await parseBody(c, updateInventorySettingsSchema)
			if ('error' in body) return body.error
			const change = body.data
			const db = await getTenantDb(ctx.orgId)
			const current = await getInventorySettings(db, ctx.region)
			if (
				change.targetFoodCostBp !== undefined &&
				change.targetFoodCostBp !== current.targetFoodCostBp &&
				!hasInventoryGrant(ctx.grants, APPROVE_EXTRA_GRANT)
			) {
				return inventoryDeny(403, 'forbidden', {
					reason: 'grant',
					required: APPROVE_EXTRA_GRANT,
				})
			}
			if (
				change.anyStaffCanReceive !== undefined &&
				change.anyStaffCanReceive !== (current.anyStaffCanReceive ?? false) &&
				!hasInventoryGrant(
					ctx.grants,
					INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING,
				)
			) {
				return inventoryDeny(403, 'forbidden', {
					reason: 'grant',
					required: INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING,
				})
			}
			const idem = readOptionalIdempotencyKey(c)
			if ('error' in idem) return idem.error
			const settings = await updateInventorySettings(ctx.orgId, {
				region: ctx.region,
				change: body.data,
				actorId: ctx.userId,
				idempotency: idem.key
					? {
							scope: `settings:update:${ctx.userId}`,
							key: idem.key,
							requestHash: hashInventoryRequest(body.data),
						}
					: null,
			})
			const locations = await listLocationSettings(
				await getTenantDb(ctx.orgId),
				ctx.locationIds,
				{ cost: canSeeInventoryCost(ctx.grants) },
			)
			return respond(ctx, { ...settings, locations })
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryRoutes.put(
	'/settings/locations/:locationId/limits',
	inventoryGuard({
		scope: 'write',
		grant: INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING,
		feature: 'purchasing',
	}),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const location = requireInventoryLocation(ctx, c.req.param('locationId'))
			if (!location.ok) return location.response
			const body = await parseBody(c, updateLocationSpendingLimitsSchema)
			if ('error' in body) return body.error
			if (!ctx.canManageSettings || !canSeeInventoryCost(ctx.grants)) {
				return inventoryDeny(403, 'forbidden', { reason: 'grant' })
			}
			const idem = readOptionalIdempotencyKey(c)
			if ('error' in idem) return idem.error
			const updated = await updateLocationSpendingLimits(inventoryCaller(ctx), {
				locationId: location.locationId,
				body: body.data,
				idempotency: idem.key
					? {
							scope: `settings:limits:${location.locationId}:${ctx.userId}`,
							key: idem.key,
							requestHash: hashInventoryRequest(body.data),
						}
					: null,
			})
			return respond(ctx, updated)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryRoutes.get(
	'/status',
	inventoryGuard({ scope: ['read', 'write'], grant: READ }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, inventoryStatusQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			const status = await getInventoryStatus(
				await getTenantDb(ctx.orgId),
				location.locationId,
			)
			return json(status)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

import {
	INVENTORY_PERMISSIONS,
	inventoryStatusQuerySchema,
	updateInventorySettingsSchema,
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
	inventoryErrorResponse,
	readOptionalIdempotencyKey,
} from '../lib/inventory-http.ts'
import { parseBody, parseQuery } from '../lib/inventory-route.ts'
import { hashInventoryRequest } from '../lib/inventory-write.ts'
import { operatorInventoryCountsRoutes } from './operator-inventory-counts.ts'
import { operatorInventoryItemsRoutes } from './operator-inventory-items.ts'
import { operatorInventoryLevelsRoutes } from './operator-inventory-levels.ts'
import { operatorInventoryOrdersRoutes } from './operator-inventory-orders.ts'
import { operatorInventoryPlacesRoutes } from './operator-inventory-places.ts'
import { operatorInventoryPurchasingRoutes } from './operator-inventory-purchasing.ts'
import { operatorInventoryRecipesRoutes } from './operator-inventory-recipes.ts'
import { operatorInventorySoldOutRoutes } from './operator-inventory-sold-out.ts'
import { operatorInventoryTodayRoutes } from './operator-inventory-today.ts'
import { operatorInventoryWasteRoutes } from './operator-inventory-waste.ts'
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
operatorInventoryRoutes.route('/', operatorInventoryPlacesRoutes)
operatorInventoryRoutes.route('/', operatorInventoryCountsRoutes)
operatorInventoryRoutes.route('/', operatorInventoryWasteRoutes)
operatorInventoryRoutes.route('/', operatorInventoryPurchasingRoutes)
operatorInventoryRoutes.route('/', operatorInventoryLevelsRoutes)
operatorInventoryRoutes.route('/', operatorInventoryOrdersRoutes)
operatorInventoryRoutes.route('/', operatorInventoryTodayRoutes)
operatorInventoryRoutes.route('/', operatorInventoryRecipesRoutes)
operatorInventoryRoutes.route('/', operatorInventorySoldOutRoutes)

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY

operatorInventoryRoutes.get(
	'/settings',
	inventoryGuard({ scope: ['read', 'write'], grant: READ }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const settings = await getInventorySettings(
				await getTenantDb(ctx.orgId),
				ctx.region,
			)
			return json(settings)
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
			const body = await parseBody(c, updateInventorySettingsSchema)
			if ('error' in body) return body.error
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
			return json(settings)
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

import {
	INVENTORY_PERMISSIONS,
	inventoryStatusQuerySchema,
	updateInventorySettingsSchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { json, readJsonBody, readQuery } from '../lib/http.ts'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import {
	inventoryErrorResponse,
	readOptionalIdempotencyKey,
} from '../lib/inventory-http.ts'
import { hashInventoryRequest } from '../lib/inventory-write.ts'
import {
	getInventorySettings,
	getInventoryStatus,
	updateInventorySettings,
} from '../services/inventory-settings-service.ts'

/**
 * Operator inventory routes (`/operator/inventory/*`), called from the App in
 * the operator's browser with a short-lived `inv+jwt` (see `inventoryGuard`).
 * Phase 0: settings and the setup status. Writes send `expectedVersion`
 * (409 `stale_version`) and may send an `Idempotency-Key`. Money fields are
 * left out for tokens without `read:inventory_cost:any`
 * (`omitInventoryMoney`); these routes carry none yet.
 */
export const operatorInventoryRoutes = new Hono()

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
			const body = await readJsonBody(c, updateInventorySettingsSchema)
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
			const query = readQuery(c, inventoryStatusQuerySchema)
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

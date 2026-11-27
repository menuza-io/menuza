import {
	INVENTORY_PERMISSIONS,
	routineKeySchema,
	routineRunsQuerySchema,
	routineRunsSchema,
	routinesQuerySchema,
	routinesSchema,
	routineSchema,
	setRoutineSchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import { inventoryDeny, inventoryErrorResponse } from '../lib/inventory-http.ts'
import {
	inventoryCaller,
	parseBody,
	parseQuery,
	respond,
} from '../lib/inventory-route.ts'
import {
	listRoutineRuns,
	listRoutines,
	setRoutine,
} from '../services/inventory-routines-service.ts'

/**
 * Ready-made routines under `/operator/inventory/routines` (#529), behind
 * `inventory.routines`. Turning one on or off needs `update:inventory:any`;
 * the two that draft or remind about orders also need Purchasing on.
 */
export const operatorInventoryRoutinesRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const FEATURE = 'routines' as const

operatorInventoryRoutinesRoutes.get(
	'/routines',
	inventoryGuard({ scope: ['read', 'write'], grant: READ, feature: FEATURE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, routinesQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				routinesSchema.parse(
					await listRoutines(await getTenantDb(ctx.orgId), {
						caller: inventoryCaller(ctx),
						locationId: location.locationId,
						purchasing: ctx.features.purchasing,
					}),
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryRoutinesRoutes.get(
	'/routines/runs',
	inventoryGuard({ scope: ['read', 'write'], grant: READ, feature: FEATURE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const query = parseQuery(c, routineRunsQuerySchema)
			if ('error' in query) return query.error
			const location = requireInventoryLocation(ctx, query.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				routineRunsSchema.parse(
					await listRoutineRuns(await getTenantDb(ctx.orgId), {
						caller: inventoryCaller(ctx),
						locationId: location.locationId,
						key: query.data.key,
						limit: query.data.limit,
						cursor: query.data.cursor,
					}),
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryRoutinesRoutes.put(
	'/routines/:key',
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: FEATURE }),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const key = routineKeySchema.safeParse(c.req.param('key'))
			if (!key.success) return inventoryDeny(404, 'not_found')
			const body = await parseBody(c, setRoutineSchema)
			if ('error' in body) return body.error
			const location = requireInventoryLocation(ctx, body.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				routineSchema.parse(
					await setRoutine(inventoryCaller(ctx), {
						key: key.data,
						locationId: location.locationId,
						enabled: body.data.enabled,
						expectedVersion: body.data.expectedVersion,
						purchasing: ctx.features.purchasing,
					}),
				),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

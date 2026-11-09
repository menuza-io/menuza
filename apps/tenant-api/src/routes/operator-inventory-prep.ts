import {
	doneTaskSchema,
	generatePrepSchema,
	INVENTORY_PERMISSIONS,
	prepQuerySchema,
	prepTaskActionSchema,
	putPrepLevelsSchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import { inventoryErrorResponse } from '../lib/inventory-http.ts'
import {
	idParam,
	inventoryCaller,
	parseBody,
	parseQuery,
	respond,
} from '../lib/inventory-route.ts'
import {
	donePrepTask,
	generatePrep,
	getPrepLevels,
	getPrepPlan,
	putPrepLevels,
	skipPrepTask,
	startPrepTask,
} from '../services/inventory-prep-service.ts'
import { z } from 'zod'

/**
 * Prep under `/operator/inventory` (behind `inventory.prep`): today's list of
 * made items to make, the weekday levels behind it and the three things a
 * cook does with a task. Reads need `read:inventory:any`; everything that
 * changes needs `update:inventory:any` (prep is kitchen work). No money.
 */
export const operatorInventoryPrepRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY

const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: ['read', 'write'], grant: READ, feature: 'prep' })
const writes = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: 'prep' })

const levelsQuerySchema = z
	.object({ locationId: z.string().min(1).max(64) })
	.strict()

operatorInventoryPrepRoutes.get('/prep', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, prepQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await getPrepPlan(await getTenantDb(ctx.orgId), {
				caller: inventoryCaller(ctx),
				locationId: location.locationId,
				date: query.data.date,
				stationId: query.data.stationId,
				now: Date.now(),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPrepRoutes.post('/prep/generate', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, generatePrepSchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await generatePrep(inventoryCaller(ctx), {
				locationId: location.locationId,
				date: body.data.date,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPrepRoutes.get('/prep/levels', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, levelsQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await getPrepLevels(await getTenantDb(ctx.orgId), {
				caller: inventoryCaller(ctx),
				locationId: location.locationId,
				now: Date.now(),
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPrepRoutes.put('/prep/levels', writes(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, putPrepLevelsSchema)
		if ('error' in body) return body.error
		const location = requireInventoryLocation(ctx, body.data.locationId)
		if (!location.ok) return location.response
		return respond(ctx, await putPrepLevels(inventoryCaller(ctx), body.data))
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryPrepRoutes.post(
	'/prep/tasks/:id/start',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, prepTaskActionSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await startPrepTask(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPrepRoutes.post(
	'/prep/tasks/:id/skip',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, prepTaskActionSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await skipPrepTask(inventoryCaller(ctx), {
					id,
					expectedVersion: body.data.expectedVersion,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

operatorInventoryPrepRoutes.post(
	'/prep/tasks/:id/done',
	writes(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, doneTaskSchema)
			if ('error' in body) return body.error
			return respond(
				ctx,
				await donePrepTask(inventoryCaller(ctx), { id, body: body.data }),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

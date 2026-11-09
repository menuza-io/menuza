import {
	clearRecipeSchema,
	dishesWithoutRecipeQuerySchema,
	getRecipeQuerySchema,
	INVENTORY_PERMISSIONS,
	putRecipeSchema,
	recipeCostsRequestSchema,
	recordBatchSchema,
} from '@repo/inventory'
import { getTenantDb } from '@repo/tenant-db'
import { type Context, Hono } from 'hono'
import {
	getInventoryAuth,
	inventoryGuard,
	requireInventoryLocation,
} from '../lib/inventory-guard.ts'
import {
	inventoryErrorResponse,
	readOptionalIdempotencyKey,
} from '../lib/inventory-http.ts'
import { type InventoryOperatorContext } from '../lib/inventory-auth.ts'
import {
	clientIdempotency,
	idParam,
	inventoryCaller,
	parseBody,
	parseQuery,
	respond,
} from '../lib/inventory-route.ts'
import {
	hashInventoryRequest,
	type InventoryIdempotency,
} from '../lib/inventory-write.ts'
import { recordBatch } from '../services/inventory-batch-service.ts'
import {
	clearRecipe,
	dishesWithoutRecipe,
	getRecipe,
	putRecipe,
	recipeCosts,
} from '../services/inventory-recipes-service.ts'

/**
 * Recipes under `/operator/inventory`: what is in a dish, a size, an option or
 * a made-in-house item, plate costs for the menu list, the dishes that still
 * need a recipe, and recording a batch of a made item. Every route needs the
 * `inventory.recipes` flag. Reads need `read:inventory:any`; recipe writes need
 * `update:inventory_recipe:any` (`update:inventory:any` alone cannot write
 * one); recording a batch is kitchen work (`update:inventory:any`). Money is
 * left out without `read:inventory_cost:any`.
 */
export const operatorInventoryRecipesRoutes = new Hono()

const READ = INVENTORY_PERMISSIONS.READ_INVENTORY
const UPDATE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY
const RECIPE = INVENTORY_PERMISSIONS.UPDATE_INVENTORY_RECIPE

const reads = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: ['read', 'write'], grant: READ, feature: 'recipes' })
const recipeWrites = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: 'write', grant: RECIPE, feature: 'recipes' })
const kitchenWrites = (): ReturnType<typeof inventoryGuard> =>
	inventoryGuard({ scope: 'write', grant: UPDATE, feature: 'recipes' })

/**
 * Recipe writes are protected by `expectedVersion` (a replay is a 409), and a
 * client may also send an `Idempotency-Key` header to get the first answer
 * back instead.
 */
function headerIdempotency(
	c: Context,
	ctx: InventoryOperatorContext,
	name: string,
	body: unknown,
): { idempotency: InventoryIdempotency | null } | { error: Response } {
	const idem = readOptionalIdempotencyKey(c)
	if ('error' in idem) return idem
	if (!idem.key) return { idempotency: null }
	const cost = ctx.grants.includes(INVENTORY_PERMISSIONS.READ_INVENTORY_COST)
	return {
		idempotency: {
			scope: `${name}:${ctx.userId}:${cost ? 'c1' : 'c0'}`,
			key: idem.key,
			requestHash: hashInventoryRequest(body),
		},
	}
}

operatorInventoryRecipesRoutes.get('/recipes', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, getRecipeQuerySchema)
		if ('error' in query) return query.error
		return respond(
			ctx,
			await getRecipe(
				await getTenantDb(ctx.orgId),
				inventoryCaller(ctx),
				query.data,
			),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryRecipesRoutes.put('/recipes', recipeWrites(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, putRecipeSchema)
		if ('error' in body) return body.error
		const idem = headerIdempotency(c, ctx, 'recipes:put', body.data)
		if ('error' in idem) return idem.error
		return respond(
			ctx,
			await putRecipe(inventoryCaller(ctx), {
				body: body.data,
				idempotency: idem.idempotency,
			}),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryRecipesRoutes.post(
	'/recipes/clear',
	recipeWrites(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const body = await parseBody(c, clearRecipeSchema)
			if ('error' in body) return body.error
			const idem = headerIdempotency(c, ctx, 'recipes:clear', body.data)
			if ('error' in idem) return idem.error
			return respond(
				ctx,
				await clearRecipe(inventoryCaller(ctx), {
					body: body.data,
					idempotency: idem.idempotency,
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

// A POST only because it carries up to 200 dishes: it changes nothing, so a
// read-scope token (and an impersonated one) may call it.
operatorInventoryRecipesRoutes.post('/recipes/costs', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const body = await parseBody(c, recipeCostsRequestSchema)
		if ('error' in body) return body.error
		return respond(
			ctx,
			await recipeCosts(
				await getTenantDb(ctx.orgId),
				inventoryCaller(ctx),
				body.data,
			),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryRecipesRoutes.get('/recipes/missing', reads(), async (c) => {
	try {
		const ctx = getInventoryAuth(c)
		const query = parseQuery(c, dishesWithoutRecipeQuerySchema)
		if ('error' in query) return query.error
		const location = requireInventoryLocation(ctx, query.data.locationId)
		if (!location.ok) return location.response
		return respond(
			ctx,
			await dishesWithoutRecipe(
				await getTenantDb(ctx.orgId),
				inventoryCaller(ctx),
				{
					locationId: location.locationId,
					days: query.data.days,
					limit: query.data.limit,
				},
			),
		)
	} catch (error) {
		return inventoryErrorResponse(error)
	}
})

operatorInventoryRecipesRoutes.post(
	'/items/:id/batch',
	kitchenWrites(),
	async (c) => {
		try {
			const ctx = getInventoryAuth(c)
			const id = idParam(c)
			const body = await parseBody(c, recordBatchSchema)
			if ('error' in body) return body.error
			const location = requireInventoryLocation(ctx, body.data.locationId)
			if (!location.ok) return location.response
			return respond(
				ctx,
				await recordBatch(inventoryCaller(ctx), {
					itemId: id,
					body: body.data,
					idempotency: clientIdempotency(
						ctx,
						`batch:${id}`,
						body.data.clientId,
						body.data,
					),
				}),
			)
		} catch (error) {
			return inventoryErrorResponse(error)
		}
	},
)

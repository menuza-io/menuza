import { favoriteItemIdSchema } from '@repo/common/guest-favorites'
import { Hono, type Context } from 'hono'

import { NO_STORE, handleRouteError } from '../lib/http.ts'
import {
	addFavorite,
	listFavorites,
	removeFavorite,
} from '../services/customer-favorites-service.ts'
import { authenticateCustomer } from './auth.ts'

/**
 * The signed-in guest's favorite dishes (#158). Browser (or app) to region with
 * the customer token; every read and write is filtered by the token's customer
 * id.
 *
 *   GET    /customer/favorites            newest first, dish ids only
 *   PUT    /customer/favorites/:itemId    idempotent; 409 `favorites_limit_reached` at 100
 *   DELETE /customer/favorites/:itemId    idempotent
 */
export const customerFavoriteRoutes = new Hono()

type Auth = Awaited<ReturnType<typeof authenticateCustomer>>

async function authenticated(c: Context): Promise<Auth | Response> {
	try {
		return await authenticateCustomer(c)
	} catch (response) {
		if (response instanceof Response) return response
		throw response
	}
}

customerFavoriteRoutes.get('/', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	return c.json(await listFavorites(auth.db, auth.customerId), 200, NO_STORE)
})

customerFavoriteRoutes.put('/:itemId', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const itemId = favoriteItemIdSchema.safeParse(c.req.param('itemId'))
	if (!itemId.success) {
		return c.json({ error: 'invalid_item' }, 400, NO_STORE)
	}
	try {
		const { created } = await addFavorite(
			auth.orgId,
			auth.db,
			auth.customerId,
			itemId.data,
		)
		return c.json(
			{ ok: true, itemId: itemId.data },
			created ? 201 : 200,
			NO_STORE,
		)
	} catch (error) {
		return handleRouteError(error)
	}
})

customerFavoriteRoutes.delete('/:itemId', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const itemId = favoriteItemIdSchema.safeParse(c.req.param('itemId'))
	if (!itemId.success) {
		return c.json({ error: 'invalid_item' }, 400, NO_STORE)
	}
	await removeFavorite(auth.db, auth.customerId, itemId.data)
	return c.json({ ok: true, itemId: itemId.data }, 200, NO_STORE)
})

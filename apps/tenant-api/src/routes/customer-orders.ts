import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { HttpError, NO_STORE } from '../lib/http.ts'
import { orderNotFoundBody } from '../lib/customer-orders-http.ts'
import { orderRefundGlance } from '../services/order-refund-service.ts'
import {
	getCustomerOrder,
	listCustomerOrders,
	reorderOf,
} from '../services/customer-orders-service.ts'
import { guestCancelGlance } from '../services/order-guest-cancel.ts'
import { receiptOrder } from '../services/order-service.ts'
import { authenticateCustomer } from './auth.ts'

/**
 * The signed-in guest's restaurant orders (#112). Browser (or app) to region
 * with the customer token; the organization is the token's, and every read is
 * filtered by the token's customer id, so another guest's order id answers the
 * same 404 as an id that does not exist. Reads only.
 *
 *   GET /customer/orders?cursor=            newest first, 50 per page
 *   GET /customer/orders/:id                the receipt (the owner's full one)
 *   GET /customer/orders/:id/reorder        catalog ids to put the order in the cart again
 */
export const customerOrderRoutes = new Hono()

type Auth = Awaited<ReturnType<typeof authenticateCustomer>>

async function authenticated(c: Context): Promise<Auth | Response> {
	try {
		return await authenticateCustomer(c)
	} catch (response) {
		if (response instanceof Response) return response
		throw response
	}
}

const querySchema = z.object({
	cursor: z.string().max(300).optional(),
})
const idSchema = z.string().trim().min(1).max(128)

customerOrderRoutes.get('/', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const query = querySchema.safeParse(c.req.query())
	if (!query.success) return c.json({ error: 'Invalid cursor' }, 400, NO_STORE)
	try {
		const page = await listCustomerOrders(auth.db, auth.customerId, query.data)
		return c.json(page, 200, NO_STORE)
	} catch (error) {
		if (error instanceof HttpError) return error.toResponse()
		throw error
	}
})

customerOrderRoutes.get('/:id', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const id = idSchema.safeParse(c.req.param('id'))
	if (!id.success) return c.json(orderNotFoundBody(), 404, NO_STORE)
	const order = await getCustomerOrder(auth.db, auth.customerId, id.data)
	if (!order) return c.json(orderNotFoundBody(), 404, NO_STORE)
	const [refunds, cancel] = await Promise.all([
		orderRefundGlance(auth.orgId, order),
		guestCancelGlance(auth.orgId, order),
	])
	return c.json({ order: receiptOrder(order, refunds, cancel) }, 200, NO_STORE)
})

customerOrderRoutes.get('/:id/reorder', async (c) => {
	const auth = await authenticated(c)
	if (auth instanceof Response) return auth
	const id = idSchema.safeParse(c.req.param('id'))
	if (!id.success) return c.json(orderNotFoundBody(), 404, NO_STORE)
	const order = await getCustomerOrder(auth.db, auth.customerId, id.data)
	if (!order) return c.json(orderNotFoundBody(), 404, NO_STORE)
	const reorder = reorderOf(order)
	if (!reorder) {
		return c.json(
			{
				error: 'not_reorderable',
				message: 'This order cannot be ordered again.',
			},
			409,
			NO_STORE,
		)
	}
	return c.json(reorder, 200, NO_STORE)
})

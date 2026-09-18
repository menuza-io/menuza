import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { getTenantDb, shopOrderLineItems, shopOrders } from '@repo/tenant-db'
import { authenticateCustomer } from './auth.ts'
import { authenticateOperator } from './operator.ts'

export const foodOrderRoutes = new Hono()
export const operatorFoodOrderRoutes = new Hono()

const cartLineSchema = z.object({
	menuItemId: z.string().optional(),
	name: z.string().min(1).max(200),
	quantity: z.coerce.number().int().min(1).max(99),
	unitPriceCents: z.coerce.number().int().min(0),
	modifierSummary: z.string().max(500).optional().nullable(),
})

const createOrderSchema = z.object({
	locationId: z.string().min(1).optional(),
	fulfillmentType: z.enum(['pickup', 'delivery']).default('pickup'),
	items: z.array(cartLineSchema).min(1),
})

const kitchenStatusSchema = z.enum([
	'placed',
	'accepted',
	'ready',
	'completed',
	'cancelled',
])

foodOrderRoutes.post('/', async (c) => {
	let auth
	try {
		auth = await authenticateCustomer(c)
	} catch (response) {
		return response as Response
	}

	const body = await c.req.json().catch(() => ({}))
	const parsed = createOrderSchema.safeParse(body)
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.errors[0]?.message || 'Invalid payload' },
			400,
		)
	}

	const { db, customerId, orgId } = auth
	const { fulfillmentType, items } = parsed.data
	const locationId =
		parsed.data.locationId ?? c.req.header('X-Location-Id') ?? null

	if (!locationId) {
		return c.json({ error: 'locationId is required' }, 400)
	}

	const subtotalCents = items.reduce(
		(sum, line) => sum + line.unitPriceCents * line.quantity,
		0,
	)
	const productName =
		items.length === 1 ? items[0]!.name : `${items.length} items`

	const orderId = randomUUID()
	await db.insert(shopOrders).values({
		id: orderId,
		customerId,
		productName,
		amountCents: subtotalCents,
		platformFeeCents: 0,
		orgPayoutCents: subtotalCents,
		currency: 'usd',
		status: 'pending',
		locationId,
		fulfillmentType,
		kitchenStatus: 'placed',
	})

	await db.insert(shopOrderLineItems).values(
		items.map((line) => ({
			orderId,
			menuItemId: line.menuItemId ?? null,
			name: line.name,
			quantity: line.quantity,
			unitPriceCents: line.unitPriceCents,
			lineTotalCents: line.unitPriceCents * line.quantity,
			modifierSummary: line.modifierSummary ?? null,
		})),
	)

	return c.json({
		order: {
			id: orderId,
			amountCents: subtotalCents,
			status: 'pending',
			kitchenStatus: 'placed',
			fulfillmentType,
			locationId,
		},
	})
})

operatorFoodOrderRoutes.get('/orders', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const { orgId } = auth
	const db = await getTenantDb(orgId)
	const orders = await db
		.select({
			id: shopOrders.id,
			productName: shopOrders.productName,
			amountCents: shopOrders.amountCents,
			currency: shopOrders.currency,
			status: shopOrders.status,
			kitchenStatus: shopOrders.kitchenStatus,
			fulfillmentType: shopOrders.fulfillmentType,
			locationId: shopOrders.locationId,
			createdAt: shopOrders.createdAt,
		})
		.from(shopOrders)
		.orderBy(desc(shopOrders.createdAt))
		.limit(100)

	return c.json({ orders })
})

operatorFoodOrderRoutes.patch('/orders/:orderId', async (c) => {
	let auth
	try {
		auth = await authenticateOperator(c)
	} catch (response) {
		return response as Response
	}

	const body = await c.req.json().catch(() => ({}))
	const parsed = z
		.object({ kitchenStatus: kitchenStatusSchema })
		.safeParse(body)
	if (!parsed.success) {
		return c.json(
			{ error: parsed.error.errors[0]?.message || 'Invalid payload' },
			400,
		)
	}

	const { orgId } = auth
	const orderId = c.req.param('orderId')
	const db = await getTenantDb(orgId)
	const [updated] = await db
		.update(shopOrders)
		.set({
			kitchenStatus: parsed.data.kitchenStatus,
			updatedAt: new Date(),
		})
		.where(eq(shopOrders.id, orderId))
		.returning({
			id: shopOrders.id,
			kitchenStatus: shopOrders.kitchenStatus,
		})

	if (!updated) {
		return c.json({ error: 'Order not found' }, 404)
	}

	return c.json({ order: updated })
})

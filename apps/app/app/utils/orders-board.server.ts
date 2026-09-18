import { desc, eq } from 'drizzle-orm'
import {
	customers,
	getTenantDb,
	shopOrderLineItems,
	shopOrders,
} from '@repo/tenant-db'
import { z } from 'zod'

export const kitchenStatusSchema = z.enum([
	'placed',
	'accepted',
	'ready',
	'completed',
	'cancelled',
])

export type KitchenOrderRow = {
	id: string
	productName: string
	amountCents: number
	currency: string
	status: string
	kitchenStatus: string
	fulfillmentType: string
	locationId: string | null
	createdAt: Date | null
	customerName: string | null
	customerPhone: string | null
	lineItemCount: number
}

export async function listKitchenOrders(organizationId: string) {
	const tenantDb = await getTenantDb(organizationId)
	const orders = await tenantDb
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
			customerName: customers.name,
			customerPhone: customers.phone,
		})
		.from(shopOrders)
		.leftJoin(customers, eq(shopOrders.customerId, customers.id))
		.orderBy(desc(shopOrders.createdAt))
		.limit(100)

	return orders
}

export async function updateKitchenOrderStatus(
	organizationId: string,
	orderId: string,
	kitchenStatus: z.infer<typeof kitchenStatusSchema>,
) {
	const parsed = kitchenStatusSchema.parse(kitchenStatus)
	const tenantDb = await getTenantDb(organizationId)
	const [updated] = await tenantDb
		.update(shopOrders)
		.set({
			kitchenStatus: parsed,
			updatedAt: new Date(),
		})
		.where(eq(shopOrders.id, orderId))
		.returning({ id: shopOrders.id, kitchenStatus: shopOrders.kitchenStatus })
	return updated ?? null
}

export async function getOrderLineItems(
	organizationId: string,
	orderId: string,
) {
	const tenantDb = await getTenantDb(organizationId)
	return tenantDb
		.select()
		.from(shopOrderLineItems)
		.where(eq(shopOrderLineItems.orderId, orderId))
}

import { z } from 'zod'

/**
 * Value lists for regional inventory records that the tenant-db check
 * constraints repeat in SQL. Change both (and add a migration) or neither.
 */

/** Who did something: an App operator, a staff member at a Station, or the system. */
export const INVENTORY_ACTOR_KINDS = ['operator', 'staff', 'system'] as const
export type InventoryActorKind = (typeof INVENTORY_ACTOR_KINDS)[number]
export const inventoryActorKindSchema = z.enum(INVENTORY_ACTOR_KINDS)

/** How a supplier takes orders. */
export const SUPPLIER_ORDER_CHANNELS = [
	'email',
	'whatsapp',
	'phone',
	'other',
] as const
export type SupplierOrderChannel = (typeof SUPPLIER_ORDER_CHANNELS)[number]
export const supplierOrderChannelSchema = z.enum(SUPPLIER_ORDER_CHANNELS)

export const DELIVERY_STATUSES = ['draft', 'received', 'cancelled'] as const
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number]

/** Where a delivery was recorded: the App, or a Station tablet. */
export const DELIVERY_SOURCES = ['operator', 'station'] as const
export type DeliverySource = (typeof DELIVERY_SOURCES)[number]

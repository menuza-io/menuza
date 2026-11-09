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

// ── Phase 2: orders ─────────────────────────────────────────────────────────

/**
 * Where an order stands. `draft` is editable; `sent` means the person sent or
 * copied it; `partly_received` and `received` follow deliveries recorded
 * against it; `cancelled` is final. A closed order (`received`, `cancelled`)
 * never reopens.
 */
export const ORDER_STATUSES = [
	'draft',
	'sent',
	'partly_received',
	'received',
	'cancelled',
] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
export const orderStatusSchema = z.enum(ORDER_STATUSES)

/** Statuses a delivery can still be received against. */
export const OPEN_ORDER_STATUSES = [
	'draft',
	'sent',
	'partly_received',
] as const satisfies readonly OrderStatus[]

/** How a person sends an order (`pdf` is printed or saved by the App). */
export const ORDER_SEND_CHANNELS = ['email', 'whatsapp', 'copy', 'pdf'] as const
export type OrderSendChannel = (typeof ORDER_SEND_CHANNELS)[number]
export const orderSendChannelSchema = z.enum(ORDER_SEND_CHANNELS)

/** Languages the region writes order and credit texts in. */
export const ORDER_TEXT_LOCALES = ['en', 'ar'] as const
export type OrderTextLocale = (typeof ORDER_TEXT_LOCALES)[number]
export const orderTextLocaleSchema = z.enum(ORDER_TEXT_LOCALES)

import { z } from 'zod'
import { countSummarySchema } from './counts.ts'
import { currencyOut, minorOut } from './common.ts'
import { orderSummarySchema } from './orders.ts'
import { deliveryDetailSchema } from './purchasing.ts'
import { foodCostSchema } from './today.ts'

/**
 * Responses of the mutations whose result is more than the changed record.
 * Added after the phase 1 wire contract (additive). The other mutations
 * answer the record they changed:
 *
 * - `POST /items`, `PATCH /items/:id`, `/archive`, `/restore`, `/units` →
 *   `itemDetailSchema` (on hand for the optional `?locationId=`, else the sum
 *   over the locations the token may see).
 * - `PUT /items/:id/places/:locationId` → `itemPlaceSchema`.
 * - `POST|PATCH /storage-areas`, `/archive`, `PUT /storage-areas/:id/items` →
 *   `storageAreaSchema`; `POST /storage-areas/reorder` →
 *   `listStorageAreasResultSchema`.
 * - `POST|PATCH /count-lists`, `/archive` → `countListSchema`.
 * - `POST /counts`, `/send`, `/reopen`, `/cancel` → `countSummarySchema`.
 * - `POST /waste/:id/undo` → `wasteEntrySchema` of the reversing entry.
 * - `POST|PATCH /suppliers`, `/archive` → `supplierSchema`;
 *   `POST /suppliers/:id/products`, `PATCH /supplier-products/:id`,
 *   `/archive` → `supplierProductSchema`.
 * - `POST /deliveries/:id/paid`, `/cancel`, `GET /deliveries/:id` →
 *   `deliveryDetailSchema`.
 *
 * Phase 2 (additive):
 *
 * - `POST /deliveries` → `recordDeliveryResultSchema` (now also the order).
 * - `POST /deliveries/:id/confirm-prices` → `recordDeliveryResultSchema`.
 * - `POST /deliveries/:id/invoice-photo` → `invoicePhotoUploadSchema`;
 *   `.../invoice-photo/confirm` → `deliveryDetailSchema`.
 * - `POST /deliveries/:id/credit-message` → `creditMessageSchema`.
 * - `GET /orders/suggested` → `suggestedOrdersSchema`.
 * - `POST /orders`, `PATCH /orders/:id`, `/cancel`, `GET /orders/:id` →
 *   `orderDetailSchema`; `GET /orders` → `listOrdersResultSchema`.
 * - `POST /orders/:id/send` → `sendOrderResultSchema`;
 *   `GET /orders/:id/text` → `orderTextSchema`;
 *   `GET /orders/:id/receive-prefill` → `receivePrefillSchema`.
 * - `GET /levels` → `listLevelsResultSchema`; `PUT /levels/bulk` →
 *   `putLevelsResultSchema`; `GET /levels/suggestions` →
 *   `levelSuggestionsSchema`.
 * - `GET /price-alerts` → `priceAlertsSchema`.
 */

/** `POST /items/:id/adjust`. */
export const adjustStockResultSchema = z.object({
	/** The adjustment movement's id (a replayed `clientId` answers the first one). */
	id: z.string(),
	quantity: z.number().int(),
	/** On hand at the location after the change. */
	onHand: z.number().int(),
	valueMinor: minorOut,
	currency: currencyOut,
})

/** `POST /counts/:id/approve`. */
export const approveCountResultSchema = z.object({
	count: countSummarySchema,
	/** Items whose stock changed (one `count` movement each). */
	adjustedItems: z.number().int(),
	/** Net money difference posted. */
	differenceValueMinor: minorOut,
	currency: currencyOut,
	/** Food cost for the period when this and the previous full count are approved (cost grant). */
	foodCost: foodCostSchema.optional(),
})
export type ApproveCountResult = z.infer<typeof approveCountResultSchema>

/** An item whose delivered price rose with a delivery (cost grant only). */
export const priceChangeSchema = z.object({
	itemId: z.string(),
	itemName: z.string(),
	/** Cost per base unit (micro-minor) before and after. */
	previousCostMicro: z.number().int(),
	costMicro: z.number().int(),
	changeBp: z.number().int(),
})

/** `POST /deliveries`. */
export const recordDeliveryResultSchema = z.object({
	delivery: deliveryDetailSchema,
	/** Items whose price rose, largest rise first. Left out without the cost grant. */
	priceChanges: z.array(priceChangeSchema).optional(),
	/** Phase 2: the order the delivery was received against, with its new status. */
	order: orderSummarySchema.optional(),
})
export type RecordDeliveryResult = z.infer<typeof recordDeliveryResultSchema>

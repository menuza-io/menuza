import {
	type adjustStockSchema,
	type approveCountSchema,
	type bulkCreateItemsSchema,
	type cancelOrderSchema,
	type clearRecipeSchema,
	type confirmDeliveryPricesSchema,
	type createOrderSchema,
	type creditMessageRequestSchema,
	type invoicePhotoRequestSchema,
	type levelSuggestionsQuerySchema,
	type listLevelsQuerySchema,
	type listOrdersQuerySchema,
	type priceAlertsQuerySchema,
	type putLevelsSchema,
	type putRecipeSchema,
	type recipeCostsRequestSchema,
	type recipeOwnerSchema,
	type recordBatchSchema,
	type sendOrderSchema,
	type updateOrderSchema,
	type countEntriesSchema,
	type createCountListSchema,
	type createItemSchema,
	type createItemUnitSchema,
	type createStorageAreaSchema,
	type createSupplierSchema,
	type listCountsQuerySchema,
	type listDeliveriesQuerySchema,
	type listItemsQuerySchema,
	type listWasteQuerySchema,
	type logWasteSchema,
	type putItemPlaceSchema,
	type recordDeliverySchema,
	type supplierProductInputSchema,
	type updateCountListSchema,
	type updateItemSchema,
	type updateSupplierProductSchema,
	type updateSupplierSchema,
} from '@repo/inventory'
import { type z } from 'zod'

/** Parsed request bodies and queries of `/operator/inventory/*`, from the wire contract. */
export type CreateItemInput = z.infer<typeof createItemSchema>
export type UpdateItemInput = z.infer<typeof updateItemSchema>
export type ItemUnitInput = z.infer<typeof createItemUnitSchema>
export type PutItemPlaceInput = z.infer<typeof putItemPlaceSchema>
export type BulkCreateItemsInput = z.infer<typeof bulkCreateItemsSchema>
export type AdjustStockInput = z.infer<typeof adjustStockSchema>
export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>
export type CreateStorageAreaInput = z.infer<typeof createStorageAreaSchema>
export type CreateCountListInput = z.infer<typeof createCountListSchema>
export type UpdateCountListInput = z.infer<typeof updateCountListSchema>
export type ListCountsQuery = z.infer<typeof listCountsQuerySchema>
export type CountEntriesInput = z.infer<typeof countEntriesSchema>
export type ApproveCountInput = z.infer<typeof approveCountSchema>
export type LogWasteInput = z.infer<typeof logWasteSchema>
export type ListWasteQuery = z.infer<typeof listWasteQuerySchema>
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>
export type UpdateSupplierInput = z.infer<typeof updateSupplierSchema>
export type SupplierProductInput = z.infer<typeof supplierProductInputSchema>
export type UpdateSupplierProductInput = z.infer<
	typeof updateSupplierProductSchema
>
export type RecordDeliveryInput = z.infer<typeof recordDeliverySchema>
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>

// Phase 2.
export type CreateOrderInput = z.infer<typeof createOrderSchema>
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>
export type SendOrderInput = z.infer<typeof sendOrderSchema>
export type CancelOrderInput = z.infer<typeof cancelOrderSchema>
export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>
export type ListLevelsQuery = z.infer<typeof listLevelsQuerySchema>
export type PutLevelsInput = z.infer<typeof putLevelsSchema>
export type LevelSuggestionsQuery = z.infer<typeof levelSuggestionsQuerySchema>
export type ConfirmDeliveryPricesInput = z.infer<
	typeof confirmDeliveryPricesSchema
>
export type CreditMessageRequest = z.infer<typeof creditMessageRequestSchema>
export type InvoicePhotoRequest = z.infer<typeof invoicePhotoRequestSchema>
export type PriceAlertsQuery = z.infer<typeof priceAlertsQuerySchema>

// Phase 3.
export type RecipeOwnerInput = z.infer<typeof recipeOwnerSchema>
export type PutRecipeInput = z.infer<typeof putRecipeSchema>
export type ClearRecipeInput = z.infer<typeof clearRecipeSchema>
export type RecipeCostsInput = z.infer<typeof recipeCostsRequestSchema>
export type RecordBatchInput = z.infer<typeof recordBatchSchema>

import {
	type adjustStockSchema,
	type approveCountSchema,
	type bulkCreateItemsSchema,
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

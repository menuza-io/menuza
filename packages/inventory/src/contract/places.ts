import { z } from 'zod'
import { inventoryLocationIdSchema } from '../token.ts'
import {
	expectedVersionSchema,
	inventoryIdSchema,
	inventoryNameSchema,
} from './common.ts'

// ── Storage areas (per location, in walking order) ──────────────────────────

/** `GET /storage-areas?locationId=` → `{ areas }` sorted by `sortOrder`. */
export const storageAreaSchema = z.object({
	id: z.string(),
	locationId: z.string(),
	name: z.string(),
	sortOrder: z.number().int(),
	itemCount: z.number().int(),
	version: z.number().int(),
})
export type StorageArea = z.infer<typeof storageAreaSchema>

export const listStorageAreasResultSchema = z.object({
	areas: z.array(storageAreaSchema),
})

/** `POST /storage-areas` (`update:inventory:any`); appended last. */
export const createStorageAreaSchema = z
	.object({ locationId: inventoryLocationIdSchema, name: inventoryNameSchema })
	.strict()

/** `PATCH /storage-areas/:id` */
export const renameStorageAreaSchema = z
	.object({ expectedVersion: expectedVersionSchema, name: inventoryNameSchema })
	.strict()

/** `POST /storage-areas/reorder`: the full walking order for a location. */
export const reorderStorageAreasSchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		areaIds: z.array(inventoryIdSchema).min(1).max(40),
	})
	.strict()

/** `PUT /storage-areas/:id/items`: shelf order of the items kept there. */
export const setAreaItemOrderSchema = z
	.object({ itemIds: z.array(inventoryIdSchema).max(2000) })
	.strict()

// `POST /storage-areas/:id/archive` takes `versionOnlySchema` (items.ts). Items
// kept only there move to "Not in an area".

// ── Count lists ("Proteins daily", "Bar weekly") ────────────────────────────

export const countListSchema = z.object({
	id: z.string(),
	locationId: z.string(),
	name: z.string(),
	itemIds: z.array(z.string()),
	version: z.number().int(),
})
export type CountList = z.infer<typeof countListSchema>

/** `GET /count-lists?locationId=` → `{ lists }` */
export const listCountListsResultSchema = z.object({
	lists: z.array(countListSchema),
})

/** `POST /count-lists` */
export const createCountListSchema = z
	.object({
		locationId: inventoryLocationIdSchema,
		name: inventoryNameSchema,
		itemIds: z.array(inventoryIdSchema).min(1).max(2000),
	})
	.strict()

/** `PATCH /count-lists/:id`; archive with `versionOnlySchema`. */
export const updateCountListSchema = z
	.object({
		expectedVersion: expectedVersionSchema,
		name: inventoryNameSchema.optional(),
		itemIds: z.array(inventoryIdSchema).min(1).max(2000).optional(),
	})
	.strict()

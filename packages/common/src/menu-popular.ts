import { z } from 'zod'

/**
 * Shared contract for Auto Popular (#97): the regional tenant-api posts
 * top-selling item IDs (no PII, no sales counts) to App's internal endpoint.
 */
export const MENU_POPULAR_PATH = '/resources/menu/popular'
export const MENU_POPULAR_WINDOW_DAYS = 28
export const MENU_POPULAR_MIN_SOLD = 20

export const MENU_POPULAR_MIN_COUNT = 3
export const MENU_POPULAR_MAX_COUNT = 10
export const MENU_POPULAR_DEFAULT_COUNT = 5
export const MENU_POPULAR_MAX_ITEM_IDS = 100

export const POPULAR_MODES = ['auto', 'always', 'never'] as const
export type PopularMode = (typeof POPULAR_MODES)[number]

export const popularModeSchema = z.enum(POPULAR_MODES)

export const menuPopularPayloadSchema = z
	.object({
		orgId: z.string().trim().min(1).max(128).optional(),
		itemIds: z
			.array(z.string().trim().min(1).max(128))
			.max(MENU_POPULAR_MAX_ITEM_IDS),
		windowDays: z.number().int().min(1).max(365),
	})
	.strict()

export type MenuPopularPayload = z.infer<typeof menuPopularPayloadSchema>

export const menuPopularResultSchema = z
	.object({
		updated: z.number().int().min(0),
		skipped: z.string().optional(),
	})
	.strict()

export type MenuPopularResult = z.infer<typeof menuPopularResultSchema>

import { z } from 'zod'
import { type CallTag, type PhoneAgentSettings } from '@repo/phone-agent'

export const RestaurantOrderingSchema = z.object({
	/** Menu categories the AI must not take phone orders for. */
	excludedCategoryIds: z.array(z.string().trim().min(1).max(64)).max(200),
	readBackSummary: z.boolean(),
	readBackTotal: z.boolean(),
	quoteReadyTime: z.boolean(),
})
export type RestaurantOrdering = z.infer<typeof RestaurantOrderingSchema>

export const DEFAULT_ORDERING: RestaurantOrdering = {
	excludedCategoryIds: [],
	readBackSummary: true,
	readBackTotal: true,
	quoteReadyTime: true,
}

/** Restaurant settings, stored under the core `settings.vertical` key. */
export const RestaurantSettingsSchema = z.object({
	upsellsEnabled: z.boolean().default(true),
	ordering: RestaurantOrderingSchema.default(DEFAULT_ORDERING),
})
export type RestaurantSettings = z.infer<typeof RestaurantSettingsSchema>

export const DEFAULT_RESTAURANT_SETTINGS: RestaurantSettings = {
	upsellsEnabled: true,
	ordering: DEFAULT_ORDERING,
}

/** The restaurant settings in `settings.vertical`, defaults filled in. */
export function restaurantSettingsOf(
	settings: Pick<PhoneAgentSettings, 'vertical'>,
): RestaurantSettings {
	const parsed = RestaurantSettingsSchema.safeParse(settings.vertical ?? {})
	return parsed.success ? parsed.data : DEFAULT_RESTAURANT_SETTINGS
}

export const RESTAURANT_DEFAULT_CALL_TAGS: CallTag[] = [
	{
		id: 'vip',
		name: 'VIP',
		description: 'The caller is a regular or mentions being a VIP guest.',
		autoApply: false,
		important: false,
	},
	{
		id: 'complaint',
		name: 'Complaint',
		description: 'The caller is unhappy or reports a problem with an order.',
		autoApply: true,
		important: true,
	},
]

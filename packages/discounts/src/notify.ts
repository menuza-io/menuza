import { z } from 'zod'
import { discountWeekKeySchema } from './token.ts'

/**
 * The notice the region sends the App when a discount's weekly budget (#392)
 * is spent. An organization id, the kind, a discount id and the week: nothing
 * about a guest, an order or an amount (the schema is strict). The App owns the
 * names, the recipients and their email addresses.
 */
export const DISCOUNT_NOTIFY_PATH = '/resources/discounts/notify' as const

export const DISCOUNT_NOTIFY_KINDS = ['budget_reached'] as const

export const discountNotifyEventSchema = z
	.object({
		orgId: z.string().min(1).max(64),
		kind: z.enum(DISCOUNT_NOTIFY_KINDS),
		discountId: z.string().min(1).max(100),
		/** The ISO week whose budget ran out; the App sends one notice per week. */
		week: discountWeekKeySchema,
	})
	.strict()
export type DiscountNotifyEvent = z.infer<typeof discountNotifyEventSchema>

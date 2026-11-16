import { z } from 'zod'

/**
 * What the regional broadcast tick tells the US App when it could not send a
 * broadcast the operator scheduled (#232). Ids only: an organization, a kind
 * and a campaign id. No name, subject, address or count crosses the plane, and
 * the schema is strict so a field that could carry one is refused.
 */
export const MARKETING_NOTIFY_PATH = '/resources/marketing/notify'

export const MARKETING_NOTIFY_KINDS = ['broadcast_skipped_late'] as const
export type MarketingNotifyKind = (typeof MARKETING_NOTIFY_KINDS)[number]

export const marketingNotifyEventSchema = z
	.object({
		orgId: z.string().min(1).max(100),
		kind: z.enum(MARKETING_NOTIFY_KINDS),
		campaignId: z.string().min(1).max(100),
	})
	.strict()
export type MarketingNotifyEvent = z.infer<typeof marketingNotifyEventSchema>

export const marketingNotifyResultSchema = z.object({
	inApp: z.number().int().min(0),
	skipped: z.string().max(60).optional(),
})
export type MarketingNotifyResult = z.infer<typeof marketingNotifyResultSchema>

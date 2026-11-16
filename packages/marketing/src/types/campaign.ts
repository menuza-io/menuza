import { z } from 'zod'

export const CAMPAIGN_STATUSES = [
	'Draft',
	'Scheduled',
	'Processing',
	'Completed',
	'Failed',
	/** The operator stopped it before it started (#101). */
	'Cancelled',
	/** A scheduled send that could not start inside its window (#232). */
	'SkippedLate',
] as const
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number]
export const campaignStatusSchema = z.enum(CAMPAIGN_STATUSES)

export const CAMPAIGN_CHANNELS = ['email', 'sms'] as const
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number]
export const campaignChannelSchema = z.enum(CAMPAIGN_CHANNELS)

export const createCampaignSchema = z.object({
	name: z.string().min(1, 'Campaign name is required'),
	channel: campaignChannelSchema,
	subject: z.string().optional(),
	content: z.string().min(1, 'Message content is required'),
	audience: z.string().default('all'),
	scheduledAt: z.string().optional(),
})
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>

export interface CampaignListItem {
	id: string
	name: string
	status: CampaignStatus
	channel: CampaignChannel
	targetAudienceCount: number
	createdAt: string | Date
	scheduledAt?: string | Date | null
	lateAfterMinutes?: number
}

export interface CampaignRecipient {
	id: string
	name: string | null
	email?: string | null
	phone?: string | null
	status: string
	sentAt: string | Date | null
	openedAt?: string | Date | null
	clickedAt?: string | Date | null
}

export interface CampaignDetail {
	id: string
	name: string
	status: CampaignStatus
	channel: CampaignChannel
	subject?: string | null
	content: string
	/** JSON array of email designer blocks, when the broadcast was designed. */
	contentBlocks?: string | null
	/** Design-time rendered HTML, when the broadcast was designed. */
	contentHtml?: string | null
	targetAudienceCount: number
	audience?: string | null
	createdAt: string | Date
	scheduledAt?: string | Date | null
	/** "Don't send if more than N minutes late" for a scheduled broadcast. */
	lateAfterMinutes?: number
	/** The broadcast this one re-sends to non-openers, when it is one. */
	retargetOfCampaignId?: string | null
	/** The re-send made from this broadcast, when there is one. */
	retargetedByCampaignId?: string | null
	/** Last change; for a Completed broadcast, when it finished. */
	updatedAt?: string | Date | null
	/** The coupon `{{couponCode}}` showed, when the broadcast carried one. */
	coupon?: CampaignCoupon | null
	recipients: CampaignRecipient[]
	/**
	 * Recipients whose send outcome is unknown: their message row was left
	 * Processing by an interrupted or timed-out send. Platform campaigns only.
	 */
	unconfirmedRecipientCount?: number
}

export type CampaignCoupon =
	/** `code` is null when the viewer may not see discount codes. */
	| { mode: 'shared'; discountName: string | null; code: string | null }
	| { mode: 'unique'; discountName: string | null; validDays: number }

export interface MarketingMetrics {
	emailsSent: number
	openRate: string
	clickRate: string
	activeCampaigns: number
}

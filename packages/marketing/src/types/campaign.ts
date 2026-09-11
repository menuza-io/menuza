import { z } from 'zod'

export const CAMPAIGN_STATUSES = [
	'Draft',
	'Scheduled',
	'Processing',
	'Completed',
	'Failed',
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
	recipients: CampaignRecipient[]
}

export interface MarketingMetrics {
	emailsSent: number
	openRate: string
	clickRate: string
	activeCampaigns: number
}

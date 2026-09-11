import { z } from 'zod'
import {
	CAMPAIGN_CHANNELS,
	type CampaignChannel,
	type CampaignStatus,
} from './campaign.ts'

export const PLATFORM_AUDIENCES = ['all_operators', 'organization'] as const
export type PlatformAudience = (typeof PLATFORM_AUDIENCES)[number]
export const platformAudienceSchema = z.enum(PLATFORM_AUDIENCES)

export const PLATFORM_TRIGGER_TYPES = [
	'org_created',
	'operator_invited',
	'subscription_started',
	'subscription_cancelled',
	'manual',
] as const
export type PlatformTriggerType = (typeof PLATFORM_TRIGGER_TYPES)[number]
export const platformTriggerTypeSchema = z.enum(PLATFORM_TRIGGER_TYPES)

export const createPlatformCampaignSchema = z.object({
	name: z.string().min(1),
	channel: z.enum(CAMPAIGN_CHANNELS),
	subject: z.string().optional(),
	content: z.string().min(1),
	/** JSON array of email designer blocks, when the broadcast was designed. */
	contentBlocks: z.string().optional(),
	/** Design-time rendered HTML, when the broadcast was designed. */
	contentHtml: z.string().optional(),
	audience: platformAudienceSchema.default('all_operators'),
	targetOrganizationId: z.string().optional(),
})
export type CreatePlatformCampaignInput = z.infer<
	typeof createPlatformCampaignSchema
>

export interface PlatformCampaignRecord {
	id: string
	name: string
	status: CampaignStatus
	channel: CampaignChannel
	audience: PlatformAudience
	targetOrganizationId: string | null
	targetAudienceCount: number
	subject: string | null
	content: string
	contentBlocks: string | null
	contentHtml: string | null
	createdAt: Date
	updatedAt: Date
}

export interface PlatformJourneyListItem {
	id: string
	name: string
	description?: string | null
	status: 'draft' | 'active' | 'paused' | 'archived'
	triggerType: string
	stepCount: number
	runsCount: number
	updatedAt: string | Date
	createdAt: string | Date
}

export const PLATFORM_TRIGGER_LABELS: Record<
	PlatformTriggerType,
	{ label: string; desc: string }
> = {
	org_created: {
		label: 'Organization Created',
		desc: 'Runs when a new tenant organization is created',
	},
	operator_invited: {
		label: 'Operator Invited',
		desc: 'Runs when an operator is invited to an organization',
	},
	subscription_started: {
		label: 'Subscription Started',
		desc: 'Runs when a tenant starts a paid subscription',
	},
	subscription_cancelled: {
		label: 'Subscription Cancelled',
		desc: 'Runs when a tenant cancels their subscription',
	},
	manual: {
		label: 'Manual Trigger',
		desc: 'Triggered via admin test or API',
	},
}

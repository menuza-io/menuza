import { createId } from '@paralleldrive/cuid2'
import {
	db,
	desc,
	eq,
	Organization,
	PlatformMarketingCampaign,
	PlatformMarketingMessage,
	User,
	UserOrganization,
} from '@repo/database'
import { getEmailProvider, sendEmail } from '@repo/email'
import { buildPlatformMarketingResendTags } from '@repo/config/marketing-email'
import { and } from 'drizzle-orm'
import {
	type CampaignDetail,
	type CampaignListItem,
	type CampaignRecipient,
	type CampaignStatus,
	type MarketingMetrics,
} from '../types/campaign.ts'
import {
	buildRecipientMergeTags,
	interpolateMergeTags,
} from '../utils/merge-tags.ts'
import {
	createPlatformCampaignSchema,
	type CreatePlatformCampaignInput,
	type PlatformAudience,
} from '../types/platform.ts'
import { ensurePlatformEmailEngagementSynced } from './platform-oci-engagement-sync.server.ts'

async function maybeSyncPlatformEngagement() {
	if (getEmailProvider() === 'oci') {
		await ensurePlatformEmailEngagementSynced()
	}
}

export async function listPlatformCampaigns(): Promise<CampaignListItem[]> {
	const campaigns = await db
		.select()
		.from(PlatformMarketingCampaign)
		.orderBy(desc(PlatformMarketingCampaign.createdAt))

	return campaigns.map((campaign) => ({
		id: campaign.id,
		name: campaign.name,
		status: campaign.status as CampaignStatus,
		channel: campaign.channel as CampaignListItem['channel'],
		targetAudienceCount: campaign.targetAudienceCount,
		createdAt: campaign.createdAt,
		scheduledAt: campaign.scheduledAt,
	}))
}

export async function getPlatformCampaign(
	campaignId: string,
): Promise<CampaignDetail | null> {
	await maybeSyncPlatformEngagement()

	const [campaign] = await db
		.select()
		.from(PlatformMarketingCampaign)
		.where(eq(PlatformMarketingCampaign.id, campaignId))

	if (!campaign) return null

	const messages = await db
		.select({
			id: PlatformMarketingMessage.id,
			status: PlatformMarketingMessage.status,
			sentAt: PlatformMarketingMessage.sentAt,
			openedAt: PlatformMarketingMessage.openedAt,
			clickedAt: PlatformMarketingMessage.clickedAt,
			name: User.name,
			email: User.email,
		})
		.from(PlatformMarketingMessage)
		.innerJoin(User, eq(PlatformMarketingMessage.userId, User.id))
		.where(eq(PlatformMarketingMessage.campaignId, campaignId))

	const recipients: CampaignRecipient[] = messages.map((message) => ({
		id: message.id,
		name: message.name,
		email: message.email,
		status: message.status,
		sentAt: message.sentAt,
		openedAt: message.openedAt,
		clickedAt: message.clickedAt,
	}))

	return {
		id: campaign.id,
		name: campaign.name,
		status: campaign.status as CampaignStatus,
		channel: campaign.channel as CampaignDetail['channel'],
		subject: campaign.subject,
		content: campaign.content,
		targetAudienceCount: campaign.targetAudienceCount,
		audience: campaign.audience,
		createdAt: campaign.createdAt,
		scheduledAt: campaign.scheduledAt,
		recipients,
	}
}

export async function getPlatformMarketingMetrics(): Promise<MarketingMetrics> {
	await maybeSyncPlatformEngagement()

	const campaigns = await db.select().from(PlatformMarketingCampaign)
	const messages = await db.select().from(PlatformMarketingMessage)

	const emailsSent = messages.filter((message) =>
		['Sent', 'Opened', 'Clicked'].includes(message.status),
	).length
	const openCount = messages.filter((message) =>
		['Opened', 'Clicked'].includes(message.status),
	).length
	const clickCount = messages.filter(
		(message) => message.status === 'Clicked',
	).length
	const activeCampaigns = campaigns.filter((c) =>
		['Processing', 'Scheduled'].includes(c.status),
	).length

	const openRate = emailsSent > 0 ? (openCount / emailsSent) * 100 : 0
	const clickRate = emailsSent > 0 ? (clickCount / emailsSent) * 100 : 0

	return {
		emailsSent,
		openRate: openRate.toFixed(1),
		clickRate: clickRate.toFixed(1),
		activeCampaigns,
	}
}

export async function createPlatformCampaign(
	input: CreatePlatformCampaignInput,
	createdById?: string,
) {
	const parsed = createPlatformCampaignSchema.parse(input)

	if (parsed.channel === 'email' && !parsed.subject) {
		throw new Error('Email campaigns require a subject')
	}

	const campaignId = createId()
	await db.insert(PlatformMarketingCampaign).values({
		id: campaignId,
		name: parsed.name,
		channel: parsed.channel,
		subject: parsed.subject || null,
		content: parsed.content,
		status: 'Processing',
		audience: parsed.audience,
		targetOrganizationId: parsed.targetOrganizationId || null,
		segmentationRules: JSON.stringify({ audience: parsed.audience }),
		createdById: createdById || null,
	})

	void dispatchPlatformCampaign(campaignId)

	return { campaignId, status: 'Processing' as const }
}

async function resolvePlatformRecipients(
	audience: PlatformAudience,
	targetOrganizationId?: string | null,
) {
	if (audience === 'organization' && targetOrganizationId) {
		const memberships = await db
			.select({
				userId: UserOrganization.userId,
				email: User.email,
				name: User.name,
				organizationName: Organization.name,
			})
			.from(UserOrganization)
			.innerJoin(User, eq(UserOrganization.userId, User.id))
			.innerJoin(
				Organization,
				eq(UserOrganization.organizationId, Organization.id),
			)
			.where(
				and(
					eq(UserOrganization.organizationId, targetOrganizationId),
					eq(UserOrganization.active, true),
					eq(User.isBanned, false),
				),
			)

		return memberships
	}

	const operators = await db
		.select({
			userId: UserOrganization.userId,
			email: User.email,
			name: User.name,
			organizationName: Organization.name,
		})
		.from(UserOrganization)
		.innerJoin(User, eq(UserOrganization.userId, User.id))
		.innerJoin(
			Organization,
			eq(UserOrganization.organizationId, Organization.id),
		)
		.where(and(eq(UserOrganization.active, true), eq(User.isBanned, false)))

	const uniqueByUser = new Map<string, (typeof operators)[number]>()
	for (const row of operators) {
		if (!uniqueByUser.has(row.userId)) {
			uniqueByUser.set(row.userId, row)
		}
	}

	return [...uniqueByUser.values()]
}

export async function dispatchPlatformCampaign(campaignId: string) {
	try {
		const [campaign] = await db
			.select()
			.from(PlatformMarketingCampaign)
			.where(eq(PlatformMarketingCampaign.id, campaignId))

		if (!campaign) return

		const recipients = await resolvePlatformRecipients(
			campaign.audience as PlatformAudience,
			campaign.targetOrganizationId,
		)

		await db
			.update(PlatformMarketingCampaign)
			.set({ targetAudienceCount: recipients.length })
			.where(eq(PlatformMarketingCampaign.id, campaignId))

		for (const recipient of recipients) {
			const messageId = createId()
			await db.insert(PlatformMarketingMessage).values({
				id: messageId,
				campaignId,
				userId: recipient.userId,
				status: 'Processing',
			})

			const mergeTags = buildRecipientMergeTags({
				name: recipient.name,
				email: recipient.email,
				organizationName: recipient.organizationName,
			})
			const parsedContent = interpolateMergeTags(campaign.content, mergeTags)

			let deliveryStatus = 'Sent'
			let providerMessageId: string | null = null
			try {
				if (campaign.channel === 'email') {
					if (!recipient.email) throw new Error('No email address')
					const escapeHtml = (unsafe: string) => {
						return unsafe
							.replace(/&/g, "&amp;")
							.replace(/</g, "&lt;")
							.replace(/>/g, "&gt;")
							.replace(/"/g, "&quot;")
							.replace(/'/g, "&#039;");
					};

					const emailRes = await sendEmail({
						to: recipient.email,
						subject: interpolateMergeTags(
							campaign.subject || campaign.name,
							mergeTags,
						),
						text: parsedContent,
						html: `<p>${escapeHtml(parsedContent).replace(/\n/g, '<br/>')}</p>`,
						tags: buildPlatformMarketingResendTags(messageId, campaignId),
					})
					if (emailRes.status === 'error') {
						throw new Error(emailRes.error.message)
					}
					providerMessageId = emailRes.data.id
				} else {
					deliveryStatus = 'Failed'
				}
			} catch (error) {
				console.error(
					`Failed to send platform campaign to ${recipient.userId}`,
					error,
				)
				deliveryStatus = 'Failed'
			}

			await db
				.update(PlatformMarketingMessage)
				.set({
					status: deliveryStatus,
					sentAt: deliveryStatus === 'Sent' ? new Date() : null,
					providerMessageId:
						deliveryStatus === 'Sent' ? providerMessageId : null,
				})
				.where(eq(PlatformMarketingMessage.id, messageId))
		}

		await db
			.update(PlatformMarketingCampaign)
			.set({ status: 'Completed' })
			.where(eq(PlatformMarketingCampaign.id, campaignId))
	} catch (error) {
		console.error(`Platform campaign dispatch failed for ${campaignId}`, error)
		await db
			.update(PlatformMarketingCampaign)
			.set({ status: 'Failed' })
			.where(eq(PlatformMarketingCampaign.id, campaignId))
	}
}

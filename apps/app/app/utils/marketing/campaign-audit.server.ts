import { AuditAction, auditService } from '@repo/audit'

/**
 * Every broadcast mutation is audited in the control plane (#101). The record
 * holds ids only: the organization, the actor, the campaign (and the one it was
 * copied or re-sent from). No name, subject, message, address or recipient: the
 * campaign itself lives in the customer data region.
 */

const ACTIONS = {
	created: [AuditAction.MARKETING_CAMPAIGN_CREATED, 'Broadcast created'],
	updated: [AuditAction.MARKETING_CAMPAIGN_UPDATED, 'Broadcast edited'],
	sent: [AuditAction.MARKETING_CAMPAIGN_SENT, 'Broadcast sent or scheduled'],
	cancelled: [AuditAction.MARKETING_CAMPAIGN_CANCELLED, 'Broadcast cancelled'],
	deleted: [AuditAction.MARKETING_CAMPAIGN_DELETED, 'Broadcast deleted'],
	duplicated: [
		AuditAction.MARKETING_CAMPAIGN_DUPLICATED,
		'Broadcast duplicated',
	],
	retargeted: [
		AuditAction.MARKETING_CAMPAIGN_RETARGETED,
		'Re-send to non-openers created',
	],
	test_sent: [AuditAction.MARKETING_CAMPAIGN_TEST_SENT, 'Test message sent'],
} as const

export type CampaignAuditKind = keyof typeof ACTIONS

export const CAMPAIGN_RESOURCE_TYPE = 'marketing_campaign'

export async function auditCampaign(input: {
	kind: CampaignAuditKind
	userId: string
	organizationId: string
	/** Absent for a test send of a message that is not saved yet. */
	campaignId?: string | null
	/** The campaign this one was copied or re-sent from. */
	sourceCampaignId?: string
	channel?: 'email' | 'sms' | 'push'
	request?: Request
}) {
	const [action, details] = ACTIONS[input.kind]
	try {
		await auditService.log({
			action,
			userId: input.userId,
			organizationId: input.organizationId,
			details,
			metadata: {
				...(input.channel ? { channel: input.channel } : {}),
				...(input.sourceCampaignId
					? { sourceCampaignId: input.sourceCampaignId }
					: {}),
			},
			request: input.request,
			resourceType: CAMPAIGN_RESOURCE_TYPE,
			resourceId: input.campaignId ?? undefined,
		})
	} catch (error) {
		// The change already happened; a lost audit row must not undo it.
		console.error(`Failed to write audit log ${action}:`, error)
	}
}

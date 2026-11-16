import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { type MarketingNotifyKind } from '@repo/common/marketing-notify'

/**
 * What the operator is told when a scheduled broadcast could not start in time
 * (#232). The in-app notification carries only the kind, the organization slug
 * and the campaign id; the words are written here.
 */

export const CAMPAIGN_ALERT_TYPE = 'marketing-broadcast-skipped-late'

export function campaignAlertKindFromNotificationType(
	type: unknown,
): MarketingNotifyKind | null {
	return type === CAMPAIGN_ALERT_TYPE ? 'broadcast_skipped_late' : null
}

export const CAMPAIGN_ALERT_COPY: Record<
	MarketingNotifyKind,
	{
		subject: MessageDescriptor
		body: MessageDescriptor
		eyebrow: MessageDescriptor
		actionLabel: MessageDescriptor
	}
> = {
	broadcast_skipped_late: {
		subject: msg`A broadcast was **not sent**: too late`,
		body: msg`It could not start inside its window, so it was skipped. Open it to duplicate it and schedule it again.`,
		eyebrow: msg`Broadcasts`,
		actionLabel: msg`Open the broadcast`,
	},
}

export function campaignAlertPath(campaignId: string) {
	return `/marketing/campaigns/${encodeURIComponent(campaignId)}`
}

/**
 * Plain English for the email: a request from the region carries no locale, so
 * the email is not translated (the in-app copy is, in the bell).
 */
export function campaignAlertEmailCopy(kind: MarketingNotifyKind) {
	switch (kind) {
		case 'broadcast_skipped_late':
			return {
				eyebrow: 'Broadcasts',
				subject: 'A broadcast was not sent: too late',
				headline: 'A broadcast was not sent: too late',
				detail:
					'It could not start inside its window, so it was skipped. Open it to duplicate it and schedule it again.',
				actionLabel: 'Open the broadcast',
			}
	}
}

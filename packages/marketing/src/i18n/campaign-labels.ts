import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type CampaignChannel, type CampaignStatus } from '../types/campaign.ts'

const STATUS_LABELS: Record<CampaignStatus, ReturnType<typeof msg>> = {
	Draft: msg`Draft`,
	Scheduled: msg`Scheduled`,
	Processing: msg`Processing`,
	Completed: msg`Completed`,
	Failed: msg`Failed`,
	Cancelled: msg`Cancelled`,
	SkippedLate: msg`Not sent: too late`,
}

const CHANNEL_LABELS: Record<CampaignChannel, ReturnType<typeof msg>> = {
	email: msg`Email`,
	sms: msg`SMS`,
	push: msg`Push`,
}

export function useCampaignLabels() {
	const { _ } = useLingui()

	return {
		statusLabel: (status: CampaignStatus) => _(STATUS_LABELS[status]),
		channelLabel: (channel: CampaignChannel) => _(CHANNEL_LABELS[channel]),
	}
}

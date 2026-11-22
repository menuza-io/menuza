import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

/**
 * What the operator is told by the occasion job (#152): a broadcast was
 * scheduled for an occasion (they can edit or cancel it until it goes out), or
 * it was not, and why. The in-app notification carries the organization slug,
 * the occasion's key and year and, when there is one, the broadcast id; the
 * words are written here (and the occasion's name by the viewer, in their own
 * language).
 */

export const OCCASION_ALERT_TYPES = {
	scheduled: 'marketing-occasion-scheduled',
	skipped: 'marketing-occasion-skipped',
} as const
export type OccasionAlertKind = keyof typeof OCCASION_ALERT_TYPES

export function occasionAlertKindFromNotificationType(
	type: unknown,
): OccasionAlertKind | null {
	if (type === OCCASION_ALERT_TYPES.scheduled) return 'scheduled'
	if (type === OCCASION_ALERT_TYPES.skipped) return 'skipped'
	return null
}

export type OccasionSkipReason = 'occasion_conflict' | 'sms_allowance'

export function occasionAlertCopy(
	kind: OccasionAlertKind,
	title: string,
	reason: string | null,
	_: (descriptor: MessageDescriptor) => string,
) {
	if (kind === 'scheduled') {
		return {
			subject: _(msg`**${title}** is scheduled`),
			body: _(
				msg`We scheduled a broadcast for it. Open it to edit or cancel it before it goes out.`,
			),
		}
	}
	return {
		subject: _(msg`**${title}** was not scheduled`),
		body:
			reason === 'sms_allowance'
				? _(
						msg`No text sends are left this month. Schedule it yourself for later.`,
					)
				: _(
						msg`Another broadcast is already scheduled within 2 days of it. Schedule it yourself if you still want it.`,
					),
	}
}

export function occasionAlertPath(campaignId: string | null) {
	return campaignId
		? `/marketing/campaigns/${encodeURIComponent(campaignId)}`
		: '/marketing/calendar'
}

/** Plain English for the email: a job carries no locale. */
export function occasionAlertEmailCopy(
	kind: OccasionAlertKind,
	title: string,
	reason: string | null,
) {
	if (kind === 'scheduled') {
		return {
			eyebrow: 'Calendar',
			subject: `${title} is scheduled`,
			headline: `${title} is scheduled`,
			detail:
				'We scheduled a broadcast for it. Open it to edit or cancel it before it goes out.',
			actionLabel: 'Open the broadcast',
		}
	}
	return {
		eyebrow: 'Calendar',
		subject: `${title} was not scheduled`,
		headline: `${title} was not scheduled`,
		detail:
			reason === 'sms_allowance'
				? 'No text sends are left this month. Schedule it yourself for later.'
				: 'Another broadcast is already scheduled within 2 days of it. Schedule it yourself if you still want it.',
		actionLabel: 'Open the calendar',
	}
}

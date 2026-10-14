import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type DeclineReason,
	type DeclineTemplate,
	type HiringSource,
	type HiringStage,
	type HiringTimelineKind,
	type InterviewMode,
	type InterviewStatus,
	type InviteStatus,
} from '@repo/staffing'
import { useMemo } from 'react'
import { type Option } from '#app/components/staff/controls.tsx'
import { type ScoreBand } from '#app/utils/hiring/applicant-view.ts'

/** Plain-language labels for the applicant screens, translated once per render. */
export function useApplicantLabels() {
	const { _, i18n } = useLingui()
	return useMemo(() => {
		const stage: Record<HiringStage, string> = {
			new: _(t`New`),
			screening: _(t`Screening`),
			interview: _(t`Interview`),
			offer: _(t`Offer`),
			hired: _(t`Hired`),
			declined: _(t`Declined`),
		}
		const source: Record<HiringSource, string> = {
			careers_page: _(t`Careers page`),
			qr: _(t`QR code`),
			share_link: _(t`Shared link`),
		}
		const mode: Record<InterviewMode, string> = {
			in_person: _(t`In person`),
			phone: _(t`Phone call`),
			video: _(t`Video call`),
		}
		const interviewStatus: Record<InterviewStatus, string> = {
			scheduled: _(t`Scheduled`),
			completed: _(t`Done`),
			cancelled: _(t`Cancelled`),
			no_show: _(t`Did not show`),
		}
		const invite: Record<InviteStatus, string> = {
			not_sent: _(t`No invitation sent`),
			sent: _(t`Invitation emailed`),
			failed: _(t`Invitation could not be sent`),
			no_email: _(t`No email on file, so nothing was sent`),
			email_disabled: _(t`Email is turned off, so nothing was sent`),
		}
		const declineReason: Record<DeclineReason, string> = {
			not_a_fit: _(t`Not the right fit`),
			position_filled: _(t`Position filled`),
			not_available: _(t`Not available when we need them`),
			missing_requirements: _(t`Missing something the job needs`),
			withdrew: _(t`Withdrew their application`),
			no_response: _(t`Stopped replying`),
		}
		const declineTemplate: Record<
			DeclineTemplate,
			{ label: string; description: string }
		> = {
			none: {
				label: _(t`Do not send anything`),
				description: _(t`Record the decision quietly.`),
			},
			thanks: {
				label: _(t`Thank them`),
				description: _(
					t`A polite note that you will not be moving forward right now.`,
				),
			},
			position_filled: {
				label: _(t`The job is filled`),
				description: _(t`Tells them the position has been filled.`),
			},
			keep_on_file: {
				label: _(t`Keep their details on file`),
				description: _(
					t`Thanks them and says you may get in touch if something suitable opens up.`,
				),
			},
		}
		const score: Record<ScoreBand, string> = {
			none: _(t`No screening questions`),
			strong: _(t`Strong match`),
			mixed: _(t`Some answers differ`),
			low: _(t`Many answers differ`),
		}
		const timeline: Record<HiringTimelineKind, string> = {
			applied: _(t`Applied`),
			stage_changed: _(t`Moved`),
			note_added: _(t`Note added`),
			interview_scheduled: _(t`Interview scheduled`),
			interview_updated: _(t`Interview updated`),
			invite_sent: _(t`Invitation`),
			declined: _(t`Declined`),
			reopened: _(t`Moved back into the pipeline`),
			decline_email_sent: _(t`Message to the applicant`),
			hired: _(t`Hired`),
		}
		const options = <K extends string>(map: Record<K, string>): Option[] =>
			(Object.keys(map) as K[]).map((value) => ({ value, label: map[value] }))

		return {
			stage,
			source,
			mode,
			interviewStatus,
			invite,
			declineReason,
			declineTemplate,
			score,
			timeline,
			stageOptions: (keys: readonly HiringStage[]): Option[] =>
				keys.map((value) => ({ value, label: stage[value] })),
			modeOptions: options(mode),
			declineReasonOptions: options(declineReason),
			/** A date with time at a workplace, in the viewer's language. */
			formatWhen: (ms: number, timeZone: string | null) => {
				try {
					return new Intl.DateTimeFormat(i18n.locale, {
						weekday: 'short',
						month: 'short',
						day: 'numeric',
						hour: 'numeric',
						minute: '2-digit',
						...(timeZone ? { timeZone } : {}),
					}).format(ms)
				} catch {
					return new Intl.DateTimeFormat(i18n.locale, {
						dateStyle: 'medium',
						timeStyle: 'short',
					}).format(ms)
				}
			},
			formatDay: (ms: number) =>
				new Intl.DateTimeFormat(i18n.locale, { dateStyle: 'medium' }).format(
					ms,
				),
		}
	}, [_, i18n.locale])
}

export type ApplicantLabels = ReturnType<typeof useApplicantLabels>

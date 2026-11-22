import { msg } from '@lingui/macro'
import { type RestyleRunStatus } from '@repo/common/media-restyle'

/** What an operator reads for a run's status and for each refusal (#146). */
export const RESTYLE_STATUS_LABELS = {
	pending: msg`Starting`,
	running: msg`Restyling your dishes`,
	paused: msg`Paused`,
	ready: msg`Ready to review`,
	cancelled: msg`Stopped`,
} as const satisfies Record<RestyleRunStatus, unknown>

export const RESTYLE_ERROR_MESSAGES = {
	restyle_in_progress: msg`A restyle is already running. Wait for it to finish or stop it first.`,
	restyle_paused: msg`Restyling is paused right now. Drafts you already have can still be reviewed.`,
	not_configured: msg`The photo studio is not set up yet.`,
	invalid_style: msg`Choose a style first.`,
	invalid_categories: msg`One of the categories is no longer on your menu.`,
	too_many_photos: msg`That is too many photos for one run. Choose fewer categories.`,
	nothing_to_restyle: msg`None of these dishes has a photo to restyle.`,
	photo_changed: msg`This dish's photo changed since the draft was made. Nothing was replaced.`,
	draft_changed: msg`This draft changed since you opened the page. Reload and look again.`,
	draft_missing: msg`This draft is no longer available.`,
	already_decided: msg`You already decided about this dish.`,
	not_used: msg`The new photo was not used on this dish.`,
	switch_back_unavailable: msg`The original photo is no longer in your library.`,
	run_cancelled: msg`This run was stopped.`,
	not_retryable: msg`This dish cannot be tried again.`,
	not_found: msg`That dish or run was not found.`,
	pos_owned: msg`This dish's photo comes from your point of sale, so it was not changed.`,
} as const

export type RestyleErrorCode = keyof typeof RESTYLE_ERROR_MESSAGES

export function isRestyleErrorCode(value: unknown): value is RestyleErrorCode {
	return typeof value === 'string' && value in RESTYLE_ERROR_MESSAGES
}

export const RESTYLE_SKIP_MESSAGES = {
	no_photo: msg`No photo`,
	photo_not_in_library: msg`Photo is not in your library`,
	unsupported_photo: msg`Photo format cannot be restyled`,
	photo_changed: msg`Photo changed during the run`,
	pos_owned: msg`Its photo comes from your point of sale`,
} as const

export const RESTYLE_FAILURE_MESSAGES = {
	draft_expired: msg`Not chosen within 30 days, so the draft was deleted`,
	unavailable: msg`The photo studio could not make this one`,
	rate_limited: msg`The photo studio was busy`,
	unsupported_image: msg`This photo could not be restyled`,
	source_missing: msg`The original photo is no longer in your library`,
	source_unreadable: msg`The original photo could not be read`,
	invalid_output: msg`The photo studio gave back something unusable`,
	attempts_exhausted: msg`This one kept failing`,
} as const

export function restyleSkipMessage(reason: string | null) {
	if (reason && reason in RESTYLE_SKIP_MESSAGES) {
		return RESTYLE_SKIP_MESSAGES[reason as keyof typeof RESTYLE_SKIP_MESSAGES]
	}
	return msg`Skipped`
}

export function restyleFailureMessage(error: string | null) {
	if (error && error in RESTYLE_FAILURE_MESSAGES) {
		return RESTYLE_FAILURE_MESSAGES[
			error as keyof typeof RESTYLE_FAILURE_MESSAGES
		]
	}
	return msg`This one could not be restyled`
}

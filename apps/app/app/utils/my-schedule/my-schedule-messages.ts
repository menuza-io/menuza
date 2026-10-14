import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	MyScheduleApiError,
	MyScheduleNetworkError,
} from './my-schedule-api.ts'

/**
 * Plain-language answers for what the schedule link can run into. Each says what
 * happened and what to do next; raw server text is never shown.
 */

const MESSAGES: Record<string, MessageDescriptor> = {
	too_many_pending: msg`You already have a lot of requests waiting. Wait for a manager to answer, or cancel one.`,
	rate_limit_exceeded: msg`That was too many requests at once. Try again in a few minutes.`,
	already_decided: msg`A manager already answered this request, so it cannot be changed here.`,
	shift_started: msg`That shift has already started.`,
	not_published: msg`That shift is not on your schedule any more. Refresh and try again.`,
	not_found: msg`We could not find that. Refresh and try again.`,
	not_your_shift: msg`That shift is not on your schedule any more. Refresh and try again.`,
	swap_not_allowed: msg`Swaps are not offered at this workplace. Ask your manager.`,
	staff_not_found: msg`That person is not available for this shift.`,
	request_pending: msg`There is already a request waiting on this shift.`,
	range_too_large: msg`That is too many days at once.`,
	invalid_range: msg`Those dates do not make sense. Check them and try again.`,
	'Invalid request': msg`Some of what you entered is not right. Check it and try again.`,
}

export function describeMyScheduleError(
	error: unknown,
	translate: (descriptor: MessageDescriptor) => string,
): string {
	if (error instanceof MyScheduleNetworkError) {
		return translate(msg`No connection. Check your internet and try again.`)
	}
	if (error instanceof MyScheduleApiError) {
		const known = MESSAGES[error.code]
		if (known) return translate(known)
		if (error.status >= 500) {
			return translate(
				msg`Something went wrong on our side. Try again in a moment.`,
			)
		}
	}
	return translate(msg`That did not work. Try again.`)
}

/** Why a link stopped working, for the page that replaces everything else. */
export function describeGoneLink(
	code: string,
	translate: (descriptor: MessageDescriptor) => string,
): { title: string; body: string } {
	switch (code) {
		case 'link_revoked':
			return {
				title: translate(msg`This link was turned off`),
				body: translate(
					msg`A manager turned off this schedule link. You will get a new one in your next schedule email.`,
				),
			}
		case 'link_expired':
			return {
				title: translate(msg`This link has expired`),
				body: translate(
					msg`Open the newest schedule email from your manager. Each email has a fresh link.`,
				),
			}
		case 'staff_inactive':
			return {
				title: translate(msg`This schedule is no longer available`),
				body: translate(msg`Ask your manager if you think this is a mistake.`),
			}
		case 'schedule_disabled':
			return {
				title: translate(msg`The schedule is not available right now`),
				body: translate(msg`Try again later, or ask your manager.`),
			}
		case 'no_link':
			return {
				title: translate(msg`Open your schedule from your email`),
				body: translate(
					msg`This page opens from the link in your schedule email. Find the latest email from your manager and tap the button in it.`,
				),
			}
		default:
			return {
				title: translate(msg`This link does not work`),
				body: translate(
					msg`Open the newest schedule email from your manager and tap the button in it. Do not copy part of the link.`,
				),
			}
	}
}

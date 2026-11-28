import { SETUP_REMINDER_DAYS } from '@repo/common/setup-reminders'
import { type LaunchChecklist } from './launch.ts'

/**
 * The setup reminder sequence (#271), pure. An organization that is not live
 * and stops making progress gets one email about its single next step 1, 3 and
 * 7 days after the last progress, then no more. Any progress (a step done or
 * undone) resets the sequence from that moment. The server module gathers the
 * facts and sends; this decides.
 */

const DAY_MS = 86_400_000
/** A reminder that is more than this many days late is skipped, not sent. */
export const REMINDER_LATE_WINDOW_DAYS = 3

export type ReminderDecision = {
	/** Which reminder of the sequence: 1, 3 or 7 days after the last progress. */
	day: (typeof SETUP_REMINDER_DAYS)[number]
	/** False when the day is long past (the job missed it): mark it, send nothing. */
	send: boolean
} | null

/**
 * The reminder due now, if any: the latest day of the sequence that has been
 * reached and not yet sent. Only that one is sent, so a job that missed a few
 * days never sends two at once; a day more than three days past is skipped
 * (an old stall is not woken by a surprise email).
 */
export function nextReminderDue(input: {
	progressAt: Date
	now: Date
	lastAutoDay: number
}): ReminderDecision {
	const days = Math.floor(
		(input.now.getTime() - input.progressAt.getTime()) / DAY_MS,
	)
	let due: (typeof SETUP_REMINDER_DAYS)[number] | null = null
	for (const day of SETUP_REMINDER_DAYS) {
		if (day > input.lastAutoDay && days >= day) due = day
	}
	if (due === null) return null
	return { day: due, send: days < due + REMINDER_LATE_WINDOW_DAYS }
}

/** The next unfinished step, or why there is nothing to remind about. */
export type ReminderTarget =
	| { kind: 'none' }
	| { kind: 'live' }
	| {
			kind: 'step'
			locationId: string
			stepKey: string
			/** Relative to `/<orgSlug>`. */
			href: string
			done: number
			total: number
			/** The done required steps, for the progress signature. */
			doneKeys: string[]
	  }

/**
 * The single next step of the first location that is not live (the default
 * location comes first). Optional steps are never nagged about. When every
 * required step is done but the location is not live, the next step is going
 * live. An organization with any live location is live: no reminders.
 */
export function pickReminderTarget(
	checklist: LaunchChecklist | null,
): ReminderTarget {
	if (!checklist || checklist.locations.length === 0) return { kind: 'none' }
	if (checklist.locations.some((location) => location.live)) {
		return { kind: 'live' }
	}
	const location = checklist.locations[0]!
	const required = location.steps.filter((step) => !step.optional)
	const next =
		required.find((step) => step.state === 'todo') ??
		required.find((step) => step.key === 'launch_go_live') ??
		required[required.length - 1]
	if (!next) return { kind: 'none' }
	return {
		kind: 'step',
		locationId: location.id,
		stepKey: next.key,
		href: next.href,
		done: location.requiredDone,
		total: location.requiredTotal,
		doneKeys: required
			.filter((step) => step.state === 'done')
			.map((step) => step.key)
			.sort(),
	}
}

/**
 * A short stable text of the progress: which required steps are done at which
 * location. Any change to it is progress and resets the sequence.
 */
export function progressSignature(target: {
	locationId: string
	doneKeys: readonly string[]
}): string {
	return `${target.locationId}:${[...target.doneKeys].sort().join(',')}`
}

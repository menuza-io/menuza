import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import {
	formatHoursTime,
	type HoursWarning,
	type HoursWarningCode,
} from '@repo/common/hours-lint'
import { DAY_LABELS, type DayOfWeek } from '@repo/common/location-types'

/**
 * What the hours editor says about each warning (#275). The words are written
 * here from a warning's code and facts, so the editor, the launch checklist and
 * Needs attention agree and every language gets the same sentence.
 */

type Translate = (descriptor: MessageDescriptor) => string

function dayName(day: DayOfWeek | undefined, _: Translate): string {
	switch (day) {
		case 'monday':
			return _(msg`Monday`)
		case 'tuesday':
			return _(msg`Tuesday`)
		case 'wednesday':
			return _(msg`Wednesday`)
		case 'thursday':
			return _(msg`Thursday`)
		case 'friday':
			return _(msg`Friday`)
		case 'saturday':
			return _(msg`Saturday`)
		case 'sunday':
			return _(msg`Sunday`)
		default:
			return day ? DAY_LABELS[day] : ''
	}
}

function time(value: unknown, locale: string): string {
	return typeof value === 'string' ? formatHoursTime(value, locale) : ''
}

export type HoursWarningText = {
	title: string
	detail: string | null
	/** The one-click fix's button label, when there is a fix. */
	fixLabel: string | null
}

export function hoursWarningText(
	warning: HoursWarning,
	_: Translate,
	locale: string,
): HoursWarningText {
	const day = dayName(warning.day, _)
	const p = warning.params
	const code: HoursWarningCode = warning.code
	switch (code) {
		case 'day_too_short': {
			const hours = Number(p.hours)
			return {
				title: _(msg`${day} is open for only ${hours} hours`),
				detail: _(msg`Guests see a very short day. Is that on purpose?`),
				fixLabel: warning.fix ? _(msg`Use the hours of the other days`) : null,
			}
		}
		case 'day_too_long': {
			const hours = Number(p.hours)
			return {
				title: _(msg`${day} is open for ${hours} hours`),
				detail: _(msg`That is more than 20 hours. Is that on purpose?`),
				fixLabel: warning.fix ? _(msg`Use the hours of the other days`) : null,
			}
		}
		case 'closes_before_opens': {
			const start = time(p.start, locale)
			const end = time(p.end, locale)
			const suggested = time(p.suggested, locale)
			const where = warning.scope === 'special' ? (warning.date ?? '') : day
			return {
				title: _(msg`${where} closes at ${end}, before it opens at ${start}`),
				detail: _(
					msg`This can be an AM and PM mix-up. Overnight hours should be split at midnight.`,
				),
				fixLabel: suggested ? _(msg`Did you mean ${suggested}?`) : null,
			}
		}
		case 'closing_looks_like_morning': {
			const end = time(p.end, locale)
			const suggested = time(p.suggested, locale)
			return {
				title: _(msg`${day} closes at ${end} in the morning`),
				detail: _(msg`Your other days close in the evening.`),
				fixLabel: _(msg`Did you mean ${suggested}?`),
			}
		}
		case 'online_overnight_not_split':
			return {
				title: _(msg`Online hours on ${day} run past midnight in one row`),
				detail: _(
					msg`Online ordering reads each day on its own, so a row that ends after midnight is never open. Split it at midnight.`,
				),
				fixLabel: _(msg`Split at midnight`),
			}
		case 'online_outside_store': {
			const from = time(p.from, locale)
			const to = time(p.to, locale)
			return {
				title: _(msg`Online ordering on ${day} runs outside store hours`),
				detail: _(
					msg`Guests can order between ${from} and ${to}, when the store is not open.`,
				),
				fixLabel: _(msg`Match the store hours`),
			}
		}
		case 'online_no_time_to_order': {
			const minutes = Number(p.minutes)
			return {
				title: _(
					msg`Online ordering on ${day} is open for only ${minutes} minutes`,
				),
				detail: _(msg`That leaves guests no time to order.`),
				fixLabel: _(msg`Match the store hours`),
			}
		}
		case 'closed_every_day':
			return {
				title: _(msg`The store is closed every day`),
				detail: _(msg`Turn on at least one day, or guests see you as closed.`),
				fixLabel: null,
			}
		case 'online_closed_every_day':
			return {
				title: _(msg`Online ordering is closed every day`),
				detail: _(msg`Turn on at least one day so guests can order.`),
				fixLabel: null,
			}
		case 'special_overlap': {
			const date = warning.date ?? ''
			return {
				title: _(msg`Special hours on ${date} overlap`),
				detail: _(msg`Two time ranges on the same day cover the same hours.`),
				fixLabel: _(msg`Merge the overlapping hours`),
			}
		}
		case 'special_open_without_hours': {
			const date = warning.date ?? ''
			return {
				title: _(msg`${date} is marked open but has no hours`),
				detail: _(msg`Guests cannot order on that day.`),
				fixLabel: _(msg`Mark it closed`),
			}
		}
		case 'special_closed_with_hours': {
			const date = warning.date ?? ''
			return {
				title: _(msg`${date} is marked closed but still lists hours`),
				detail: _(msg`The closure wins and the hours are ignored.`),
				fixLabel: _(msg`Keep it closed and remove the hours`),
			}
		}
		case 'special_duplicate_date': {
			const date = warning.date ?? ''
			return {
				title: _(msg`There are two special entries for ${date}`),
				detail: _(msg`Only one of them can apply.`),
				fixLabel: _(msg`Remove this one`),
			}
		}
	}
}

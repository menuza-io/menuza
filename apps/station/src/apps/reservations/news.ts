import { msg, plural } from '@lingui/macro'
import { type useLingui } from '@lingui/react'
import { type DayNotice } from './book.ts'
import { isVip, shortName, type DayReservation } from './feed.ts'

type Translate = ReturnType<typeof useLingui>['_']

/**
 * What the stand says, quietly, about what changed since it last looked at the
 * day: who has turned up at another host's stand, a booking a guest made
 * online, one that was cancelled, a party size that changed. One change is
 * said as itself; several as a count (the screen reader still hears each).
 */
/** A screen reader is told this many changes in full; the rest as a count. */
export const MAX_SPOKEN = 3

export function newsOf(
	_: Translate,
	input: {
		arrivals: DayReservation[]
		notices: DayNotice[]
		formatTime: (epochMs: number) => string
	},
): { items: string[]; toast: string | null } {
	const all: string[] = []
	const guest = _(msg`Guest`)
	const { arrivals } = input
	if (arrivals.length > 1)
		all.push(
			_(
				plural(arrivals.length, {
					one: '# party has arrived.',
					other: '# parties have arrived.',
				}),
			),
		)
	else if (arrivals[0]) {
		const who = shortName(arrivals[0], guest)
		all.push(
			isVip(arrivals[0])
				? _(msg`VIP guest has arrived: ${who}.`)
				: _(msg`${who} has arrived.`),
		)
	}
	for (const notice of input.notices) {
		const r = notice.reservation
		const who = shortName(r, guest)
		const time = input.formatTime(r.startAt)
		const size = r.partySize
		if (notice.kind === 'online')
			all.push(_(msg`New online booking: ${who}, ${size} at ${time}`))
		else if (notice.kind === 'cancelled')
			all.push(_(msg`Cancelled: ${who}, ${time}`))
		else {
			const from = notice.from
			all.push(_(msg`Party size changed: ${who}, ${from} to ${size}`))
		}
	}
	const count = all.length
	// Said in full for the first few; a burst is a count, never a long reading.
	const items = all.slice(0, MAX_SPOKEN)
	const more = count - items.length
	if (more > 0)
		items.push(_(plural(more, { one: 'and # more', other: 'and # more' })))
	return {
		items,
		toast:
			count === 0
				? null
				: count === 1
					? all[0]!
					: _(
							plural(count, {
								one: '# update at the stand',
								other: '# updates at the stand',
							}),
						),
	}
}

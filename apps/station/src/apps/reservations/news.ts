import { msg, plural } from '@lingui/macro'
import { type useLingui } from '@lingui/react'
import { type DayNotice } from './book.ts'
import { isLargeParty } from './combine.ts'
import { isVip, shortName, type DayReservation } from './feed.ts'
import { listText } from './guest.ts'

type Translate = ReturnType<typeof useLingui>['_']

/**
 * What the stand says, quietly, about what changed since it last looked at the
 * day: who has turned up at another host's stand, a booking a guest made
 * online, one that was cancelled, a party size that changed. One or two
 * changes are named ("Layla H. booked 12 for 7:30 PM"); more are a summary
 * ("5 new, 1 cancelled") that the host can tap to see what changed; a VIP or a
 * large party is said as such. The screen reader still hears the first few in
 * full, then "and N more".
 */
/** A screen reader is told this many changes in full; the rest as a count. */
export const MAX_SPOKEN = 3

/** The toast names this many changes; more are a summary. */
export const MAX_NAMED = 2

/** A changed row carries its "New" or "Changed" tag this long. */
export const CHANGE_TAG_MS = 60_000

export type ChangeKind = 'new' | 'cancelled' | 'changed' | 'arrived'

type Change = { kind: ChangeKind; reservation: DayReservation; from?: number }

export type News = {
	/** What a screen reader is told: the first few in full, then "and N more". */
	items: string[]
	/** The toast's words (null: nothing changed). */
	toast: string | null
	/** More than two changes: the toast is a summary, tappable to filter the list. */
	summary: boolean
	/** A VIP or a large party is among them: the toast stands out. */
	highlight: boolean
	/** Every booking that changed (a cancelled one is no longer in the list). */
	ids: string[]
	/** The tag each changed row carries for a minute: a booking made, a size changed. */
	tags: Map<string, 'new' | 'changed'>
}

export function newsOf(
	_: Translate,
	input: {
		arrivals: DayReservation[]
		notices: DayNotice[]
		formatTime: (epochMs: number) => string
		/** For the list "5 new, 1 cancelled" (default English). */
		locale?: string
	},
): News {
	const guest = _(msg`Guest`)
	const changes: Change[] = [
		...input.arrivals.map((reservation): Change => ({
			kind: 'arrived',
			reservation,
		})),
		...input.notices.map((notice): Change => ({
			kind:
				notice.kind === 'online'
					? 'new'
					: notice.kind === 'size'
						? 'changed'
						: 'cancelled',
			reservation: notice.reservation,
			...(notice.kind === 'size' ? { from: notice.from } : {}),
		})),
	]
	if (changes.length === 0)
		return {
			items: [],
			toast: null,
			summary: false,
			highlight: false,
			ids: [],
			tags: new Map(),
		}

	/** One change in a sentence, with a VIP or a large party said as such. */
	const sentence = ({ kind, reservation: r, from }: Change): string => {
		const who = shortName(r, guest)
		const size = r.partySize
		const time = input.formatTime(r.startAt)
		const before = from ?? size
		const text =
			kind === 'new'
				? _(msg`${who} booked ${size} for ${time}`)
				: kind === 'cancelled'
					? _(msg`${who} cancelled`)
					: kind === 'arrived'
						? _(msg`${who} has arrived`)
						: _(msg`${who} changed from ${before} to ${size}`)
		const vip = isVip(r)
		const large = isLargeParty(size)
		return vip && large
			? _(msg`VIP, large party: ${text}`)
			: vip
				? _(msg`VIP: ${text}`)
				: large
					? _(msg`Large party: ${text}`)
					: text
	}

	// Spoken: each change in full (several arrivals as one count), then "and N more".
	const spoken: string[] = []
	const arrived = changes.filter((c) => c.kind === 'arrived')
	if (arrived.length > 1)
		spoken.push(
			_(
				plural(arrived.length, {
					one: '# party has arrived.',
					other: '# parties have arrived.',
				}),
			),
		)
	for (const change of changes)
		if (change.kind !== 'arrived' || arrived.length === 1)
			spoken.push(sentence(change))
	const items = spoken.slice(0, MAX_SPOKEN)
	const more = spoken.length - items.length
	if (more > 0)
		items.push(_(plural(more, { one: 'and # more', other: 'and # more' })))

	const standOut = changes.filter(
		(c) => isVip(c.reservation) || isLargeParty(c.reservation.partySize),
	).length
	const count = (kind: ChangeKind) =>
		changes.filter((c) => c.kind === kind).length
	const summary = changes.length > MAX_NAMED
	let toast: string
	if (!summary) toast = changes.map(sentence).join(' · ')
	else {
		const made = count('new')
		const cancelled = count('cancelled')
		const changed = count('changed')
		const here = count('arrived')
		const parts = [
			...(made > 0 ? [_(msg`${made} new`)] : []),
			...(cancelled > 0 ? [_(msg`${cancelled} cancelled`)] : []),
			...(changed > 0 ? [_(msg`${changed} changed`)] : []),
			...(here > 0 ? [_(msg`${here} arrived`)] : []),
		]
		toast = listText(parts, input.locale ?? 'en')
		if (standOut > 0)
			toast = _(
				plural(standOut, {
					one: `${toast} · # VIP or large party`,
					other: `${toast} · # VIPs or large parties`,
				}),
			)
	}
	const tags = new Map<string, 'new' | 'changed'>()
	for (const change of changes) {
		if (change.kind === 'new') tags.set(change.reservation.id, 'new')
		else if (change.kind === 'changed')
			tags.set(change.reservation.id, 'changed')
	}
	return {
		items,
		toast,
		summary,
		highlight: standOut > 0,
		ids: changes.map((c) => c.reservation.id),
		tags,
	}
}

/**
 * Which bookings still carry a "New" or "Changed" tag: the ones tagged in the
 * last minute (`at` is when each was tagged).
 */
export function liveTags(
	tagged: ReadonlyMap<string, { tag: 'new' | 'changed'; at: number }>,
	now: number,
): Map<string, 'new' | 'changed'> {
	const live = new Map<string, 'new' | 'changed'>()
	for (const [id, { tag, at }] of tagged)
		if (now >= at && now - at <= CHANGE_TAG_MS) live.set(id, tag)
	return live
}

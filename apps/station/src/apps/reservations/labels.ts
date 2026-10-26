import { msg, plural } from '@lingui/macro'
import { type useLingui } from '@lingui/react'
import { type CoversHere } from './arrival.ts'
import { type PartyStatus } from './book.ts'

type Translate = ReturnType<typeof useLingui>['_']

/** How a party stands, in words: for a bar's name and anywhere an icon alone would say too little. */
export function statusText(_: Translate, status: PartyStatus): string {
	switch (status.kind) {
		case 'seated':
			return _(msg`Seated`)
		case 'here':
			return _(msg`At the stand`)
		case 'late': {
			const { late, said: runningLate } = status
			return runningLate > 0
				? _(msg`${late} min late (said ${runningLate})`)
				: _(msg`${late} min late`)
		}
		case 'running': {
			const runningLate = status.said
			return _(msg`Running ${runningLate} min late`)
		}
		case 'confirmed':
			return _(msg`Confirmed`)
		case 'awaiting':
			return _(msg`Awaiting payment`)
		case 'finished':
			return _(msg`Finished`)
		case 'no_show':
			return _(msg`No-show`)
		default:
			return _(msg`Booked`)
	}
}

/** "3 of 5 here" for the ones at the door, "seated 3 of 5" for the ones at the table. */
export function coversText(_: Translate, partly: CoversHere): string {
	const { here, of } = partly
	return partly.stage === 'table'
		? _(msg`seated ${here} of ${of}`)
		: _(msg`${here} of ${of} here`)
}

const countFormats = new Map<string, Intl.NumberFormat>()

/**
 * A count in the language's own digits, the way the rest of the stand writes
 * its times and dates (the runtime's default for the locale), so a figure and
 * the clock beside it never mix two kinds of digit.
 */
export function formatCount(value: number, locale: string): string {
	let format = countFormats.get(locale)
	if (!format) {
		try {
			format = new Intl.NumberFormat(locale)
		} catch {
			format = new Intl.NumberFormat('en')
		}
		countFormats.set(locale, format)
	}
	return format.format(value)
}

/**
 * What the floor and the timeline say when there is nothing to draw: it names
 * the location (this terminal's own, else "this location") and how many tables
 * came in, so a manager can tell "never set up" from "set up but not shown".
 */
export function noTablesText(
	_: Translate,
	locationName: string | null,
	received: number,
): string {
	const place = locationName?.trim() || _(msg`this location`)
	return received === 0
		? _(
				msg`${place} has no tables yet. A manager adds the floor plan in the app, under Reservations, Setup.`,
			)
		: _(
				plural(received, {
					one: `${place} sent # table, but none is in a room that shows. A manager checks the rooms in the app, under Reservations, Setup.`,
					other: `${place} sent # tables, but none is in a room that shows. A manager checks the rooms in the app, under Reservations, Setup.`,
				}),
			)
}

import { msg } from '@lingui/macro'
import { type useLingui } from '@lingui/react'
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

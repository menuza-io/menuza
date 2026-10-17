import { type ReservationsApi } from './api.ts'
import { type ReservationLabels } from './labels.ts'
import { addDaysIso, formatHhmm, todayIn } from './time.ts'
import {
	guestsLabel,
	inputClass,
	labelClass,
	primaryButtonClass,
} from './ui.ts'
import { el } from '~/lib/ordering/dom'

export type BlockBarDeps = {
	api: ReservationsApi
	labels: ReservationLabels
	locationId: string
	defaultParty: number
	reserveHref: (query: URLSearchParams) => string
	navigate: (href: string) => void
}

/** The compact party/date/time bar of an inline "Book a table" block. */
export async function initBlockBar(form: HTMLFormElement, deps: BlockBarDeps) {
	const { labels } = deps
	let place: {
		id: string
		timeZone: string
		min: number
		max: number
		horizon: number
	} = {
		id: deps.locationId,
		timeZone: 'UTC',
		min: 1,
		max: 10,
		horizon: 60,
	}
	try {
		const config = await deps.api.config()
		const found =
			config.locations.find((item) => item.id === deps.locationId) ??
			config.locations[0]
		if (found) {
			place = {
				id: found.id,
				timeZone: found.timeZone,
				min: found.partySize.min,
				max: found.partySize.max,
				horizon: found.horizonDays,
			}
		}
	} catch {
		// Without config the bar still works with plain defaults; /reserve reports any outage.
	}

	form.replaceChildren()
	const wrap = (id: string, text: string, control: HTMLElement) => {
		const box = el('div', 'flex flex-col gap-2')
		const label = el('label', labelClass, text)
		label.htmlFor = id
		box.append(label, control)
		return box
	}
	const party = el('select', inputClass)
	party.id = 'rsv-bar-party'
	for (let size = place.min; size <= place.max; size++) {
		const option = el('option', undefined, guestsLabel(labels, size))
		option.value = String(size)
		party.append(option)
	}
	party.value = String(
		Math.min(Math.max(deps.defaultParty, place.min), place.max),
	)
	const today = todayIn(place.timeZone)
	const date = el('input', inputClass)
	date.id = 'rsv-bar-date'
	date.type = 'date'
	date.min = today
	date.max = addDaysIso(today, place.horizon)
	date.value = today
	const time = el('input', inputClass)
	time.id = 'rsv-bar-time'
	time.type = 'time'
	time.dir = 'ltr'
	time.value = formatHhmm(19 * 60)
	const submit = el('button', primaryButtonClass, labels.findButton)
	submit.type = 'submit'
	const action = el('div', 'flex items-end')
	action.append(submit)
	form.append(
		wrap(party.id, labels.fieldParty, party),
		wrap(date.id, labels.fieldDate, date),
		wrap(time.id, labels.fieldTime, time),
		action,
	)
	form.addEventListener('submit', (event) => {
		event.preventDefault()
		const query = new URLSearchParams()
		if (deps.locationId) query.set('location', deps.locationId)
		query.set('party', party.value)
		if (date.value) query.set('date', date.value)
		if (time.value) query.set('time', time.value)
		deps.navigate(deps.reserveHref(query))
	})
}

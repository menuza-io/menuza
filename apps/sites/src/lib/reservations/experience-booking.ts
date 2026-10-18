import { type ReservationsApi } from './api.ts'
import { reservationErrorKey } from './errors.ts'
import { type ReservationLabels } from './labels.ts'
import { formatClock, formatDateLong, formatHhmm } from './time.ts'
import { type Availability } from './types.ts'
import {
	bannerErrorClass,
	chipClass,
	cardClass,
	inputClass,
	labelClass,
} from './ui.ts'
import { el } from '~/lib/ordering/dom'
import { fillTemplate } from '~/lib/ordering/money'

export type ExperienceBookingData = {
	id: string
	locationId: string
	partyMin: number
	partyMax: number
	/** Dates with at least one seating, from the public catalog. */
	dates: string[]
}

export type ExperienceBookingDeps = {
	api: ReservationsApi
	labels: ReservationLabels
	locale: string
	data: ExperienceBookingData
	/** `/reserve` for this site and locale. */
	reserveHref: string
	navigate: (href: string) => void
}

export function reserveHrefFor(
	base: string,
	data: Pick<ExperienceBookingData, 'id' | 'locationId'>,
	choice: { partySize: number; date: string; localMin: number },
) {
	const params = new URLSearchParams({
		location: data.locationId,
		experience: data.id,
		party: String(choice.partySize),
		date: choice.date,
		time: formatHhmm(choice.localMin),
	})
	return `${base}?${params.toString()}`
}

/**
 * The booking control on an experience page: party size, date and the seating
 * times (sold-out ones shown disabled). Choosing a time continues in the
 * regular reservation flow, which holds the seating and takes payment.
 */
export function initExperienceBooking(
	root: HTMLElement,
	deps: ExperienceBookingDeps,
) {
	const { api, labels, locale, data } = deps
	root.replaceChildren()
	const card = el('section', cardClass)
	card.setAttribute('aria-labelledby', 'exp-book-heading')
	const heading = el(
		'h2',
		'text-lg font-semibold text-foreground',
		labels.expBookHeading,
	)
	heading.id = 'exp-book-heading'
	card.append(heading)
	root.append(card)

	if (data.dates.length === 0) {
		card.append(el('p', 'text-sm text-muted-foreground', labels.expNoDates))
		return
	}

	const party = el('select', inputClass)
	party.id = 'exp-party'
	for (let size = data.partyMin; size <= data.partyMax; size++) {
		const option = el(
			'option',
			undefined,
			size === 1
				? labels.guestsOne
				: fillTemplate(labels.guestsMany, { count: size }),
		)
		option.value = String(size)
		party.append(option)
	}
	const date = el('select', inputClass)
	date.id = 'exp-date'
	for (const day of data.dates) {
		const option = el('option', undefined, formatDateLong(day, locale))
		option.value = day
		date.append(option)
	}
	const controls = el('div', 'grid gap-4 sm:grid-cols-2')
	for (const [id, text, control] of [
		['exp-party', labels.expFieldParty, party],
		['exp-date', labels.expFieldDate, date],
	] as const) {
		const wrap = el('div', 'flex flex-col gap-2')
		const label = el('label', labelClass, text)
		label.htmlFor = id
		wrap.append(label, control)
		controls.append(wrap)
	}
	const status = el('div')
	status.setAttribute('aria-live', 'polite')
	const times = el('div', 'flex flex-col gap-3')
	times.setAttribute('aria-live', 'polite')
	card.append(
		controls,
		status,
		times,
		el('p', 'text-xs text-muted-foreground', labels.expContinueHint),
	)

	let seq = 0
	async function load() {
		const mine = ++seq
		const partySize = Number(party.value)
		const day = date.value
		status.replaceChildren()
		times.replaceChildren(
			el('p', 'text-sm text-muted-foreground', labels.searching),
		)
		times.setAttribute('aria-busy', 'true')
		try {
			const result = await api.availability({
				locationId: data.locationId,
				date: day,
				partySize,
				locale,
				experienceId: data.id,
			})
			if (mine !== seq) return
			render(result, partySize, day)
		} catch (error) {
			if (mine !== seq) return
			times.replaceChildren()
			const note = el('p', bannerErrorClass, labels[reservationErrorKey(error)])
			note.setAttribute('role', 'alert')
			status.replaceChildren(note)
		} finally {
			if (mine === seq) times.removeAttribute('aria-busy')
		}
	}

	function render(result: Availability, partySize: number, day: string) {
		times.replaceChildren()
		const slots = result.slots ?? []
		const soldOut = result.soldOut ?? []
		if (slots.length === 0 && soldOut.length === 0) {
			times.append(el('p', 'text-sm text-muted-foreground', labels.expNoTimes))
			return
		}
		const row = el('div', 'flex flex-wrap gap-2')
		row.setAttribute('role', 'group')
		row.setAttribute('aria-label', labels.timesHeading)
		for (const slot of slots) {
			const time = formatClock(slot.localMin, locale)
			const chip = el('button', chipClass, time)
			chip.type = 'button'
			chip.dataset.time = formatHhmm(slot.localMin)
			chip.setAttribute('aria-label', fillTemplate(labels.selectTime, { time }))
			chip.addEventListener('click', () =>
				deps.navigate(
					reserveHrefFor(deps.reserveHref, data, {
						partySize,
						date: day,
						localMin: slot.localMin,
					}),
				),
			)
			row.append(chip)
		}
		for (const item of soldOut) {
			const time = formatClock(item.localMin, locale)
			const chip = el('button', `${chipClass} flex-col gap-0.5 py-1.5`)
			chip.type = 'button'
			chip.disabled = true
			chip.dataset.soldOut = 'true'
			chip.setAttribute(
				'aria-label',
				fillTemplate(labels.expSoldOutTime, { time }),
			)
			chip.append(
				el('span', undefined, time),
				el(
					'span',
					'text-xs font-normal text-muted-foreground',
					labels.expSoldOut,
				),
			)
			row.append(chip)
		}
		times.append(row)
	}

	party.addEventListener('change', () => void load())
	date.addEventListener('change', () => void load())
	return load()
}

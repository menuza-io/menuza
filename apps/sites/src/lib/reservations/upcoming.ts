import { type ReservationsApi, ReservationsApiError } from './api.ts'
import { type ReservationLabels } from './labels.ts'
import { formatClock, formatDateLong } from './time.ts'
import { guestsLabel, secondaryButtonClass, statusLabel } from './ui.ts'
import { el } from '~/lib/ordering/dom'
import { fillTemplate } from '~/lib/ordering/money'

export type UpcomingDeps = {
	api: ReservationsApi
	labels: ReservationLabels
	locale: string
	manageHref: (token: string) => string
	bookHref: string
}

/** The profile page's "Upcoming reservations" list, fed by `GET /reservations/mine`. */
export async function initUpcomingPanel(list: HTMLElement, deps: UpcomingDeps) {
	const { api, labels, locale } = deps
	const message = (text: string) => {
		const item = el(
			'li',
			'px-4 py-6 text-center text-sm text-muted-foreground',
			text,
		)
		list.replaceChildren(item)
	}
	try {
		const mine = await api.mine()
		if (mine.upcoming.length === 0) {
			message(labels.upcomingEmpty)
			return
		}
		list.replaceChildren()
		for (const booking of mine.upcoming) {
			const item = el(
				'li',
				'flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm',
			)
			item.dataset.reservationId = booking.id
			const details = el('div', 'flex flex-col gap-1')
			details.append(
				el('p', 'font-medium text-foreground', booking.locationName ?? ''),
				el(
					'p',
					'text-muted-foreground',
					fillTemplate(labels.holdSummary, {
						party: guestsLabel(labels, booking.partySize),
						date: formatDateLong(booking.date, locale),
						time: formatClock(booking.localMin, locale),
					}),
				),
				el(
					'p',
					'text-xs text-muted-foreground',
					statusLabel(labels, booking.status),
				),
			)
			const manage = el('a', secondaryButtonClass, labels.upcomingManage)
			manage.href = deps.manageHref(booking.manageToken)
			item.append(details, manage)
			list.append(item)
		}
	} catch (error) {
		if (error instanceof ReservationsApiError && error.status === 401) {
			message(labels.upcomingEmpty)
			return
		}
		message(labels.upcomingLoadError)
	}
}

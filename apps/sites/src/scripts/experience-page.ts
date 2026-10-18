import { browserLocaleHref } from '~/lib/locale'
import {
	createBrowserReservationsApi,
	readReservationLabels,
} from '~/lib/reservations/client'
import {
	initExperienceBooking,
	type ExperienceBookingData,
} from '~/lib/reservations/experience-booking'

const root = document.getElementById('experience-book')
if (root?.dataset.experience) {
	try {
		const data = JSON.parse(root.dataset.experience) as ExperienceBookingData
		void initExperienceBooking(root, {
			api: createBrowserReservationsApi(),
			labels: readReservationLabels(),
			locale: document.documentElement.lang || 'en',
			data,
			reserveHref: browserLocaleHref('/reserve'),
			navigate: (href) => location.assign(href),
		})
	} catch {
		// Malformed data leaves the server-rendered page without the booking control.
	}
}

import { browserLocale, browserLocaleHref } from '~/lib/locale'
import {
	createBrowserReservationsApi,
	readReservationLabels,
} from '~/lib/reservations/client'
import { takeManageToken } from '~/lib/reservations/fragment'
import { initManagePage } from '~/lib/reservations/manage'

const root = document.getElementById('manage-root')
if (root) {
	// Read the capability token first: it is removed from the address bar
	// and history before anything else can leak it.
	const token = takeManageToken(location, history)
	void initManagePage(root, {
		api: createBrowserReservationsApi(),
		labels: readReservationLabels(),
		locale: browserLocale(),
		token,
		bookHref: browserLocaleHref('/reserve'),
	})
}

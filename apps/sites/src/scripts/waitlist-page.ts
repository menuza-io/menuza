import { getAccessToken } from '~/lib/client-auth'
import { browserLocale, browserLocaleHref } from '~/lib/locale'
import {
	createBrowserReservationsApi,
	loadCustomerPrefill,
	readReservationLabels,
} from '~/lib/reservations/client'
import { initWaitlistPage } from '~/lib/reservations/waitlist-box'

const root = document.getElementById('waitlist-root')
if (root) {
	void initWaitlistPage(root, {
		api: createBrowserReservationsApi(),
		labels: readReservationLabels(),
		locale: browserLocale(),
		smsAllowed: root.dataset.smsAllowed !== 'false',
		phoneExample: root.dataset.phoneExample || undefined,
		turnstileSiteKey: root.dataset.turnstileSiteKey || '',
		orgName: root.dataset.orgName || '',
		search: location.search,
		pageLocation: location,
		history,
		bookHref: browserLocaleHref('/reserve'),
		headingEl: document.getElementById('waitlist-heading'),
		subtitleEl: document.getElementById('waitlist-subtitle'),
		loadPrefill: loadCustomerPrefill,
		signedIn: () => Boolean(getAccessToken()),
	})
}

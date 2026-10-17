import { getAccessToken } from '~/lib/client-auth'
import { browserLocaleHref } from '~/lib/locale'
import {
	createBrowserReservationsApi,
	loadCustomerPrefill,
	readReservationLabels,
} from '~/lib/reservations/client'
import { initReserveFlow } from '~/lib/reservations/flow'

const root = document.getElementById('reserve-root')
if (root) {
	void initReserveFlow(root, {
		api: createBrowserReservationsApi(),
		labels: readReservationLabels(),
		locale: document.documentElement.lang || 'en',
		smsAllowed: root.dataset.smsAllowed !== 'false',
		phoneExample: root.dataset.phoneExample || undefined,
		turnstileSiteKey: root.dataset.turnstileSiteKey || '',
		orgName: root.dataset.orgName || '',
		search: location.search,
		hash: location.hash,
		history,
		pageLocation: location,
		manageHref: (token) =>
			`${browserLocaleHref('/reserve/manage')}#t=${encodeURIComponent(token)}`,
		loadPrefill: loadCustomerPrefill,
		signedIn: () => Boolean(getAccessToken()),
	})
}

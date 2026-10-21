import { browserLocale, browserLocaleHref } from '~/lib/locale'
import { readReservationLabels } from '~/lib/reservations/client'
import { createPaymentApi, initPayPage } from '~/lib/reservations/pay'

const root = document.getElementById('pay-root')
if (root) {
	void initPayPage(root, {
		api: createPaymentApi(),
		labels: readReservationLabels(),
		locale: browserLocale(),
		hash: location.hash,
		search: location.search,
		done: root.dataset.done === 'true',
		pageLocation: location,
		history,
		redirect: (url) => location.assign(url),
		bookHref: browserLocaleHref('/reserve'),
		manageHref: browserLocaleHref('/reserve/manage'),
	})
}

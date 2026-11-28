import { getAccessToken } from '~/lib/client-auth'
import { mountGroupPage } from '~/lib/ordering/group-ui'
import { createMoneyFormatter } from '~/lib/ordering/money'
import { type GroupOrderLabels } from '~/lib/ordering-labels'
import { signInAndReturn } from '~/lib/return-after-login'

/** Mounts the group order page (#170) from the data the page left in `#group-root`. */
const root = document.getElementById('group-root')
if (root) {
	const labels = JSON.parse(root.dataset.labels ?? '{}') as GroupOrderLabels
	const meta = JSON.parse(root.dataset.meta ?? '{}') as {
		organizationId: string
		locale: string
		defaultLocale: string
		currency: string
		locations: Array<{ id: string; name: string }>
		defaultLocationId: string
		menuHref: string
		checkoutHref: string
		successHref: string
		pagePath: string
		signInHref: string
	}
	mountGroupPage({
		root,
		labels,
		orgId: meta.organizationId,
		locale: meta.locale,
		defaultLocale: meta.defaultLocale,
		currency: meta.currency,
		formatMoney: createMoneyFormatter(meta.currency, meta.locale),
		locations: meta.locations,
		defaultLocationId: meta.defaultLocationId,
		menuHref: meta.menuHref,
		checkoutHref: meta.checkoutHref,
		successHref: meta.successHref,
		pagePath: meta.pagePath,
		signInHref: meta.signInHref,
		signInAndReturn: () => signInAndReturn(),
		isSignedIn: () => Boolean(getAccessToken()),
	})
}

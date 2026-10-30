import { getAccessToken } from '~/lib/client-auth'
import { browserLocale, browserLocaleHref } from '~/lib/locale'
import { readLoyaltyLabels } from '~/lib/loyalty/read-labels'
import { initWalletPage } from '~/lib/loyalty/wallet-page'
import { createLoyaltyClient } from '~/lib/loyalty-client'

const root = document.getElementById('loyalty-wallet-root')
if (root) {
	void initWalletPage(root, {
		client: createLoyaltyClient(),
		labels: readLoyaltyLabels(),
		locale: browserLocale(),
		signedIn: () => Boolean(getAccessToken()),
		loginHref: root.dataset.loginHref || browserLocaleHref('/login'),
	})
}

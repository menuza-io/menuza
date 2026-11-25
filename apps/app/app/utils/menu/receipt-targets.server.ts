import { getFeatureFlag } from '@repo/common/feature-flags'
import { buildLink } from '@repo/common/links'
import {
	cleanGoogleReviewUrl,
	type ReceiptTargets,
} from '@repo/common/receipt-extras'
import { LOYALTY_FLAG_KEYS } from '@repo/loyalty'
import { ENV } from 'varlock/env'
import { loadPublicCustomerApp } from '#app/utils/customer-apps/public.server.ts'
import { resolveSitesOrigin } from '#app/utils/sites/sites-origin.server.ts'

/**
 * The addresses the receipt codes open (#263). The review code opens the
 * location's own Google review link. The app code opens the site's store
 * redirect (the smart link, counted under the Print placement) when the
 * restaurant's app is live in a store, otherwise the site's rewards page when
 * loyalty is on, otherwise nothing: a code is offered only when its target
 * exists. Static links; no guest data.
 */
export async function buildReceiptTargets(
	org: { id: string; slug: string; customDomain: string | null },
	locations: ReadonlyArray<{ id: string; googleReviewUrl: string | null }>,
): Promise<Map<string, ReceiptTargets>> {
	const origin = resolveSitesOrigin({
		slug: org.slug,
		customDomain: org.customDomain,
		baseUrl: ENV.BASE_URL ?? '',
		hostSuffixes: (ENV as { PUBLIC_SITE_HOST_SUFFIXES?: string })
			.PUBLIC_SITE_HOST_SUFFIXES,
	})
	const [app, loyalty] = await Promise.all([
		loadPublicCustomerApp(org.id).catch(() => null),
		getFeatureFlag(LOYALTY_FLAG_KEYS.enabled, { organizationId: org.id }).catch(
			() => false,
		),
	])
	const appLive = Boolean(app && Object.keys(app.stores).length > 0)
	const appUrl = appLive
		? buildLink('get_app', { p: 'print' }, { origin })
		: loyalty === true
			? buildLink('loyalty', {}, { origin })
			: null
	const targets = new Map<string, ReceiptTargets>()
	for (const location of locations) {
		targets.set(location.id, {
			reviewUrl: cleanGoogleReviewUrl(location.googleReviewUrl),
			appUrl,
		})
	}
	return targets
}

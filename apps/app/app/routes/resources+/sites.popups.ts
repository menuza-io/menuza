import { hasExternalTarget } from '@repo/common/action-targets'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import { type LoaderFunctionArgs } from 'react-router'
import { loadPublicPopups } from '#app/utils/popups/popups.server.ts'
import { funnelEnabled } from '#app/utils/site-events/site-events.server.ts'
import { withPublicCors } from '#app/utils/sites/public-cors.server.ts'
import { requirePublishedSiteOrganization } from '#app/utils/sites/published-org.server.ts'
import { loadPublicActionTargets } from '#app/utils/website/action-targets.server.ts'

/**
 * Promotional popups (#132): `GET /resources/sites/popups?slug=acme&lng=ar`.
 * Published popups of a published site with the coupon resolved server-side:
 * the code is present only while the coupon is valid online, and a popup whose
 * coupon expired or was switched off is left out. Empty while `website.popups`
 * is off; `funnel` says whether the site counts its funnel. CORS-open (the browser of a site on another origin reads it). Never cached by the browser or a shared cache, so a stopped coupon
 * stops the popup at once. Sites decides page, dates and frequency per view.
 */
export const loader = withPublicCors(async function loader({
	request,
}: LoaderFunctionArgs) {
	const { organization, url } = await requirePublishedSiteOrganization(request)
	const config = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const requested = url.searchParams.get('lng')?.trim().toLowerCase() || null
	const locale =
		requested && (config.locales as string[]).includes(requested)
			? requested
			: config.defaultLocale
	const funnel = await funnelEnabled(organization.id)
	const popups = await loadPublicPopups({
		organization: { id: organization.id, dataRegion: organization.dataRegion },
		locale,
		defaultLocale: config.defaultLocale,
	})
	return Response.json(
		// `funnel` tells the browser whether to count its funnel (#179).
		// `outbound` says whether to count clicks that leave for another site
		// (#318): on with the funnel, and whenever a button goes to another site.
		{
			popups,
			funnel,
			outbound:
				funnel ||
				hasExternalTarget(await loadPublicActionTargets(organization.id)),
		},
		{ headers: { 'Cache-Control': 'private, no-store' } },
	)
})

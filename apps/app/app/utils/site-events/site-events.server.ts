import { isWebsiteFlagOn } from '#app/utils/website/website-flags.ts'

/** The funnel panel and the beacon are behind `website.funnel` (default off). */
export const WEBSITE_FUNNEL_FLAG = 'website.funnel'

export function funnelEnabled(organizationId: string) {
	return isWebsiteFlagOn(organizationId, WEBSITE_FUNNEL_FLAG)
}

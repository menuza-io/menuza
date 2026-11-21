import {
	ATTRIBUTION_PARAMS,
	tagOwnSiteLinksInHtml,
	tagOwnSiteLinksInText,
} from '@repo/common/short-links'
import { getOrgEmailSender } from '../lib/org-email-sender.ts'
import { campaignUtm } from './short-links.ts'

/**
 * Links to the organization's own site in a Menuza email carry the UTM values
 * and the opaque campaign id (`mzc`, with the step id `mzs` for an automation),
 * so an order after a click can be credited to the message (#115). Other links
 * are left alone. The values are ids and a campaign name: never a guest's data.
 */
export async function tagEmailLinks(
	orgId: string,
	content: { html: string; text: string },
	context: {
		campaignId: string
		stepId?: string | null
		campaignName?: string | null
	},
): Promise<{ html: string; text: string }> {
	const profile = await getOrgEmailSender(orgId).catch(() => null)
	const siteOrigin = profile?.siteOrigin
	if (!siteOrigin) return content
	const params = {
		utm_source: 'menuza',
		utm_medium: 'email',
		utm_campaign: campaignUtm(context.campaignName, context.campaignId),
		[ATTRIBUTION_PARAMS.campaign]: context.campaignId,
		[ATTRIBUTION_PARAMS.step]: context.stepId,
	}
	return {
		html: tagOwnSiteLinksInHtml(content.html, siteOrigin, params),
		text: tagOwnSiteLinksInText(content.text, siteOrigin, params),
	}
}

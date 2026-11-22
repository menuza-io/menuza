import { isValidTimeZone } from '@repo/zoned-time'
import {
	countMarketingSmsSegments,
	smsSendWindow,
	withSmsOptOutFooter,
} from '@repo/common/sms-compliance'
import {
	ATTRIBUTION_PARAMS,
	findOwnSiteLinks,
	shortLinkUrl,
	tagOwnSiteLinksInText,
} from '@repo/common/short-links'
import { getTenantDb } from '@repo/tenant-db'
import { quietHoursDisabledForTests } from '../lib/marketing-sms-switch.ts'
import {
	getOrgEmailSender,
	isOrgLookupConfigured,
} from '../lib/org-email-sender.ts'
import { campaignUtm, ensureShortLink } from './short-links.ts'

/**
 * The one place a marketing text is prepared (#75), used by broadcasts and
 * automation steps alike: it words the message (opt-out phrase last) and says
 * when it may go out (9:00 to 20:00 in the location's time zone). Quiet hours
 * defer, they never drop: `notBefore` is the next time the window opens.
 */

/** When the time zone cannot be read yet, look again after this long. */
export const TIME_ZONE_RETRY_MS = 15 * 60 * 1000

export type PreparedMarketingSms = {
	/** The text to send, ending with the opt-out phrase. */
	body: string
	/** The earliest instant it may be sent: `now` when the window is open. */
	notBefore: number
	/** Why a send is deferred, for logs and run timelines. */
	reason: 'quiet_hours' | 'time_zone_unknown' | null
	/** Segments the guest is billed for, footer included. */
	segments: number
}

/**
 * The IANA zone a text to this location is timed in: the location's own, else
 * the organization's first. Null when the App could not say.
 */
export async function marketingSmsTimeZone(
	orgId: string,
	locationId?: string | null,
): Promise<string | null> {
	if (!isOrgLookupConfigured()) return 'UTC' // a bare local run
	const profile = await getOrgEmailSender(orgId).catch(() => null)
	const zone =
		(locationId ? profile?.locationTimeZones[locationId] : undefined) ??
		profile?.timeZone
	return zone && isValidTimeZone(zone) ? zone : null
}

/** Which campaign a text belongs to, so its links can be short, counted and attributed. */
export type SmsLinkContext = {
	/** The broadcast id, or the automation (journey) id. */
	campaignId: string
	/** The automation step (node) id; absent for a broadcast. */
	stepId?: string | null
	/** The campaign's name, which becomes `utm_campaign`. */
	campaignName?: string | null
	/** This recipient's `marketing_messages` id: a click marks that text clicked. */
	messageId?: string | null
}

/**
 * Links to the organization's own site in a text (#159, #115). With short links
 * on, each becomes `<site>/l/<code>` (UTM values and ids live in the link row);
 * without, the same values are added to the URL itself. Other URLs are left as
 * they are.
 */
export async function linkOwnSite(
	orgId: string,
	text: string,
	context: SmsLinkContext,
): Promise<string> {
	const profile = await getOrgEmailSender(orgId).catch(() => null)
	const siteOrigin = profile?.siteOrigin
	if (!siteOrigin) return text
	const links = findOwnSiteLinks(text, siteOrigin)
	if (links.length === 0) return text
	const utmCampaign = campaignUtm(context.campaignName, context.campaignId)
	if (!profile.shortLinksEnabled) {
		return tagOwnSiteLinksInText(text, siteOrigin, {
			utm_source: 'menuza',
			utm_medium: 'sms',
			utm_campaign: utmCampaign,
			[ATTRIBUTION_PARAMS.campaign]: context.campaignId,
			[ATTRIBUTION_PARAMS.step]: context.stepId,
		})
	}
	const db = await getTenantDb(orgId)
	let out = text
	for (const link of new Map(
		links.map((entry) => [entry.url, entry]),
	).values()) {
		const row = await ensureShortLink(db, {
			kind: 'message',
			ref: `${context.campaignId}:${context.stepId ?? ''}`,
			targetPath: link.path,
			utmSource: 'menuza',
			utmMedium: 'sms',
			utmCampaign,
			campaignId: context.campaignId,
			stepId: context.stepId,
		})
		out = out
			.split(link.url)
			.join(shortLinkUrl(siteOrigin, row.code, context.messageId))
	}
	return out
}

export async function prepareMarketingSms(input: {
	orgId: string
	locationId?: string | null
	text: string
	now: number
	/** The campaign the text belongs to; links to the own site are shortened and tagged. */
	links?: SmsLinkContext
}): Promise<PreparedMarketingSms> {
	const text = input.links
		? await linkOwnSite(input.orgId, input.text, input.links)
		: input.text
	const body = withSmsOptOutFooter(text)
	const segments = countMarketingSmsSegments(text).segments
	if (quietHoursDisabledForTests()) {
		return { body, notBefore: input.now, reason: null, segments }
	}
	const zone = await marketingSmsTimeZone(input.orgId, input.locationId)
	if (!zone) {
		return {
			body,
			notBefore: input.now + TIME_ZONE_RETRY_MS,
			reason: 'time_zone_unknown',
			segments,
		}
	}
	const window = smsSendWindow(input.now, zone)
	return {
		body,
		notBefore: window.notBefore,
		reason: window.open ? null : 'quiet_hours',
		segments,
	}
}

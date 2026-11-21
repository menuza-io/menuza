import { isValidTimeZone } from '@repo/zoned-time'
import {
	countMarketingSmsSegments,
	smsSendWindow,
	withSmsOptOutFooter,
} from '@repo/common/sms-compliance'
import { quietHoursDisabledForTests } from '../lib/marketing-sms-switch.ts'
import {
	getOrgEmailSender,
	isOrgLookupConfigured,
} from '../lib/org-email-sender.ts'

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

export async function prepareMarketingSms(input: {
	orgId: string
	locationId?: string | null
	text: string
	now: number
}): Promise<PreparedMarketingSms> {
	const body = withSmsOptOutFooter(input.text)
	const segments = countMarketingSmsSegments(input.text).segments
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

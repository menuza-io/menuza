import { ENV } from 'varlock/env'
import {
	SCHEDULE_LINK_PAGE_PATH,
	formatScheduleLinkToken,
	scheduleLinkFragment,
	scheduleLinkHashMessage,
	scheduleLinkSecretMessage,
} from '@repo/staffing'
import { getNodeRegion } from './region.ts'
import { hmacHash, syncEnvFromProcess } from './secrets.ts'

/**
 * The credential behind a person's "my schedule" link.
 *
 * The secret part is an HMAC (from `AUTH_HMAC_SECRET`) of the organization, the
 * link and the person, so it is derived rather than stored: the same email can
 * be sent again and the plaintext is never kept. What the database holds is a
 * second keyed hash of the whole token, which is what a presented token is
 * checked against. Rotating `AUTH_HMAC_SECRET` therefore revokes every link,
 * which is the intended emergency switch.
 *
 * The page address carries the token in the URL fragment, so no server log, CDN
 * or referrer ever sees it.
 */

export function deriveScheduleLinkToken(
	orgId: string,
	linkId: string,
	staffId: string,
): string {
	const secret = hmacHash(scheduleLinkSecretMessage(orgId, linkId, staffId))
	return formatScheduleLinkToken(orgId, linkId, secret)
}

export function hashScheduleLinkToken(token: string): string {
	return hmacHash(scheduleLinkHashMessage(token))
}

function appUrl(): string {
	syncEnvFromProcess()
	return (ENV.APP_URL || (ENV as { BASE_URL?: string }).BASE_URL || '').replace(
		/\/$/,
		'',
	)
}

/**
 * The address that opens the page for this token, or `null` when the node does
 * not know the App's public address (the email then carries no link).
 */
export function scheduleLinkUrl(token: string): string | null {
	const base = appUrl()
	if (!base) return null
	return `${base}${SCHEDULE_LINK_PAGE_PATH}${scheduleLinkFragment(getNodeRegion(), token)}`
}

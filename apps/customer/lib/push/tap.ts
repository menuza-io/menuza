import { type TenantConfiguration } from '../config/configuration'
import { resolveIncomingLink, routerTarget } from '../links/app-links'
import { type PushTapData } from './notifications'

export type PushTapDestination =
	| { kind: 'screen'; pathname: string; params: Record<string, string> }
	/** The address is not one this app opens as a screen: the website opens instead. */
	| { kind: 'web'; url: string }
	| { kind: 'none' }

/**
 * Where a tapped push goes. The payload carries a link from the shared
 * registry (`@repo/common/links`); the same resolver that opens links from
 * outside the app decides, so an order push opens the order screen, a booking
 * push the booking, and anything the app should not claim opens the website.
 * A payload with no link opens the app where it is.
 */
export function destinationForPush(
	data: PushTapData,
	configuration: Pick<TenantConfiguration, 'siteAddress'>,
	platform: 'ios' | 'android',
): PushTapDestination {
	if (!data.url) return { kind: 'none' }
	const resolved = resolveIncomingLink(data.url, configuration, platform)
	const target = routerTarget(resolved)
	if (target) return { kind: 'screen', ...target }
	if (resolved.kind === 'web' && resolved.reason !== 'invalid') {
		return { kind: 'web', url: resolved.url }
	}
	return { kind: 'none' }
}

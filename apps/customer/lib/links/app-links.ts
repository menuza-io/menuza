import { resolveLink, type ResolvedLink } from '@repo/common/links'

/** Opens the website in an in-app browser only when it is this restaurant's host. */
export function shouldOpenResolvedWebInBrowser(
	resolved: ResolvedLink,
): resolved is Extract<ResolvedLink, { kind: 'web' }> {
	return (
		resolved.kind === 'web' &&
		(resolved.reason === 'not_in_app' ||
			resolved.reason === 'not_this_platform' ||
			resolved.reason === 'app_too_old')
	)
}
import { type TenantConfiguration } from '../config/configuration'

/**
 * Reads an address the app was opened with (#195). The registry
 * (`@repo/common/links`) decides: only this app's own restaurant host opens a
 * screen, a link to anything else (another organization, a type this version
 * does not know, a web-only type like the cart) opens the website instead.
 * The shared (un-branded) app is bound to no host and so claims nothing here.
 *
 * Capability tokens ride in the fragment: they are returned in `fragment`, for
 * the screen to use in memory, and are never logged, stored or put in a route.
 */
export function resolveIncomingLink(
	url: string,
	configuration: Pick<TenantConfiguration, 'siteAddress'>,
	platform: 'ios' | 'android',
): ResolvedLink {
	return resolveLink(url, {
		appHost:
			configuration.siteAddress.host ??
			hostOf(configuration.siteAddress.origin),
		platform,
	})
}

function hostOf(origin: string | null): string | null {
	if (!origin) return null
	try {
		return new URL(origin).host
	} catch {
		return null
	}
}

/** The expo-router destination of a resolved link, or null to open the website. */
export function routerTarget(
	resolved: ResolvedLink,
): { pathname: string; params: Record<string, string> } | null {
	if (resolved.kind !== 'app') return null
	const tab = TAB_ROUTES[resolved.route]
	const path = tab ?? resolved.route
	return {
		pathname: path,
		params: {
			...resolved.query,
			// A capability token travels as a screen parameter in memory only.
			...(resolved.fragment.link ? { link: resolved.fragment.link } : {}),
		},
	}
}

/** Registry app routes that live in the tab bar. */
const TAB_ROUTES: Record<string, string> = {
	'/menu': '/menu',
	'/reservations': '/reservations',
	'/reservations/waitlist': '/reservations/waitlist',
	'/rewards': '/rewards',
	'/gift-cards': '/gift-cards',
}

import Constants from 'expo-constants'
import * as WebBrowser from 'expo-web-browser'
import { Platform } from 'react-native'
import { configurationFromBuild } from '../lib/config/configuration'
import { resolveIncomingLink, routerTarget } from '../lib/links/app-links'

/**
 * Routes a link the app was opened with (#195) before expo-router sees it:
 * the shared link registry decides, so an order link opens the order screen,
 * a booking link the booking, and a link the app should not claim opens the
 * website's page in the browser. Capability tokens stay in memory (the order
 * screen reads them from its parameters) and are never logged.
 */
export function redirectSystemPath({
	path,
}: {
	path: string
	initial: boolean
}) {
	try {
		const configuration = configurationFromBuild(
			Constants.expoConfig?.extra?.customer,
			{ platform: Platform.OS },
		)
		const platform = Platform.OS === 'android' ? 'android' : 'ios'
		const resolved = resolveIncomingLink(path, configuration, platform)
		const target = routerTarget(resolved)
		if (!target) {
			// Not ours to open as a screen: the same address on the website.
			if (resolved.kind === 'web' && resolved.reason !== 'invalid') {
				void WebBrowser.openBrowserAsync(resolved.url)
			}
			return '/'
		}
		const query = new URLSearchParams(target.params).toString()
		return query ? `${target.pathname}?${query}` : target.pathname
	} catch {
		return '/'
	}
}

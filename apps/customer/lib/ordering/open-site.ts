import * as WebBrowser from 'expo-web-browser'

/** The parameter that tells the website it is open inside the app (#196). */
export const IN_APP_PARAM = 'inapp'

/**
 * Marks an address as opened from the app, so the website never invites an
 * app user to get the app. The marker rides in the query (kept for the whole
 * session by the site); a fragment, if any, is left alone.
 */
export function withInAppMarker(url: string): string {
	try {
		const parsed = new URL(url)
		parsed.searchParams.set(IN_APP_PARAM, '1')
		return parsed.toString()
	} catch {
		return url
	}
}

/** Opens a public site page in the in-app browser, where checkout already runs. */
export function openWebsitePage(url: string): void {
	void WebBrowser.openBrowserAsync(withInAppMarker(url))
}

import * as WebBrowser from 'expo-web-browser'

/** Opens a public site page in the in-app browser, where checkout already runs. */
export function openWebsitePage(url: string): void {
	void WebBrowser.openBrowserAsync(url)
}

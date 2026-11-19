const KEY = /^[A-Za-z0-9-]{8,128}$/

/** The key file body when `requested` is the site's IndexNow key, else null. */
export function indexNowKeyFile(
	siteKey: string | null | undefined,
	requested: string | undefined,
): string | null {
	if (!siteKey || !KEY.test(siteKey) || requested !== siteKey) return null
	return siteKey
}

/** Only http(s) URLs or same-site paths; blocks `javascript:` and similar. */
export function isSafeAnnouncementLink(value: string) {
	// Browsers strip tab/CR/LF from URLs, so `/\t/evil.com` would become `//evil.com`.
	if (/[\u0000-\u001f\u007f]/.test(value)) return false
	if (/^\/(?![/\\])/.test(value)) return true
	try {
		const { protocol } = new URL(value)
		return protocol === 'http:' || protocol === 'https:'
	} catch {
		return false
	}
}

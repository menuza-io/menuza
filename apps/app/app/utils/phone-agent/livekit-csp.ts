const PAIRED_PROTOCOL: Record<string, string> = {
	'wss:': 'https:',
	'https:': 'wss:',
	'ws:': 'http:',
	'http:': 'ws:',
}

/**
 * `connect-src` entries for browser test calls. The LiveKit client opens the
 * signal WebSocket on the configured URL and also makes HTTP requests (region
 * lookup, connection checks) to the same host, so both schemes are allowed.
 */
export function liveKitConnectSrc(liveKitUrl: string | undefined) {
	if (!liveKitUrl) return []
	let url: URL
	try {
		url = new URL(liveKitUrl)
	} catch {
		return []
	}
	const paired = PAIRED_PROTOCOL[url.protocol]
	if (!paired) return []
	return [`${url.protocol}//${url.host}`, `${paired}//${url.host}`]
}

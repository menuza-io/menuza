/**
 * The pairing link a tablet opens. The code rides in the URL *fragment*
 * (`#r=us&c=...`), which browsers never send to any server: the kiosk page
 * reads it, calls the regional API directly, and removes it from the address
 * bar. So neither this app's servers nor their logs ever see the code.
 */
export const KIOSK_PAIR_PATH = '/kiosk/pair'

export function buildKioskPairingUrl(origin: string, fragment: string): string {
	const clean = origin.replace(/\/+$/, '')
	const hash = fragment.startsWith('#') ? fragment : `#${fragment}`
	return `${clean}${KIOSK_PAIR_PATH}${hash}`
}

export type ParsedPairingFragment = { region: 'us' | 'ksa'; code: string }

/** Reads `#r=<region>&c=<code>`; anything malformed is `null`. */
export function parsePairingFragment(
	hash: string,
): ParsedPairingFragment | null {
	const params = new URLSearchParams(hash.replace(/^#/, ''))
	const region = params.get('r')
	const code = params.get('c')
	if ((region !== 'us' && region !== 'ksa') || !code) return null
	if (code.length < 20 || code.length > 160) return null
	return { region, code }
}

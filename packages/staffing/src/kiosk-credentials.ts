/**
 * Formats of the two opaque kiosk credentials. Both carry the organization id
 * as a plain prefix so the regional router can pick the right database before
 * anything is verified; neither carries anything a client could abuse (the
 * random part is the only secret and is stored only as a keyed hash).
 *
 *   pairing code  `kpc1.<orgId>.<random>`            one time, 10 minutes
 *   device secret `kdv1.<orgId>.<deviceId>.<random>` bound to one scope
 *
 * Organization ids match `[A-Za-z0-9_-]+` and base64url never contains a dot,
 * so `.` is an unambiguous separator.
 */
export const KIOSK_PAIRING_CODE_PREFIX = 'kpc1'
export const KIOSK_DEVICE_SECRET_PREFIX = 'kdv1'
export const KIOSK_PAIRING_CODE_TTL_MS = 10 * 60 * 1000
/** Random bytes in each credential (256 bits). */
export const KIOSK_RANDOM_BYTES = 32

const ORG_ID = '[A-Za-z0-9_-]{1,64}'
const RANDOM_PART = '[A-Za-z0-9_-]{43}'
const DEVICE_ID = '[A-Za-z0-9_-]{8,64}'

const PAIRING_CODE_PATTERN = new RegExp(
	`^${KIOSK_PAIRING_CODE_PREFIX}\\.(${ORG_ID})\\.(${RANDOM_PART})$`,
)
const DEVICE_SECRET_PATTERN = new RegExp(
	`^${KIOSK_DEVICE_SECRET_PREFIX}\\.(${ORG_ID})\\.(${DEVICE_ID})\\.(${RANDOM_PART})$`,
)

/** URL-safe random token from Web Crypto (no padding). */
export function randomKioskToken(byteLength = KIOSK_RANDOM_BYTES): string {
	const bytes = new Uint8Array(byteLength)
	crypto.getRandomValues(bytes)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function formatKioskPairingCode(orgId: string, random: string): string {
	const code = `${KIOSK_PAIRING_CODE_PREFIX}.${orgId}.${random}`
	if (!PAIRING_CODE_PATTERN.test(code)) {
		throw new Error('Invalid pairing code parts')
	}
	return code
}

export function formatKioskDeviceSecret(
	orgId: string,
	deviceId: string,
	random: string,
): string {
	const secret = `${KIOSK_DEVICE_SECRET_PREFIX}.${orgId}.${deviceId}.${random}`
	if (!DEVICE_SECRET_PATTERN.test(secret)) {
		throw new Error('Invalid device secret parts')
	}
	return secret
}

export function parseKioskPairingCode(
	value: unknown,
): { orgId: string; random: string } | null {
	if (typeof value !== 'string' || value.length > 160) return null
	const match = PAIRING_CODE_PATTERN.exec(value)
	return match ? { orgId: match[1]!, random: match[2]! } : null
}

export function parseKioskDeviceSecret(
	value: unknown,
): { orgId: string; deviceId: string; random: string } | null {
	if (typeof value !== 'string' || value.length > 200) return null
	const match = DEVICE_SECRET_PATTERN.exec(value)
	return match
		? { orgId: match[1]!, deviceId: match[2]!, random: match[3]! }
		: null
}

/** The message fed to HMAC for a stored credential hash. */
export function kioskSecretHashMessage(secret: string): string {
	return `kiosk-device:${secret}`
}

export function kioskPairingCodeHashMessage(code: string): string {
	return `kiosk-pair:${code}`
}

/** The fragment the pairing QR carries; it never reaches a server. */
export function kioskPairingFragment(region: 'us' | 'ksa', code: string) {
	return `#r=${region}&c=${encodeURIComponent(code)}`
}

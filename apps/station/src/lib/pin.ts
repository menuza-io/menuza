/**
 * Local PIN verification, for signing in with no connection.
 *
 * What this is and is not. After a person signs in online, the till remembers a
 * slow salted hash of their PIN (never the PIN) so they can sign in again when the
 * network is down. A 4 to 6 digit PIN has few possibilities, so anyone who can
 * read this device's storage could try them all offline: the hash slows that, it
 * does not stop it. That is accepted because the PIN is for knowing who rang an
 * order and for keeping casual hands off an unattended till, not a security
 * boundary (the device secret already allows sending orders). Remembered people
 * expire, and an online check always has the last word.
 */

const ITERATIONS = 150_000
const SALT_KEY = 'pin-salt'

export const PIN_PATTERN = /^\d{4,6}$/

const toB64 = (bytes: ArrayBuffer): string => {
	let binary = ''
	for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b)
	return btoa(binary)
}

/** A random salt for this device, made once. Per device, so one derivation per attempt covers everyone. */
export function newSalt(): string {
	return toB64(crypto.getRandomValues(new Uint8Array(16)).buffer)
}

/** PBKDF2-SHA256 of the PIN with this device's salt, as base64. Deterministic for a given salt. */
export async function derivePinKey(pin: string, salt: string): Promise<string> {
	const material = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(pin),
		'PBKDF2',
		false,
		['deriveBits'],
	)
	const bits = await crypto.subtle.deriveBits(
		{
			name: 'PBKDF2',
			hash: 'SHA-256',
			iterations: ITERATIONS,
			salt: Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)),
		},
		material,
		256,
	)
	return toB64(bits)
}

export { SALT_KEY }

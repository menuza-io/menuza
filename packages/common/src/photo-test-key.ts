/**
 * The beacon key of a dish photo test (#192). The public counter beacon is open
 * to any browser, so the region counts an event only when it carries the key
 * the App signed for that exact (organization, test, dish): HMAC-SHA-256 over
 * those ids with a secret the App and the region share
 * (`TENANT_OPERATOR_TOKEN`). The key is public (it rides in the menu payload);
 * it only proves the test exists, so invented test ids count nothing.
 */

const encoder = new TextEncoder()

async function hmac(secret: string, message: string): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	return new Uint8Array(
		await crypto.subtle.sign('HMAC', key, encoder.encode(message)),
	)
}

function base64Url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/g, '')
}

export const PHOTO_TEST_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/

export async function photoTestBeaconKey(
	secret: string,
	input: { organizationId: string; testId: string; itemId: string },
): Promise<string> {
	const digest = await hmac(
		secret,
		`photo-test:v1:${input.organizationId}:${input.testId}:${input.itemId}`,
	)
	return base64Url(digest).slice(0, 32)
}

/** Constant-time check of a beacon key. */
export async function verifyPhotoTestBeaconKey(
	secret: string,
	input: { organizationId: string; testId: string; itemId: string },
	key: string,
): Promise<boolean> {
	if (!PHOTO_TEST_KEY_PATTERN.test(key)) return false
	const expected = await photoTestBeaconKey(secret, input)
	if (expected.length !== key.length) return false
	let diff = 0
	for (let index = 0; index < expected.length; index += 1) {
		diff |= expected.charCodeAt(index) ^ key.charCodeAt(index)
	}
	return diff === 0
}

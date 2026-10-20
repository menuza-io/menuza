const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

function randomString(alphabet: string, length: number) {
	const bytes = new Uint8Array(length)
	crypto.getRandomValues(bytes)
	let out = ''
	for (const byte of bytes) out += alphabet[byte % alphabet.length]
	return out
}

/** Stripe-shaped id: prefix plus 24 alphanumerics (`pi_3Ab...`). */
export function stripeId(prefix: string, length = 24) {
	return `${prefix}${randomString(BASE62, length)}`
}

/** Checkout.com-shaped id: prefix plus 26 lowercase base32 characters. */
export function checkoutId(prefix: string) {
	return `${prefix}${randomString(BASE32, 26)}`
}

export function randomToken(length = 32) {
	return randomString(BASE62, length)
}

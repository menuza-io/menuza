/** Small helpers shared by both emulators. No provider knowledge. */

export type Json = Record<string, any>

export function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

export async function sha256Hex(value: string) {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(value),
	)
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

export async function hmacSha256Hex(secret: string, payload: string) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(payload),
	)
	return [...new Uint8Array(signature)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('')
}

/** Stable stringify so equal parameter sets hash equally. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Json)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		return `{${entries
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
			.join(',')}}`
	}
	return JSON.stringify(value)
}

/** Luhn check; digits only. */
export function passesLuhn(digits: string) {
	if (!/^\d{12,19}$/.test(digits)) return false
	let sum = 0
	let double = false
	for (let index = digits.length - 1; index >= 0; index--) {
		let value = Number(digits[index])
		if (double) {
			value *= 2
			if (value > 9) value -= 9
		}
		sum += value
		double = !double
	}
	return sum % 10 === 0
}

export function digitsOnly(value: string | undefined | null) {
	return (value ?? '').replace(/\D/g, '')
}

/**
 * Parse an `application/x-www-form-urlencoded` body the way Stripe does:
 * `a[b]=1`, `a[]=x`, `a[0][b]=y`. Values stay strings.
 */
export function parseFormBody(input: string): Json {
	const root: Json = {}
	for (const [rawKey, value] of new URLSearchParams(input)) {
		const segments = [...rawKey.matchAll(/([^[\]]+)|\[(\d*)\]/g)].map(
			(match) => (match[1] !== undefined ? match[1] : (match[2] ?? '')),
		)
		if (segments.length === 0) continue
		let node: Json = root
		segments.forEach((rawSegment, index) => {
			// `a[]` appends: use the next free numeric key.
			const segment =
				rawSegment === '' ? String(Object.keys(node).length) : rawSegment
			if (index === segments.length - 1) {
				node[segment] = value
				return
			}
			if (!isRecord(node[segment])) node[segment] = {}
			node = node[segment]
		})
	}
	return normalizeLists(root)
}

function normalizeLists(value: any): any {
	if (Array.isArray(value)) return value.map(normalizeLists)
	if (value && typeof value === 'object') {
		const keys = Object.keys(value)
		if (keys.length > 0 && keys.every((key) => /^\d+$/.test(key))) {
			return keys
				.sort((a, b) => Number(a) - Number(b))
				.map((key) => normalizeLists(value[key]))
		}
		for (const key of keys) value[key] = normalizeLists(value[key])
	}
	return value
}

export function jsonResponse(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	})
}

export function cents(value: unknown) {
	return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/** `true` when `value` is an own, non-null, non-array object. */
export function isRecord(value: unknown): value is Json {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

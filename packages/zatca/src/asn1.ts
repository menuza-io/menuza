/**
 * The small part of ASN.1 DER this package needs: enough to write a PKCS#10
 * certificate request and an ECDSA signature, and to read the fields ZATCA's
 * signature needs out of an X.509 certificate.
 */

export type Der = Uint8Array

const concat = (...parts: Uint8Array[]): Uint8Array => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
	let offset = 0
	for (const p of parts) {
		out.set(p, offset)
		offset += p.length
	}
	return out
}

function encodeLength(length: number): Uint8Array {
	if (length < 0x80) return Uint8Array.of(length)
	const bytes: number[] = []
	for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff)
	return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

export const tlv = (tag: number, value: Uint8Array): Der =>
	concat(Uint8Array.of(tag), encodeLength(value.length), value)

export const sequence = (...items: Der[]): Der => tlv(0x30, concat(...items))
export const set = (...items: Der[]): Der => tlv(0x31, concat(...items))
export const octetString = (value: Uint8Array): Der => tlv(0x04, value)
export const bitString = (value: Uint8Array): Der =>
	tlv(0x03, concat(Uint8Array.of(0), value))
export const utf8String = (value: string): Der =>
	tlv(0x0c, new TextEncoder().encode(value))
export const printableString = (value: string): Der =>
	tlv(0x13, new TextEncoder().encode(value))
/** Context-specific, constructed (`[n]` around one or more elements). */
export const context = (n: number, ...items: Der[]): Der =>
	tlv(0xa0 | n, concat(...items))

/** A non-negative INTEGER from big-endian bytes (leading zeros dropped, sign byte added when needed). */
export function unsignedInteger(bytes: Uint8Array): Der {
	let start = 0
	while (start < bytes.length - 1 && bytes[start] === 0) start++
	const trimmed = bytes.slice(start)
	return tlv(
		0x02,
		trimmed[0]! & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed,
	)
}

export const smallInteger = (n: number): Der =>
	unsignedInteger(Uint8Array.of(n))

export function oid(dotted: string): Der {
	const parts = dotted.split('.').map((p) => BigInt(p))
	const bytes: number[] = [Number(parts[0]! * 40n + parts[1]!)]
	for (const part of parts.slice(2)) {
		const chunk: number[] = []
		let n = part
		do {
			chunk.unshift(Number(n & 0x7fn))
			n >>= 7n
		} while (n > 0n)
		for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80
		bytes.push(...chunk)
	}
	return tlv(0x06, Uint8Array.from(bytes))
}

/** DER `SEQUENCE { r INTEGER, s INTEGER }` from a 64-byte compact ECDSA signature. */
export const ecdsaDerSignature = (compact: Uint8Array): Der =>
	sequence(
		unsignedInteger(compact.slice(0, 32)),
		unsignedInteger(compact.slice(32, 64)),
	)

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type Node = {
	tag: number
	/** The whole element, header included. */
	raw: Uint8Array
	value: Uint8Array
	children: Node[]
}

export function parse(bytes: Uint8Array, offset = 0): Node {
	const tag = bytes[offset]!
	let length = bytes[offset + 1]!
	let header = 2
	if (length & 0x80) {
		const count = length & 0x7f
		length = 0
		for (let i = 0; i < count; i++)
			length = length * 256 + bytes[offset + 2 + i]!
		header += count
	}
	const value = bytes.slice(offset + header, offset + header + length)
	const raw = bytes.slice(offset, offset + header + length)
	const constructed = (tag & 0x20) !== 0
	const children: Node[] = []
	if (constructed) {
		for (let at = 0; at < value.length;) {
			const child = parse(value, at)
			children.push(child)
			at += child.raw.length
		}
	}
	return { tag, raw, value, children }
}

export function readOid(node: Node): string {
	const bytes = node.value
	const parts: bigint[] = [
		BigInt(Math.floor(bytes[0]! / 40)),
		BigInt(bytes[0]! % 40),
	]
	let n = 0n
	for (const byte of bytes.slice(1)) {
		n = (n << 7n) | BigInt(byte & 0x7f)
		if ((byte & 0x80) === 0) {
			parts.push(n)
			n = 0n
		}
	}
	return parts.join('.')
}

/** An INTEGER as a decimal string (certificate serial numbers can be very large). */
export function readIntegerDecimal(node: Node): string {
	let n = 0n
	for (const byte of node.value) n = (n << 8n) | BigInt(byte)
	return n.toString(10)
}

export { concat }

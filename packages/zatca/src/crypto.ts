import { hmac } from '@noble/hashes/hmac'
import { sha256 } from '@noble/hashes/sha2'
import * as secp from '@noble/secp256k1'
import {
	bitString,
	ecdsaDerSignature,
	oid,
	parse,
	sequence,
	type Der,
} from './asn1.ts'

// Synchronous signing: the till signs inside an IndexedDB transaction, which
// closes if it awaits anything else.
// (@noble/hashes 1.x types predate the ArrayBuffer-only byte arrays 3.x asks for.)
secp.hashes.sha256 = sha256 as unknown as typeof secp.hashes.sha256
secp.hashes.hmacSha256 = ((key: Uint8Array, message: Uint8Array) =>
	hmac(sha256, key, message)) as unknown as typeof secp.hashes.hmacSha256

export const OID_EC_PUBLIC_KEY = '1.2.840.10045.2.1'
export const OID_SECP256K1 = '1.3.132.0.10'
export const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2'

export const utf8 = (text: string) => new TextEncoder().encode(text)
export const sha256Bytes = (data: Uint8Array | string) =>
	sha256(typeof data === 'string' ? utf8(data) : data)

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) throw new Error('Not hex')
	return Uint8Array.from(hex.match(/../g) ?? [], (pair) =>
		Number.parseInt(pair, 16),
	)
}

export function toBase64(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
}

export const fromBase64 = (text: string): Uint8Array =>
	Uint8Array.from(atob(text), (c) => c.charCodeAt(0))

/** An EGS unit's signing key: secp256k1, as ZATCA requires. */
export function generatePrivateKey(): Uint8Array {
	return secp.utils.randomSecretKey()
}

export const publicKeyOf = (privateKey: Uint8Array) =>
	secp.getPublicKey(privateKey, false)

/** SubjectPublicKeyInfo (DER) for a secp256k1 public key. */
export const subjectPublicKeyInfo = (publicKey: Uint8Array): Der =>
	sequence(
		sequence(oid(OID_EC_PUBLIC_KEY), oid(OID_SECP256K1)),
		bitString(publicKey),
	)

/** ECDSA-SHA256 over `message`, DER encoded (what X.509, PKCS#10 and ZATCA expect). */
export function signDer(
	message: Uint8Array,
	privateKey: Uint8Array,
): Uint8Array {
	const compact = secp.sign(message, privateKey, { prehash: true, lowS: true })
	return ecdsaDerSignature(compact)
}

/** Verifies a DER ECDSA-SHA256 signature (for tests and self-checks). */
export function verifyDer(
	signatureDer: Uint8Array,
	message: Uint8Array,
	publicKey: Uint8Array,
): boolean {
	const [r, sValue] = parse(signatureDer).children
	const fixed = (n: Uint8Array) => {
		const trimmed = n[0] === 0 ? n.slice(1) : n
		const out = new Uint8Array(32)
		out.set(trimmed, 32 - trimmed.length)
		return out
	}
	const compact = new Uint8Array(64)
	compact.set(fixed(r!.value), 0)
	compact.set(fixed(sValue!.value), 32)
	return secp.verify(compact, message, publicKey, {
		prehash: true,
		lowS: false,
	})
}

/** PEM armour around DER. */
export function pem(label: string, der: Uint8Array): string {
	const body = toBase64(der)
		.replace(/(.{64})/g, '$1\n')
		.trimEnd()
	return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

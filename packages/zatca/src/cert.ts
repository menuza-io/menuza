import { parse, readIntegerDecimal, readOid, type Node } from './asn1.ts'
import { fromBase64, sha256Bytes, toBase64, toHex } from './crypto.ts'

/**
 * What the signature and the Phase 2 QR code need from the CSID certificate
 * ZATCA issues (`binarySecurityToken`, which is the base64 DER, base64 encoded
 * once more).
 */
export type ZatcaCertificate = {
	/** Base64 DER, as written into `ds:X509Certificate`. */
	base64: string
	/** `CN=..., DC=...` in RFC 2253 order (most specific first). */
	issuerName: string
	/** Serial number in decimal. */
	serialNumber: string
	/** SubjectPublicKeyInfo DER (QR tag 8). */
	publicKey: Uint8Array
	/** The issuing CA's signature over the certificate (QR tag 9). */
	signature: Uint8Array
}

const ATTRIBUTE_NAMES: Record<string, string> = {
	'2.5.4.3': 'CN',
	'2.5.4.6': 'C',
	'2.5.4.7': 'L',
	'2.5.4.8': 'ST',
	'2.5.4.10': 'O',
	'2.5.4.11': 'OU',
	'0.9.2342.19200300.100.1.25': 'DC',
	'0.9.2342.19200300.100.1.1': 'UID',
}

function nameToString(name: Node): string {
	const parts = name.children.flatMap((rdn) =>
		rdn.children.map((pair) => {
			const [type, value] = pair.children
			const key = ATTRIBUTE_NAMES[readOid(type!)] ?? readOid(type!)
			return `${key}=${new TextDecoder().decode(value!.value)}`
		}),
	)
	return parts.reverse().join(', ')
}

/** Reads a certificate from ZATCA's `binarySecurityToken` or from plain base64 DER. */
export function readCertificate(token: string): ZatcaCertificate {
	const trimmed = token.trim()
	// A token is the base64 of the base64 DER; base64 DER of a certificate starts with "MII".
	const base64 = trimmed.startsWith('MII')
		? trimmed
		: new TextDecoder().decode(fromBase64(trimmed)).trim()
	const certificate = parse(fromBase64(base64))
	const [tbs, , signatureValue] = certificate.children
	const fields = tbs!.children
	// An explicit [0] version comes first in v3 certificates.
	const at = fields[0]!.tag === 0xa0 ? 1 : 0
	return {
		base64,
		serialNumber: readIntegerDecimal(fields[at]!),
		issuerName: nameToString(fields[at + 2]!),
		publicKey: fields[at + 5]!.raw,
		signature: signatureValue!.value.slice(1),
	}
}

/**
 * The certificate digest ZATCA's XAdES profile uses: SHA-256 of the base64
 * certificate text, hex encoded, then base64 encoded.
 */
export const certificateDigest = (certificate: ZatcaCertificate) =>
	toBase64(new TextEncoder().encode(toHex(sha256Bytes(certificate.base64))))

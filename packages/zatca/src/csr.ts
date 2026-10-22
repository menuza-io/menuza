import {
	bitString,
	context,
	octetString,
	oid,
	printableString,
	sequence,
	set,
	smallInteger,
	utf8String,
	type Der,
} from './asn1.ts'
import {
	OID_ECDSA_SHA256,
	pem,
	publicKeyOf,
	signDer,
	subjectPublicKeyInfo,
	toBase64,
} from './crypto.ts'

/**
 * The certificate signing request an EGS unit sends to ZATCA to get its
 * compliance CSID. Shape fixed by ZATCA's "EGS onboarding" guidelines (the
 * openssl config they publish): subject C/OU/O/CN, the Microsoft certificate
 * template extension naming the environment, and a subjectAltName directory
 * name carrying the unit's serial, the VAT number, the invoice types it issues,
 * its address and business category.
 */

export const ZATCA_ENVIRONMENTS = [
	'sandbox',
	'simulation',
	'production',
] as const
export type ZatcaEnvironment = (typeof ZATCA_ENVIRONMENTS)[number]

/** The certificate template name ZATCA expects in the CSR, per environment. */
export const TEMPLATE_NAME: Record<ZatcaEnvironment, string> = {
	sandbox: 'TSTZATCA-Code-Signing',
	simulation: 'PREZATCA-Code-Signing',
	production: 'ZATCA-Code-Signing',
}

export type CsrInput = {
	environment: ZatcaEnvironment
	/** Seller's legal name (O). */
	organizationName: string
	/** Branch or unit name (OU); for a VAT group, the member's TIN. */
	organizationUnit: string
	/** A name for this EGS unit (CN). */
	commonName: string
	/** `1-<solution name>|2-<model or version>|3-<serial>`. */
	serialNumber: string
	/** 15-digit VAT registration number (UID). */
	vatNumber: string
	/** Invoice types issued: four digits, standard then simplified (`0100` = simplified only). */
	invoiceTypes: string
	/** Short national address of the branch (registeredAddress). */
	address: string
	/** Industry or sector (businessCategory). */
	businessCategory: string
}

const attribute = (attributeOid: string, value: Der) =>
	set(sequence(oid(attributeOid), value))

/** A Name: one attribute per relative distinguished name, in order. */
const name = (...rdns: Array<[string, Der]>) =>
	sequence(...rdns.map(([o, v]) => attribute(o, v)))

export function buildCsr(
	input: CsrInput,
	privateKey: Uint8Array,
): { der: Uint8Array; pem: string; base64Pem: string } {
	const subject = name(
		['2.5.4.6', printableString('SA')],
		['2.5.4.11', utf8String(input.organizationUnit)],
		['2.5.4.10', utf8String(input.organizationName)],
		['2.5.4.3', utf8String(input.commonName)],
	)
	const directoryName = name(
		['2.5.4.4', utf8String(input.serialNumber)], // SN
		['0.9.2342.19200300.100.1.1', utf8String(input.vatNumber)], // UID
		['2.5.4.12', utf8String(input.invoiceTypes)], // title
		['2.5.4.26', utf8String(input.address)], // registeredAddress
		['2.5.4.15', utf8String(input.businessCategory)], // businessCategory
	)
	const extensions = sequence(
		// Microsoft certificate template name: ASN1:PRINTABLESTRING:<template>.
		sequence(
			oid('1.3.6.1.4.1.311.20.2'),
			octetString(printableString(TEMPLATE_NAME[input.environment])),
		),
		// subjectAltName = dirName:alt_names ([4] directoryName, explicit).
		sequence(
			oid('2.5.29.17'),
			octetString(sequence(context(4, directoryName))),
		),
	)
	const extensionRequest = sequence(
		oid('1.2.840.113549.1.9.14'),
		set(extensions),
	)
	const info = sequence(
		smallInteger(0),
		subject,
		subjectPublicKeyInfo(publicKeyOf(privateKey)),
		context(0, extensionRequest),
	)
	const der = sequence(
		info,
		sequence(oid(OID_ECDSA_SHA256)),
		bitString(signDer(info, privateKey)),
	)
	const text = pem('CERTIFICATE REQUEST', der)
	// The Fatoora API takes the PEM text, base64 encoded once more.
	return { der, pem: text, base64Pem: toBase64(new TextEncoder().encode(text)) }
}

import { certificateDigest, type ZatcaCertificate } from './cert.ts'
import {
	fromBase64,
	sha256Bytes,
	signDer,
	toBase64,
	toHex,
	utf8,
} from './crypto.ts'

/**
 * UBL 2.1 simplified tax invoices, credit notes and debit notes as ZATCA's
 * Phase 2 (integration) profile wants them, signed with the EGS unit's key.
 *
 * The XML is written in canonical form from the start (C14N 1.1: no XML
 * declaration in the hashed form, no insignificant whitespace, attributes in
 * order, explicit end tags, minimal escaping). The invoice hash is SHA-256 of
 * the document without `ext:UBLExtensions`, `cac:Signature` and the QR
 * reference, which is exactly what ZATCA's transforms remove before
 * canonicalizing, so it can be computed from the same builder without an XML
 * parser.
 */

export type ZatcaSeller = {
	/** Legal name (cac:PartyLegalEntity/RegistrationName, QR tag 1). */
	name: string
	/** 15-digit VAT registration number (starts and ends with 3). */
	vatNumber: string
	/** Commercial registration number (PartyIdentification schemeID="CRN"). */
	crNumber: string
	street: string
	/** Four digits. */
	buildingNumber: string
	/** District (CitySubdivisionName). */
	district: string
	city: string
	/** Five digits. */
	postalCode: string
}

export const ZATCA_DOCUMENT_KINDS = [
	'invoice',
	'credit_note',
	'debit_note',
] as const
export type ZatcaDocumentKind = (typeof ZATCA_DOCUMENT_KINDS)[number]

const TYPE_CODE: Record<ZatcaDocumentKind, string> = {
	invoice: '388',
	credit_note: '381',
	debit_note: '383',
}
/** Simplified (B2C) document, no third party, nominal, export or summary flags. */
const SIMPLIFIED_SUBTYPE = '0200000'

export type ZatcaLine = {
	name: string
	quantity: number
	/** Net price of one unit, before VAT, in halalas. */
	unitNetCents: number
	/** `S` standard rate, `O` outside the scope of VAT (tips, donations). */
	category: 'S' | 'O'
}

export type ZatcaPaymentMeans = 'cash' | 'card' | 'other'
const PAYMENT_MEANS_CODE: Record<ZatcaPaymentMeans, string> = {
	cash: '10',
	card: '48',
	other: '1',
}

export type ZatcaDocumentInput = {
	kind: ZatcaDocumentKind
	/** Human document number (cbc:ID). */
	id: string
	uuid: string
	/** When it was issued (instant). */
	issuedAt: Date
	/** Invoice counter value: this document's number in the unit's chain. */
	counter: number
	/** Previous document's invoice hash (base64); the genesis value for the first. */
	previousHash: string
	currency: 'SAR'
	/** Standard VAT rate in percent, e.g. 15. */
	taxRatePercent: number
	lines: ZatcaLine[]
	/** Document-level discount on standard-rated amounts (net). */
	allowanceCents?: number
	/** Document-level discount on amounts outside the scope of VAT. */
	outOfScopeAllowanceCents?: number
	/** Document-level charge on standard-rated amounts (net). */
	chargeCents?: number
	/**
	 * What the buyer paid in total (VAT and tips included). The document's VAT
	 * is worked out from its own taxable amount (so ZATCA's arithmetic rules hold
	 * exactly); any halala between that and what was paid is the payable
	 * rounding amount.
	 */
	payableCents: number
	paymentMeans: ZatcaPaymentMeans[]
	/** The invoice a credit or debit note corrects (its cbc:ID and issue date). */
	billingReference?: { id: string; issueDate: string }
	/** Why a credit or debit note was issued. */
	reason?: string
	seller: ZatcaSeller
}

/** PIH of the first document: base64 of the hex SHA-256 of "0", as ZATCA specifies. */
export const ZATCA_GENESIS_PIH = toBase64(utf8(toHex(sha256Bytes('0'))))

const NS = {
	ubl: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
	cac: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
	cbc: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
	ext: 'urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2',
	sig: 'urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2',
	sac: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2',
	sbc: 'urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2',
	ds: 'http://www.w3.org/2000/09/xmldsig#',
	xades: 'http://uri.etsi.org/01903/v1.3.2#',
}

// ---------------------------------------------------------------------------
// Canonical XML writing
// ---------------------------------------------------------------------------

const escapeText = (text: string) =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/\r/g, '&#xD;')
const escapeAttribute = (text: string) =>
	text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/"/g, '&quot;')
		.replace(/\t/g, '&#x9;')
		.replace(/\n/g, '&#xA;')
		.replace(/\r/g, '&#xD;')

/** An element; attributes are written in sorted order, as C14N does. */
function el(
	name: string,
	attributes: Record<string, string> | null,
	...children: string[]
): string {
	const attrs = attributes
		? Object.keys(attributes)
				.sort(compareAttributes)
				.map((key) => ` ${key}="${escapeAttribute(attributes[key]!)}"`)
				.join('')
		: ''
	return `<${name}${attrs}>${children.join('')}</${name}>`
}
const text = (
	name: string,
	value: string,
	attributes: Record<string, string> | null = null,
) => el(name, attributes, escapeText(value))

/** Namespace declarations first (default, then by prefix), then other attributes by name. */
function compareAttributes(a: string, b: string): number {
	const rank = (k: string) =>
		k === 'xmlns' ? 0 : k.startsWith('xmlns:') ? 1 : 2
	return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0)
}

const amount = (cents: number) => {
	const sign = cents < 0 ? '-' : ''
	const abs = Math.abs(cents)
	return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
const money = (name: string, cents: number, currency: string) =>
	text(name, amount(cents), { currencyID: currency })
const percent = (rate: number) => rate.toFixed(2)

/** Saudi local date and time (UTC+3, no daylight saving). */
export function riyadhDateTime(at: Date): { date: string; time: string } {
	const local = new Date(at.getTime() + 3 * 60 * 60 * 1000).toISOString()
	return { date: local.slice(0, 10), time: local.slice(11, 19) }
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export type ZatcaFigures = {
	lineExtensionCents: number
	standardTaxableCents: number
	outOfScopeCents: number
	/** VAT on the standard-rated taxable amount (BR-S-09 / BR-CO-17). */
	taxCents: number
	standardAllowanceCents: number
	outOfScopeAllowanceCents: number
	allowanceTotalCents: number
	taxExclusiveCents: number
	taxInclusiveCents: number
	payableRoundingCents: number
	lines: Array<ZatcaLine & { netCents: number; taxCents: number }>
}

export function figures(input: ZatcaDocumentInput): ZatcaFigures {
	const rate = input.taxRatePercent
	const lines = input.lines.map((line) => {
		const netCents = line.unitNetCents * line.quantity
		return {
			...line,
			netCents,
			taxCents: line.category === 'S' ? Math.round((netCents * rate) / 100) : 0,
		}
	})
	const lineExtensionCents = lines.reduce((s, l) => s + l.netCents, 0)
	const standardLines = lines
		.filter((l) => l.category === 'S')
		.reduce((s, l) => s + l.netCents, 0)
	const outOfScopeLines = lines
		.filter((l) => l.category === 'O')
		.reduce((s, l) => s + l.netCents, 0)
	// A discount never takes a category below zero.
	const allowance = Math.min(input.allowanceCents ?? 0, standardLines)
	const outOfScopeAllowance = Math.min(
		input.outOfScopeAllowanceCents ?? 0,
		outOfScopeLines,
	)
	const charge = input.chargeCents ?? 0
	const standardTaxableCents = standardLines - allowance + charge
	const outOfScopeCents = outOfScopeLines - outOfScopeAllowance
	const taxCents = Math.round((standardTaxableCents * rate) / 100)
	const taxExclusiveCents =
		lineExtensionCents - allowance - outOfScopeAllowance + charge
	const taxInclusiveCents = taxExclusiveCents + taxCents
	return {
		lineExtensionCents,
		standardTaxableCents,
		outOfScopeCents,
		taxCents,
		standardAllowanceCents: allowance,
		outOfScopeAllowanceCents: outOfScopeAllowance,
		allowanceTotalCents: allowance + outOfScopeAllowance,
		taxExclusiveCents,
		taxInclusiveCents,
		payableRoundingCents: input.payableCents - taxInclusiveCents,
		lines,
	}
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

const TAX_SCHEME = el(
	'cac:TaxScheme',
	null,
	text('cbc:ID', 'VAT', { schemeAgencyID: '6', schemeID: 'UN/ECE 5153' }),
)
const OUT_OF_SCOPE_REASON = { code: 'VATEX-SA-OOS', text: 'Not subject to VAT' }

function taxCategory(category: 'S' | 'O', rate: number) {
	return el(
		'cac:TaxCategory',
		null,
		text('cbc:ID', category, { schemeAgencyID: '6', schemeID: 'UN/ECE 5305' }),
		text('cbc:Percent', percent(category === 'S' ? rate : 0)),
		...(category === 'O'
			? [
					text('cbc:TaxExemptionReasonCode', OUT_OF_SCOPE_REASON.code),
					text('cbc:TaxExemptionReason', OUT_OF_SCOPE_REASON.text),
				]
			: []),
		TAX_SCHEME,
	)
}

function seller(s: ZatcaSeller) {
	return el(
		'cac:AccountingSupplierParty',
		null,
		el(
			'cac:Party',
			null,
			el(
				'cac:PartyIdentification',
				null,
				text('cbc:ID', s.crNumber, { schemeID: 'CRN' }),
			),
			el(
				'cac:PostalAddress',
				null,
				text('cbc:StreetName', s.street),
				text('cbc:BuildingNumber', s.buildingNumber),
				text('cbc:CitySubdivisionName', s.district),
				text('cbc:CityName', s.city),
				text('cbc:PostalZone', s.postalCode),
				el('cac:Country', null, text('cbc:IdentificationCode', 'SA')),
			),
			el(
				'cac:PartyTaxScheme',
				null,
				text('cbc:CompanyID', s.vatNumber),
				el('cac:TaxScheme', null, text('cbc:ID', 'VAT')),
			),
			el('cac:PartyLegalEntity', null, text('cbc:RegistrationName', s.name)),
		),
	)
}

function attachment(id: string, base64: string) {
	return el(
		'cac:AdditionalDocumentReference',
		null,
		text('cbc:ID', id),
		el(
			'cac:Attachment',
			null,
			text('cbc:EmbeddedDocumentBinaryObject', base64, {
				mimeCode: 'text/plain',
			}),
		),
	)
}

const SIGNATURE_REFERENCE = el(
	'cac:Signature',
	null,
	text('cbc:ID', 'urn:oasis:names:specification:ubl:signature:Invoice'),
	text(
		'cbc:SignatureMethod',
		'urn:oasis:names:specification:ubl:dsig:enveloped:xades',
	),
)

/** The parts of the document, so the hashed form and the signed form share them. */
function parts(input: ZatcaDocumentInput) {
	const f = figures(input)
	const { date, time } = riyadhDateTime(input.issuedAt)
	const cur = input.currency
	const rate = input.taxRatePercent
	const head = [
		text('cbc:ProfileID', 'reporting:1.0'),
		text('cbc:ID', input.id),
		text('cbc:UUID', input.uuid),
		text('cbc:IssueDate', date),
		text('cbc:IssueTime', time),
		text('cbc:InvoiceTypeCode', TYPE_CODE[input.kind], {
			name: SIMPLIFIED_SUBTYPE,
		}),
		text('cbc:DocumentCurrencyCode', cur),
		text('cbc:TaxCurrencyCode', 'SAR'),
		...(input.billingReference
			? [
					el(
						'cac:BillingReference',
						null,
						el(
							'cac:InvoiceDocumentReference',
							null,
							text(
								'cbc:ID',
								`Invoice Number: ${input.billingReference.id}; Invoice Issue Date: ${input.billingReference.issueDate}`,
							),
						),
					),
				]
			: []),
		el(
			'cac:AdditionalDocumentReference',
			null,
			text('cbc:ID', 'ICV'),
			text('cbc:UUID', String(input.counter)),
		),
		attachment('PIH', input.previousHash),
	]
	const subtotals = [
		el(
			'cac:TaxSubtotal',
			null,
			money('cbc:TaxableAmount', f.standardTaxableCents, cur),
			money('cbc:TaxAmount', f.taxCents, cur),
			taxCategory('S', rate),
		),
		...(f.outOfScopeCents > 0
			? [
					el(
						'cac:TaxSubtotal',
						null,
						money('cbc:TaxableAmount', f.outOfScopeCents, cur),
						money('cbc:TaxAmount', 0, cur),
						taxCategory('O', rate),
					),
				]
			: []),
	]
	const allowanceOf = (category: 'S' | 'O', cents: number) =>
		el(
			'cac:AllowanceCharge',
			null,
			text('cbc:ChargeIndicator', 'false'),
			text('cbc:AllowanceChargeReason', 'Discount'),
			money('cbc:Amount', cents, cur),
			taxCategory(category, rate),
		)
	const documentLevel = [
		...(f.standardAllowanceCents > 0
			? [allowanceOf('S', f.standardAllowanceCents)]
			: []),
		...(f.outOfScopeAllowanceCents > 0
			? [allowanceOf('O', f.outOfScopeAllowanceCents)]
			: []),
		...((input.chargeCents ?? 0) > 0
			? [
					el(
						'cac:AllowanceCharge',
						null,
						text('cbc:ChargeIndicator', 'true'),
						text('cbc:AllowanceChargeReason', 'Adjustment'),
						money('cbc:Amount', input.chargeCents!, cur),
						taxCategory('S', rate),
					),
				]
			: []),
	]
	const tail = [
		seller(input.seller),
		el('cac:AccountingCustomerParty', null, el('cac:Party', null)),
		...(input.paymentMeans.length > 0
			? input.paymentMeans
			: (['cash'] as ZatcaPaymentMeans[])
		).map((means) =>
			el(
				'cac:PaymentMeans',
				null,
				text('cbc:PaymentMeansCode', PAYMENT_MEANS_CODE[means]),
				...(input.reason && input.kind !== 'invoice'
					? [text('cbc:InstructionNote', input.reason)]
					: []),
			),
		),
		...documentLevel,
		el('cac:TaxTotal', null, money('cbc:TaxAmount', f.taxCents, cur)),
		el(
			'cac:TaxTotal',
			null,
			money('cbc:TaxAmount', f.taxCents, cur),
			...subtotals,
		),
		el(
			'cac:LegalMonetaryTotal',
			null,
			money('cbc:LineExtensionAmount', f.lineExtensionCents, cur),
			money('cbc:TaxExclusiveAmount', f.taxExclusiveCents, cur),
			money('cbc:TaxInclusiveAmount', f.taxInclusiveCents, cur),
			money('cbc:AllowanceTotalAmount', f.allowanceTotalCents, cur),
			...((input.chargeCents ?? 0) > 0
				? [money('cbc:ChargeTotalAmount', input.chargeCents!, cur)]
				: []),
			money('cbc:PrepaidAmount', 0, cur),
			...(f.payableRoundingCents !== 0
				? [money('cbc:PayableRoundingAmount', f.payableRoundingCents, cur)]
				: []),
			money('cbc:PayableAmount', input.payableCents, cur),
		),
		...f.lines.map((line, index) =>
			el(
				'cac:InvoiceLine',
				null,
				text('cbc:ID', String(index + 1)),
				text('cbc:InvoicedQuantity', line.quantity.toFixed(6), {
					unitCode: 'PCE',
				}),
				money('cbc:LineExtensionAmount', line.netCents, cur),
				el(
					'cac:TaxTotal',
					null,
					money('cbc:TaxAmount', line.taxCents, cur),
					money('cbc:RoundingAmount', line.netCents + line.taxCents, cur),
				),
				el(
					'cac:Item',
					null,
					text('cbc:Name', line.name),
					el(
						'cac:ClassifiedTaxCategory',
						null,
						text('cbc:ID', line.category),
						text('cbc:Percent', percent(line.category === 'S' ? rate : 0)),
						...(line.category === 'O'
							? [
									text('cbc:TaxExemptionReasonCode', OUT_OF_SCOPE_REASON.code),
									text('cbc:TaxExemptionReason', OUT_OF_SCOPE_REASON.text),
								]
							: []),
						el('cac:TaxScheme', null, text('cbc:ID', 'VAT')),
					),
				),
				el('cac:Price', null, money('cbc:PriceAmount', line.unitNetCents, cur)),
			),
		),
	]
	return { head, tail, figures: f, date, time }
}

const ROOT_NAMESPACES = {
	xmlns: NS.ubl,
	'xmlns:cac': NS.cac,
	'xmlns:cbc': NS.cbc,
	'xmlns:ext': NS.ext,
}

/** The document as ZATCA hashes it: without the signature extension, the signature reference and the QR. */
export function hashedForm(input: ZatcaDocumentInput): string {
	const { head, tail } = parts(input)
	return el('Invoice', ROOT_NAMESPACES, ...head, ...tail)
}

/** The invoice hash (base64 of the raw SHA-256 digest), also the next document's PIH. */
export const invoiceHash = (input: ZatcaDocumentInput) =>
	toBase64(sha256Bytes(hashedForm(input)))

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

function signedProperties(certificate: ZatcaCertificate, signingTime: string) {
	return el(
		'xades:SignedProperties',
		{ Id: 'xadesSignedProperties', 'xmlns:xades': NS.xades },
		el(
			'xades:SignedSignatureProperties',
			null,
			text('xades:SigningTime', signingTime),
			el(
				'xades:SigningCertificate',
				null,
				el(
					'xades:Cert',
					null,
					el(
						'xades:CertDigest',
						null,
						el('ds:DigestMethod', {
							Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
							'xmlns:ds': NS.ds,
						}),
						text('ds:DigestValue', certificateDigest(certificate), {
							'xmlns:ds': NS.ds,
						}),
					),
					el(
						'xades:IssuerSerial',
						null,
						text('ds:X509IssuerName', certificate.issuerName, {
							'xmlns:ds': NS.ds,
						}),
						text('ds:X509SerialNumber', certificate.serialNumber, {
							'xmlns:ds': NS.ds,
						}),
					),
				),
			),
		),
	)
}

const TRANSFORM_XPATH = 'http://www.w3.org/TR/1999/REC-xpath-19991116'
const C14N11 = 'http://www.w3.org/2006/12/xml-c14n11'

function signatureExtension(input: {
	invoiceHash: string
	signedPropertiesHash: string
	signatureValue: string
	certificate: ZatcaCertificate
	signedPropertiesXml: string
}) {
	const xpath = (expression: string) =>
		el(
			'ds:Transform',
			{ Algorithm: TRANSFORM_XPATH },
			text('ds:XPath', expression),
		)
	const signedInfo = el(
		'ds:SignedInfo',
		null,
		el('ds:CanonicalizationMethod', { Algorithm: C14N11 }),
		el('ds:SignatureMethod', {
			Algorithm: 'http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256',
		}),
		el(
			'ds:Reference',
			{ Id: 'invoiceSignedData', URI: '' },
			el(
				'ds:Transforms',
				null,
				xpath('not(//ancestor-or-self::ext:UBLExtensions)'),
				xpath('not(//ancestor-or-self::cac:Signature)'),
				xpath(
					"not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])",
				),
				el('ds:Transform', { Algorithm: C14N11 }),
			),
			el('ds:DigestMethod', {
				Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
			}),
			text('ds:DigestValue', input.invoiceHash),
		),
		el(
			'ds:Reference',
			{
				Type: 'http://www.w3.org/2000/09/xmldsig#SignatureProperties',
				URI: '#xadesSignedProperties',
			},
			el('ds:DigestMethod', {
				Algorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
			}),
			text('ds:DigestValue', input.signedPropertiesHash),
		),
	)
	return el(
		'ext:UBLExtensions',
		null,
		el(
			'ext:UBLExtension',
			null,
			text(
				'ext:ExtensionURI',
				'urn:oasis:names:specification:ubl:dsig:enveloped:xades',
			),
			el(
				'ext:ExtensionContent',
				null,
				el(
					'sig:UBLDocumentSignatures',
					{ 'xmlns:sac': NS.sac, 'xmlns:sbc': NS.sbc, 'xmlns:sig': NS.sig },
					el(
						'sac:SignatureInformation',
						null,
						text('cbc:ID', 'urn:oasis:names:specification:ubl:signature:1'),
						text(
							'sbc:ReferencedSignatureID',
							'urn:oasis:names:specification:ubl:signature:Invoice',
						),
						el(
							'ds:Signature',
							{ Id: 'signature', 'xmlns:ds': NS.ds },
							signedInfo,
							text('ds:SignatureValue', input.signatureValue),
							el(
								'ds:KeyInfo',
								null,
								el(
									'ds:X509Data',
									null,
									text('ds:X509Certificate', input.certificate.base64),
								),
							),
							el(
								'ds:Object',
								null,
								el(
									'xades:QualifyingProperties',
									{ Target: 'signature', 'xmlns:xades': NS.xades },
									input.signedPropertiesXml,
								),
							),
						),
					),
				),
			),
		),
	)
}

/** TLV of the Phase 2 QR code (simplified documents carry all nine tags). */
export function phase2Qr(input: {
	sellerName: string
	vatNumber: string
	timestamp: string
	totalCents: number
	taxCents: number
	invoiceHash: string
	signatureValue: string
	certificate: ZatcaCertificate
}): string {
	const fields: Uint8Array[] = [
		utf8(input.sellerName),
		utf8(input.vatNumber),
		utf8(input.timestamp),
		utf8(amount(input.totalCents)),
		utf8(amount(input.taxCents)),
		utf8(input.invoiceHash),
		utf8(input.signatureValue),
		input.certificate.publicKey,
		input.certificate.signature,
	]
	const bytes: number[] = []
	fields.forEach((value, index) => {
		if (value.length > 255) throw new Error(`QR tag ${index + 1} is too long`)
		bytes.push(index + 1, value.length, ...value)
	})
	return toBase64(Uint8Array.from(bytes))
}

export type SignedZatcaDocument = {
	/** The signed XML, with an XML declaration. */
	xml: string
	/** Base64 of `xml`, as the Fatoora API takes it. */
	xmlBase64: string
	invoiceHash: string
	signatureValue: string
	qr: string
	uuid: string
	/** What the QR and the receipt show. */
	totalCents: number
	taxCents: number
	timestamp: string
}

/**
 * Builds and signs a document. Synchronous (the till signs inside an IndexedDB
 * transaction). The signature is ECDSA-SHA256 over the invoice hash.
 */
export function signDocument(
	input: ZatcaDocumentInput,
	privateKey: Uint8Array,
	certificate: ZatcaCertificate,
	signingTime: Date = input.issuedAt,
): SignedZatcaDocument {
	const { head, tail, date, time, figures: f } = parts(input)
	const hash = invoiceHash(input)
	const signatureValue = toBase64(signDer(fromBase64(hash), privateKey))
	const signingTimeText = new Date(signingTime.getTime())
		.toISOString()
		.slice(0, 19)
	const signedPropertiesXml = signedProperties(certificate, signingTimeText)
	const signedPropertiesHash = toBase64(
		utf8(toHex(sha256Bytes(signedPropertiesXml))),
	)
	const timestamp = `${date}T${time}`
	const qr = phase2Qr({
		sellerName: input.seller.name,
		vatNumber: input.seller.vatNumber,
		timestamp,
		totalCents: input.payableCents,
		taxCents: f.taxCents,
		invoiceHash: hash,
		signatureValue,
		certificate,
	})
	const [profile, ...restOfHead] = head
	const xml =
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
		el(
			'Invoice',
			ROOT_NAMESPACES,
			signatureExtension({
				invoiceHash: hash,
				signedPropertiesHash,
				signatureValue,
				certificate,
				signedPropertiesXml,
			}),
			profile!,
			...restOfHead,
			attachment('QR', qr),
			SIGNATURE_REFERENCE,
			...tail,
		)
	return {
		xml,
		xmlBase64: toBase64(utf8(xml)),
		invoiceHash: hash,
		signatureValue,
		qr,
		uuid: input.uuid,
		totalCents: input.payableCents,
		taxCents: f.taxCents,
		timestamp,
	}
}

import { fromBase64, sha256Bytes, toBase64 } from './crypto.ts'
import { hasXmlIllegal, type ZatcaDocumentKind } from './document.ts'

/**
 * Reads back a signed document as the till uploads it, so the server reports
 * only what it records: the scalar fields are taken from the XML and the
 * invoice hash is recomputed from it. Only documents in the exact form
 * `signDocument` writes are read (canonical, one of each element), which every
 * till produces; anything else is refused rather than reported.
 */

export type ReadZatcaDocument = {
	/** cbc:ID */
	id: string
	uuid: string
	kind: ZatcaDocumentKind
	/** ICV. */
	counter: number
	/** PIH. */
	previousHash: string
	/** Recomputed from the XML. */
	invoiceHash: string
	payableCents: number
	taxCents: number
	vatNumber: string
}

const DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>\n'
const KIND_OF: Record<string, ZatcaDocumentKind> = {
	'388': 'invoice',
	'381': 'credit_note',
	'383': 'debit_note',
}

/** The single match of `pattern` in `xml`, or null when there is none or more than one. */
function only(xml: string, pattern: RegExp): RegExpMatchArray | null {
	const all = [...xml.matchAll(new RegExp(pattern.source, 'g'))]
	return all.length === 1 ? all[0]! : null
}

const cents = (amount: string | undefined) => {
	const match = amount?.match(/^(-?)(\d+)\.(\d{2})$/)
	if (!match) return null
	const value = Number(match[2]) * 100 + Number(match[3])
	return match[1] ? -value : value
}

const unescape = (text: string) =>
	text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&#xD;/g, '\r')
		.replace(/&amp;/g, '&')

export function readSignedDocument(
	xmlBase64: string,
): { ok: true; value: ReadZatcaDocument } | { ok: false; error: string } {
	const fail = (error: string) => ({ ok: false as const, error })
	let xml: string
	try {
		xml = new TextDecoder('utf-8', { fatal: true }).decode(
			fromBase64(xmlBase64),
		)
	} catch {
		return fail('not UTF-8')
	}
	if (!xml.startsWith(DECLARATION)) return fail('no XML declaration')
	if (hasXmlIllegal(xml)) return fail('characters XML does not allow')
	const body = xml.slice(DECLARATION.length)
	// What ZATCA's transforms remove before hashing (see `hashedForm`).
	const extensions = only(
		body,
		/<ext:UBLExtensions>[\s\S]*?<\/ext:UBLExtensions>/,
	)
	const signature = only(body, /<cac:Signature>[\s\S]*?<\/cac:Signature>/)
	const qr = only(
		body,
		/<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/,
	)
	if (!extensions || !signature || !qr) return fail('not a signed document')
	const hashed = body
		.replace(extensions[0], '')
		.replace(signature[0], '')
		.replace(qr[0], '')
	const head = hashed.match(
		/^<Invoice [^>]*><cbc:ProfileID>reporting:1\.0<\/cbc:ProfileID><cbc:ID>([^<]+)<\/cbc:ID><cbc:UUID>([^<]+)<\/cbc:UUID><cbc:IssueDate>[^<]+<\/cbc:IssueDate><cbc:IssueTime>[^<]+<\/cbc:IssueTime><cbc:InvoiceTypeCode name="0200000">(\d{3})<\/cbc:InvoiceTypeCode>/,
	)
	const icv = only(
		hashed,
		/<cac:AdditionalDocumentReference><cbc:ID>ICV<\/cbc:ID><cbc:UUID>(\d{1,10})<\/cbc:UUID><\/cac:AdditionalDocumentReference>/,
	)
	const pih = only(
		hashed,
		/<cac:AdditionalDocumentReference><cbc:ID>PIH<\/cbc:ID><cac:Attachment><cbc:EmbeddedDocumentBinaryObject mimeCode="text\/plain">([A-Za-z0-9+/=]+)<\/cbc:EmbeddedDocumentBinaryObject><\/cac:Attachment><\/cac:AdditionalDocumentReference>/,
	)
	const payable = only(
		hashed,
		/<cbc:PayableAmount currencyID="SAR">([^<]+)<\/cbc:PayableAmount>/,
	)
	// The first of the two document-level tax totals (the one without subtotals).
	const tax = only(
		hashed,
		/<cac:TaxTotal><cbc:TaxAmount currencyID="SAR">([^<]+)<\/cbc:TaxAmount><\/cac:TaxTotal>/,
	)
	const vat = only(hashed, /<cbc:CompanyID>(\d{15})<\/cbc:CompanyID>/)
	const kind = head ? KIND_OF[head[3]!] : undefined
	const payableCents = cents(payable?.[1])
	const taxCents = cents(tax?.[1])
	if (
		!head ||
		!kind ||
		!icv ||
		!pih ||
		payableCents === null ||
		taxCents === null ||
		!vat
	)
		return fail('a required field is missing or repeated')
	return {
		ok: true,
		value: {
			id: unescape(head[1]!),
			uuid: unescape(head[2]!),
			kind,
			counter: Number(icv[1]),
			previousHash: pih[1]!,
			invoiceHash: toBase64(sha256Bytes(hashed)),
			payableCents,
			taxCents,
			vatNumber: vat[1]!,
		},
	}
}

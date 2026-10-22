/**
 * Fiscal document chain for the walk-in point of sale, shared by the till and
 * the regional tenant-api. No dependencies, so the till can bundle it.
 *
 * Every closed sale (an invoice) and every refund (a credit note) gets the next
 * number in its till's chain and a SHA-256 hash over its canonical form plus the
 * previous document's hash, the shape ZATCA's simplified tax invoices use (ICV
 * counter and PIH previous-invoice hash). The chain belongs to a till
 * installation (`chainId`), not to a pairing, so re-pairing a tablet continues
 * it. Numbers are never reused or rewritten: the human order number can change
 * after a collision, the fiscal counter cannot.
 *
 * The hash is computed synchronously because the till issues documents inside
 * an IndexedDB transaction, which closes if it awaits anything else (such as
 * `crypto.subtle`).
 */

export const POS_FISCAL_GENESIS_HASH = '0'.repeat(64)
export const POS_FISCAL_KINDS = ['invoice', 'credit_note'] as const
export type PosFiscalKind = (typeof POS_FISCAL_KINDS)[number]

export type PosFiscalDocument = {
	chainId: string
	counter: number
	kind: PosFiscalKind
	/** The order id for an invoice, the refund id for a credit note. */
	docId: string
	orderId: string
	/** ISO 8601 instant the document was issued. */
	at: string
	currency: string
	/** Amount of the document, always positive (a credit note's refund amount). */
	totalCents: number
	taxCents: number
	previousHash: string
	hash: string
}

export type PosFiscalChainHead = {
	chainId: string
	counter: number
	hash: string
}

/** The exact bytes that are hashed. Field order and separators are part of the contract. */
export function posFiscalCanonical(
	doc: Omit<PosFiscalDocument, 'hash'>,
): string {
	return [
		'pos-fiscal-v1',
		doc.chainId,
		String(doc.counter),
		doc.kind,
		doc.docId,
		doc.orderId,
		doc.at,
		doc.currency,
		String(doc.totalCents),
		String(doc.taxCents),
		doc.previousHash,
	].join('|')
}

export const posFiscalHash = (doc: Omit<PosFiscalDocument, 'hash'>): string =>
	sha256Hex(posFiscalCanonical(doc))

/** Issues the next document after `head` (or the first one of a new chain). */
export function issuePosFiscalDocument(
	head: PosFiscalChainHead,
	input: Omit<
		PosFiscalDocument,
		'chainId' | 'counter' | 'previousHash' | 'hash'
	>,
): { document: PosFiscalDocument; head: PosFiscalChainHead } {
	const unsigned = {
		...input,
		chainId: head.chainId,
		counter: head.counter + 1,
		previousHash: head.hash,
	}
	const document: PosFiscalDocument = {
		...unsigned,
		hash: posFiscalHash(unsigned),
	}
	return {
		document,
		head: {
			chainId: head.chainId,
			counter: document.counter,
			hash: document.hash,
		},
	}
}

export const newPosFiscalChain = (chainId: string): PosFiscalChainHead => ({
	chainId,
	counter: 0,
	hash: POS_FISCAL_GENESIS_HASH,
})

/** Tax carried by a refund: the bill's tax in proportion to the amount refunded. */
export function posRefundTaxCents(
	totals: { totalCents: number; taxCents: number },
	refundCents: number,
): number {
	if (totals.totalCents <= 0) return 0
	return Math.round((totals.taxCents * refundCents) / totals.totalCents)
}

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4) over UTF-8, synchronous.
// ---------------------------------------------------------------------------

const K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

export function sha256Hex(message: string): string {
	const bytes = new TextEncoder().encode(message)
	const bitLength = bytes.length * 8
	const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64)
	padded.set(bytes)
	padded[bytes.length] = 0x80
	const view = new DataView(padded.buffer)
	view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32))
	view.setUint32(padded.length - 4, bitLength >>> 0)

	const h = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
		0x1f83d9ab, 0x5be0cd19,
	])
	const w = new Uint32Array(64)
	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
		for (let i = 16; i < 64; i++) {
			const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
			const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
		}
		let [a, b, c, d, e, f, g, hh] = h as unknown as number[]
		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)
			const ch = (e! & f!) ^ (~e! & g!)
			const t1 = (hh! + S1 + ch + K[i]! + w[i]!) >>> 0
			const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)
			const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!)
			const t2 = (S0 + maj) >>> 0
			hh = g
			g = f
			f = e
			e = (d! + t1) >>> 0
			d = c
			c = b
			b = a
			a = (t1 + t2) >>> 0
		}
		h[0] = (h[0]! + a!) >>> 0
		h[1] = (h[1]! + b!) >>> 0
		h[2] = (h[2]! + c!) >>> 0
		h[3] = (h[3]! + d!) >>> 0
		h[4] = (h[4]! + e!) >>> 0
		h[5] = (h[5]! + f!) >>> 0
		h[6] = (h[6]! + g!) >>> 0
		h[7] = (h[7]! + hh!) >>> 0
	}
	return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('')
}

// ---------------------------------------------------------------------------
// ZATCA simplified tax invoice QR (Phase 1 TLV, base64).
// ---------------------------------------------------------------------------

/**
 * The QR payload ZATCA requires on a simplified tax invoice: tag-length-value of
 * seller name (1), VAT registration number (2), timestamp (3), invoice total
 * with VAT (4) and VAT total (5), base64 encoded. Amounts are in major units
 * with two decimals.
 */
export function zatcaQrPayload(input: {
	sellerName: string
	vatNumber: string
	at: string
	totalCents: number
	taxCents: number
}): string {
	const encoder = new TextEncoder()
	const fields = [
		input.sellerName,
		input.vatNumber,
		input.at,
		(input.totalCents / 100).toFixed(2),
		(input.taxCents / 100).toFixed(2),
	]
	const parts: number[] = []
	fields.forEach((value, index) => {
		const bytes = encoder.encode(value).slice(0, 255)
		parts.push(index + 1, bytes.length, ...bytes)
	})
	let binary = ''
	for (const byte of parts) binary += String.fromCharCode(byte)
	return btoa(binary)
}

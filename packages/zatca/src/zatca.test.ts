import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { fatooraClient, summarizeErrors } from './api.ts'
import { readCertificate } from './cert.ts'
import {
	fromBase64,
	generatePrivateKey,
	pem,
	publicKeyOf,
	signDer,
	subjectPublicKeyInfo,
	toBase64,
	verifyDer,
} from './crypto.ts'
import { buildCsr } from './csr.ts'
import {
	figures,
	hasXmlIllegal,
	hashedForm,
	invoiceHash,
	signDocument,
	ZATCA_GENESIS_PIH,
	type ZatcaDocumentInput,
	xmlSafe,
} from './document.ts'
import { fromRefund, fromSale } from './from-sale.ts'
import { readSignedDocument } from './verify.ts'

const has = (tool: string) => {
	try {
		execFileSync(tool, ['--version'], { stdio: 'ignore' })
		return true
	} catch {
		try {
			execFileSync(tool, ['version'], { stdio: 'ignore' })
			return true
		} catch {
			return false
		}
	}
}
const OPENSSL = has('openssl')
const XMLLINT = has('xmllint')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zatca-test-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const file = (name: string, content: string | Uint8Array) => {
	const p = path.join(dir, name)
	fs.writeFileSync(p, content)
	return p
}
const run = (args: string[]) =>
	execFileSync('openssl', args, {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	})
/** stdout and stderr together: OpenSSL 3 reports `verify OK` on stderr, 4 on stdout. */
const runCombined = (args: string[]) => {
	const result = spawnSync('openssl', args, { encoding: 'utf8' })
	if (result.status !== 0) throw new Error(result.stderr || 'openssl failed')
	return `${result.stdout}\n${result.stderr}`
}

/** A throwaway secp256k1 CA-signed certificate from openssl, to stand in for a ZATCA CSID. */
function opensslCertificate() {
	const key = path.join(dir, 'ca.key')
	const cert = path.join(dir, 'ca.pem')
	run(['ecparam', '-name', 'secp256k1', '-genkey', '-noout', '-out', key])
	run([
		'req',
		'-new',
		'-x509',
		'-key',
		key,
		'-out',
		cert,
		'-days',
		'1',
		'-subj',
		'/DC=local/DC=gov/DC=extgazt/CN=TSZEINVOICE-SubCA-1',
		'-set_serial',
		'379112742831380471835263969587287663520528387',
	])
	const base64 = fs
		.readFileSync(cert, 'utf8')
		.replace(/-----[^-]+-----/g, '')
		.replace(/\s+/g, '')
	return { base64, certPath: cert }
}

const seller = {
	name: 'مطعم الحارة Al Hara Kitchen',
	vatNumber: '399999999900003',
	crNumber: '1010010000',
	street: 'Prince Sultan',
	buildingNumber: '2322',
	district: 'Al-Murabba',
	city: 'Riyadh',
	postalCode: '23333',
}

const sale = (over: Partial<Parameters<typeof fromSale>[0]> = {}) =>
	fromSale(
		{
			lines: [
				{
					name: 'Burger & "Fries" <large>',
					variantLabel: 'Large',
					quantity: 2,
					baseCents: 2300,
					options: [{ unitCents: 200, quantity: 1, taxable: true }],
				},
				{
					name: 'Water',
					variantLabel: null,
					quantity: 1,
					baseCents: 500,
					options: [{ unitCents: 100, quantity: 1, taxable: false }],
				},
			],
			taxRatePercent: 15,
			taxInclusive: false,
			totals: {
				adjustmentCents: 0,
				taxCents: 825,
				tipCents: 300,
				totalCents: 6725,
			},
			payments: [{ method: 'card' }, { method: 'cash' }],
			...over,
		},
		{
			id: 'T1-INV-000001',
			uuid: '3cf5ee18-ee25-44ea-a444-2c37ba7f28be',
			issuedAt: new Date('2026-10-21T18:30:05Z'),
			counter: 1,
			previousHash: ZATCA_GENESIS_PIH,
			seller,
		},
	)

describe('keys and signatures', () => {
	it('signs with secp256k1 ECDSA-SHA256 in DER, and verifies', () => {
		const key = generatePrivateKey()
		const message = new TextEncoder().encode('hello')
		const signature = signDer(message, key)
		expect(signature[0]).toBe(0x30)
		expect(verifyDer(signature, message, publicKeyOf(key))).toBe(true)
	})

	it.skipIf(!OPENSSL)(
		'produces signatures and public keys openssl accepts',
		() => {
			const key = generatePrivateKey()
			const message = new TextEncoder().encode('invoice hash bytes')
			const pub = file(
				'pub.pem',
				pem('PUBLIC KEY', subjectPublicKeyInfo(publicKeyOf(key))),
			)
			const sig = file('sig.der', signDer(message, key))
			const msg = file('msg.bin', message)
			expect(
				run(['dgst', '-sha256', '-verify', pub, '-signature', sig, msg]),
			).toMatch(/Verified OK/)
		},
	)
})

describe('CSR', () => {
	const input = {
		environment: 'sandbox' as const,
		organizationName: seller.name,
		organizationUnit: 'Riyadh Branch',
		commonName: 'T1-0f3a9c21',
		serialNumber: '1-Menuza|2-POS|3-0f3a9c21-1b7e-4a52-9a1d-6b1e2c3d4e5f',
		vatNumber: seller.vatNumber,
		invoiceTypes: '0100',
		address: 'RRRD2929',
		businessCategory: 'Restaurant',
	}

	it('is base64 of the PEM, as the API takes it', () => {
		const csr = buildCsr(input, generatePrivateKey())
		expect(new TextDecoder().decode(fromBase64(csr.base64Pem))).toBe(csr.pem)
		expect(csr.pem).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----\n/)
	})

	it.skipIf(!OPENSSL)(
		'is a valid, self-signed PKCS#10 request carrying ZATCA’s fields',
		() => {
			const csr = buildCsr(input, generatePrivateKey())
			const out = runCombined([
				'req',
				'-in',
				file('csr.pem', csr.pem),
				'-noout',
				'-verify',
				'-text',
				'-nameopt',
				'utf8',
			])
			expect(out).toMatch(/verify OK/i)
			expect(out).toMatch(/C\s*=\s*SA/)
			expect(out).toContain('TSTZATCA-Code-Signing')
			expect(out).toContain(
				'1-Menuza|2-POS|3-0f3a9c21-1b7e-4a52-9a1d-6b1e2c3d4e5f',
			)
			expect(out).toContain(seller.vatNumber)
			expect(out).toContain('0100')
			expect(out).toMatch(/secp256k1/)
			expect(out).toContain(seller.name)
		},
	)
})

describe('certificate', () => {
	it.skipIf(!OPENSSL)(
		'reads issuer, serial, public key and signature the way ZATCA’s signature expects',
		() => {
			const { base64, certPath } = opensslCertificate()
			// As ZATCA hands it out: the base64 DER, base64 encoded again.
			const cert = readCertificate(toBase64(new TextEncoder().encode(base64)))
			expect(cert.base64).toBe(base64)
			expect(cert.issuerName).toBe(
				'CN=TSZEINVOICE-SubCA-1, DC=extgazt, DC=gov, DC=local',
			)
			expect(cert.serialNumber).toBe(
				'379112742831380471835263969587287663520528387',
			)
			const spki = run(['x509', '-in', certPath, '-noout', '-pubkey'])
			expect(pem('PUBLIC KEY', cert.publicKey)).toBe(spki)
			expect(cert.signature[0]).toBe(0x30)
			expect(readCertificate(base64).serialNumber).toBe(cert.serialNumber)
		},
	)
})

describe('documents', () => {
	it('adds up: line nets, VAT on the standard-rated part, out-of-scope tips and untaxed extras', () => {
		const doc = sale()
		const f = figures(doc)
		// 2 x (23 + 2) = 50.00 S, 1 x 5 = 5.00 S, 1 x 1 = 1.00 O, tip 3.00 O.
		expect(f.standardTaxableCents).toBe(5500)
		expect(f.outOfScopeCents).toBe(400)
		expect(f.taxCents).toBe(825)
		expect(f.taxInclusiveCents).toBe(5900 + 825)
		expect(f.payableRoundingCents).toBe(0)
	})

	it('keeps VAT exactly 15% of the taxable amount when unit prices include tax, rounding the rest (BR-S-09)', () => {
		// 10 x 1.00 incl. VAT, VAT 1.30 on the bill: 0.87 net each, evened out to
		// 8.69 taxable (whose 15% is the bill's 1.30), paid 10.00.
		const doc = sale({
			lines: [
				{
					name: 'Water',
					variantLabel: null,
					quantity: 10,
					baseCents: 100,
					options: [],
				},
			],
			taxInclusive: true,
			totals: {
				adjustmentCents: 0,
				taxCents: 130,
				tipCents: 0,
				totalCents: 1000,
			},
			payments: [{ method: 'cash' }],
		})
		const f = figures(doc)
		expect(f.standardTaxableCents).toBe(869)
		expect(f.taxCents).toBe(Math.round(869 * 0.15))
		expect(f.taxCents).toBe(130)
		expect(f.taxInclusiveCents + f.payableRoundingCents).toBe(1000)
		expect(hashedForm(doc)).toContain(
			'<cbc:PayableRoundingAmount currencyID="SAR">0.01</cbc:PayableRoundingAmount>',
		)
	})

	it('converts VAT-inclusive prices for the whole line, not unit by unit, and keeps the bill’s VAT', () => {
		// 50 x 1.00 incl. VAT: 43.48 net, not 50 x 0.87 = 43.50; VAT 6.52 as on the bill.
		const doc = sale({
			lines: [
				{
					name: 'Water',
					variantLabel: null,
					quantity: 50,
					baseCents: 100,
					options: [],
				},
			],
			taxInclusive: true,
			totals: {
				adjustmentCents: 0,
				taxCents: Math.round((5000 * 15) / 115),
				tipCents: 0,
				totalCents: 5000,
			},
			payments: [{ method: 'cash' }],
		})
		const f = figures(doc)
		// Each line is still unit price x quantity (BR-KSA-EN16931-11); the
		// rounding of the unit price comes off once, for the document.
		expect(f.lines[0]!.netCents).toBe(50 * 87)
		expect(f.standardTaxableCents).toBe(4348)
		expect(f.taxCents).toBe(652)
		expect(f.taxCents).toBe(Math.round(f.standardTaxableCents * 0.15))
		expect(f.taxInclusiveCents + f.payableRoundingCents).toBe(5000)
	})

	it('gives every VAT-inclusive bill the till’s VAT, with BR-S-09 exact', () => {
		for (let gross = 1; gross <= 3000; gross += 7) {
			const taxCents = Math.round((gross * 15) / 115)
			const doc = sale({
				lines: [
					{
						name: 'Item',
						variantLabel: null,
						quantity: 1,
						baseCents: gross,
						options: [],
					},
				],
				taxInclusive: true,
				totals: {
					adjustmentCents: 0,
					taxCents,
					tipCents: 0,
					totalCents: gross,
				},
				payments: [{ method: 'cash' }],
			})
			const f = figures(doc)
			expect(f.taxCents).toBe(taxCents)
			expect(f.taxCents).toBe(Math.round((f.standardTaxableCents * 15) / 100))
			expect(Math.abs(f.payableRoundingCents)).toBeLessThanOrEqual(1)
		}
	})

	it('gives a credit note the VAT on the till’s credit note when the bill’s VAT is known', () => {
		// 23.00 incl. VAT (VAT 3.00), 7.00 refunded: the till's note carries 0.91.
		const bill = { totalCents: 2300, taxCents: 300 }
		const refunded = 700
		const doc = fromRefund(
			{ amountCents: refunded, method: 'cash', reason: 'Wrong item' },
			{ taxRatePercent: 15, outOfScopeCents: 0, ...bill },
			{
				id: 'T1-CN',
				uuid: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c03',
				issuedAt: new Date(),
				counter: 2,
				previousHash: ZATCA_GENESIS_PIH,
				seller,
				billingReference: { id: 'T1', issueDate: '2026-10-21' },
			},
		)
		const f = figures(doc)
		// posRefundTaxCents in @repo/common/pos-fiscal.
		expect(f.taxCents).toBe(
			Math.round((bill.taxCents * refunded) / bill.totalCents),
		)
		expect(f.taxCents).toBe(Math.round((f.standardTaxableCents * 15) / 100))
		expect(f.taxInclusiveCents + f.payableRoundingCents).toBe(refunded)
	})

	it('drops characters XML 1.0 does not allow before hashing', () => {
		const doc = sale({
			lines: [
				{
					name: 'Bad\u0001name\u001F\uFFFE \uD800tea',
					variantLabel: 'Hot\u000B',
					quantity: 1,
					baseCents: 1000,
					options: [],
				},
			],
			totals: {
				adjustmentCents: 0,
				taxCents: 150,
				tipCents: 0,
				totalCents: 1150,
			},
			payments: [{ method: 'cash' }],
		})
		const xml = hashedForm(doc)
		expect(hasXmlIllegal(xml)).toBe(false)
		expect(xml).toContain('<cbc:Name>Badname tea (Hot)</cbc:Name>')
		expect(hasXmlIllegal('a\u0000')).toBe(true)
		expect(hasXmlIllegal('a\uDC00')).toBe(true)
		expect(hasXmlIllegal('emoji \uD83C\uDF54 and tab\t')).toBe(false)
		expect(xmlSafe('ok \uD83C\uDF54')).toBe('ok \uD83C\uDF54')
		if (XMLLINT) execFileSync('xmllint', ['--noout', file('illegal.xml', xml)])
	})

	it('signs even when the seller name is longer than a QR tag holds, cutting it on a character', () => {
		if (!OPENSSL) return
		const key = generatePrivateKey()
		const cert = readCertificate(opensslCertificate().base64)
		const longName = 'مطعم '.repeat(40) // 360 bytes
		const signed = signDocument(
			{ ...sale(), seller: { ...seller, name: longName } },
			key,
			cert,
		)
		const bytes = fromBase64(signed.qr)
		expect(bytes[0]).toBe(1)
		const length = bytes[1]!
		expect(length).toBeLessThanOrEqual(255)
		const name = new TextDecoder('utf-8', { fatal: true }).decode(
			bytes.subarray(2, 2 + length),
		)
		expect(longName.startsWith(name)).toBe(true)
	})

	it('splits a discount between taxed and untaxed amounts, never below zero', () => {
		const doc = sale({
			lines: [
				{
					name: 'Burger',
					variantLabel: null,
					quantity: 1,
					baseCents: 900,
					options: [{ unitCents: 100, quantity: 1, taxable: false }],
				},
			],
			totals: {
				adjustmentCents: 500,
				taxCents: 68,
				tipCents: 0,
				totalCents: 568,
			},
			payments: [{ method: 'cash' }],
		})
		const f = figures(doc)
		expect(f.standardAllowanceCents).toBe(450)
		expect(f.outOfScopeAllowanceCents).toBe(50)
		expect(f.standardTaxableCents).toBe(450)
		expect(f.outOfScopeCents).toBe(50)
		expect(f.taxCents).toBe(68)
		expect(hashedForm(doc).match(/<cac:AllowanceCharge>/g)).toHaveLength(2)
	})

	it('does not claim VAT back on the tip when refunding a sale that had one (BR-S-09)', () => {
		// 100.00 + 15.00 VAT + 10.00 tip, refunded in full.
		const doc = fromRefund(
			{ amountCents: 12_500, method: 'card', reason: 'Wrong order' },
			{ taxRatePercent: 15, totalCents: 12_500, outOfScopeCents: 1000 },
			{
				id: 'T1-CN',
				uuid: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c02',
				issuedAt: new Date(),
				counter: 2,
				previousHash: ZATCA_GENESIS_PIH,
				seller,
				billingReference: { id: 'T1', issueDate: '2026-10-21' },
			},
		)
		const f = figures(doc)
		expect(f.standardTaxableCents).toBe(10_000)
		expect(f.taxCents).toBe(1500)
		expect(f.outOfScopeCents).toBe(1000)
		expect(f.payableRoundingCents).toBe(0)
	})

	it('turns tax-inclusive prices into net amounts, keeping the VAT charged and rounding the rest', () => {
		const doc = sale({
			lines: [
				{
					name: 'Shawarma',
					variantLabel: null,
					quantity: 3,
					baseCents: 1150,
					options: [],
				},
			],
			taxInclusive: true,
			totals: {
				adjustmentCents: 0,
				taxCents: 450,
				tipCents: 0,
				totalCents: 3450,
			},
			payments: [{ method: 'cash' }],
		})
		const f = figures(doc)
		expect(doc.lines[0]!.unitNetCents).toBe(1000)
		expect(f.taxInclusiveCents + f.payableRoundingCents).toBe(3450)
		expect(f.taxCents).toBe(450)
	})

	it.skipIf(!XMLLINT)(
		'hashes exactly what canonical XML 1.1 gives for the signed document with the signature and QR removed',
		() => {
			const key = generatePrivateKey()
			const cert = OPENSSL ? readCertificate(opensslCertificate().base64) : null
			if (!cert) return
			const signed = signDocument(sale(), key, cert)
			// Well-formed.
			execFileSync('xmllint', ['--noout', file('signed.xml', signed.xml)])
			// What ZATCA's XPath transforms remove.
			const stripped = signed.xml
				.replace(/<ext:UBLExtensions>[\s\S]*<\/ext:UBLExtensions>/, '')
				.replace(/<cac:Signature>[\s\S]*?<\/cac:Signature>/, '')
				.replace(
					/<cac:AdditionalDocumentReference><cbc:ID>QR<\/cbc:ID>[\s\S]*?<\/cac:AdditionalDocumentReference>/,
					'',
				)
			const canonical = execFileSync(
				'xmllint',
				['--c14n11', file('stripped.xml', stripped)],
				{ encoding: 'utf8' },
			)
			expect(canonical).toBe(hashedForm(sale()))
			expect(signed.invoiceHash).toBe(invoiceHash(sale()))
		},
	)

	it('signs the invoice hash, and the QR carries all nine tags', () => {
		if (!OPENSSL) return
		const key = generatePrivateKey()
		const cert = readCertificate(opensslCertificate().base64)
		const signed = signDocument(sale(), key, cert)
		expect(
			verifyDer(
				fromBase64(signed.signatureValue),
				fromBase64(signed.invoiceHash),
				publicKeyOf(key),
			),
		).toBe(true)
		const bytes = fromBase64(signed.qr)
		const tags: number[] = []
		for (let i = 0; i < bytes.length; i += 2 + bytes[i + 1]!)
			tags.push(bytes[i]!)
		expect(tags).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
		expect(signed.timestamp).toBe('2026-10-21T21:30:05')
		expect(signed.xml).toContain(
			'<cbc:IssueDate>2026-10-21</cbc:IssueDate><cbc:IssueTime>21:30:05</cbc:IssueTime>',
		)
		expect(signed.xml).toContain('Burger &amp; "Fries" &lt;large&gt;')
		expect(signed.xml).toContain(
			`<ds:X509Certificate>${cert.base64}</ds:X509Certificate>`,
		)
	})

	it('chains: the next document’s PIH is this one’s hash, and a credit note refers to its invoice', () => {
		const first = invoiceHash(sale())
		const credit: ZatcaDocumentInput = fromRefund(
			{ amountCents: 1150, method: 'cash', reason: 'Wrong item charged' },
			{ taxRatePercent: 15, totalCents: 1150, outOfScopeCents: 0 },
			{
				id: 'T1-CN-000002',
				uuid: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c01',
				issuedAt: new Date('2026-10-21T19:00:00Z'),
				counter: 2,
				previousHash: first,
				seller,
				billingReference: { id: 'T1-INV-000001', issueDate: '2026-10-21' },
			},
		)
		const xml = hashedForm(credit)
		expect(xml).toContain(
			'<cbc:InvoiceTypeCode name="0200000">381</cbc:InvoiceTypeCode>',
		)
		expect(xml).toContain(
			`<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${first}</cbc:EmbeddedDocumentBinaryObject>`,
		)
		expect(xml).toContain(
			'Invoice Number: T1-INV-000001; Invoice Issue Date: 2026-10-21',
		)
		expect(xml).toContain(
			'<cbc:InstructionNote>Wrong item charged</cbc:InstructionNote>',
		)
		expect(figures(credit).taxInclusiveCents).toBe(1150)
	})

	it('uses ZATCA’s genesis PIH for the first document', () => {
		expect(ZATCA_GENESIS_PIH).toBe(
			'NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==',
		)
	})
})

describe('reading a signed document back', () => {
	it.skipIf(!OPENSSL)(
		'reads the fields the server records and recomputes the invoice hash',
		() => {
			const key = generatePrivateKey()
			const cert = readCertificate(opensslCertificate().base64)
			const input = sale()
			const signed = signDocument(input, key, cert)
			const read = readSignedDocument(signed.xmlBase64)
			expect(read).toEqual({
				ok: true,
				value: {
					id: 'T1-INV-000001',
					uuid: input.uuid,
					kind: 'invoice',
					counter: 1,
					previousHash: ZATCA_GENESIS_PIH,
					invoiceHash: signed.invoiceHash,
					payableCents: 6725,
					taxCents: signed.taxCents,
					vatNumber: seller.vatNumber,
				},
			})
		},
	)

	it.skipIf(!OPENSSL)(
		'notices a changed amount, a second element of a kind, or something that is not a signed document',
		() => {
			const key = generatePrivateKey()
			const cert = readCertificate(opensslCertificate().base64)
			const signed = signDocument(sale(), key, cert)
			const encode = (xml: string) => toBase64(new TextEncoder().encode(xml))
			const changed = readSignedDocument(
				encode(
					signed.xml.replace(
						'<cbc:PayableAmount currencyID="SAR">67.25</cbc:PayableAmount>',
						'<cbc:PayableAmount currencyID="SAR">1.00</cbc:PayableAmount>',
					),
				),
			)
			expect(changed).toMatchObject({ ok: true, value: { payableCents: 100 } })
			if (changed.ok)
				expect(changed.value.invoiceHash).not.toBe(signed.invoiceHash)
			const twice = signed.xml.replace(
				'</cac:LegalMonetaryTotal>',
				'</cac:LegalMonetaryTotal><cbc:PayableAmount currencyID="SAR">1.00</cbc:PayableAmount>',
			)
			expect(readSignedDocument(encode(twice)).ok).toBe(false)
			expect(readSignedDocument(encode('<Invoice/>')).ok).toBe(false)
			expect(readSignedDocument('////').ok).toBe(false)
		},
	)
})

describe('Fatoora client', () => {
	it('retries a timeout, flags refused credentials, and reads ZATCA’s status on a 2xx', async () => {
		const answers = [
			new Response('', { status: 408 }),
			new Response('', { status: 425 }),
			new Response('', { status: 401 }),
			Response.json({
				validationResults: {
					status: 'ERROR',
					errorMessages: [{ code: 'BR-KSA-98', message: 'no' }],
				},
				reportingStatus: 'NOT_REPORTED',
			}),
			Response.json(
				{
					validationResults: { status: 'WARNING' },
					reportingStatus: 'REPORTED',
				},
				{ status: 202 },
			),
		]
		const client = fatooraClient('sandbox', (async () =>
			answers.shift()!) as unknown as typeof fetch)
		const csid = { binarySecurityToken: 't', secret: 's', requestId: '1' }
		const doc = { invoiceHash: 'h', uuid: 'u', xmlBase64: 'x' }
		expect(await client.report(csid, doc)).toMatchObject({
			ok: false,
			retry: true,
		})
		expect(await client.report(csid, doc)).toMatchObject({
			ok: false,
			retry: true,
		})
		expect(await client.report(csid, doc)).toMatchObject({
			ok: false,
			retry: false,
			unauthorized: true,
		})
		expect(await client.report(csid, doc)).toMatchObject({
			ok: false,
			retry: false,
			error: 'BR-KSA-98: no',
		})
		expect(await client.report(csid, doc)).toMatchObject({
			ok: true,
			status: 202,
		})
	})

	it('sends the documented headers and bodies, and tells refusals from retries', async () => {
		const calls: Array<{ url: string; init: RequestInit }> = []
		const responses = [
			Response.json({
				requestID: 123,
				binarySecurityToken: 'dG9rZW4=',
				secret: 's3',
			}),
			Response.json(
				{
					validationResults: {
						errorMessages: [{ code: 'BR-KSA-37', message: 'bad' }],
					},
				},
				{ status: 400 },
			),
			new Response('busy', { status: 503 }),
		]
		const client = fatooraClient('sandbox', (async (
			url: string,
			init: RequestInit,
		) => {
			calls.push({ url, init })
			return responses.shift()!
		}) as typeof fetch)
		const csid = await client.complianceCsid('Q1NS', '123345')
		expect(csid).toMatchObject({
			ok: true,
			value: { requestId: '123', secret: 's3' },
		})
		expect(calls[0]!.url).toBe(
			'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/compliance',
		)
		expect(calls[0]!.init.headers).toMatchObject({
			OTP: '123345',
			'Accept-Version': 'V2',
		})
		const refused = await client.report(
			{ binarySecurityToken: 't', secret: 's', requestId: '1' },
			{ invoiceHash: 'h', uuid: 'u', xmlBase64: 'x' },
		)
		expect(refused).toMatchObject({
			ok: false,
			retry: false,
			error: 'BR-KSA-37: bad',
		})
		expect(calls[1]!.init.headers).toMatchObject({
			'Clearance-Status': '0',
			Authorization: `Basic ${btoa('t:s')}`,
		})
		const busy = await client.report(
			{ binarySecurityToken: 't', secret: 's', requestId: '1' },
			{ invoiceHash: 'h', uuid: 'u', xmlBase64: 'x' },
		)
		expect(busy).toMatchObject({ ok: false, retry: true })
		expect(summarizeErrors({ errors: ['Invalid OTP'] })).toBe('Invalid OTP')
	})
})

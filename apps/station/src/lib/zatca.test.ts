import 'fake-indexeddb/auto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { posOrderRequestSchema } from '@repo/common/pos-orders'
import {
	fromBase64,
	generatePrivateKey,
	publicKeyOf,
	toHex,
	verifyDer,
	ZATCA_GENESIS_PIH,
} from '@repo/zatca'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useClock } from './clock.ts'
import { db } from './db.ts'
import { createOrder, refundOrder, type OrderDraft } from './orders.ts'
import { toWireOrder } from './outbox.ts'
import {
	forgetZatcaUnit,
	invoiceId,
	syncZatcaUnit,
	zatcaUnit,
} from './zatca.ts'

let openssl = true
try {
	execFileSync('openssl', ['version'], { stdio: 'ignore' })
} catch {
	openssl = false
}

/** A secp256k1 certificate standing in for the production CSID, as ZATCA hands it out. */
function certificateToken() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-zatca-'))
	const key = path.join(dir, 'k.pem')
	const cert = path.join(dir, 'c.pem')
	execFileSync('openssl', [
		'ecparam',
		'-name',
		'secp256k1',
		'-genkey',
		'-noout',
		'-out',
		key,
	])
	execFileSync('openssl', [
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
		'/CN=TSZEINVOICE-SubCA-1',
	])
	const base64 = fs
		.readFileSync(cert, 'utf8')
		.replace(/-----[^-]+-----/g, '')
		.replace(/\s+/g, '')
	fs.rmSync(dir, { recursive: true, force: true })
	return btoa(base64)
}

const draft: OrderDraft = {
	terminalCode: 'T1',
	locationId: 'loc',
	currency: 'SAR',
	taxRatePercent: 15,
	taxInclusive: true,
	orderType: 'dine_in',
	customerName: '',
	tableLabel: '4',
	lines: [
		{
			id: 'l1',
			itemId: 'a',
			name: 'Shawarma',
			variantId: null,
			variantLabel: null,
			quantity: 2,
			baseCents: 1150,
			instructions: '',
			options: [],
		},
	],
	adjustments: [],
	tipCents: 0,
}
const cash = (amountCents: number) => ({
	method: 'cash' as const,
	amountCents,
	tenderedCents: amountCents,
	changeCents: 0,
})
const seller = {
	name: 'Al Hara Kitchen',
	vatNumber: '399999999900003',
	crNumber: '1010010000',
	street: 'Prince Sultan',
	buildingNumber: '2322',
	district: 'Al-Murabba',
	city: 'Riyadh',
	postalCode: '23333',
}

beforeEach(async () => {
	await db.orders.clear()
	await db.meta.clear()
	await db.shifts.clear()
	useClock.setState({ skewMs: null })
})

describe.skipIf(!openssl)('signing for ZATCA on the till', () => {
	it('signs each closed sale and refund, chains them by PIH, and the order still passes the contract', async () => {
		const privateKey = generatePrivateKey()
		await db.meta.put({
			key: 'zatca:unit',
			value: {
				environment: 'sandbox',
				privateKeyHex: toHex(privateKey),
				certificate: certificateToken(),
				seller,
			},
		})

		const sale = await createOrder(draft, cash(2300))
		const invoice = sale.fiscal[0]!
		expect(invoice.zatca).toBeTruthy()
		const xml = new TextDecoder().decode(fromBase64(invoice.zatca!.xml))
		expect(xml).toContain(`<cbc:ID>${invoiceId(sale)}</cbc:ID>`)
		expect(xml).toContain(
			`<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${ZATCA_GENESIS_PIH}</cbc:EmbeddedDocumentBinaryObject>`,
		)
		expect(xml).toContain(
			'<cbc:PayableAmount currencyID="SAR">23.00</cbc:PayableAmount>',
		)
		expect(invoice.zatca!.taxCents).toBe(sale.totals.taxCents)
		// The signature is over the invoice hash, with this till's key.
		const signature = /<ds:SignatureValue>([^<]+)</.exec(xml)![1]!
		expect(
			verifyDer(
				fromBase64(signature),
				fromBase64(invoice.zatca!.invoiceHash),
				publicKeyOf(privateKey),
			),
		).toBe(true)
		expect(posOrderRequestSchema.safeParse(toWireOrder(sale)).success).toBe(
			true,
		)

		const refunded = await refundOrder(sale.id, {
			amountCents: 1150,
			reason: 'quality',
			by: null,
			approvedBy: null,
		})
		const credit = refunded.fiscal.find((d) => d.kind === 'credit_note')!
		const creditXml = new TextDecoder().decode(fromBase64(credit.zatca!.xml))
		expect(creditXml).toContain('>381</cbc:InvoiceTypeCode>')
		expect(creditXml).toContain(
			`<cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${invoice.zatca!.invoiceHash}</cbc:EmbeddedDocumentBinaryObject>`,
		)
		expect(creditXml).toContain(`Invoice Number: ${invoiceId(sale)}`)
		expect(creditXml).toContain(
			'<cbc:InstructionNote>Quality issue</cbc:InstructionNote>',
		)
		expect(posOrderRequestSchema.safeParse(toWireOrder(refunded)).success).toBe(
			true,
		)
	})

	it('signs nothing when the till is not an onboarded unit, or the sale is not in riyals', async () => {
		expect((await createOrder(draft, cash(2300))).fiscal[0]!.zatca).toBeNull()
		await db.meta.put({
			key: 'zatca:unit',
			value: {
				environment: 'sandbox',
				privateKeyHex: toHex(generatePrivateKey()),
				certificate: certificateToken(),
				seller,
			},
		})
		expect(
			(await createOrder({ ...draft, currency: 'USD' }, cash(2300))).fiscal[0]!
				.zatca,
		).toBeNull()
	})

	it('keeps the signed invoice number when the order is renumbered, and a credit note refers to it', async () => {
		await db.meta.put({
			key: 'zatca:unit',
			value: {
				environment: 'sandbox',
				privateKeyHex: toHex(generatePrivateKey()),
				certificate: certificateToken(),
				seller,
			},
		})
		const sale = await createOrder(draft, cash(2300))
		const signedNumber = sale.fiscal[0]!.zatca!.invoiceNumber
		expect(signedNumber).toBe(invoiceId(sale))
		// The server offered another number after a collision.
		await db.orders.update(sale.id, {
			number: 'T1-0099',
			renumberedFrom: sale.number,
		})
		const refunded = await refundOrder(sale.id, {
			amountCents: 1150,
			reason: 'mistake',
			by: null,
			approvedBy: null,
		})
		const credit = refunded.fiscal.find((d) => d.kind === 'credit_note')!
		const xml = new TextDecoder().decode(fromBase64(credit.zatca!.xml))
		expect(xml).toContain(`Invoice Number: ${signedNumber};`)
		expect(credit.zatca!.invoiceNumber).toBe(`${signedNumber}-CN2`)
		expect(posOrderRequestSchema.safeParse(toWireOrder(refunded)).success).toBe(
			true,
		)
	})
})

describe.skipIf(!openssl)(
	'a tablet clock the server has shown to be wrong',
	() => {
		it('refuses to sign (and so to close the sale), and saves nothing half-done', async () => {
			await db.meta.put({
				key: 'zatca:unit',
				value: {
					environment: 'sandbox',
					privateKeyHex: toHex(generatePrivateKey()),
					certificate: certificateToken(),
					seller,
				},
			})
			useClock.setState({ skewMs: 5 * 60_000 })
			await expect(createOrder(draft, cash(2300))).rejects.toThrow(
				/clock is about 5 minutes off/,
			)
			expect(await db.orders.count()).toBe(0)
			// Within the limit, signing goes ahead.
			useClock.setState({ skewMs: 60_000 })
			expect(
				(await createOrder(draft, cash(2300))).fiscal[0]!.zatca,
			).toBeTruthy()
		})

		it('does not block a till that is not a ZATCA unit', async () => {
			useClock.setState({ skewMs: 60 * 60_000 })
			expect((await createOrder(draft, cash(2300))).fiscal[0]!.zatca).toBeNull()
		})
	},
)

describe('a terminal that is unpaired or removed', () => {
	it('forgets its signing key, certificate and chain hash', async () => {
		await db.meta.put({
			key: 'zatca:unit',
			value: {
				environment: 'sandbox',
				privateKeyHex: 'a'.repeat(64),
				certificate: 'cert',
				seller,
			},
		})
		await db.meta.put({ key: 'zatca:pih', value: 'C'.repeat(43) + '=' })
		await forgetZatcaUnit()
		expect(await zatcaUnit()).toBeNull()
		expect(await db.meta.get('zatca:pih')).toBeUndefined()
	})
})

describe('a till that lost its storage', () => {
	it('continues the ZATCA chain from the last hash the server holds', async () => {
		const settings = {
			tenantApiUrl: 'https://api.test',
			deviceToken: 'secret',
		} as Parameters<typeof syncZatcaUnit>[0]
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('', { status: 404 })),
		)
		await syncZatcaUnit(settings, {
			status: 'active',
			lastInvoiceHash: 'A'.repeat(43) + '=',
		})
		expect((await db.meta.get('zatca:pih'))?.value).toBe('A'.repeat(43) + '=')
		// A till that still has its own chain keeps it.
		await syncZatcaUnit(settings, {
			status: 'active',
			lastInvoiceHash: 'B'.repeat(43) + '=',
		})
		expect((await db.meta.get('zatca:pih'))?.value).toBe('A'.repeat(43) + '=')
		vi.unstubAllGlobals()
	})
})

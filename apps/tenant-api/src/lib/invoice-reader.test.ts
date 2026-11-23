import { MAX_PRICE_LIST_LINES } from '@repo/inventory'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import {
	isInvoiceReaderConfigured,
	parseInvoiceNumber,
	readInvoiceDocument,
	readInvoiceImage,
	readPriceListDocument,
} from './invoice-reader.ts'

const READER = 'https://reader.example.test/v1'

const READER_ENV = {
	DATA_REGION: 'us',
	INVOICE_READER_BASE_URL: READER,
	INVOICE_READER_API_KEY: 'reader-secret-key',
	INVOICE_READER_MODEL: 'vision-1',
	INVOICE_READER_DATA_REGION: 'us',
}

function setReaderEnv(
	overrides: Partial<Record<keyof typeof READER_ENV, string>> = {},
) {
	Object.assign(process.env, READER_ENV, overrides)
	syncEnvFromProcess()
}

const completion = (payload: unknown) =>
	new Response(
		JSON.stringify({
			choices: [{ message: { content: JSON.stringify(payload) } }],
		}),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	)

describe('invoice-reader', () => {
	afterEach(() => {
		for (const key of Object.keys(READER_ENV)) {
			process.env[key] = ''
		}
		syncEnvFromProcess()
		vi.restoreAllMocks()
	})

	it('checks in-region configuration strictly', () => {
		expect(isInvoiceReaderConfigured()).toBe(false)
		setReaderEnv()
		expect(isInvoiceReaderConfigured()).toBe(true)
		setReaderEnv({ INVOICE_READER_DATA_REGION: 'ksa' })
		expect(isInvoiceReaderConfigured()).toBe(false)
		setReaderEnv({ INVOICE_READER_API_KEY: '' })
		expect(isInvoiceReaderConfigured()).toBe(false)
	})

	it('parses numbers strictly without NaN', () => {
		expect(parseInvoiceNumber('1,234.50')).toBe(1234.5)
		expect(parseInvoiceNumber('1.234,50')).toBe(1234.5)
		expect(parseInvoiceNumber('1,234')).toBe(1234)
		expect(parseInvoiceNumber('SAR 45.25')).toBe(45.25)
		expect(parseInvoiceNumber('N/A')).toBeNull()
		expect(parseInvoiceNumber('-')).toBeNull()
		expect(parseInvoiceNumber(Number.NaN)).toBeNull()
		expect(parseInvoiceNumber(Number.POSITIVE_INFINITY)).toBeNull()
	})

	it('reads both images and PDFs with unitPrice, packSizeText, and strict sanitization', async () => {
		setReaderEnv()
		const sentBodies: any[] = []
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
			sentBodies.push(JSON.parse(String((init as RequestInit).body)))
			return completion({
				supplier: 'Fresh\u0000 Farms',
				invoiceNumber: 'INV-101',
				total: '125.50',
				lines: [
					{
						name: 'Tomatoes\tBox',
						quantity: 5,
						unit: 'box',
						packSize: '6 kg',
						unitPrice: '25.10',
						lineTotal: '125.50',
					},
					{
						name: 'Bad negative',
						quantity: -3,
						unitPrice: 'N/A',
						lineTotal: 99_999_999_999_999,
					},
				],
			})
		})

		const imgRes = await readInvoiceImage({
			bytes: new Uint8Array([137, 80, 78, 71]),
			contentType: 'image/png',
		})
		expect(imgRes).toEqual({
			supplierName: 'Fresh Farms',
			invoiceNumber: 'INV-101',
			total: 125.5,
			lines: [
				{
					text: 'Tomatoes Box',
					quantity: 5,
					unit: 'box',
					packSizeText: '6 kg',
					unitPrice: 25.1,
					lineTotal: 125.5,
				},
				{
					text: 'Bad negative',
					quantity: null,
					unit: null,
					lineTotal: null,
				},
			],
		})
		expect(JSON.stringify(sentBodies[0])).toContain('data:image/png;base64,')

		const simplePdf = new TextEncoder().encode(
			'%PDF-1.4\nBT (Fresh Farms) Tj (Tomatoes 6 kg) Tj ET\n%%EOF',
		)
		const pdfRes = await readInvoiceDocument({
			bytes: simplePdf,
			contentType: 'application/pdf',
			fileName: 'inv-101.pdf',
		})
		expect(pdfRes.supplierName).toBe('Fresh Farms')
		const pdfPayload = JSON.stringify(sentBodies[1])
		expect(pdfPayload).toContain('data:application/pdf;base64,')
		expect(pdfPayload).toContain('Tomatoes 6 kg')
	})

	it('reads price-list documents and caps at MAX_PRICE_LIST_LINES', async () => {
		setReaderEnv()
		const manyLines = Array.from(
			{ length: MAX_PRICE_LIST_LINES + 15 },
			(_, idx) => ({
				name: `Item ${idx + 1}`,
				sku: `SKU-${idx + 1}`,
				packSize: '1 kg',
				unit: 'kg',
				price: idx === 0 ? -10 : 12.5,
				pricedByWeight: idx % 2 === 0,
			}),
		)

		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			completion({ supplier: 'Gulf Foods', lines: manyLines }),
		)

		const result = await readPriceListDocument({
			bytes: new TextEncoder().encode('%PDF-1.4\nBT (Gulf Foods) Tj ET'),
			contentType: 'application/pdf',
			fileName: 'prices.pdf',
		})
		expect(result.supplierName).toBe('Gulf Foods')
		expect(result.truncated).toBe(true)
		expect(result.lines).toHaveLength(MAX_PRICE_LIST_LINES)
		expect(result.lines[0]).toEqual({
			name: 'Item 1',
			sku: 'SKU-1',
			packSizeText: '1 kg',
			unit: 'kg',
			price: null,
			pricedByWeight: true,
		})
		expect(result.lines[1]?.price).toBe(12.5)
	})
})

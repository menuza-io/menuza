import { invoiceReadSchema } from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invDeliveries,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { resetInvoiceReadLimits } from '../services/inventory-invoice-read-service.ts'
import { makeWorld } from './inventory-orders-fixture.ts'
import {
	BASE,
	cid,
	makeClient,
	mintToken,
	READ,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/** Reading a photographed or PDF invoice into lines & warnings (#504). */

const ORG = 'org_inv_read_a'
const LOC = 'loc_read'
const READER = 'https://reader.example.test/v1'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))

const app = new Hono()
app.route(BASE, operatorInventoryRoutes)
const call = makeClient(app)

const storageEnv = {
	RECORDING_S3_BUCKET: 'region-bucket',
	RECORDING_S3_ENDPOINT: 'https://s3.example.test',
	RECORDING_S3_ACCESS_KEY: 'access',
	RECORDING_S3_SECRET: 'secret',
}
const readerEnv = {
	INVOICE_READER_BASE_URL: READER,
	INVOICE_READER_API_KEY: 'reader-key',
	INVOICE_READER_MODEL: 'vision-1',
	INVOICE_READER_DATA_REGION: 'us',
}

let env: ReturnType<typeof setupTenantEnv>
let full: string
let noPurchasing: string
let world: ReturnType<typeof makeWorld>
let supplier: { id: string }
let delivery: { id: string }
let withoutPhoto: { id: string }
let tomatoes: { id: string }
let oliveOil: { id: string }
let tomatoProduct: { id: string }
let oilProduct: { id: string }
let fetchSpy: ReturnType<typeof vi.spyOn>
let readerBodies: any[]
let answer: () => Response

const completion = (content: string) =>
	new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
		status: 200,
		headers: { 'content-type': 'application/json' },
	})

beforeAll(async () => {
	env = setupTenantEnv('inv-read')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	full = await mintToken(ORG)
	noPurchasing = await mintToken(ORG, { grants: [READ, UPDATE] })
	world = makeWorld(call, full, LOC)
	supplier = await world.supplier('Reader Supplier')
	tomatoes = await world.item('Tomatoes')
	oliveOil = await world.item('Olive Oil', 'ml')
	tomatoProduct = await world.product(supplier.id, tomatoes.id, {
		packName: 'Box 10 kg',
		packBaseQuantity: 10_000_000,
		priceMinor: 2000,
	})
	oilProduct = await world.product(supplier.id, oliveOil.id, {
		packName: 'Tin 5 L',
		packBaseQuantity: 5_000_000,
		priceMinor: 5000,
	})
	const make = async () =>
		(
			await world.ok('POST', '/deliveries', {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: supplier.id,
				currency: 'SAR',
				lines: [{ itemId: tomatoes.id, quantity: 1000, lineTotalMinor: 10 }],
			})
		).delivery
	delivery = await make()
	withoutPhoto = await make()
	const db = await getTenantDb(ORG)
	await db
		.update(invDeliveries)
		.set({
			photoKey: `inventory-invoices/${ORG}/${delivery.id}/00000000-0000-4000-8000-000000000000.png`,
			photoContentType: 'image/png',
		})
		.where(eq(invDeliveries.id, delivery.id))
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

afterEach(() => {
	for (const key of [...Object.keys(storageEnv), ...Object.keys(readerEnv)]) {
		process.env[key] = ''
	}
	syncEnvFromProcess()
	fetchSpy?.mockRestore()
	resetInvoiceReadLimits()
})

function withReader(
	reply: () => Response = () =>
		completion(
			'```json\n' +
				JSON.stringify({
					supplier: 'Fresh Farms',
					invoiceNumber: 'INV-77',
					total: '23.50',
					lines: [
						{ name: 'tomatoes ', quantity: 5, unit: 'kg', lineTotal: 12.5 },
						{ name: 'Mystery\u0000 crate', quantity: '2', unit: null },
					],
				}) +
				'\n```',
		),
) {
	Object.assign(process.env, storageEnv, readerEnv)
	syncEnvFromProcess()
	readerBodies = []
	answer = reply
	fetchSpy = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (url, init) => {
			const target = String(url)
			if (target.startsWith(READER)) {
				readerBodies.push(JSON.parse(String((init as RequestInit).body)))
				return answer()
			}
			if (target.startsWith('https://s3.example.test/')) {
				return new Response(new Uint8Array([137, 80, 78, 71]), {
					status: 200,
				})
			}
			throw new Error(`unexpected fetch ${target}`)
		})
}

const read = (id = delivery.id, token = full) =>
	call('POST', `${BASE}/deliveries/${id}/invoice-photo/read`, {
		token,
		body: {},
	})

describe('reading an invoice photo or PDF (#504)', () => {
	it('answers 503 reader_not_configured without a reader, and for a reader in another region', async () => {
		Object.assign(process.env, storageEnv)
		syncEnvFromProcess()
		fetchSpy = vi.spyOn(globalThis, 'fetch')
		const none = await read()
		expect(none.status).toBe(503)
		expect(none.body.code).toBe('reader_not_configured')
		Object.assign(process.env, readerEnv, { INVOICE_READER_DATA_REGION: 'ksa' })
		syncEnvFromProcess()
		const abroad = await read()
		expect(abroad.status).toBe(503)
		expect(abroad.body.code).toBe('reader_not_configured')
		expect(fetchSpy).not.toHaveBeenCalled()

		// Raw invoice read also enforces region check
		const rawAbroad = await call('POST', `${BASE}/deliveries/invoice/read`, {
			token: full,
			body: {
				supplierId: supplier.id,
				fileName: 'inv.pdf',
				contentType: 'application/pdf',
				contentBase64: btoa('%PDF-1.4\n%%EOF'),
			},
		})
		expect(rawAbroad.status).toBe(503)
		expect(rawAbroad.body.code).toBe('reader_not_configured')
	})

	it('needs a stored photo', async () => {
		withReader()
		const res = await read(withoutPhoto.id)
		expect(res.status).toBe(409)
		expect(res.body.code).toBe('no_photo')
		expect(readerBodies).toEqual([])
	})

	it('reads the photo into lines to check, matching items by name and cleaning the text', async () => {
		withReader()
		const res = await read()
		expect(res.status).toBe(200)
		const result = invoiceReadSchema.parse(res.body)
		expect(result).toMatchObject({
			deliveryId: delivery.id,
			supplierName: 'Fresh Farms',
			invoiceNumber: 'INV-77',
			totalMinor: 2350,
			linesSumMinor: 1250,
			invoiceTotalMismatch: true,
		})
		expect(result.lines).toEqual([
			{
				text: 'tomatoes',
				quantity: 5,
				unit: 'kg',
				lineTotalMinor: 1250,
				itemId: tomatoes.id,
				itemName: 'Tomatoes',
				matchedSupplierProductId: tomatoProduct.id,
				expectedPackBaseQuantity: 10_000_000,
				previousPriceMinor: 2000,
				warnings: ['price_change_gt_5pct'],
			},
			{
				text: 'Mystery crate',
				quantity: 2,
				unit: null,
				itemId: null,
				itemName: null,
				warnings: ['unmatched'],
			},
		])
		// The model got the photo as a data URL and an instruction to ignore text on it.
		expect(readerBodies).toHaveLength(1)
		expect(readerBodies[0].model).toBe('vision-1')
		expect(JSON.stringify(readerBodies[0])).toContain('data:image/png;base64,')
		// Nothing was recorded from it.
		const detail = await call('GET', `${BASE}/deliveries/${delivery.id}`, {
			token: full,
		})
		expect(detail.body.lines).toHaveLength(1)
	})

	it('reads a raw PDF invoice via POST /deliveries/invoice/read and flags pack_diff, price_change_gt_5pct, line_total_mismatch, unmatched, and invoiceTotalMismatch', async () => {
		withReader(() =>
			completion(
				JSON.stringify({
					supplier: 'Reader Supplier',
					invoiceNumber: 'INV-900',
					total: 200.0,
					lines: [
						// Tomatoes: packSize 6kg vs expected 10kg (pack_diff); unitPrice 25.00 vs prev 20.00 (price_change_gt_5pct); 2 * 2500 = 5000 vs lineTotal 5500 (line_total_mismatch)
						{
							name: 'Tomatoes',
							quantity: 2,
							unit: 'box',
							packSize: '6 kg',
							unitPrice: 25.0,
							lineTotal: 55.0,
						},
						// Olive Oil: matching 5 L pack (5_000_000), unitPrice 51.00 (2% change, NOT >5%), 2 * 5100 = 10200 vs 10201 (1 minor tolerance -> NO mismatch)
						{
							name: 'Olive Oil',
							quantity: 2,
							unit: 'tin',
							packSize: '5 L',
							unitPrice: 51.0,
							lineTotal: 102.01,
						},
						// Unmatched line
						{
							name: 'Truffle Salt',
							quantity: 1,
							unit: 'jar',
							unitPrice: 10.0,
							lineTotal: 10.0,
						},
					],
				}),
			),
		)

		const res = await call('POST', `${BASE}/deliveries/invoice/read`, {
			token: full,
			body: {
				supplierId: supplier.id,
				fileName: 'invoice-900.pdf',
				contentType: 'application/pdf',
				contentBase64: btoa('%PDF-1.4\nBT (Reader Supplier) Tj ET'),
			},
		})
		expect(res.status).toBe(200)
		const parsed = invoiceReadSchema.parse(res.body)
		expect(parsed.deliveryId).toBe('')
		expect(parsed.totalMinor).toBe(20000)
		expect(parsed.linesSumMinor).toBe(16701)
		expect(parsed.invoiceTotalMismatch).toBe(true)

		expect(parsed.lines[0]).toMatchObject({
			text: 'Tomatoes',
			itemId: tomatoes.id,
			matchedSupplierProductId: tomatoProduct.id,
			packSizeText: '6 kg',
			packBaseQuantity: 6_000_000,
			expectedPackBaseQuantity: 10_000_000,
			unitPriceMinor: 2500,
			lineTotalMinor: 5500,
			previousPriceMinor: 2000,
			warnings: ['pack_diff', 'line_total_mismatch', 'price_change_gt_5pct'],
		})
		expect(parsed.lines[1]).toMatchObject({
			text: 'Olive Oil',
			itemId: oliveOil.id,
			matchedSupplierProductId: oilProduct.id,
			packBaseQuantity: 5_000_000,
			expectedPackBaseQuantity: 5_000_000,
			unitPriceMinor: 5100,
			lineTotalMinor: 10201,
			previousPriceMinor: 5000,
		})
		expect(parsed.lines[1]?.warnings).toBeUndefined()
		expect(parsed.lines[2]).toMatchObject({
			text: 'Truffle Salt',
			itemId: null,
			warnings: ['unmatched'],
		})
		expect(JSON.stringify(readerBodies[0])).toContain(
			'data:application/pdf;base64,',
		)
	})

	it('leaves money out without the cost grant, and refuses a person who cannot price', async () => {
		withReader()
		expect((await read(delivery.id, noPurchasing)).status).toBe(403)
		expect(
			(
				await call('POST', `${BASE}/deliveries/invoice/read`, {
					token: noPurchasing,
					body: {
						fileName: 'inv.png',
						contentType: 'image/png',
						contentBase64: btoa('png'),
					},
				})
			).status,
		).toBe(403)

		const token = await mintToken(ORG, {
			grants: [READ, UPDATE, 'update:inventory_purchasing:any'],
		})
		const res = await read(delivery.id, token)
		expect(res.status).toBe(200)
		expect(res.body).not.toHaveProperty('totalMinor')
		expect(res.body).not.toHaveProperty('linesSumMinor')
		expect(res.body).not.toHaveProperty('invoiceTotalMismatch')
		expect(res.body.lines[0]).not.toHaveProperty('lineTotalMinor')
		expect(res.body.lines[0]).not.toHaveProperty('unitPriceMinor')
		expect(res.body.lines[0]).not.toHaveProperty('previousPriceMinor')
	})

	it('answers 502 reader_failed on a bad or unavailable answer, without echoing it', async () => {
		withReader(() => completion('sorry, I cannot read that'))
		const bad = await read()
		expect(bad.status).toBe(502)
		expect(bad.body.code).toBe('reader_failed')
		expect(JSON.stringify(bad.body)).not.toContain('sorry')
		answer = () => new Response('boom', { status: 500 })
		expect((await read()).status).toBe(502)
	})

	it('refuses a body and an unknown delivery', async () => {
		withReader()
		const res = await call(
			'POST',
			`${BASE}/deliveries/${delivery.id}/invoice-photo/read`,
			{ token: full, body: { url: 'https://evil.example' } },
		)
		expect(res.status).toBe(400)
		expect((await read('nope_delivery')).status).toBe(404)
	})
})

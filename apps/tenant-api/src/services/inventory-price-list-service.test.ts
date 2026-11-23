import {
	MAX_PRICE_LIST_LINES,
	priceHistoryResultSchema,
	priceListApplyResultSchema,
	priceListParseResultSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invItems,
	invSupplierProductPrices,
	invSupplierProducts,
	provisionTenantDb,
} from '@repo/tenant-db'
import { isNull } from 'drizzle-orm'
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
import { makeWorld } from '../routes/inventory-orders-fixture.ts'
import {
	BASE,
	COST,
	makeClient,
	mintToken,
	PURCHASING,
	READ,
	setupTenantEnv,
	UPDATE,
} from '../routes/inventory-test-utils.ts'
import { operatorInventoryRoutes } from '../routes/operator-inventory.ts'
import { parsePackSpec } from './inventory-price-list-service.ts'

const ORG = 'org_price_list_a'
const LOC = 'loc_pl'
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

const READER_ENV = {
	INVOICE_READER_BASE_URL: READER,
	INVOICE_READER_API_KEY: 'reader-key',
	INVOICE_READER_MODEL: 'vision-1',
	INVOICE_READER_DATA_REGION: 'us',
}

function toBase64(bytes: Uint8Array): string {
	let bin = ''
	for (const b of bytes) bin += String.fromCharCode(b)
	return btoa(bin)
}

function textBase64(text: string): string {
	return toBase64(new TextEncoder().encode(text))
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

function colLetters(idx: number): string {
	let n = idx + 1
	let out = ''
	while (n > 0) {
		const rem = (n - 1) % 26
		out = String.fromCharCode(65 + rem) + out
		n = Math.floor((n - 1) / 26)
	}
	return out
}

/** Builds a valid stored-entry (method 0) XLSX archive for tests. */
function buildTestXlsx(rows: string[][]): Uint8Array {
	const sharedStrings: string[] = []
	const sharedIndex = new Map<string, number>()
	const intern = (s: string): number => {
		const existing = sharedIndex.get(s)
		if (existing !== undefined) return existing
		const idx = sharedStrings.length
		sharedStrings.push(s)
		sharedIndex.set(s, idx)
		return idx
	}

	const rowXml = rows
		.map((cells, rIdx) => {
			const cXml = cells
				.map((val, cIdx) => {
					const idx = intern(val)
					return `<c r="${colLetters(cIdx)}${rIdx + 1}" t="s"><v>${idx}</v></c>`
				})
				.join('')
			return `<row r="${rIdx + 1}">${cXml}</row>`
		})
		.join('')

	const sstXml = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${sharedStrings.map((s) => `<si><t>${escapeXml(s)}</t></si>`).join('')}</sst>`
	const sheetXml = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`

	const files = [
		{
			name: 'xl/sharedStrings.xml',
			data: new TextEncoder().encode(sstXml),
		},
		{
			name: 'xl/worksheets/sheet1.xml',
			data: new TextEncoder().encode(sheetXml),
		},
	]

	const localParts: Uint8Array[] = []
	const centralParts: Uint8Array[] = []
	let offset = 0

	for (const file of files) {
		const nameBytes = new TextEncoder().encode(file.name)
		const local = new Uint8Array(30 + nameBytes.length + file.data.length)
		const lv = new DataView(local.buffer)
		lv.setUint32(0, 0x04034b50, true)
		lv.setUint16(4, 20, true)
		lv.setUint16(8, 0, true)
		lv.setUint32(18, file.data.length, true)
		lv.setUint32(22, file.data.length, true)
		lv.setUint16(26, nameBytes.length, true)
		local.set(nameBytes, 30)
		local.set(file.data, 30 + nameBytes.length)
		localParts.push(local)

		const central = new Uint8Array(46 + nameBytes.length)
		const cv = new DataView(central.buffer)
		cv.setUint32(0, 0x02014b50, true)
		cv.setUint16(4, 20, true)
		cv.setUint16(6, 20, true)
		cv.setUint16(10, 0, true)
		cv.setUint32(20, file.data.length, true)
		cv.setUint32(24, file.data.length, true)
		cv.setUint16(28, nameBytes.length, true)
		cv.setUint32(42, offset, true)
		central.set(nameBytes, 46)
		centralParts.push(central)

		offset += local.length
	}

	const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0)
	const eocd = new Uint8Array(22)
	const ev = new DataView(eocd.buffer)
	ev.setUint32(0, 0x06054b50, true)
	ev.setUint16(8, files.length, true)
	ev.setUint16(10, files.length, true)
	ev.setUint32(12, centralSize, true)
	ev.setUint32(16, offset, true)

	const totalSize = offset + centralSize + eocd.length
	const out = new Uint8Array(totalSize)
	let pos = 0
	for (const part of localParts) {
		out.set(part, pos)
		pos += part.length
	}
	for (const part of centralParts) {
		out.set(part, pos)
		pos += part.length
	}
	out.set(eocd, pos)
	return out
}

let env: ReturnType<typeof setupTenantEnv>
let full: string
let noCost: string
let noPurchasing: string
let world: ReturnType<typeof makeWorld>

beforeAll(async () => {
	env = setupTenantEnv('price-list')
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
	noCost = await mintToken(ORG, { grants: [READ, UPDATE, PURCHASING] })
	noPurchasing = await mintToken(ORG, { grants: [READ, UPDATE, COST] })
	world = makeWorld(call, full, LOC)
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

afterEach(() => {
	for (const key of Object.keys(READER_ENV)) {
		process.env[key] = ''
	}
	syncEnvFromProcess()
	vi.restoreAllMocks()
})

describe('inventory price-list service (#505)', () => {
	it('parses pack size specs accurately into base units', () => {
		expect(parsePackSpec({ packSizeText: '6 kg' })).toMatchObject({
			packName: '6 kg',
			packBaseQuantity: 6_000_000,
			baseUnit: 'g',
			recognizedUnit: true,
		})
		expect(parsePackSpec({ packSizeText: '1x10kg' })).toMatchObject({
			packName: '1x10kg',
			packBaseQuantity: 10_000_000,
			baseUnit: 'g',
			recognizedUnit: true,
		})
		expect(parsePackSpec({ packSizeText: '500 g' })).toMatchObject({
			packBaseQuantity: 500_000,
			baseUnit: 'g',
		})
		expect(parsePackSpec({ packSizeText: '1 L' })).toMatchObject({
			packBaseQuantity: 1_000_000,
			baseUnit: 'ml',
		})
		expect(parsePackSpec({ packSizeText: '24 pcs' })).toMatchObject({
			packBaseQuantity: 24_000,
			baseUnit: 'piece',
		})
	})

	it('AC1 & AC2: 50-line CSV proposes 50 products without DB writes or model calls, and re-import detects exactly 2 changed prices + gone products + price history', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const supplier = await world.supplier('Desert Produce')
		const existingItem = await world.item('Item 1', 'g')
		const goneItem = await world.item('Discontinued Mint', 'g')
		const goneProduct = await world.product(supplier.id, goneItem.id, {
			packName: '1 kg',
			packBaseQuantity: 1_000_000,
			priceMinor: 900,
			sku: 'GONE-1',
		})

		const csvRows = ['SKU,Name,Pack Size,Price,Category']
		for (let i = 1; i <= 50; i++) {
			csvRows.push(`SKU-${i},Item ${i},6 kg,${(10 + i).toFixed(2)},produce`)
		}
		const csvContent = csvRows.join('\n')

		const parseRes = await call(
			'POST',
			`${BASE}/suppliers/${supplier.id}/price-list/parse`,
			{
				token: full,
				body: {
					fileName: 'price-list.csv',
					contentType: 'text/csv',
					contentBase64: textBase64(csvContent),
				},
			},
		)
		expect(parseRes.status).toBe(200)
		const parsed = priceListParseResultSchema.parse(parseRes.body)
		expect(parsed.fileKind).toBe('csv')
		expect(parsed.truncated).toBe(false)
		expect(parsed.totalParsed).toBe(50)
		expect(parsed.lines).toHaveLength(50)
		expect(parsed.lines[0]).toMatchObject({
			sku: 'SKU-1',
			name: 'Item 1',
			packBaseQuantity: 6_000_000,
			baseUnit: 'g',
			priceMinor: 1100,
			matchKind: 'matched_item',
			matchedItemId: existingItem.id,
			changeKind: 'new',
		})
		expect(parsed.lines[1]).toMatchObject({
			sku: 'SKU-2',
			name: 'Item 2',
			matchKind: 'new_item',
			matchedItemId: null,
			changeKind: 'new',
		})
		expect(parsed.goneProducts).toHaveLength(1)
		expect(parsed.goneProducts[0]?.productId).toBe(goneProduct.id)
		const modelCalls = fetchSpy.mock.calls.filter(([url]) =>
			String(url).includes('/chat/completions'),
		)
		expect(modelCalls).toHaveLength(0)

		// Nothing saved during /parse!
		const db = await getTenantDb(ORG)
		const productsBeforeApply = await db
			.select()
			.from(invSupplierProducts)
			.where(isNull(invSupplierProducts.archivedAt))
		expect(productsBeforeApply).toHaveLength(1)

		// Apply all 50 lines with import effectiveDate
		const applyRes = await call(
			'POST',
			`${BASE}/suppliers/${supplier.id}/price-list/apply`,
			{
				token: full,
				body: {
					effectiveDate: '2026-10-15',
					currency: 'SAR',
					lines: parsed.lines.map((line) => ({
						action: 'upsert' as const,
						existingProductId: line.existingProductId,
						matchedItemId: line.matchedItemId,
						...(line.matchedItemId
							? {}
							: {
									createItem: {
										name: line.name,
										baseUnit: line.baseUnit,
										category: line.category,
									},
								}),
						packName: line.packName,
						packBaseQuantity: line.packBaseQuantity,
						priceMinor: line.priceMinor!,
						pricedByWeight: line.pricedByWeight,
						sku: line.sku,
					})),
				},
			},
		)
		expect(applyRes.status).toBe(200)
		const applied = priceListApplyResultSchema.parse(applyRes.body)
		expect(applied).toEqual({
			createdItems: 49,
			createdProducts: 50,
			updatedProducts: 0,
			archivedProducts: 0,
			recordedPrices: 50,
		})

		// Re-import with 2 new prices (#3 and #17) + 1 brand-new item (#51), leaving goneProduct out
		const reimportRows = ['SKU,Name,Pack Size,Price,Category']
		for (let i = 1; i <= 50; i++) {
			const price = i === 3 ? 99.5 : i === 17 ? 88.25 : 10 + i
			reimportRows.push(`SKU-${i},Item ${i},6 kg,${price.toFixed(2)},produce`)
		}
		reimportRows.push('SKU-51,Fresh Parsley,500 g,8.50,produce')

		const reparseRes = await call(
			'POST',
			`${BASE}/suppliers/${supplier.id}/price-list/parse`,
			{
				token: full,
				body: {
					fileName: 'price-list-v2.csv',
					contentType: 'text/csv',
					contentBase64: textBase64(reimportRows.join('\n')),
				},
			},
		)
		expect(reparseRes.status).toBe(200)
		const reparsed = priceListParseResultSchema.parse(reparseRes.body)
		expect(reparsed.lines).toHaveLength(51)
		const changed = reparsed.lines.filter(
			(l) => l.changeKind === 'price_changed',
		)
		const unchanged = reparsed.lines.filter((l) => l.changeKind === 'unchanged')
		const created = reparsed.lines.filter((l) => l.changeKind === 'new')
		expect(changed.map((c) => c.sku)).toEqual(['SKU-3', 'SKU-17'])
		expect(changed[0]?.previousPriceMinor).toBe(1300)
		expect(changed[0]?.priceMinor).toBe(9950)
		expect(unchanged).toHaveLength(48)
		expect(created.map((c) => c.sku)).toEqual(['SKU-51'])
		expect(reparsed.goneProducts.map((g) => g.productId)).toEqual([
			goneProduct.id,
		])

		// Apply the 2 price changes and archive goneProduct
		const reapplyRes = await call(
			'POST',
			`${BASE}/suppliers/${supplier.id}/price-list/apply`,
			{
				token: full,
				body: {
					effectiveDate: '2026-10-20',
					currency: 'SAR',
					lines: changed.map((line) => ({
						action: 'upsert' as const,
						existingProductId: line.existingProductId,
						matchedItemId: line.matchedItemId,
						packName: line.packName,
						packBaseQuantity: line.packBaseQuantity,
						priceMinor: line.priceMinor!,
						pricedByWeight: false,
						sku: line.sku,
					})),
					archiveGoneProductIds: [goneProduct.id],
				},
			},
		)
		expect(reapplyRes.status).toBe(200)
		expect(reapplyRes.body).toEqual({
			createdItems: 0,
			createdProducts: 0,
			updatedProducts: 2,
			archivedProducts: 1,
			recordedPrices: 2,
		})

		const prod3Id = changed[0]!.existingProductId!
		const prod3HistoryRes = await call(
			'GET',
			`${BASE}/supplier-products/${prod3Id}/prices`,
			{ token: full },
		)
		expect(prod3HistoryRes.status).toBe(200)
		const prod3History = priceHistoryResultSchema.parse(prod3HistoryRes.body)
		expect(prod3History.entries).toHaveLength(2)
		expect(prod3History.entries[0]!.priceMinor).toBe(9950)
		expect(prod3History.entries[0]!.effectiveAt).toBe(
			Date.parse('2026-10-20T12:00:00.000Z'),
		)
		expect(prod3History.entries[0]!.source).toBe('price_list')
		expect(prod3History.entries[1]!.priceMinor).toBe(1300)
		expect(prod3History.entries[1]!.effectiveAt).toBe(
			Date.parse('2026-10-15T12:00:00.000Z'),
		)

		const item3HistoryRes = await call(
			'GET',
			`${BASE}/items/${changed[0]!.matchedItemId}/price-history`,
			{ token: full },
		)
		expect(item3HistoryRes.status).toBe(200)
		expect(item3HistoryRes.body.entries).toHaveLength(2)

		// Permission enforcement
		expect(
			(
				await call('GET', `${BASE}/supplier-products/${prod3Id}/prices`, {
					token: noCost,
				})
			).status,
		).toBe(403)
		expect(
			(
				await call(
					'POST',
					`${BASE}/suppliers/${supplier.id}/price-list/parse`,
					{
						token: noPurchasing,
						body: {
							fileName: 'p.csv',
							contentType: 'text/csv',
							contentBase64: textBase64('Name,Price\nSalt,5'),
						},
					},
				)
			).status,
		).toBe(403)

		const priceRows = await db.select().from(invSupplierProductPrices)
		expect(priceRows.length).toBe(52)
	})

	it('parses XLSX spreadsheets deterministically without calling the model', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const supplier = await world.supplier('XLSX Dairy')
		const xlsxBytes = buildTestXlsx([
			['Item', 'SKU', 'Pack', 'Price', 'Category'],
			['Whole Milk', 'MILK-1', '1 L', '6.50', 'dairy'],
			['Mozzarella', 'MOZ-2', '1x10kg', '180.00', 'dairy'],
		])

		const res = await call(
			'POST',
			`${BASE}/suppliers/${supplier.id}/price-list/parse`,
			{
				token: full,
				body: {
					fileName: 'dairy.xlsx',
					contentType:
						'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
					contentBase64: toBase64(xlsxBytes),
				},
			},
		)
		expect(res.status).toBe(200)
		const parsed = priceListParseResultSchema.parse(res.body)
		expect(parsed.fileKind).toBe('xlsx')
		expect(parsed.lines).toHaveLength(2)
		expect(parsed.lines[0]).toMatchObject({
			name: 'Whole Milk',
			sku: 'MILK-1',
			packBaseQuantity: 1_000_000,
			baseUnit: 'ml',
			priceMinor: 650,
			category: 'dairy',
		})
		expect(parsed.lines[1]).toMatchObject({
			name: 'Mozzarella',
			sku: 'MOZ-2',
			packBaseQuantity: 10_000_000,
			baseUnit: 'g',
			priceMinor: 18000,
		})
		const modelCalls = fetchSpy.mock.calls.filter(([url]) =>
			String(url).includes('/chat/completions'),
		)
		expect(modelCalls).toHaveLength(0)
	})

	it('caps CSV at MAX_PRICE_LIST_LINES (500) and marks truncated', async () => {
		const supplier = await world.supplier('Big Catalog')
		const rows = ['Name,Pack,Price']
		for (let i = 1; i <= MAX_PRICE_LIST_LINES + 25; i++) {
			rows.push(`Bulk Spice ${i},1 kg,12.00`)
		}
		const res = await call(
			'POST',
			`${BASE}/suppliers/${supplier.id}/price-list/parse`,
			{
				token: full,
				body: {
					fileName: 'big.csv',
					contentType: 'text/csv',
					contentBase64: textBase64(rows.join('\n')),
				},
			},
		)
		expect(res.status).toBe(200)
		expect(res.body.truncated).toBe(true)
		expect(res.body.lines).toHaveLength(MAX_PRICE_LIST_LINES)
		expect(res.body.totalParsed).toBe(MAX_PRICE_LIST_LINES)
	})

	it('uses regional reader for PDF/photo price lists and refuses 503 when unconfigured', async () => {
		const supplier = await world.supplier('PDF Bakery')
		const unconfigured = await call(
			'POST',
			`${BASE}/suppliers/${supplier.id}/price-list/parse`,
			{
				token: full,
				body: {
					fileName: 'bakery.pdf',
					contentType: 'application/pdf',
					contentBase64: textBase64('%PDF-1.4\n%%EOF'),
				},
			},
		)
		expect(unconfigured.status).toBe(503)
		expect(unconfigured.body.code).toBe('reader_not_configured')

		Object.assign(process.env, READER_ENV)
		syncEnvFromProcess()
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									supplier: 'PDF Bakery',
									lines: [
										{
											name: 'Burger Buns',
											sku: 'BUN-24',
											packSize: '24 pcs',
											unit: 'pcs',
											price: 18.0,
											pricedByWeight: false,
										},
									],
								}),
							},
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		)

		const okRes = await call(
			'POST',
			`${BASE}/suppliers/${supplier.id}/price-list/parse`,
			{
				token: full,
				body: {
					fileName: 'bakery.pdf',
					contentType: 'application/pdf',
					contentBase64: textBase64('%PDF-1.4\nBT (Burger Buns) Tj ET'),
				},
			},
		)
		expect(okRes.status).toBe(200)
		const parsed = priceListParseResultSchema.parse(okRes.body)
		expect(parsed.fileKind).toBe('pdf')
		expect(parsed.lines[0]).toMatchObject({
			name: 'Burger Buns',
			sku: 'BUN-24',
			packBaseQuantity: 24_000,
			baseUnit: 'piece',
			priceMinor: 1800,
		})
	})
})

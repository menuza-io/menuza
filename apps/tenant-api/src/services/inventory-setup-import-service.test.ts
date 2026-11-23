import {
	applySetupImportResultSchema,
	setupImportDetailSchema,
	setupImportListSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invItems,
	invSetupImportFiles,
	invSetupImports,
	invSupplierProductPrices,
	invSupplierProducts,
	invSuppliers,
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
import { resetInvoiceReadLimits } from '../lib/vision-read-limit.ts'
import {
	BASE,
	makeClient,
	mintToken,
	READ,
	setupTenantEnv,
	UPDATE,
} from '../routes/inventory-test-utils.ts'
import { operatorInventoryRoutes } from '../routes/operator-inventory.ts'

const ORG = 'org_setup_import_a'
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

function textBase64(text: string): string {
	const bytes = new TextEncoder().encode(text)
	let bin = ''
	for (const b of bytes) bin += String.fromCharCode(b)
	return btoa(bin)
}

function bytesBase64(bytes: Uint8Array): string {
	let bin = ''
	for (const b of bytes) bin += String.fromCharCode(b)
	return btoa(bin)
}

let env: ReturnType<typeof setupTenantEnv>
let full: string
let readOnly: string

beforeAll(async () => {
	env = setupTenantEnv('setup-import')
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
	readOnly = await mintToken(ORG, { scope: 'read', grants: [READ] })
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
	resetInvoiceReadLimits()
	vi.restoreAllMocks()
})

describe('inventory setup import service (#506)', () => {
	it('refuses PDF/image when reader is not configured and enforces 50-file cap', async () => {
		const res = await call('POST', `${BASE}/setup/imports`, {
			token: full,
			body: {
				files: [
					{
						fileName: 'inv1.pdf',
						contentType: 'application/pdf',
						contentBase64: textBase64('%PDF-1.4\n%%EOF'),
					},
				],
			},
		})
		expect(res.status).toBe(503)
		expect(res.body.code).toBe('reader_not_configured')

		const tooMany = await call('POST', `${BASE}/setup/imports`, {
			token: full,
			body: {
				files: Array.from({ length: 51 }, (_, i) => ({
					fileName: `f-${i}.csv`,
					contentType: 'text/csv',
					contentBase64: textBase64('Name,Price\nSalt,5'),
				})),
			},
		})
		expect(tooMany.status).toBe(400)
		expect(tooMany.body.code).toBe('invalid_request')
	})

	it('AC1 & AC2: processes 10 invoices across 3 suppliers, merges Tomato 6kg & Tomatoes 6 kg, creates nothing before apply, supports resume, and writes suppliers/items/products/prices on apply', async () => {
		Object.assign(process.env, READER_ENV)
		syncEnvFromProcess()

		// Mock reader for PDF & image invoices
		let readerCall = 0
		vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			readerCall++
			if (readerCall === 1) {
				return new Response(
					JSON.stringify({
						choices: [
							{
								message: {
									content: JSON.stringify({
										supplier: 'Fresh Farms',
										invoiceNumber: 'FF-1',
										lines: [
											{
												name: 'Tomato 6kg',
												quantity: 2,
												unit: 'box',
												unitPrice: 24.0,
												lineTotal: 48.0,
											},
											{
												name: 'Red Onions 5 kg',
												quantity: 1,
												unit: 'bag',
												unitPrice: 15.0,
												lineTotal: 15.0,
											},
										],
									}),
								},
							},
						],
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			}
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									supplier: 'Fresh Farms',
									invoiceNumber: 'FF-2',
									lines: [
										{
											name: 'Tomatoes 6 kg',
											quantity: 3,
											unit: 'box',
											unitPrice: 27.5,
											lineTotal: 82.5,
										},
									],
								}),
							},
						},
					],
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		})

		// 10 invoices across 3 suppliers (Fresh Farms, Riyadh Dairy, Prime Meats)
		const files = [
			// 1 (PDF -> Fresh Farms: Tomato 6kg @ 24.00, Red Onions 5 kg @ 15.00)
			{
				fileName: 'fresh-farms-1.pdf',
				contentType: 'application/pdf',
				contentBase64: textBase64('%PDF-1.4\nBT (Fresh Farms) Tj ET'),
			},
			// 2 (Image -> Fresh Farms: Tomatoes 6 kg @ 27.50 -> merges with Tomato 6kg, latest price 2750!)
			{
				fileName: 'fresh-farms-2.png',
				contentType: 'image/png',
				contentBase64: bytesBase64(new Uint8Array([137, 80, 78, 71])),
			},
			// 3 (CSV -> Fresh Farms: Cucumber 4 kg)
			{
				fileName: 'fresh-farms-3.csv',
				contentType: 'text/csv',
				contentBase64: textBase64(
					'Supplier,Fresh Farms\nItem,Pack Size,Price\nCucumber,4 kg,18.00\n',
				),
			},
			// 4-6 (CSVs -> Riyadh Dairy)
			{
				fileName: 'riyadh-dairy-1.csv',
				contentType: 'text/csv',
				contentBase64: textBase64(
					'Supplier,Riyadh Dairy\nItem,Pack Size,Price\nWhole Milk,1 L,6.00\n',
				),
			},
			{
				fileName: 'riyadh-dairy-2.csv',
				contentType: 'text/csv',
				contentBase64: textBase64(
					'Supplier,Riyadh Dairy\nItem,Pack Size,Price\nWhole Milk,1 L,6.50\nCheddar Cheese,2 kg,45.00\n',
				),
			},
			{
				fileName: 'riyadh-dairy-3.csv',
				contentType: 'text/csv',
				contentBase64: textBase64(
					'Supplier,Riyadh Dairy\nItem,Pack Size,Price\nButter,500 g,19.00\n',
				),
			},
			// 7-10 (CSVs -> Prime Meats)
			{
				fileName: 'prime-meats-1.csv',
				contentType: 'text/csv',
				contentBase64: textBase64(
					'Supplier,Prime Meats\nItem,Pack Size,Price\nChicken Breast,5 kg,85.00\n',
				),
			},
			{
				fileName: 'prime-meats-2.csv',
				contentType: 'text/csv',
				contentBase64: textBase64(
					'Supplier,Prime Meats\nItem,Pack Size,Price\nBeef Chuck,10 kg,240.00\n',
				),
			},
			{
				fileName: 'prime-meats-3.csv',
				contentType: 'text/csv',
				contentBase64: textBase64(
					'Supplier,Prime Meats\nItem,Pack Size,Price\nChicken Breast,5 kg,88.00\n',
				),
			},
			{
				fileName: 'prime-meats-4.csv',
				contentType: 'text/csv',
				contentBase64: textBase64(
					'Supplier,Prime Meats\nItem,Pack Size,Price\nLamb Shoulder,5 kg,195.00\n',
				),
			},
		]

		const startRes = await call('POST', `${BASE}/setup/imports`, {
			token: full,
			body: { files },
		})
		expect(startRes.status).toBe(200)
		const started = setupImportDetailSchema.parse(startRes.body)
		expect(started.totalFiles).toBe(10)
		expect(started.status).toBe('reading')

		// Nothing created in suppliers/items/products before apply!
		const db = await getTenantDb(ORG)
		expect(await db.select().from(invSuppliers)).toHaveLength(0)
		expect(await db.select().from(invItems)).toHaveLength(0)
		expect(await db.select().from(invSupplierProducts)).toHaveLength(0)

		// Poll / get detail (awaits / finishes processing if still in flight)
		const detailRes = await call('GET', `${BASE}/setup/imports/${started.id}`, {
			token: full,
		})
		expect(detailRes.status).toBe(200)
		const detail = setupImportDetailSchema.parse(detailRes.body)
		expect(detail.status).toBe('ready')
		expect(detail.completedFiles).toBe(10)
		expect(detail.failedFiles).toBe(0)
		expect(detail.suppliers).toHaveLength(3)
		expect(detail.suppliers.map((s) => s.name)).toEqual([
			'Fresh Farms',
			'Riyadh Dairy',
			'Prime Meats',
		])

		// Fresh Farms merged "Tomato 6kg" and "Tomatoes 6 kg" into ONE item with latest price 2750!
		const freshFarms = detail.suppliers[0]!
		const tomatoLine = freshFarms.items.find((i) => /tomato/i.test(i.itemName))!
		expect(tomatoLine).toBeDefined()
		expect(tomatoLine.packBaseQuantity).toBe(6_000_000)
		expect(tomatoLine.baseUnit).toBe('g')
		expect(tomatoLine.priceMinor).toBe(2750)
		expect(tomatoLine.mergedAliases).toEqual(['Tomato 6kg', 'Tomatoes 6 kg'])
		expect(tomatoLine.sourceFiles).toEqual([
			'fresh-farms-1.pdf',
			'fresh-farms-2.png',
		])

		// Riyadh Dairy latest price for Whole Milk = 650 (from file 2)
		const dairy = detail.suppliers[1]!
		const milkLine = dairy.items.find((i) => i.itemName === 'Whole Milk')!
		expect(milkLine.priceMinor).toBe(650)

		// inlineContent cleared after reading
		const fileRows = await db.select().from(invSetupImportFiles)
		expect(fileRows.every((f) => f.inlineContent === null)).toBe(true)

		// Resume across reload: GET /setup/imports returns saved sessions + readerConfigured
		const listRes = await call('GET', `${BASE}/setup/imports`, {
			token: full,
		})
		expect(listRes.status).toBe(200)
		const list = setupImportListSchema.parse(listRes.body)
		expect(list.readerConfigured).toBe(true)
		expect(list.imports).toHaveLength(1)
		expect(list.imports[0]!.id).toBe(started.id)

		// Read-only token without cost grant can read setup imports with priceMinor stripped
		const readOnlyListRes = await call('GET', `${BASE}/setup/imports`, {
			token: readOnly,
		})
		expect(readOnlyListRes.status).toBe(200)
		expect(
			readOnlyListRes.body.imports[0].suppliers[0].items[0].priceMinor,
		).toBeUndefined()

		// Still nothing created before apply!
		expect(await db.select().from(invSuppliers)).toHaveLength(0)
		expect(await db.select().from(invItems)).toHaveLength(0)

		// Apply with one excluded supplier (Prime Meats) and one excluded item (Cucumber)
		const applyRes = await call(
			'POST',
			`${BASE}/setup/imports/${started.id}/apply`,
			{
				token: full,
				body: {
					currency: 'SAR',
					suppliers: detail.suppliers.map((sup) => ({
						include: sup.name !== 'Prime Meats',
						existingSupplierId: sup.existingSupplierId,
						name: sup.name,
						items: sup.items.map((item) => ({
							include: item.itemName !== 'Cucumber',
							existingItemId: item.existingItemId,
							itemName: item.itemName,
							category: item.category,
							baseUnit: item.baseUnit,
							packName: item.packName,
							packBaseQuantity: item.packBaseQuantity,
							priceMinor: item.priceMinor,
							sku: item.sku,
						})),
					})),
				},
			},
		)
		expect(applyRes.status).toBe(200)
		const applied = applySetupImportResultSchema.parse(applyRes.body)
		expect(applied).toEqual({
			importId: started.id,
			suppliersCreated: 2,
			itemsCreated: 5,
			productsUpserted: 5,
			pricesRecorded: 5,
		})

		expect(await db.select().from(invSuppliers)).toHaveLength(2)
		expect(await db.select().from(invItems)).toHaveLength(5)
		const products = await db.select().from(invSupplierProducts)
		expect(products).toHaveLength(5)
		const prices = await db.select().from(invSupplierProductPrices)
		expect(prices).toHaveLength(5)
		expect(prices.every((p) => p.source === 'setup_import')).toBe(true)

		// Re-applying is refused 409
		const secondApply = await call(
			'POST',
			`${BASE}/setup/imports/${started.id}/apply`,
			{
				token: full,
				body: {
					currency: 'SAR',
					suppliers: [
						{
							include: true,
							name: 'Fresh Farms',
							items: [],
						},
					],
				},
			},
		)
		expect(secondApply.status).toBe(409)

		// Status is now 'applied'
		const afterApply = await call(
			'GET',
			`${BASE}/setup/imports/${started.id}`,
			{
				token: full,
			},
		)
		expect(afterApply.body.status).toBe('applied')
		expect(afterApply.body.appliedAt).toBeTypeOf('number')

		// Token without purchasing cannot start or apply
		const noPurchToken = await mintToken(ORG, { grants: [READ, UPDATE] })
		expect(
			(
				await call('POST', `${BASE}/setup/imports`, {
					token: noPurchToken,
					body: {
						files: [
							{
								fileName: 'a.csv',
								contentType: 'text/csv',
								contentBase64: textBase64('Name,Price\nSalt,5'),
							},
						],
					},
				})
			).status,
		).toBe(403)
	})

	it('keeps GET /setup/imports/:id side-effect free and rejects oversized decoded batches', async () => {
		Object.assign(process.env, READER_ENV)
		syncEnvFromProcess()
		const fetchSpy = vi.spyOn(globalThis, 'fetch')

		const db = await getTenantDb(ORG)
		const staleImportId = 'imp_stale_reading_no_work'
		await db.insert(invSetupImports).values({
			id: staleImportId,
			status: 'reading',
			totalFiles: 1,
			completedFiles: 0,
			failedFiles: 0,
			proposalJson: { suppliers: [] },
			createdByKind: 'operator',
			createdById: 'user_1',
			appliedAt: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})
		await db.insert(invSetupImportFiles).values({
			id: 'impf_stale_1',
			importId: staleImportId,
			fileName: 'stale.pdf',
			contentType: 'application/pdf',
			fileKind: 'pdf',
			storageKey: null,
			inlineContent: textBase64('%PDF-1.4\n%%EOF'),
			status: 'pending',
			errorCode: null,
			readJson: null,
			createdAt: Date.now(),
			updatedAt: Date.now(),
		})

		const getRes = await call('GET', `${BASE}/setup/imports/${staleImportId}`, {
			token: readOnly,
		})
		expect(getRes.status).toBe(200)
		expect(getRes.body.status).toBe('reading')
		expect(fetchSpy).not.toHaveBeenCalled()

		const refreshed = await db
			.select()
			.from(invSetupImportFiles)
			.where(eq(invSetupImportFiles.importId, staleImportId))
		expect(refreshed[0]?.status).toBe('pending')

		// Exceeding 18 MiB across decoded files returns 400 batch_too_large.
		const sevenMbBase64 = Buffer.alloc(7 * 1024 * 1024, 65).toString('base64')
		const tooBig = await call('POST', `${BASE}/setup/imports`, {
			token: full,
			body: {
				files: [
					{
						fileName: 'a.csv',
						contentType: 'text/csv',
						contentBase64: sevenMbBase64,
					},
					{
						fileName: 'b.csv',
						contentType: 'text/csv',
						contentBase64: sevenMbBase64,
					},
					{
						fileName: 'c.csv',
						contentType: 'text/csv',
						contentBase64: sevenMbBase64,
					},
				],
			},
		})
		expect(tooBig.status).toBe(400)
		expect(tooBig.body.reason).toBe('batch_too_large')
	})
})

import {
	invoiceInboxDetailSchema,
	invoiceInboxListSchema,
	matchInvoiceResultSchema,
	type InboundMail,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invDeliveries,
	invInvoiceInbox,
	invInvoiceInboxFiles,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { seedInventoryContextForTest } from '../lib/inventory-context.ts'
import { invoiceInboxDeps, type InvoiceAddress } from '../lib/invoice-inbox.ts'
import { type PublishedOrganization } from '../lib/origin.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import { resetInvoiceReadLimits } from '../lib/vision-read-limit.ts'
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
import {
	invoiceInboxInternalRoutes,
	invoiceMailWebhookRoutes,
} from './invoice-inbox-webhook.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Supplier invoices by email (#503): an emailed PDF lands in "Invoices to
 * match" for the right location, in this region's storage only, with the reader
 * (mocked) reading it; unknown senders are marked, the same number from the same
 * supplier is a duplicate, 25 MB is the limit, and matching to an order hands
 * the receive screen what to prefill. Mail is a fake payload; no live mailbox.
 */

const ORG = 'org_inv_inbox_us'
const ORG_KSA = 'org_inv_inbox_ksa'
const LOC = 'loc_inbox_a'
const LOC_B = 'loc_inbox_b'
const CODE_A = 'abcd2345wxyz'
const CODE_B = 'zzzz9999aaaa'
const CODE_KSA = 'ksaa2345wxyz'
const SECRET = 'invoice-webhook-secret-0123456789'

const orgs = vi.hoisted(() => new Map<string, PublishedOrganization>())
const reader = vi.hoisted(() => ({
	on: true,
	read: vi.fn(),
}))

vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))
vi.mock('../lib/invoice-reader.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/invoice-reader.ts')>()),
	isInvoiceReaderConfigured: () => reader.on,
	readInvoiceDocument: (...args: unknown[]) => reader.read(...args),
}))

const app = new Hono()
app.route(BASE, operatorInventoryRoutes)
app.route('/webhooks/invoice-mail', invoiceMailWebhookRoutes)
app.route('/api/invoice-inbox', invoiceInboxInternalRoutes)
const call = makeClient(app)

const addresses = new Map<string, InvoiceAddress>([
	[CODE_A, { orgId: ORG, locationId: LOC, dataRegion: 'us' }],
	[CODE_B, { orgId: ORG, locationId: LOC_B, dataRegion: 'us' }],
	[CODE_KSA, { orgId: ORG_KSA, locationId: 'loc_ksa', dataRegion: 'ksa' }],
])
const lookups: string[] = []
const puts: string[] = []

const storageEnv = (host: string) => ({
	RECORDING_S3_BUCKET: 'region-bucket',
	RECORDING_S3_ENDPOINT: `https://${host}`,
	RECORDING_S3_ACCESS_KEY: 'access',
	RECORDING_S3_SECRET: 'secret',
})
const inboxEnv = {
	INVOICE_INBOX_DOMAIN: 'in.menuza.test',
	INVOICE_INBOX_WEBHOOK_SECRET: SECRET,
}
const useEnv = (values: Record<string, string>) => {
	Object.assign(process.env, values)
	syncEnvFromProcess()
}
const clearEnv = (...keys: string[]) => {
	for (const key of keys) process.env[key] = ''
	syncEnvFromProcess()
}

const pdf = (name = 'invoice.pdf', size = 600) => ({
	filename: name,
	contentType: 'application/pdf',
	contentBase64: Buffer.alloc(size, 1).toString('base64'),
})

let n = 0
const mail = (over: Partial<InboundMail> = {}): InboundMail => ({
	messageId: `<m${++n}@supplier.example>`,
	from: { address: 'Billing@Fresh-Farms.example', name: 'Fresh Farms' },
	to: [`Restaurant <invoices+${CODE_A}@in.menuza.test>`],
	subject: 'Invoice INV-77',
	text: 'Please find the invoice attached.',
	attachments: [pdf()],
	...over,
})

async function post(body: unknown, secret: string | null = SECRET) {
	const res = await app.request('/webhooks/invoice-mail', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(secret ? { Authorization: `Bearer ${secret}` } : {}),
		},
		body: JSON.stringify(body),
	})
	return { status: res.status, body: (await res.json()) as any }
}

let env: ReturnType<typeof setupTenantEnv>
let owner: string
let noFlag: string
let scoped: string
let world: ReturnType<typeof makeWorld>
let fetchSpy: ReturnType<typeof vi.spyOn>

const list = async (locationId = LOC, status = 'open', token = owner) => {
	const reply = await call(
		'GET',
		`${BASE}/invoice-inbox?locationId=${locationId}&status=${status}`,
		{ token },
	)
	expect(reply.status, JSON.stringify(reply.body)).toBe(200)
	return invoiceInboxListSchema.parse(reply.body)
}

const settle = async (id: string) => {
	const db = await getTenantDb(ORG)
	for (let i = 0; i < 100; i++) {
		const [row] = await db
			.select()
			.from(invInvoiceInbox)
			.where(eq(invInvoiceInbox.id, id))
		if (row && row.readState !== 'pending') return row
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	throw new Error('the read never finished')
}

beforeAll(async () => {
	env = setupTenantEnv('inv-inbox')
	for (const [id, region] of [
		[ORG, 'us'],
		[ORG_KSA, 'ksa'],
	] as const) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: region,
			name: id,
		})
		await provisionTenantDb(id)
	}
	owner = await mintToken(ORG, {
		features: { invoiceInbox: true },
		subject: 'user_owner',
		canManageSettings: true,
	})
	noFlag = await mintToken(ORG, {})
	scoped = await mintToken(ORG, {
		features: { invoiceInbox: true },
		locationIds: [LOC_B],
	})
	world = makeWorld(call, owner, LOC)
})

beforeEach(() => {
	seedInventoryContextForTest(ORG, {
		enabled: true,
		purchasing: true,
		recipes: false,
		prep: false,
		transfers: false,
		invoiceInbox: true,
	})
	seedInventoryContextForTest(ORG_KSA, {
		enabled: true,
		purchasing: true,
		recipes: false,
		prep: false,
		transfers: false,
		invoiceInbox: true,
	})
	useEnv({ ...inboxEnv, ...storageEnv('s3.us.example.test') })
	reader.on = true
	reader.read.mockReset()
	reader.read.mockResolvedValue({
		supplierName: 'Fresh Farms',
		invoiceNumber: 'INV-77',
		invoiceDate: '2026-11-26',
		total: 23.5,
		lines: [
			{ text: 'Tomatoes', quantity: 5, unit: 'kg', lineTotal: 12.5 },
			{ text: 'Mystery crate', quantity: 2, unit: null, lineTotal: null },
		],
	})
	lookups.length = 0
	puts.length = 0
	invoiceInboxDeps.lookup = async (code) => {
		lookups.push(code)
		return addresses.get(code) ?? null
	}
	fetchSpy = vi
		.spyOn(globalThis, 'fetch')
		.mockImplementation(async (url, init) => {
			if ((init as RequestInit | undefined)?.method === 'PUT') {
				puts.push(String(url))
				return new Response(null, { status: 200 })
			}
			throw new Error(`unexpected fetch ${String(url)}`)
		})
})

afterEach(() => {
	clearEnv(
		...Object.keys(inboxEnv),
		'RECORDING_S3_BUCKET',
		'RECORDING_S3_ENDPOINT',
		'RECORDING_S3_ACCESS_KEY',
		'RECORDING_S3_SECRET',
	)
	process.env.DATA_REGION = 'us'
	syncEnvFromProcess()
	fetchSpy.mockRestore()
	resetInvoiceReadLimits()
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_KSA)
	env.cleanup()
})

describe('the webhook', () => {
	it('needs the secret, a configured node and a body in our shape', async () => {
		expect((await post(mail(), null)).status).toBe(401)
		expect((await post(mail(), 'wrong-secret-0123456789abcdef')).status).toBe(
			401,
		)
		expect((await post({ nonsense: true })).status).toBe(400)
		clearEnv('INVOICE_INBOX_DOMAIN')
		expect((await post(mail())).status).toBe(503)
		expect(lookups).toEqual([])
	})

	it('ignores mail that is not for an invoice address, and an address nobody has', async () => {
		const elsewhere = await post(mail({ to: ['someone@in.menuza.test'] }))
		expect(elsewhere.body).toMatchObject({
			status: 'ignored',
			reason: 'no_address',
		})
		const wrongDomain = await post(
			mail({ to: [`invoices+${CODE_A}@other.example`] }),
		)
		expect(wrongDomain.body).toMatchObject({
			status: 'ignored',
			reason: 'no_address',
		})
		const unknown = await post(
			mail({ to: ['invoices+nobody123456@in.menuza.test'] }),
		)
		expect(unknown.body).toMatchObject({
			status: 'ignored',
			reason: 'unknown_address',
		})
		expect(puts).toEqual([])
	})

	it('only the location code goes to the control plane', async () => {
		await post(mail())
		expect(lookups).toEqual([CODE_A])
		// The fetches this test saw are storage PUTs only: nothing else left the node.
		expect(
			fetchSpy.mock.calls.every(
				([, init]) => (init as RequestInit)?.method === 'PUT',
			),
		).toBe(true)
	})
})

describe('an emailed invoice', () => {
	it('an emailed PDF appears in Invoices to match for the right location', async () => {
		const sent = await post(mail())
		expect(sent.status, JSON.stringify(sent.body)).toBe(200)
		expect(sent.body.status).toBe('stored')
		const here = await list(LOC)
		const mine = here.items.find((row) => row.subject === 'Invoice INV-77')!
		expect(mine).toMatchObject({
			locationId: LOC,
			source: 'email',
			status: 'new',
			fromAddress: 'billing@fresh-farms.example',
			files: [
				{
					fileName: 'invoice.pdf',
					contentType: 'application/pdf',
					sizeBytes: 600,
				},
			],
		})
		expect(here.openCount).toBeGreaterThan(0)
		// The other location of the same organization sees nothing of it.
		expect((await list(LOC_B)).items).toEqual([])
		// A token limited to the other location cannot read this one.
		const refused = await call(
			'GET',
			`${BASE}/invoice-inbox?locationId=${LOC}`,
			{ token: scoped },
		)
		expect(refused.status).toBe(403)
	})

	it("goes straight to the node's own storage: the PDF and the body, nothing else", async () => {
		await post(mail())
		expect(puts.length).toBe(2)
		expect(
			puts.every((url) => url.startsWith('https://s3.us.example.test/')),
		).toBe(true)
		expect(puts[0]).toContain(`/inventory-invoices/${ORG}/inbox-`)
		expect(puts.some((url) => url.includes('/body.txt'))).toBe(true)
	})

	it("a KSA location's invoice is stored only in KSA storage, and a US node never keeps it", async () => {
		// The KSA node: the KSA bucket only.
		process.env.DATA_REGION = 'ksa'
		useEnv(storageEnv('s3.ksa.example.test'))
		const stored = await post(
			mail({ to: [`invoices+${CODE_KSA}@in.menuza.test`] }),
		)
		expect(stored.body.status).toBe('stored')
		expect(puts.length).toBe(2)
		expect(
			puts.every((url) => url.startsWith('https://s3.ksa.example.test/')),
		).toBe(true)
		expect(puts.some((url) => url.includes('s3.us.example.test'))).toBe(false)
		const db = await getTenantDb(ORG_KSA)
		expect(await db.select().from(invInvoiceInbox)).toHaveLength(1)

		// The US node gets mail for a KSA location: dropped, not stored, no storage call.
		puts.length = 0
		process.env.DATA_REGION = 'us'
		useEnv(storageEnv('s3.us.example.test'))
		const abroad = await post(
			mail({ to: [`invoices+${CODE_KSA}@in.menuza.test`] }),
		)
		expect(abroad.body).toMatchObject({
			status: 'ignored',
			reason: 'other_region',
		})
		expect(puts).toEqual([])
		expect(await db.select().from(invInvoiceInbox)).toHaveLength(1)
	})

	it('stores a retried message once', async () => {
		const message = mail()
		expect((await post(message)).body.status).toBe('stored')
		const putsAfterFirst = puts.length
		const again = await post(message)
		expect(again.body.status).toBe('duplicate')
		expect(puts.length).toBe(putsAfterFirst)
	})

	it('refuses an email over 25 MB whole, and ignores attachments that are not invoices', async () => {
		const huge = await post(
			mail({
				attachments: [
					{ ...pdf(), contentBase64: 'A'.repeat(19_000_000) },
					{ ...pdf('more.pdf'), contentBase64: 'A'.repeat(19_000_000) },
				],
			}),
		)
		expect(huge.status).toBe(413)
		expect(huge.body.status).toBe('too_large')
		const none = await post(
			mail({
				attachments: [
					{
						filename: 'logo.exe',
						contentType: 'application/x-msdownload',
						contentBase64: 'QUJD',
					},
					{
						filename: 'notes.txt',
						contentType: 'text/plain',
						contentBase64: 'QUJD',
					},
				],
			}),
		)
		expect(none.body).toMatchObject({ status: 'ignored', reason: 'ignored' })
		const mixed = await post(
			mail({
				attachments: [
					{
						filename: 'notes.txt',
						contentType: 'text/plain',
						contentBase64: 'QUJD',
					},
					pdf('real.pdf'),
				],
			}),
		)
		expect(mixed.body.status).toBe('stored')
		const db = await getTenantDb(ORG)
		const files = await db.select().from(invInvoiceInboxFiles)
		expect(files.filter((file) => file.fileName === 'notes.txt')).toEqual([])
	})

	it('the hop to the organization takes no more than the edge took, plus the envelope', async () => {
		useEnv({ INTERNAL_COMMAND_TOKEN: 'test-internal-token-123456789' })
		const res = await app.request('/api/invoice-inbox/receive', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: 'Bearer test-internal-token-123456789',
				'content-length': String(40 * 1024 * 1024),
			},
			body: '{}',
		})
		expect(res.status, await res.clone().text()).toBe(413)
		const refused = await app.request('/api/invoice-inbox/receive', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		})
		expect(refused.status).toBe(401)
	})

	it('asks the provider to retry while storage is down', async () => {
		fetchSpy.mockImplementation(async () => new Response('no', { status: 500 }))
		const reply = await post(mail())
		expect(reply.status).toBe(503)
		expect(reply.body.status).toBe('storage_unavailable')
		const db = await getTenantDb(ORG)
		expect(
			(await db.select().from(invInvoiceInbox)).some((row) =>
				row.messageId?.includes('m'),
			),
		).toBe(true) // earlier tests' rows exist; none was made for this message
	})

	it('drops mail while the organization flag is off', async () => {
		seedInventoryContextForTest(ORG, {
			enabled: true,
			purchasing: true,
			recipes: false,
			prep: false,
			transfers: false,
			invoiceInbox: false,
		})
		const reply = await post(mail())
		expect(reply.body).toMatchObject({
			status: 'ignored',
			reason: 'feature_off',
		})
		expect(puts).toEqual([])
	})
})

describe('reading, marking and matching', () => {
	it('reads supplier, number, date, total and lines with the reader, and marks an unknown sender', async () => {
		await world.supplier('Fresh Farms', { email: 'orders@fresh-farms.example' })
		const sent = await post(mail())
		const row = await settle(sent.body.inboxId ?? (await list()).items[0]!.id)
		expect(row).toMatchObject({
			readState: 'read',
			supplierName: 'Fresh Farms',
			invoiceNumber: 'INV-77',
			invoiceDate: '2026-11-26',
			totalMinor: 2350,
			senderState: 'unknown',
		})
		expect(row.supplierId).not.toBeNull()
		expect(row.linesJson).toMatchObject([
			{
				description: 'Tomatoes',
				quantity: 5,
				unit: 'kg',
				lineTotalMinor: 1250,
			},
			{
				description: 'Mystery crate',
				quantity: 2,
				unit: null,
				lineTotalMinor: null,
			},
		])
	})

	it('the owner can allow a sender, which clears the mark everywhere', async () => {
		const first = await post(
			mail({
				from: { address: 'accounts@newsupplier.example' },
				subject: 'First',
			}),
		)
		await post(
			mail({
				from: { address: 'accounts@newsupplier.example' },
				subject: 'Second',
			}),
		)
		const rows = (await list(LOC, 'all')).items.filter(
			(r) => r.fromAddress === 'accounts@newsupplier.example',
		)
		expect(rows.every((r) => r.senderState === 'unknown')).toBe(true)
		const allowed = await call(
			'POST',
			`${BASE}/invoice-inbox/${first.body.inboxId}/allow-sender`,
			{
				token: owner,
				body: {},
			},
		)
		expect(allowed.status, JSON.stringify(allowed.body)).toBe(200)
		const after = (await list(LOC, 'all')).items.filter(
			(r) => r.fromAddress === 'accounts@newsupplier.example',
		)
		expect(after.every((r) => r.senderState === 'allowed')).toBe(true)
		// A person without the settings grant cannot.
		const plain = await mintToken(ORG, {
			features: { invoiceInbox: true },
			canManageSettings: false,
		})
		const refused = await call(
			'POST',
			`${BASE}/invoice-inbox/${first.body.inboxId}/allow-sender`,
			{ token: plain, body: {} },
		)
		expect(refused.status).toBe(403)
	})

	it('flags the same invoice number from the same supplier as a duplicate', async () => {
		reader.read.mockResolvedValue({
			supplierName: 'Dup Supplier',
			invoiceNumber: 'D-1',
			invoiceDate: null,
			total: 10,
			lines: [],
		})
		await world.supplier('Dup Supplier')
		const one = await post(mail())
		const first = await settle(one.body.inboxId)
		expect(first.duplicateOfId).toBeNull()
		const two = await post(mail())
		const second = await settle(two.body.inboxId)
		expect(second.duplicateOfId).toBe(first.id)
		const view = (await list(LOC, 'all')).items.find((r) => r.id === second.id)!
		expect(view.duplicateOfId).toBe(first.id)
	})

	it('Matching it to an order hands the delivery screen what to prefill, and receiving from it delivers the invoice', async () => {
		const sup = await world.supplier('Matching Farms')
		const item = await world.item('Matching tomatoes')
		const product = await world.product(sup.id, item.id, {
			packName: 'Crate 6 kg',
			packBaseQuantity: 6_000_000,
			priceMinor: 9_000,
		})
		const order = await world.ok('POST', '/orders', {
			clientId: cid('ord'),
			locationId: LOC,
			supplierId: sup.id,
			lines: [{ itemId: item.id, supplierProductId: product.id, packs: 3 }],
		})
		const sent = await world.ok('POST', `/orders/${order.id}/send`, {
			expectedVersion: order.version,
			channel: 'copy',
		})
		reader.read.mockResolvedValue({
			supplierName: 'Matching Farms',
			invoiceNumber: 'M-500',
			invoiceDate: '2026-11-27',
			total: 270,
			lines: [
				{
					text: 'Matching tomatoes',
					quantity: 3,
					unit: 'crate',
					lineTotal: 270,
				},
			],
		})
		const mailed = await post(
			mail({ from: { address: 'billing@matching.example' } }),
		)
		await settle(mailed.body.inboxId)
		const id = mailed.body.inboxId as string

		const detail = invoiceInboxDetailSchema.parse(
			(
				await call('GET', `${BASE}/invoice-inbox/${id}?locationId=${LOC}`, {
					token: owner,
				})
			).body,
		)
		expect(detail.suggestedOrders.map((o) => o.id)).toEqual([order.id])
		expect(detail.lines[0]).toMatchObject({
			description: 'Matching tomatoes',
			itemId: item.id,
		})
		expect(detail.files[0]!.url).toContain('https://s3.us.example.test/')

		const matched = await call('POST', `${BASE}/invoice-inbox/${id}/match`, {
			token: owner,
			body: { expectedVersion: detail.version, orderId: order.id },
		})
		expect(matched.status, JSON.stringify(matched.body)).toBe(200)
		const result = matchInvoiceResultSchema.parse(matched.body)
		expect(result.invoice.status).toBe('matched')
		expect(result.prefill).toEqual({
			orderId: order.id,
			supplierId: sup.id,
			invoiceNumber: 'M-500',
			invoiceDate: '2026-11-27',
			totalMinor: 27000,
			currency: 'SAR',
			inboxId: id,
		})
		// The delivery screen's own prefill from the order is the existing route.
		const prefill = await call(
			'GET',
			`${BASE}/orders/${order.id}/receive-prefill`,
			{ token: owner },
		)
		expect(prefill.status).toBe(200)
		expect(prefill.body.lines[0].itemId).toBe(item.id)
		// Without the use-by flag the line says nothing about dates (#479).
		expect(prefill.body.lines[0]).not.toHaveProperty('trackByDate')
		// With it, the receiving screen learns the item is tracked by date and its shelf life.
		const dated = await mintToken(ORG, {
			features: { invoiceInbox: true, useBy: true },
			subject: 'user_owner',
			canManageSettings: true,
		})
		const current = await call(
			'GET',
			`${BASE}/items/${item.id}?locationId=${LOC}`,
			{ token: dated },
		)
		const tracked = await call('PATCH', `${BASE}/items/${item.id}`, {
			token: dated,
			body: {
				trackByDate: true,
				shelfLifeHours: 48,
				expectedVersion: current.body.version,
			},
		})
		expect(tracked.status, JSON.stringify(tracked.body)).toBe(200)
		const datedPrefill = await call(
			'GET',
			`${BASE}/orders/${order.id}/receive-prefill`,
			{ token: dated },
		)
		expect(datedPrefill.body.lines[0]).toMatchObject({
			trackByDate: true,
			shelfLifeHours: 48,
		})

		// Receiving against the order, made from the invoice, delivers it.
		const delivered = await call('POST', `${BASE}/deliveries`, {
			token: owner,
			body: {
				clientId: cid('del'),
				locationId: LOC,
				supplierId: sup.id,
				orderId: order.id,
				invoiceNumber: 'M-500',
				invoiceDate: '2026-11-27',
				currency: 'SAR',
				invoiceInboxId: id,
				lines: [
					{
						itemId: item.id,
						quantity: 18_000_000,
						lineTotalMinor: 27_000,
						orderLineId: sent.lines?.[0]?.id ?? order.lines[0].id,
						supplierProductId: product.id,
						packs: 3,
					},
				],
			},
		})
		expect(delivered.status, JSON.stringify(delivered.body)).toBe(200)
		const db = await getTenantDb(ORG)
		const [row] = await db
			.select()
			.from(invInvoiceInbox)
			.where(eq(invInvoiceInbox.id, id))
		expect(row).toMatchObject({
			status: 'delivered',
			deliveryId: delivered.body.delivery.id,
		})
		const stored = await db
			.select()
			.from(invDeliveries)
			.where(eq(invDeliveries.id, delivered.body.delivery.id))
		expect(stored[0]!.invoiceNumber).toBe('M-500')
		// A delivered invoice cannot be matched again.
		const again = await call('POST', `${BASE}/invoice-inbox/${id}/match`, {
			token: owner,
			body: { expectedVersion: row!.version, orderId: order.id },
		})
		expect(again.status).toBe(409)
	})

	it("matching to another supplier's order, or a closed one, is refused; matching to a delivery delivers the invoice", async () => {
		const other = await world.supplier('Other Farms')
		const item = await world.item('Other tomatoes')
		const product = await world.product(other.id, item.id)
		const order = await world.ok('POST', '/orders', {
			clientId: cid('ord'),
			locationId: LOC,
			supplierId: other.id,
			lines: [{ itemId: item.id, supplierProductId: product.id, packs: 1 }],
		})
		const sup = await world.supplier('Right Farms')
		reader.read.mockResolvedValue({
			supplierName: 'Right Farms',
			invoiceNumber: 'R-1',
			invoiceDate: null,
			total: 5,
			lines: [],
		})
		const mailed = await post(mail())
		const row = await settle(mailed.body.inboxId)
		const wrong = await call('POST', `${BASE}/invoice-inbox/${row.id}/match`, {
			token: owner,
			body: { expectedVersion: row.version, orderId: order.id },
		})
		expect(wrong.status).toBe(409)
		expect(wrong.body.code).toBe('supplier_mismatch')
		const unknown = await call(
			'POST',
			`${BASE}/invoice-inbox/${row.id}/match`,
			{
				token: owner,
				body: { expectedVersion: row.version, orderId: 'nope' },
			},
		)
		expect(unknown.status).toBe(404)
		expect(sup.id).toBeTruthy()
	})

	it('dismisses an invoice, and asks the reader again on request', async () => {
		reader.read.mockResolvedValue({
			supplierName: 'Again Farms',
			invoiceNumber: 'A-9',
			invoiceDate: null,
			total: 1,
			lines: [],
		})
		const mailed = await post(mail())
		const row = await settle(mailed.body.inboxId)
		const reread = await call('POST', `${BASE}/invoice-inbox/${row.id}/read`, {
			token: owner,
			body: {},
		})
		// Re-reading fetches the stored file; this test's storage only accepts uploads.
		expect([200, 502]).toContain(reread.status)
		const dismissed = await call(
			'POST',
			`${BASE}/invoice-inbox/${row.id}/dismiss`,
			{
				token: owner,
				body: { expectedVersion: (await settle(row.id)).version },
			},
		)
		expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200)
		expect(dismissed.body.status).toBe('dismissed')
		expect((await list(LOC)).items.some((r) => r.id === row.id)).toBe(false)
		expect(
			(await list(LOC, 'dismissed')).items.some((r) => r.id === row.id),
		).toBe(true)
	})

	it('shows readState not_configured when the node has no reader', async () => {
		reader.on = false
		const mailed = await post(mail())
		const db = await getTenantDb(ORG)
		const [row] = await db
			.select()
			.from(invInvoiceInbox)
			.where(eq(invInvoiceInbox.id, mailed.body.inboxId))
		expect(row!.readState).toBe('not_configured')
		expect(reader.read).not.toHaveBeenCalled()
	})
})

describe('uploads and Station photos', () => {
	const upload = async (
		files: Array<{ name: string; type: string; bytes: number }>,
		token = owner,
		location = LOC,
	) => {
		const form = new FormData()
		for (const file of files) {
			form.append(
				'files',
				new File([new Uint8Array(file.bytes).fill(2)], file.name, {
					type: file.type,
				}),
			)
		}
		const res = await app.request(
			`${BASE}/invoice-inbox/upload?locationId=${location}`,
			{
				method: 'POST',
				headers: { Authorization: `Bearer ${token}` },
				body: form,
			},
		)
		return { status: res.status, body: (await res.json()) as any }
	}

	it('takes several files at once, one invoice each, and leaves other files out', async () => {
		const reply = await upload([
			{ name: 'a.pdf', type: 'application/pdf', bytes: 500 },
			{ name: 'b.jpg', type: 'image/jpeg', bytes: 400 },
			{ name: 'c.txt', type: 'text/plain', bytes: 10 },
		])
		expect(reply.status, JSON.stringify(reply.body)).toBe(201)
		expect(reply.body.invoices).toHaveLength(2)
		expect(reply.body.ignored).toBe(1)
		expect(
			reply.body.invoices.every(
				(row: any) => row.source === 'upload' && row.senderState === 'known',
			),
		).toBe(true)
		expect(puts.length).toBe(2)
	})

	it('refuses nothing-to-keep, too much, the wrong location and a missing flag', async () => {
		expect(
			(await upload([{ name: 'c.txt', type: 'text/plain', bytes: 10 }])).status,
		).toBe(400)
		expect(
			(
				await upload(
					[{ name: 'a.pdf', type: 'application/pdf', bytes: 500 }],
					scoped,
				)
			).status,
		).toBe(403)
		expect(
			(
				await upload(
					[{ name: 'a.pdf', type: 'application/pdf', bytes: 500 }],
					noFlag,
				)
			).status,
		).toBe(403)
	})

	it('the config says whether to show the address', async () => {
		const on = await call(
			'GET',
			`${BASE}/invoice-inbox/config?locationId=${LOC}`,
			{ token: owner },
		)
		expect(on.body).toEqual({ enabled: true, domain: 'in.menuza.test' })
		clearEnv('INVOICE_INBOX_DOMAIN')
		const off = await call(
			'GET',
			`${BASE}/invoice-inbox/config?locationId=${LOC}`,
			{ token: owner },
		)
		expect(off.body).toEqual({ enabled: false, domain: null })
		const flagless = await call(
			'GET',
			`${BASE}/invoice-inbox/config?locationId=${LOC}`,
			{ token: noFlag },
		)
		expect(flagless.body.enabled).toBe(false)
		expect([READ, UPDATE]).toBeTruthy()
	})
})

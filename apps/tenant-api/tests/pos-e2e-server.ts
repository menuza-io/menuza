/**
 * Backend for the Station Playwright suite (apps/station/e2e). Runs the REAL tenant-api
 * app (every middleware, the real `/pos` routes, real SQLite on a temp
 * directory) beside a stub of the three App routes the POS and the order
 * verification read. Nothing here is mocked between the browser and the
 * database, so the suite proves the till, the contract and the server together.
 *
 *   App stub     http://127.0.0.1:4710   /resources/sites, /resources/sites/menu,
 *                                        /resources/order-context
 *   Tenant API   http://127.0.0.1:4711   everything tenant-api serves, plus the
 *                                        test-only `/__test/*` controls below
 *
 * Test controls never exist in the product: this file is only started by the
 * POS Playwright config.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'

const APP_PORT = 4710
const API_PORT = 4711
const ORG_ID = 'org_e2e_pos'
const ORG_SLUG = 'demo'
const INTERNAL_TOKEN = 'e2e-internal-token-very-long-and-secure-123456'
const POS_ORIGINS = ['http://localhost:3110', 'http://127.0.0.1:3110']

// Playwright stops this process with SIGKILL, so no exit handler can be relied on
// to clean up. Sweep leftovers from earlier runs first, then use one fresh dir.
for (const entry of fs.readdirSync(os.tmpdir())) {
	if (entry.startsWith('pos-e2e-')) {
		try {
			fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true })
		} catch {}
	}
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-e2e-'))
Object.assign(process.env, {
	NODE_ENV: 'development',
	TENANT_DB_DIR: directory,
	DATA_REGION: 'us',
	PORT: String(API_PORT),
	APP_URL: `http://127.0.0.1:${APP_PORT}`,
	TENANT_API_URL: `http://127.0.0.1:${API_PORT}`,
	INTERNAL_COMMAND_TOKEN: INTERNAL_TOKEN,
	TENANT_OPERATOR_TOKEN: 'e2e-operator-token-very-long-and-secure-123456',
	JWT_SECRET: 'e2e-jwt-secret-very-long-and-secure-1234567890',
	AUTH_HMAC_SECRET: 'e2e-hmac-secret-very-long-and-secure-1234567890',
	POS_ORIGINS: POS_ORIGINS.join(','),
})

await import('varlock/auto-load')
const { Hono } = await import('hono')
const { serve } = await import('@hono/node-server')
const { createTenantApiApp } = await import('../src/app.ts')
const {
	getTenantDb,
	provisionTenantDb,
	posCashMovements,
	posDevices,
	posFiscalDocuments,
	posHeldUploads,
	posManagers,
	posOrderLines,
	posOrderRevisions,
	posOrders,
	posOrderTransfers,
	posPairingCodes,
	posPayments,
	posPinAttempts,
	posShifts,
	posZatcaSettings,
	posZatcaSubmissions,
	posZatcaUnits,
	staffMembers,
	staffScopeAssignments,
} = await import('@repo/tenant-db')
const { clearPosMenuCache } = await import('../src/routes/pos.ts')
const { pinLookupFor } = await import('../src/services/kiosk-pin-service.ts')
const { eq, sql } = await import('drizzle-orm')
const { createPairingCode, listDevices, listPosOrders, revokeDevice } =
	await import('../src/services/pos-service.ts')
const { listShifts } = await import('../src/services/pos-shift-service.ts')
const { seal } = await import('../src/lib/zatca-seal.ts')
const { generatePrivateKey, toHex } = await import('@repo/zatca')

// ZATCA is never called from tests: reporting answers "reported" here.
const realFetch = globalThis.fetch
const zatcaReports: string[] = []
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	const url =
		typeof input === 'string'
			? input
			: input instanceof URL
				? input.href
				: input.url
	if (url.startsWith('https://gw-fatoora.zatca.gov.sa/')) {
		zatcaReports.push(url)
		return Response.json({ reportingStatus: 'REPORTED' })
	}
	return realFetch(input, init)
}) as typeof fetch
const { restaurantOrderContextSchema } =
	await import('@repo/common/restaurant-orders')
const { demoCatalog } = await import('../../station/src/lib/demo-catalog.ts')

// ---------------------------------------------------------------------------
// Catalog: the POS demo menu, so e2e expectations match what the UI shows.
// `published` is what the POS downloads; `live` is what the server verifies
// against. Tests diverge them to simulate a menu that changed after the till
// cached it.
// ---------------------------------------------------------------------------

type Json = Record<string, any>
const baseCatalog = (): Json => {
	const snapshot = structuredClone(demoCatalog()) as Json
	snapshot.menu.organization = {
		...snapshot.menu.organization,
		id: ORG_ID,
		slug: ORG_SLUG,
	}
	snapshot.organization = {
		...snapshot.organization,
		id: ORG_ID,
		slug: ORG_SLUG,
		dataRegion: 'us',
	}
	// Online ordering is irrelevant to the till; leave it closed to prove that.
	for (const location of snapshot.menu.locations) {
		location.onlineHours = [
			'sunday',
			'monday',
			'tuesday',
			'wednesday',
			'thursday',
			'friday',
			'saturday',
		].map((day) => ({ day, isOpen: false, slots: [] }))
		location.fulfillmentOptions = {
			pickup: false,
			delivery: false,
			dineIn: true,
			curbside: false,
		}
	}
	return snapshot
}
let published = baseCatalog()
let live = structuredClone(published)
let themeOverride: Json | null = null
let contextDown = false

const walkItems = (menu: Json, visit: (item: Json) => void) => {
	const walk = (category: Json) => {
		category.items?.forEach(visit)
		category.subcategories?.forEach(walk)
	}
	for (const m of menu.menus) m.categories.forEach(walk)
}

const contextFor = () => ({
	orgId: ORG_ID,
	dataRegion: 'us',
	menu: live.menu,
	drop: null,
	onlinePayment: { enabled: false, processor: null },
})

// Fail loudly at startup if the shared catalog stops satisfying the server's own schema.
restaurantOrderContextSchema.parse(contextFor())

// ---------------------------------------------------------------------------
// App stub
// ---------------------------------------------------------------------------

const json = (
	res: import('node:http').ServerResponse,
	status: number,
	body: unknown,
) => {
	res.writeHead(status, {
		'content-type': 'application/json',
		'access-control-allow-origin': '*',
		'cache-control': 'no-store',
	})
	res.end(JSON.stringify(body))
}

const appServer = createServer((req, res) => {
	const url = new URL(req.url ?? '/', `http://127.0.0.1:${APP_PORT}`)
	const slug = url.searchParams.get('slug')
	if (url.pathname === '/resources/sites') {
		if (slug !== ORG_SLUG) return json(res, 404, { error: 'not_found' })
		const organization = structuredClone(published.organization)
		if (themeOverride)
			organization.theme = { ...organization.theme, ...themeOverride }
		return json(res, 200, organization)
	}
	if (url.pathname === '/resources/sites/menu') {
		if (slug !== ORG_SLUG) return json(res, 404, { error: 'not_found' })
		return json(res, 200, published.menu)
	}
	if (url.pathname === '/resources/order-context') {
		if (contextDown) return json(res, 503, { error: 'down' })
		if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`)
			return json(res, 401, { error: 'unauthorized' })
		if (url.searchParams.get('orgId') !== ORG_ID)
			return json(res, 404, { error: 'not_found' })
		return json(res, 200, contextFor())
	}
	json(res, 404, { error: 'not_found' })
})

// ---------------------------------------------------------------------------
// Tenant API with test controls
// ---------------------------------------------------------------------------

await provisionTenantDb(ORG_ID)
const db = await getTenantDb(ORG_ID)

type Seen = {
	method: string
	path: string
	status: number
	idempotencyKey: string | null
	at: number
}
const seen: Seen[] = []
let outage: { status: number; remaining: number } | null = null

const root = new Hono()

root.get('/__test/health', (c) => c.json({ ok: true }))

// Every test control may change the menu: never answer from the cached copy.
root.use('/__test/*', async (_c, next) => {
	clearPosMenuCache()
	await next()
})

/**
 * Money and history tables refuse deletes (triggers in migration 0020). Between
 * tests the harness lifts them, empties the tables, and puts them back exactly.
 */
const posTriggers = fs
	.readFileSync(
		path.join(
			import.meta.dirname,
			'../../../packages/tenant-db/drizzle/0020_pos_orders_and_terminals.sql',
		),
		'utf8',
	)
	.split('--> statement-breakpoint')
	.map((statement) => statement.trim())
	.filter((statement) => statement.includes('CREATE TRIGGER'))
const triggerNames = posTriggers.map(
	(statement) => /CREATE TRIGGER `([^`]+)`/.exec(statement)![1]!,
)

root.use('/pos/*', async (c, next) => {
	if (
		outage &&
		outage.remaining !== 0 &&
		c.req.path === '/pos/orders' &&
		c.req.method === 'POST'
	) {
		if (outage.remaining > 0) outage.remaining -= 1
		seen.push({
			method: c.req.method,
			path: c.req.path,
			status: outage.status,
			idempotencyKey: c.req.header('idempotency-key') ?? null,
			at: Date.now(),
		})
		return c.json({ error: 'injected_outage' }, outage.status as 503, {
			'access-control-allow-origin': c.req.header('origin') ?? '*',
		})
	}
	await next()
	if (c.req.method !== 'OPTIONS') {
		seen.push({
			method: c.req.method,
			path: c.req.path,
			status: c.res.status,
			idempotencyKey: c.req.header('idempotency-key') ?? null,
			at: Date.now(),
		})
	}
})

root.post('/__test/reset', async (c) => {
	for (const name of triggerNames)
		await db.run(sql.raw(`DROP TRIGGER IF EXISTS \`${name}\``))
	await db.delete(posPayments)
	await db.delete(posOrderLines)
	await db.delete(posOrderRevisions)
	await db.delete(posOrderTransfers)
	await db.delete(posHeldUploads)
	await db.delete(posFiscalDocuments)
	await db.delete(posCashMovements)
	await db.delete(posShifts)
	await db.delete(posZatcaSubmissions)
	await db.delete(posZatcaUnits)
	await db.delete(posZatcaSettings)
	await db.delete(posOrders)
	for (const statement of posTriggers) await db.run(sql.raw(statement))
	await db.delete(posPinAttempts)
	await db.delete(posPairingCodes)
	await db.delete(posDevices)
	await db.delete(posManagers)
	await db.delete(staffScopeAssignments)
	await db.delete(staffMembers)
	published = baseCatalog()
	live = structuredClone(published)
	themeOverride = null
	contextDown = false
	outage = null
	seen.length = 0
	return c.json({ ok: true })
})

root.post('/__test/pairing-code', async (c) => {
	const body = (await c.req.json()) as {
		label?: string
		terminalCode?: string
		locationId?: string | null
		ttlMs?: number
		signInRequired?: boolean
		shiftsRequired?: boolean
		scopeId?: string
	}
	const result = await createPairingCode(db, ORG_ID, {
		label: body.label ?? 'Front counter',
		terminalCode: body.terminalCode ?? 'T1',
		locationId: body.locationId ?? null,
		scopeId: body.scopeId,
		// Off unless a test asks: most of the suite is about selling, not signing in.
		signInRequired: body.signInRequired ?? false,
		shiftsRequired: body.shiftsRequired ?? false,
		createdBy: 'e2e-manager',
	})
	if (!result.ok) return c.json(result, 409)
	if (body.ttlMs !== undefined) {
		// Lets a test hand out a code that is already expired.
		await db.update(posPairingCodes).set({ expiresAt: Date.now() + body.ttlMs })
	}
	const link = `http://localhost:3110/#a=${encodeURIComponent(`http://127.0.0.1:${API_PORT}`)}&u=${encodeURIComponent(`http://127.0.0.1:${APP_PORT}`)}&s=${ORG_SLUG}&c=${encodeURIComponent(result.value.code)}`
	return c.json({
		code: result.value.code,
		link,
		terminalCode: result.value.terminalCode,
	})
})

// Staff, written the way the staff module writes them (a keyed hash of the PIN, per workplace).
root.post('/__test/staff', async (c) => {
	const b = (await c.req.json()) as {
		first?: string
		last?: string
		pin?: string | null
		manager?: boolean
		scopeId?: string
		status?: string
	}
	const id = crypto.randomUUID()
	const scopeId = b.scopeId ?? 'main'
	await db
		.insert(staffMembers)
		.values({
			id,
			firstName: b.first ?? 'Ana',
			lastName: b.last ?? 'Karim',
			status: (b.status ?? 'active') as never,
		})
	await db.insert(staffScopeAssignments).values({
		staffId: id,
		scopeId,
		pinLookup:
			b.pin === null ? null : pinLookupFor(ORG_ID, scopeId, b.pin ?? '4321'),
	})
	if (b.manager)
		await db.insert(posManagers).values({ staffId: id, addedBy: 'e2e' })
	return c.json({ id })
})
root.post('/__test/staff-update', async (c) => {
	const b = (await c.req.json()) as {
		id: string
		pin?: string
		status?: string
		manager?: boolean
	}
	if (b.status)
		await db
			.update(staffMembers)
			.set({ status: b.status as never })
			.where(eq(staffMembers.id, b.id))
	if (b.pin)
		await db
			.update(staffScopeAssignments)
			.set({ pinLookup: pinLookupFor(ORG_ID, 'main', b.pin) })
			.where(eq(staffScopeAssignments.staffId, b.id))
	if (b.manager === true)
		await db
			.insert(posManagers)
			.values({ staffId: b.id, addedBy: 'e2e' })
			.onConflictDoNothing()
	if (b.manager === false)
		await db.delete(posManagers).where(eq(posManagers.staffId, b.id))
	return c.json({ ok: true })
})
// A manager flips sign-in for an existing terminal in the Menuza app.
root.post('/__test/terminal', async (c) => {
	const b = (await c.req.json()) as {
		id: string
		signInRequired?: boolean
		shiftsRequired?: boolean
	}
	await db
		.update(posDevices)
		.set({
			...(b.signInRequired === undefined
				? {}
				: { signInRequired: b.signInRequired }),
			...(b.shiftsRequired === undefined
				? {}
				: { shiftsRequired: b.shiftsRequired }),
		})
		.where(eq(posDevices.id, b.id))
	return c.json({ ok: true })
})
root.get('/__test/orders', async (c) =>
	c.json({ orders: await listPosOrders(db, { limit: 200 }) }),
)
root.get('/__test/devices', async (c) =>
	c.json({ devices: await listDevices(db) }),
)
root.get('/__test/shifts', async (c) =>
	c.json({ shifts: await listShifts(db, { limit: 50 }) }),
)
/** Makes every active terminal an onboarded ZATCA unit (a throwaway openssl certificate stands in for the CSID). */
root.post('/__test/zatca', async (c) => {
	const body = (await c.req.json().catch(() => ({}))) as { vatNumber?: string }
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-e2e-zatca-'))
	execFileSync('openssl', [
		'ecparam',
		'-name',
		'secp256k1',
		'-genkey',
		'-noout',
		'-out',
		path.join(dir, 'k.pem'),
	])
	execFileSync('openssl', [
		'req',
		'-new',
		'-x509',
		'-key',
		path.join(dir, 'k.pem'),
		'-out',
		path.join(dir, 'c.pem'),
		'-days',
		'1',
		'-subj',
		'/CN=TSZEINVOICE-SubCA-1',
	])
	const certificate = Buffer.from(
		fs
			.readFileSync(path.join(dir, 'c.pem'), 'utf8')
			.replace(/-----[^-]+-----/g, '')
			.replace(/\s+/g, ''),
	).toString('base64')
	fs.rmSync(dir, { recursive: true, force: true })
	const settings = {
		environment: 'sandbox' as const,
		sellerName: 'Demo Kitchen',
		vatNumber: body.vatNumber ?? '399999999900003',
		crNumber: '1010010000',
		street: 'Prince Sultan',
		buildingNumber: '2322',
		district: 'Al-Murabba',
		city: 'Riyadh',
		postalCode: '23333',
		businessCategory: 'Restaurant',
		branchName: 'Main',
		updatedBy: 'e2e',
	}
	await db
		.insert(posZatcaSettings)
		.values({ id: 'main', ...settings })
		.onConflictDoUpdate({ target: posZatcaSettings.id, set: settings })
	for (const device of (await listDevices(db)).filter(
		(d) => d.revokedAt === null,
	)) {
		const unit = {
			environment: 'sandbox' as const,
			status: 'active' as const,
			privateKeySealed: seal(toHex(generatePrivateKey())),
			productionToken: certificate,
			productionSecretSealed: seal('e2e-secret'),
			complianceRequestId: '1',
			onboardedAt: Date.now(),
		}
		await db
			.insert(posZatcaUnits)
			.values({ deviceId: device.id, ...unit })
			.onConflictDoUpdate({ target: posZatcaUnits.deviceId, set: unit })
	}
	return c.json({ ok: true })
})
root.get('/__test/zatca-submissions', async (c) =>
	c.json({
		submissions: await db.select().from(posZatcaSubmissions),
		reports: zatcaReports,
	}),
)
root.get('/__test/requests', (c) => c.json({ requests: seen }))
root.post('/__test/revoke', async (c) => {
	const { deviceId } = (await c.req.json()) as { deviceId: string }
	return c.json({ revoked: await revokeDevice(db, deviceId, 'e2e-manager') })
})
// Make the App's order-context endpoint fail (the server cannot check the menu).
root.post('/__test/context', async (c) => {
	contextDown = ((await c.req.json()) as { down: boolean }).down
	return c.json({ ok: true })
})
// Make the next `count` order uploads fail with `status` (count -1 = until cleared).
root.post('/__test/outage', async (c) => {
	const body = (await c.req.json()) as
		{ status?: number; count?: number } | { clear: true }
	outage =
		'clear' in body
			? null
			: { status: body.status ?? 503, remaining: body.count ?? -1 }
	return c.json({ ok: true })
})
// Change what the server verifies against, without republishing to the till.
root.post('/__test/live-menu', async (c) => {
	const body = (await c.req.json()) as {
		prices?: Record<string, number>
		remove?: string[]
		publish?: boolean
	}
	walkItems(live.menu, (item) => {
		if (body.prices?.[item.id] !== undefined) item.price = body.prices[item.id]
		if (body.remove?.includes(item.id)) item.availabilityStatus = 'unavailable'
	})
	if (body.remove?.length) {
		const strip = (category: Json) => {
			category.items = category.items.filter(
				(i: Json) => !body.remove!.includes(i.id),
			)
			category.subcategories?.forEach(strip)
		}
		for (const m of live.menu.menus) m.categories.forEach(strip)
	}
	if (body.publish) published = structuredClone(live)
	return c.json({ ok: true })
})
// Location overrides (price, availability, enabled) for the single demo location,
// applied to what the server verifies against and, if asked, to what the till gets.
root.post('/__test/overrides', async (c) => {
	const body = (await c.req.json()) as { overrides: Json[]; publish?: boolean }
	live.menu.locationOverrides = { 'loc-1': body.overrides }
	if (body.publish) published = structuredClone(live)
	return c.json({ ok: true })
})
// Restaurant-level settings on the demo location (e.g. tips), live and published.
root.post('/__test/location', async (c) => {
	const patch = (await c.req.json()) as Json
	for (const menu of [live.menu, published.menu])
		Object.assign(menu.locations[0], patch)
	return c.json({ ok: true })
})
// What the till downloads on its next refresh (e.g. a manager 86'd something).
root.post('/__test/publish', (c) => {
	published = structuredClone(live)
	return c.json({ ok: true })
})
root.post('/__test/theme', async (c) => {
	themeOverride = (await c.req.json()) as Json
	return c.json({ ok: true })
})

root.route('/', createTenantApiApp())

appServer.listen(APP_PORT, '127.0.0.1')
serve({ fetch: root.fetch, port: API_PORT, hostname: '127.0.0.1' })
console.log(
	`pos-e2e backend ready: app stub :${APP_PORT}, tenant-api :${API_PORT}, db ${directory}`,
)

const cleanup = () => {
	try {
		fs.rmSync(directory, { recursive: true, force: true })
	} catch {}
	process.exit(0)
}
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

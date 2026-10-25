/**
 * Backend for the Station Playwright suite (apps/station/e2e). Runs the REAL tenant-api
 * app (every middleware, the real `/pos` routes, real SQLite on a temp
 * directory) beside a stub of the three App routes the POS and the order
 * verification read. Nothing here is mocked between the browser and the
 * database, so the suite proves the till, the contract and the server together.
 *
 *   App stub     http://127.0.0.1:4710   /resources/sites, /resources/sites/menu,
 *                                        /resources/order-context, and the
 *                                        staffing and reservations contexts
 *                                        the Station apps read
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
	posHosts,
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
const { resetScopeContextCache } = await import('../src/lib/scope-context.ts')
const { resetReservationsContextCache } =
	await import('../src/lib/reservations-context.ts')
const { publicContext } =
	await import('../src/routes/reservations-public-fixture.ts')
const { SignJWT } = await import('jose')
const { brand } = await import('@repo/config/brand')
const {
	rsvAreas,
	rsvFloorElements,
	rsvLocationSettings,
	rsvServices,
	rsvTables,
	timePunches,
	rsvGuests,
	rsvReservations,
} = await import('@repo/tenant-db')
const { pinLookupFor } = await import('../src/services/kiosk-pin-service.ts')
const { and, eq, sql } = await import('drizzle-orm')
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

/** The demo menu's one location, where the host stand runs. */
const STATION_LOC = 'loc-1'
const STATION_TZ = 'America/New_York'
const stationFlags = { timeclock: true, reservations: true, waitlist: true }
const reservationsContext = () => {
	const base = publicContext(ORG_ID, {
		enabled: stationFlags.reservations,
		waitlist: stationFlags.waitlist,
	})
	return {
		...base,
		locations: base.locations.map((location) => ({
			...location,
			id: STATION_LOC,
			name: 'Downtown',
			timeZone: STATION_TZ,
		})),
	}
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
	// The control plane's word that the organization exists (operator routes ask).
	if (url.pathname === '/resources/tenant-organization') {
		if (url.searchParams.get('orgId') !== ORG_ID)
			return json(res, 404, { error: 'not_found' })
		return json(res, 200, {
			id: ORG_ID,
			slug: ORG_SLUG,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: 'Demo',
		})
	}
	// The Station apps: staffing flags and workplace, reservations flags and location.
	if (url.pathname === '/resources/staffing/scope-context') {
		if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`)
			return json(res, 401, { error: 'unauthorized' })
		return json(res, 200, {
			orgId: ORG_ID,
			dataRegion: 'us',
			features: {
				enabled: stationFlags.timeclock,
				timeclock: stationFlags.timeclock,
				scheduling: false,
				hiring: false,
			},
			// A till bound to a location works at that location's scope.
			scopes: [
				{ id: 'main', name: 'Downtown', timeZone: STATION_TZ },
				{ id: STATION_LOC, name: 'Downtown', timeZone: STATION_TZ },
			],
		})
	}
	if (url.pathname === '/resources/reservations/context') {
		if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`)
			return json(res, 401, { error: 'unauthorized' })
		return json(res, 200, reservationsContext())
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
	// Punches, entries and bookings point at staff: they go first.
	await clearReservations()
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
	await db.delete(posHosts)
	await db.delete(staffScopeAssignments)
	await db.delete(staffMembers)
	published = baseCatalog()
	live = structuredClone(published)
	themeOverride = null
	contextDown = false
	outage = null
	seen.length = 0
	Object.assign(stationFlags, {
		timeclock: true,
		reservations: true,
		waitlist: true,
	})
	resetScopeContextCache()
	resetReservationsContextCache()
	return c.json({ ok: true })
})

/**
 * Every reservations row, emptied for the next test. Their append-only
 * triggers are set aside for the delete and put back, as for the POS tables.
 */
async function clearReservations() {
	const triggers = (await db.all(
		sql.raw(
			"select name, sql from sqlite_master where type = 'trigger' and (tbl_name like 'rsv_%' or tbl_name like 'time_%' or tbl_name = 'staff_audit_log')",
		),
	)) as Array<{ name: string; sql: string }>
	for (const trigger of triggers)
		await db.run(sql.raw(`DROP TRIGGER IF EXISTS \`${trigger.name}\``))
	const tables = (await db.all(
		sql.raw(
			"select name from sqlite_master where type = 'table' and (name like 'rsv_%' or name in ('time_punches','time_breaks','time_entries','time_entry_edits','staff_audit_log'))",
		),
	)) as Array<{ name: string }>
	await db.run(sql.raw('PRAGMA foreign_keys = OFF'))
	for (const table of tables)
		await db.run(sql.raw(`DELETE FROM \`${table.name}\``))
	await db.run(sql.raw('PRAGMA foreign_keys = ON'))
	for (const trigger of triggers) await db.run(sql.raw(trigger.sql))
}

root.post('/__test/pairing-code', async (c) => {
	const body = (await c.req.json()) as {
		label?: string
		terminalCode?: string
		locationId?: string | null
		ttlMs?: number
		signInRequired?: boolean
		shiftsRequired?: boolean
		scopeId?: string
		timeclockEnabled?: boolean
		reservationsEnabled?: boolean
	}
	const result = await createPairingCode(db, ORG_ID, {
		label: body.label ?? 'Front counter',
		terminalCode: body.terminalCode ?? 'T1',
		locationId: body.locationId ?? null,
		scopeId: body.scopeId,
		// Off unless a test asks: most of the suite is about selling, not signing in.
		signInRequired: body.signInRequired ?? false,
		shiftsRequired: body.shiftsRequired ?? false,
		timeclockEnabled: body.timeclockEnabled ?? false,
		reservationsEnabled: body.reservationsEnabled ?? false,
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
		/** On the terminal's host list; `guest` also sees guests' contact details. */
		host?: boolean | 'guest'
		scopeId?: string
		status?: string
	}
	const id = crypto.randomUUID()
	const scopeId = b.scopeId ?? 'main'
	await db.insert(staffMembers).values({
		id,
		firstName: b.first ?? 'Ana',
		lastName: b.last ?? 'Karim',
		status: (b.status ?? 'active') as never,
	})
	// The default workplace also works at the location tills are bound to.
	for (const scope of scopeId === 'main' ? ['main', STATION_LOC] : [scopeId])
		await db.insert(staffScopeAssignments).values({
			staffId: id,
			scopeId: scope,
			pinLookup:
				b.pin === null ? null : pinLookupFor(ORG_ID, scope, b.pin ?? '4321'),
		})
	if (b.manager)
		await db.insert(posManagers).values({ staffId: id, addedBy: 'e2e' })
	if (b.host)
		await db
			.insert(posHosts)
			.values({ staffId: id, guestDetails: b.host === 'guest', addedBy: 'e2e' })
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
		for (const scope of ['main', STATION_LOC])
			await db
				.update(staffScopeAssignments)
				.set({ pinLookup: pinLookupFor(ORG_ID, scope, b.pin) })
				.where(
					and(
						eq(staffScopeAssignments.staffId, b.id),
						eq(staffScopeAssignments.scopeId, scope),
					),
				)
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
		timeclockEnabled?: boolean
		reservationsEnabled?: boolean
	}
	await db
		.update(posDevices)
		.set({
			...(b.timeclockEnabled === undefined
				? {}
				: { timeclockEnabled: b.timeclockEnabled }),
			...(b.reservationsEnabled === undefined
				? {}
				: { reservationsEnabled: b.reservationsEnabled }),
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
		/** Names as the menu editor stores them once translated: JSON maps per language. */
		translate?: boolean
	}
	if (body.translate) {
		const both = (text: string) =>
			text.startsWith('{')
				? text
				: JSON.stringify({ en: text, ar: `ع ${text}` })
		const category = (c: Json) => {
			c.displayName = both(c.displayName)
			for (const item of c.items) {
				item.displayName = both(item.displayName)
				if (item.description) item.description = both(item.description)
			}
			c.subcategories?.forEach(category)
		}
		for (const m of live.menu.menus) m.categories.forEach(category)
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

const api = createTenantApiApp()
root.route('/', api)

// ---------------------------------------------------------------------------
// Station apps
// ---------------------------------------------------------------------------

root.post('/__test/station-flags', async (c) => {
	Object.assign(
		stationFlags,
		(await c.req.json()) as Partial<typeof stationFlags>,
	)
	resetScopeContextCache()
	resetReservationsContextCache()
	return c.json({ ok: true })
})

root.get('/__test/punches', async (c) =>
	c.json({ punches: await db.select().from(timePunches) }),
)

// Bookings with their guest's first name, to count what a double tap made.
root.get('/__test/bookings', async (c) =>
	c.json({
		bookings: await db
			.select({ id: rsvReservations.id, firstName: rsvGuests.firstName })
			.from(rsvReservations)
			.leftJoin(rsvGuests, eq(rsvGuests.id, rsvReservations.guestId)),
	}),
)

/** Local date and minutes after midnight at the location, now. */
function localNow(offsetMin = 0) {
	const at = new Date(Date.now() + offsetMin * 60_000)
	const parts = Object.fromEntries(
		new Intl.DateTimeFormat('en-CA', {
			timeZone: STATION_TZ,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		})
			.formatToParts(at)
			.map((part) => [part.type, part.value]),
	)
	return {
		date: `${parts.year}-${parts.month}-${parts.day}`,
		minutes: Number(parts.hour) * 60 + Number(parts.minute),
	}
}
const hhmm = (minutes: number) =>
	`${String(Math.floor(minutes / 60) % 24).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`

/**
 * A floor for the host stand: two rooms drawn by a manager, a service that runs
 * all day, and today's bookings around now (seated, due, later, at the stand),
 * plus two parties on the waitlist. Bookings go through the real operator
 * routes with a token like the one App mints.
 */
root.post('/__test/floor', async (c) => {
	await clearReservations()
	await db.insert(rsvLocationSettings).values({
		locationId: STATION_LOC,
		enabled: true,
		onlineEnabled: true,
		timeZone: STATION_TZ,
		// The day turns at midnight, so the seeded bookings land on "today" at any hour.
		dayStartMin: 0,
		intervalMin: 15,
		horizonDays: 60,
		minNoticeMin: 0,
		partyMax: 30,
		waitlistEnabled: true,
	})
	await db.insert(rsvAreas).values([
		{
			id: 'area_main',
			locationId: STATION_LOC,
			name: 'Main room',
			sort: 0,
			canvasW: 1200,
			canvasH: 760,
		},
		{
			id: 'area_patio',
			locationId: STATION_LOC,
			name: 'Patio',
			sort: 1,
			canvasW: 1000,
			canvasH: 600,
		},
	])
	const table = (
		id: string,
		areaId: string,
		label: string,
		max: number,
		shape: 'round' | 'square' | 'rect',
		x: number,
		y: number,
		w: number,
		h: number,
	) => ({
		id,
		locationId: STATION_LOC,
		areaId,
		label,
		minCovers: 1,
		maxCovers: max,
		shape,
		x,
		y,
		w,
		h,
		onlineBookable: true,
		resetBufferMin: 0,
	})
	await db
		.insert(rsvTables)
		.values([
			table('tbl_1', 'area_main', '1', 2, 'round', 120, 120, 110, 110),
			table('tbl_2', 'area_main', '2', 2, 'round', 300, 120, 110, 110),
			table('tbl_3', 'area_main', '3', 4, 'square', 480, 110, 140, 130),
			table('tbl_4', 'area_main', '4', 4, 'square', 680, 110, 140, 130),
			table('tbl_5', 'area_main', '5', 6, 'rect', 120, 360, 240, 130),
			table('tbl_6', 'area_main', '6', 6, 'rect', 420, 360, 240, 130),
			table('tbl_7', 'area_main', '7', 8, 'rect', 720, 360, 300, 140),
			table('tbl_8', 'area_main', '8', 2, 'round', 120, 580, 110, 110),
			table('tbl_9', 'area_main', '9', 2, 'round', 300, 580, 110, 110),
			table('tbl_p1', 'area_patio', 'P1', 4, 'round', 140, 140, 150, 150),
			table('tbl_p2', 'area_patio', 'P2', 4, 'round', 420, 140, 150, 150),
			table('tbl_p3', 'area_patio', 'P3', 6, 'rect', 140, 380, 300, 130),
		])
	await db.insert(rsvFloorElements).values([
		{
			id: 'el_bar',
			locationId: STATION_LOC,
			areaId: 'area_main',
			kind: 'bar',
			label: 'Bar',
			x: 900,
			y: 80,
			w: 220,
			h: 220,
		},
		{
			id: 'el_door',
			locationId: STATION_LOC,
			areaId: 'area_main',
			kind: 'door',
			label: 'Entrance',
			x: 560,
			y: 720,
			w: 160,
			h: 24,
		},
		{
			id: 'el_wall',
			locationId: STATION_LOC,
			areaId: 'area_main',
			kind: 'wall',
			x: 40,
			y: 300,
			w: 1040,
			h: 12,
		},
	])
	await db.insert(rsvServices).values({
		id: 'svc_all_day',
		locationId: STATION_LOC,
		name: 'All day',
		daysMask: 127,
		firstSeatingMin: 0,
		lastSeatingMin: 23 * 60 + 45,
		endMin: 24 * 60,
		onlineEnabled: true,
		sort: 0,
	})

	const token = await new SignJWT({
		role: 'operator',
		region: 'us',
		orgId: ORG_ID,
		scope: 'book',
		grants: ['read:reservation:any', 'update:reservation:any'],
		locationIds: null,
		features: {
			enabled: true,
			online: true,
			waitlist: true,
			payments: false,
			experiences: false,
			voice: false,
		},
		impersonated: false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: 'rsv+jwt' })
		.setAudience('tenant-api-reservations-operator')
		.setIssuer(brand.shortName)
		.setSubject('e2e-seed')
		.setIssuedAt()
		.setExpirationTime('10m')
		.sign(new TextEncoder().encode(process.env.TENANT_OPERATOR_TOKEN!))
	let key = 0
	const call = async (path: string, body: unknown) => {
		const response = await api.request(`/operator/reservations/book${path}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
				'Idempotency-Key': `e2e-floor-${Date.now()}-${++key}`,
			},
			body: JSON.stringify(body),
		})
		const text = await response.text()
		if (!response.ok) throw new Error(`${path} ${response.status} ${text}`)
		return JSON.parse(text) as Json
	}
	const now = localNow()
	const slot = (offset: number) => {
		const minutes = Math.round((now.minutes + offset) / 15) * 15
		return hhmm(Math.max(0, Math.min(23 * 60 + 45, minutes)))
	}
	let phone = 100
	const book = (
		time: string,
		size: number,
		first: string,
		last: string,
		tableIds: string[],
		extra: Json = {},
	) =>
		call('/reservations', {
			locationId: STATION_LOC,
			date: now.date,
			time,
			partySize: size,
			tableIds,
			overbook: true,
			overbookReason: 'Seeded floor',
			channel: 'phone',
			// One number per guest: the same number is the same guest.
			guest: { firstName: first, lastName: last, phone: `+1212555${++phone}` },
			...extra,
		})
	const idOf = (created: Json) =>
		(created.reservation?.id ?? created.id) as string
	const seated = idOf(await book(slot(-45), 4, 'Omar', 'Saleh', ['tbl_3']))
	await call(`/reservations/${seated}/status`, { toStatus: 'seated' })
	const seated2 = idOf(await book(slot(-30), 6, 'Hala', 'Nasser', ['tbl_6']))
	await call(`/reservations/${seated2}/status`, { toStatus: 'seated' })
	const arrived = idOf(
		await book(slot(0), 2, 'Maya', 'Haddad', ['tbl_2'], {
			staffNotes: 'Window if possible',
			guest: {
				firstName: 'Maya',
				lastName: 'Haddad',
				phone: '+12125550111',
				allergyNotes: 'Peanuts',
			},
		}),
	)
	await call(`/reservations/${arrived}/status`, { toStatus: 'arrived' })
	await book(slot(15), 4, 'Yusuf', 'Rahman', ['tbl_4'])
	await book(slot(45), 2, 'Lea', 'Martin', [])
	await book(slot(75), 6, 'Sami', 'Khoury', ['tbl_5'])
	await book(slot(120), 8, 'Nadia', 'Farah', ['tbl_7'])
	await call('/walk-ins', {
		locationId: STATION_LOC,
		partySize: 2,
		tableIds: ['tbl_8'],
		guestName: 'Walk-in',
	})
	await call('/waitlist', {
		locationId: STATION_LOC,
		displayName: 'Rana Khalid',
		partySize: 2,
		phone: '+12125550123',
	})
	await call('/waitlist', {
		locationId: STATION_LOC,
		displayName: 'Tariq Aziz',
		partySize: 4,
	})
	return c.json({ ok: true, date: now.date })
})

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

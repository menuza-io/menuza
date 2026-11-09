import { brand } from '@repo/config/brand'
import { POS_STAFF_SESSION_HEADER } from '@repo/common/pos-orders'
import {
	INVENTORY_POS_CONTRACT_HEADER,
	INVENTORY_PERMISSIONS,
	INVENTORY_TOKEN_AUDIENCE,
	INVENTORY_TOKEN_TYP,
	INVENTORY_FEATURES_OFF,
} from '@repo/inventory'
import { invWaste, posDevices } from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { SignJWT } from 'jose'
import { expect } from 'vitest'
import { type ClockHarness, LOC_1 } from '../../tests/timeclock-harness.ts'
import { OPERATOR_SECRET } from '../../tests/staff-harness.ts'
import { seedInventoryContextForTest } from '../lib/inventory-context.ts'
import { setManager } from '../services/pos-service.ts'
import { makeWorld } from './inventory-orders-fixture.ts'
import { BASE, cid, makeClient } from './inventory-test-utils.ts'

/**
 * Shared kit of the `/pos/inventory` suites (routes, security, contract): a
 * paired Stock terminal, signed-in people, and a small kitchen seeded through
 * the real operator routes. Each suite declares its own `vi.mock` calls
 * (`../lib/origin.ts`, `../lib/scope-context.ts`, `../services/pos-service.ts`):
 * Vitest hoists mocks per file.
 */

/** The terminal's location (inventory's location id) and its staffing workplace. */
export const STOCK_LOC = 'loc_stock'
export const STOCK_SCOPE = LOC_1

export const ON = {
	...INVENTORY_FEATURES_OFF,
	enabled: true,
	purchasing: true,
	// Kitchen "Log it as waste?" needs recipes; the operator token below keeps its own features.
	recipes: true,
}

const ALL_GRANTS = [
	INVENTORY_PERMISSIONS.READ_INVENTORY,
	INVENTORY_PERMISSIONS.UPDATE_INVENTORY,
	INVENTORY_PERMISSIONS.READ_INVENTORY_COST,
	INVENTORY_PERMISSIONS.UPDATE_INVENTORY_PURCHASING,
]

/** An App operator's inventory token (what the office uses; the tablet never holds one). */
export async function mintInventoryOperator(orgId: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	return new SignJWT({
		role: 'operator',
		orgId,
		region: 'us',
		scope: 'write',
		grants: ALL_GRANTS,
		locationIds: null,
		features: { ...ON, recipes: false, prep: false, transfers: false },
		impersonated: false,
	})
		.setProtectedHeader({ alg: 'HS256', typ: INVENTORY_TOKEN_TYP })
		.setSubject('user_owner')
		.setIssuer(brand.shortName)
		.setAudience(INVENTORY_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

/** What App signs for someone who manages terminals (the pairing code route reads `stationApps`). */
export const mintTerminalOperator = (orgId: string) =>
	new SignJWT({
		orgId,
		role: 'operator',
		scope: 'orders:write',
		stationApps: {
			timeclock: true,
			reservations: true,
			guestDetails: true,
			locationIds: null,
			scopeIds: null,
			inventory: true,
			inventoryLocationIds: null,
		},
	})
		.setSubject('user_manager_1')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(OPERATOR_SECRET))

export type Reply = {
	status: number
	body: any
	raw: string
	headers: Headers
}

export type RequestOptions = {
	secret?: string
	authorization?: string
	session?: string
	body?: unknown
	rawBody?: string
	/** Extra request headers (`If-None-Match`, `Origin`). */
	headers?: Record<string, string>
	/** The `Pos-Inventory-Contract` header: a number, or `null` to leave it out (default 1). */
	contract?: number | string | null
}

export function createStationKit(h: ClockHarness) {
	async function request(
		method: string,
		pathname: string,
		options: RequestOptions = {},
	): Promise<Reply> {
		const headers: Record<string, string> = { ...options.headers }
		if (options.secret) headers.Authorization = `Bearer ${options.secret}`
		if (options.authorization) headers.Authorization = options.authorization
		if (options.session) headers[POS_STAFF_SESSION_HEADER] = options.session
		if (options.contract !== null) {
			headers[INVENTORY_POS_CONTRACT_HEADER] = String(options.contract ?? 1)
		}
		let body: string | undefined
		if (options.rawBody !== undefined) body = options.rawBody
		else if (options.body !== undefined) body = JSON.stringify(options.body)
		if (body !== undefined) headers['content-type'] = 'application/json'
		const response = await h.app.request(pathname, { method, headers, body })
		const raw = await response.text()
		let parsed: any = null
		try {
			parsed = raw ? JSON.parse(raw) : null
		} catch {
			parsed = null
		}
		return {
			status: response.status,
			body: parsed,
			raw,
			headers: response.headers,
		}
	}

	async function pairTerminal(options: {
		orgId: string
		terminalCode?: string
		inventoryEnabled?: boolean
		signInRequired?: boolean
		locationId?: string | null
	}) {
		const created = await h.app.request('/operator/pos/pairing-codes', {
			method: 'POST',
			headers: {
				authorization: `Bearer ${await mintTerminalOperator(options.orgId)}`,
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				label: 'Kitchen',
				terminalCode: options.terminalCode ?? 'K1',
				scopeId: STOCK_SCOPE,
				locationId:
					options.locationId === undefined ? STOCK_LOC : options.locationId,
				signInRequired: options.signInRequired ?? true,
				timeclockEnabled: false,
				reservationsEnabled: false,
				inventoryEnabled: options.inventoryEnabled ?? true,
			}),
		})
		if (created.status !== 201) {
			throw new Error(
				`pairing code failed: ${created.status} ${await created.text()}`,
			)
		}
		const { code } = (await created.json()) as { code: string }
		const paired = await request('POST', '/pos/pair', { body: { code } })
		expect(paired.status, paired.raw).toBe(201)
		return {
			secret: paired.body.deviceSecret as string,
			deviceId: paired.body.device.id as string,
		}
	}

	async function signIn(secret: string, pin: string) {
		const reply = await request('POST', '/pos/sign-in', {
			secret,
			body: { pin },
		})
		expect(reply.status, reply.raw).toBe(200)
		return reply.body as {
			sessionToken: string
			role: 'cashier' | 'manager'
			staff: { id: string }
		}
	}

	/** A person at the terminal's workplace with a PIN; a manager when asked. */
	async function seedPerson(
		orgId: string,
		options: { manager?: boolean; firstName?: string } = {},
	) {
		const seeded = await h.seedStaff(orgId, {
			scopeIds: [STOCK_SCOPE],
			firstName: options.firstName,
		})
		if (options.manager) {
			await setManager(await h.db(orgId), seeded.staffId, 'user_owner')
		}
		return seeded
	}

	/** A person at the terminal's workplace, signed in at it; a manager when asked. */
	async function person(
		orgId: string,
		secret: string,
		options: { manager?: boolean; firstName?: string } = {},
	) {
		const seeded = await seedPerson(orgId, options)
		const session = await signIn(secret, seeded.pin)
		return {
			staffId: seeded.staffId,
			pin: seeded.pin,
			session: session.sessionToken,
			role: session.role,
		}
	}

	/** A whole station: paired terminal, a cashier and a manager signed in. */
	async function station(
		orgId: string,
		options: { terminalCode?: string } = {},
	) {
		// A workplace is real once someone is assigned to it.
		const first = await seedPerson(orgId, { firstName: 'Cora' })
		const device = await pairTerminal({
			orgId,
			terminalCode: options.terminalCode,
		})
		const cashier = {
			staffId: first.staffId,
			pin: first.pin,
			session: (await signIn(device.secret, first.pin)).sessionToken,
			role: 'cashier' as const,
		}
		const manager = await person(orgId, device.secret, {
			manager: true,
			firstName: 'Max',
		})
		return { ...device, cashier, manager }
	}

	/** Enables Stock for an organization on this node (the flag App would answer). */
	const enableInventory = (orgId: string, features = ON) =>
		seedInventoryContextForTest(orgId, features)

	/** Reads back who a waste row names, straight from the database. */
	async function wasteRows(orgId: string, deviceId?: string) {
		const db = await h.db(orgId)
		return deviceId
			? db.select().from(invWaste).where(eq(invWaste.deviceId, deviceId))
			: db.select().from(invWaste)
	}

	async function setDevice(
		orgId: string,
		deviceId: string,
		patch: Partial<typeof posDevices.$inferInsert>,
	) {
		const db = await h.db(orgId)
		await db.update(posDevices).set(patch).where(eq(posDevices.id, deviceId))
	}

	/**
	 * A small kitchen at `STOCK_LOC`, through the real operator routes: two
	 * storage areas, items (one in no area and only on the weekly list), a
	 * supplier that sells two of them, and a sent order for them.
	 */
	async function kitchen(orgId: string) {
		const token = await mintInventoryOperator(orgId)
		const world = makeWorld(makeClient(h.app), token, STOCK_LOC)
		const area = (name: string) =>
			world.ok('POST', '/storage-areas', { locationId: STOCK_LOC, name })
		const walkin = await area('Walk-in fridge')
		const dry = await area('Dry store')
		const place = (
			countUnit: string,
			areaIds: string[],
		): Record<string, unknown> => ({
			locationId: STOCK_LOC,
			countUnit,
			areaIds,
			orderBelowQuantity: null,
			fillUpToQuantity: null,
		})
		const item = (
			name: string,
			baseUnit: string,
			extra: Record<string, unknown> = {},
		) =>
			world.ok('POST', '/items', {
				clientId: cid('item'),
				name,
				category: 'produce',
				kind: 'bought',
				baseUnit,
				...extra,
			})
		const tomato = await item('Tomatoes', 'g', {
			place: place('kg', [walkin.id]),
		})
		const chicken = await item('Chicken thigh', 'g', {
			category: 'meat',
			units: [{ name: 'Box', baseQuantity: 10_000_000 }],
			place: place('kg', [walkin.id]),
		})
		const oil = await item('Olive oil', 'ml', {
			category: 'dry_goods',
			place: place('l', [dry.id]),
		})
		const pita = await item('Pita bread', 'piece', {
			category: 'bakery',
			place: place('piece', [dry.id]),
		})
		// Not kept here: only on the weekly list.
		const lemon = await item('Lemons', 'piece')
		const list = await world.ok('POST', '/count-lists', {
			locationId: STOCK_LOC,
			name: 'Weekly count',
			itemIds: [tomato.id, chicken.id, oil.id, pita.id, lemon.id],
		})
		const supplier = await world.supplier('Fresh Produce Co', {
			email: 'orders@fresh.example',
			phone: '+966500000000',
			contactName: 'Faisal',
		})
		const tomatoProduct = await world.product(supplier.id, tomato.id, {
			packName: 'Crate 6 kg',
			packBaseQuantity: 6_000_000,
			priceMinor: 9_000,
		})
		const chickenProduct = await world.product(supplier.id, chicken.id, {
			packName: 'Box',
			packBaseQuantity: 10_000_000,
			priceMinor: 28_000,
			pricedByWeight: true,
		})
		const order = await world.ok('POST', '/orders', {
			clientId: cid('ord'),
			locationId: STOCK_LOC,
			supplierId: supplier.id,
			lines: [
				{ itemId: tomato.id, supplierProductId: tomatoProduct.id, packs: 3 },
				{
					itemId: chicken.id,
					supplierProductId: chickenProduct.id,
					packs: 2,
				},
			],
		})
		const sent = await world.ok('POST', `/orders/${order.id}/send`, {
			expectedVersion: order.version,
			channel: 'copy',
		})
		return {
			world,
			token,
			areas: { walkin, dry },
			items: { tomato, chicken, oil, pita, lemon },
			list,
			supplier,
			products: { tomato: tomatoProduct, chicken: chickenProduct },
			order: { ...order, version: sent.order?.version ?? order.version },
			orderId: order.id as string,
			orderLines: order.lines as Array<{ id: string; itemId: string }>,
		}
	}

	return {
		request,
		pairTerminal,
		signIn,
		person,
		seedPerson,
		station,
		enableInventory,
		wasteRows,
		setDevice,
		kitchen,
		call: makeClient(h.app),
		BASE,
	}
}

export type StationKit = ReturnType<typeof createStationKit>
export type Kitchen = Awaited<ReturnType<StationKit['kitchen']>>

/** Every key in a JSON value, at any depth. */
export function keysOf(value: unknown, into = new Set<string>()): Set<string> {
	if (Array.isArray(value)) value.forEach((item) => keysOf(item, into))
	else if (value && typeof value === 'object') {
		for (const [key, inner] of Object.entries(value)) {
			into.add(key)
			keysOf(inner, into)
		}
	}
	return into
}

/** The two contract fields that merely contain the word "price". */
const PRICE_WORDS = new Set(['pricedByWeight', 'pricesPending'])

/** Keys that would carry money, a price or a cost. The Stock contract has none. */
export function moneyKeys(value: unknown): string[] {
	return [...keysOf(value)].filter(
		(key) => /minor|micro|price|cost|value/i.test(key) && !PRICE_WORDS.has(key),
	)
}

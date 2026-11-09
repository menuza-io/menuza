import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
	stationCatalogSchema,
	stationCountEntriesResultSchema,
	stationCountSheetSchema,
	stationDeliveryResultSchema,
	stationPhotoUploadSchema,
	stationStartCountResultSchema,
	stationWasteResultSchema,
	STATION_LATE_SYNC_MS,
} from '@repo/inventory'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createClockHarness,
	ORG_A,
	type ClockHarness,
} from '../../tests/timeclock-harness.ts'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import { invalidateInventoryContext } from '../lib/inventory-context.ts'
import {
	createStationKit,
	moneyKeys,
	STOCK_LOC,
	type Kitchen,
	type StationKit,
} from './pos-inventory-fixture.ts'

/**
 * The Stock app's answers, recorded as fixtures next to the tablet client
 * (`apps/station/src/apps/stock/fixtures`), where its own tests parse them.
 * This suite plays one scripted shift against the real routes and checks that
 * every answer still has exactly the fixture's key structure (and parses with
 * the contract schema), so a server change the tablet would not understand
 * fails here until the fixtures are re-recorded:
 *
 *   RECORD_STATION_FIXTURES=1 npx vitest run src/routes/pos-inventory-contract.test.ts
 *
 * Re-recording replaces the hand-written fixtures with the routes' own
 * answers (ids and times normalised), so only do it for a contract change.
 */

const RECORD = process.env.RECORD_STATION_FIXTURES === '1'
const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const FIXTURE_DIR = path.join(REPO_ROOT, 'apps/station/src/apps/stock/fixtures')

const orgs = vi.hoisted(() => new Map<string, TestOrg>())

vi.mock('../lib/scope-context.ts', () => ({
	getScopeFacts: vi.fn(async () => null),
	hasScope: vi.fn(async () => true),
	getStaffingFeatures: vi.fn(async () => null),
	resetScopeContextCache: vi.fn(),
}))
vi.mock('../services/pos-service.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../services/pos-service.ts')>()),
	checkLocation: vi.fn(async () => 'known' as const),
}))
vi.mock('../lib/origin.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/origin.ts')>()),
	findActiveOrganizationById: vi.fn(async (id: string) => orgs.get(id) ?? null),
	lookupActiveOrganization: vi.fn(async (id: string) => {
		const organization = orgs.get(id)
		return organization
			? { status: 'found' as const, organization }
			: { status: 'missing' as const }
	}),
}))

/** The structure of a JSON value: keys and types, never the values. */
function shapeOf(value: unknown): unknown {
	if (value === null) return 'null'
	if (Array.isArray(value)) {
		const shapes = new Map<string, unknown>()
		for (const item of value) {
			const shape = shapeOf(item)
			shapes.set(JSON.stringify(shape), shape)
		}
		return { array: [...shapes.values()] }
	}
	if (typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, v]) => [k, shapeOf(v)]),
		)
	}
	return typeof value
}

/** Keys must match; a nullable field may be null in one sample and typed in the other. */
function sameKeys(a: unknown, b: unknown, trail = ''): string[] {
	if (a === 'null' || b === 'null') return []
	if (typeof a === 'string' || typeof b === 'string') {
		return a === b
			? []
			: [`${trail}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`]
	}
	const aObj = a as Record<string, unknown>
	const bObj = b as Record<string, unknown>
	if ('array' in aObj || 'array' in bObj) {
		const aItems = (aObj.array as unknown[] | undefined) ?? []
		const bItems = (bObj.array as unknown[] | undefined) ?? []
		if (aItems.length === 0 || bItems.length === 0) return []
		// Every element shape in the live answer must exist in the fixture's keys.
		return bItems.flatMap((item) => sameKeys(aItems[0], item, `${trail}[]`))
	}
	const problems: string[] = []
	for (const k of new Set([...Object.keys(aObj), ...Object.keys(bObj)])) {
		if (!(k in aObj)) problems.push(`${trail}.${k}: missing in fixture`)
		else if (!(k in bObj)) problems.push(`${trail}.${k}: missing in live`)
		else problems.push(...sameKeys(aObj[k], bObj[k], `${trail}.${k}`))
	}
	return problems
}

const FIXED_NOW = Date.UTC(2026, 0, 1, 12, 0, 0)
const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Stable values, so recording twice leaves `git status` clean. */
function makeNormalizer(recordedNow: number) {
	const aliases = new Map<string, string>()
	const alias = (prefix: string, value: string) => {
		const hit = aliases.get(value)
		if (hit) return hit
		const next = `${prefix}${aliases.size + 1}`
		aliases.set(value, next)
		return next
	}
	const walk = (value: unknown, key: string): unknown => {
		if (typeof value === 'number' && value > 1e12 && value < 1e13) {
			return FIXED_NOW + Math.round((value - recordedNow) / 60_000) * 60_000
		}
		if (typeof value === 'string') {
			if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return '2026-01-01'
			if (key === 'version' && value.startsWith('cat-'))
				return 'cat-fixture0001'
			if (key === 'uploadUrl') return 'https://storage.example.test/upload'
			if (UUID_RE.test(value)) return alias('id_', value)
			if (/^(entry|waste|start|delivery)-/.test(value))
				return alias(`${value.split('-')[0]}-0000-`, value)
			if (value.includes('inventory-invoices/'))
				return value
					.replace(UUID_RE, 'photo')
					.replace(/[A-Za-z0-9_-]{20,}/, 'org')
			return value
		}
		if (Array.isArray(value)) return value.map((v) => walk(v, key))
		if (value && typeof value === 'object') {
			return Object.fromEntries(
				Object.entries(value).map(([k, v]) => [k, walk(v, k)]),
			)
		}
		return value
	}
	return (value: unknown) => walk(value, '')
}

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`

describe('the Stock fixtures and the routes agree', () => {
	let h: ClockHarness
	let kit: StationKit
	let k: Kitchen

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		vi.stubEnv('POS_ENABLED', '')
		vi.stubEnv('INVENTORY_ENABLED', '')
		invalidateInventoryContext()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not found', { status: 404 })),
		)
		h = await createClockHarness([ORG_A])
		kit = createStationKit(h)
		kit.enableInventory(ORG_A)
		k = await kit.kitchen(ORG_A)
	})
	afterEach(async () => {
		invalidateInventoryContext()
		for (const key of [
			'RECORDING_S3_BUCKET',
			'RECORDING_S3_ENDPOINT',
			'RECORDING_S3_ACCESS_KEY',
			'RECORDING_S3_SECRET',
		]) {
			process.env[key] = ''
		}
		vi.unstubAllGlobals()
		await h.cleanup()
	})

	it('answers every route with the key structure the fixtures record', async () => {
		const recordedNow = Date.now()
		const tablet = await kit.station(ORG_A)
		const as = (who: 'cashier' | 'manager') => ({
			secret: tablet.secret,
			session: tablet[who].session,
		})
		const call = async (
			who: 'cashier' | 'manager',
			method: string,
			pathname: string,
			body?: unknown,
		) => {
			const reply = await kit.request(method, pathname, {
				...as(who),
				...(body === undefined ? {} : { body }),
			})
			expect(reply.status, `${method} ${pathname}: ${reply.raw}`).toBe(200)
			expect(moneyKeys(reply.body), `${method} ${pathname}`).toEqual([])
			return reply.body
		}
		const replies: Record<string, { schema: any; body: unknown }> = {}

		// A count: started by one tablet, joined by the second start.
		const listId = k.list.id
		await call('cashier', 'POST', '/pos/inventory/counts', {
			clientId: uid('start'),
			locationId: STOCK_LOC,
			listId,
		})
		const joined = await call('manager', 'POST', '/pos/inventory/counts', {
			clientId: uid('start'),
			locationId: STOCK_LOC,
			listId,
		})
		const countId = joined.count.id as string
		replies['start-count'] = {
			schema: stationStartCountResultSchema,
			body: joined,
		}

		const entry = (
			itemId: string,
			amount: number | null,
			extra: Record<string, unknown> = {},
		) => ({
			clientId: uid('entry'),
			itemId,
			areaId: k.areas.walkin.id,
			amount,
			unit: 'kg',
			...extra,
		})
		const first = entry(k.items.chicken.id, 4.5)
		await call('cashier', 'POST', `/pos/inventory/counts/${countId}/entries`, {
			entries: [first, entry(k.items.tomato.id, 2)],
		})
		replies['count-entries'] = {
			schema: stationCountEntriesResultSchema,
			body: await call(
				'cashier',
				'POST',
				`/pos/inventory/counts/${countId}/entries`,
				{
					entries: [
						entry(k.items.tomato.id, null),
						first,
						entry(k.items.tomato.id, 1, { unit: 'l' }),
					],
				},
			),
		}
		// A count that lists an item no area holds (the sheet's last group).
		replies['count-sheet'] = {
			schema: stationCountSheetSchema,
			body: await call('cashier', 'GET', `/pos/inventory/counts/${countId}`),
		}

		// Waste: one stored, then a resend, an archived item and a late entry.
		const logged = {
			clientId: uid('waste'),
			locationId: STOCK_LOC,
			itemId: k.items.tomato.id,
			amount: 1.5,
			unit: 'kg',
			reason: 'spoiled',
		}
		await call('cashier', 'POST', '/pos/inventory/waste', { entries: [logged] })
		await k.world.ok('POST', `/items/${k.items.lemon.id}/archive`, {
			expectedVersion: k.items.lemon.version,
		})
		replies['waste'] = {
			schema: stationWasteResultSchema,
			body: await call('cashier', 'POST', '/pos/inventory/waste', {
				entries: [
					{
						...logged,
						clientId: uid('waste'),
						itemId: k.items.pita.id,
						unit: 'piece',
						amount: 3,
						madeAt: Date.now() - STATION_LATE_SYNC_MS - 60_000,
					},
					logged,
					{
						...logged,
						clientId: uid('waste'),
						itemId: k.items.lemon.id,
						unit: 'piece',
					},
				],
			}),
		}

		// The catalogue with a count in progress, recent waste and an open order.
		replies['catalog'] = {
			schema: stationCatalogSchema,
			body: await call(
				'cashier',
				'GET',
				`/pos/inventory/catalog?locationId=${STOCK_LOC}`,
			),
		}

		// A delivery against that order, and its photo.
		const delivered = await call(
			'manager',
			'POST',
			'/pos/inventory/deliveries',
			{
				clientId: uid('delivery'),
				locationId: STOCK_LOC,
				supplierId: k.supplier.id,
				orderId: k.orderId,
				lines: [
					{
						itemId: k.items.tomato.id,
						supplierProductId: k.products.tomato.id,
						quantity: 12_000_000,
						packs: 2,
						packName: 'Crate 6 kg',
						packBaseQuantity: 6_000_000,
						orderLineId: k.orderLines.find(
							(l) => l.itemId === k.items.tomato.id,
						)!.id,
					},
				],
			},
		)
		replies['delivery'] = {
			schema: stationDeliveryResultSchema,
			body: delivered,
		}
		Object.assign(process.env, {
			RECORDING_S3_BUCKET: 'region-bucket',
			RECORDING_S3_ENDPOINT: 'https://s3.example.test',
			RECORDING_S3_ACCESS_KEY: 'access',
			RECORDING_S3_SECRET: 'secret',
		})
		replies['photo-upload'] = {
			schema: stationPhotoUploadSchema,
			body: await call(
				'manager',
				'POST',
				`/pos/inventory/deliveries/${delivered.id}/photo`,
				{ contentType: 'image/jpeg', sizeBytes: 123_456 },
			),
		}

		// What the shift produced is what the contract and the fixtures describe.
		expect(replies['start-count']!.body.joined).toBe(true)
		expect(replies['count-entries']!.body).toMatchObject({
			accepted: [{ quantity: null }],
			duplicates: [first.clientId],
			refused: [{ code: 'unit_mismatch' }],
		})
		expect(replies['waste']!.body).toMatchObject({
			accepted: [{ quantity: 3_000 }],
			duplicates: [{ clientId: logged.clientId }],
			refused: [{ code: 'item_archived' }],
			lateSync: [expect.any(String)],
		})
		expect(replies['catalog']!.body).toMatchObject({
			counts: [{ status: 'counting' }],
			recentWasteItemIds: expect.arrayContaining([k.items.tomato.id]),
			expectedDeliveries: [{ orderId: k.orderId }],
		})

		const normalize = makeNormalizer(recordedNow)
		if (RECORD) fs.mkdirSync(FIXTURE_DIR, { recursive: true })
		for (const [name, { schema, body }] of Object.entries(replies)) {
			expect(schema.safeParse(body).success, `${name} parses`).toBe(true)
			const file = path.join(FIXTURE_DIR, `${name}.json`)
			const value = normalize(body)
			if (RECORD) {
				fs.writeFileSync(file, `${JSON.stringify(value, null, '\t')}\n`)
				continue
			}
			expect(fs.existsSync(file), `${file} is missing: re-record`).toBe(true)
			const fixture = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
			expect(schema.safeParse(fixture).success, `${name} fixture parses`).toBe(
				true,
			)
			expect(sameKeys(shapeOf(fixture), shapeOf(value)), name).toEqual([])
		}
	})
})

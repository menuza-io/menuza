import crypto from 'node:crypto'
import {
	STATION_LATE_SYNC_MS,
	STATION_WASTE_UNDO_SERVER_MS,
	stationCatalogSchema,
	stationCountEntriesResultSchema,
	stationCountSheetSchema,
	stationDeliveryResultSchema,
	prepPlanSchema,
	prepTaskSchema,
	stationDishWasteResultSchema,
	stationPhotoUploadSchema,
	stationStartCountResultSchema,
	stationUndoWasteResultSchema,
	stationWasteResultSchema,
	PICKABLE_WASTE_REASONS,
} from '@repo/inventory'
import {
	invAuditLog,
	invCountEntries,
	invDeliveries,
	invDeliveryLines,
	invItems,
	invMovements,
	invPrepLevels,
	invPrepTasks,
	invRecipeLines,
	invRecipes,
	invWaste,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	createClockHarness,
	ORG_A,
	ORG_B,
	type ClockHarness,
} from '../../tests/timeclock-harness.ts'
import { makeOrg, type TestOrg } from '../../tests/staff-harness.ts'
import {
	invalidateInventoryContext,
	seedInventoryContextForTest,
} from '../lib/inventory-context.ts'
import {
	createStationKit,
	moneyKeys,
	ON,
	STOCK_LOC,
	type Kitchen,
	type StationKit,
} from './pos-inventory-fixture.ts'

/**
 * `/pos/inventory/*`, the Station Stock app's regional API: every route's
 * happy path and the rules the contract states (join, latest wins, per-entry
 * refusals, closed counts, pickable reasons, late sync, the roster rule, undo
 * windows, quantity-only deliveries, the receive permission, order links,
 * idempotency and the invoice photo).
 */

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

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 12)}`
const HOUR = 60 * 60 * 1000

describe('/pos/inventory', () => {
	let h: ClockHarness
	let kit: StationKit
	let k: Kitchen
	let tablet: Awaited<ReturnType<StationKit['station']>>

	beforeEach(async () => {
		orgs.clear()
		orgs.set(ORG_A, makeOrg(ORG_A))
		orgs.set(ORG_B, makeOrg(ORG_B))
		vi.stubEnv('POS_ENABLED', '')
		vi.stubEnv('INVENTORY_ENABLED', '')
		invalidateInventoryContext()
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response('not found', { status: 404 })),
		)
		h = await createClockHarness([ORG_A, ORG_B])
		kit = createStationKit(h)
		kit.enableInventory(ORG_A)
		kit.enableInventory(ORG_B)
		k = await kit.kitchen(ORG_A)
		tablet = await kit.station(ORG_A)
	})
	afterEach(async () => {
		vi.useRealTimers()
		invalidateInventoryContext()
		vi.unstubAllGlobals()
		await h.cleanup()
	})

	/** The tablet's calls: the terminal's secret and a person's session. */
	const as =
		(who: 'cashier' | 'manager' = 'cashier') =>
		(
			method: string,
			path: string,
			options: Parameters<StationKit['request']>[2] = {},
		) =>
			kit.request(method, path, {
				secret: tablet.secret,
				session: tablet[who].session,
				...options,
			})
	const cashier = as('cashier')
	const manager = as('manager')

	const startCount = (
		options: {
			listId?: string | null
			clientId?: string
			who?: 'cashier' | 'manager'
		} = {},
	) =>
		as(options.who ?? 'cashier')('POST', '/pos/inventory/counts', {
			body: {
				clientId: options.clientId ?? uid('start'),
				locationId: STOCK_LOC,
				listId: options.listId === undefined ? k.list.id : options.listId,
			},
		})

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

	// ── Catalogue ─────────────────────────────────────────────────────────────

	describe('GET /pos/inventory/catalog', () => {
		const catalog = () =>
			cashier('GET', `/pos/inventory/catalog?locationId=${STOCK_LOC}`)

		it('answers the location in the contract’s shape, with no money, stock figure or supplier contact', async () => {
			const reply = await catalog()
			expect(reply.status, reply.raw).toBe(200)
			expect(reply.headers.get('cache-control')).toBe('private, no-store')
			const parsed = stationCatalogSchema.parse(reply.body)
			expect(parsed.locationId).toBe(STOCK_LOC)
			expect(parsed.contractVersion).toBe(1)
			expect(parsed.settings).toEqual({
				receiveRequiresManager: true,
				photoMaxBytes: 5 * 1024 * 1024,
				ordersEnabled: true,
			})

			// Items the location keeps, plus the one only the weekly list names.
			expect(parsed.items.map((item) => item.name)).toEqual([
				'Chicken thigh',
				'Lemons',
				'Olive oil',
				'Pita bread',
				'Tomatoes',
			])
			const chicken = parsed.items.find(
				(item) => item.name === 'Chicken thigh',
			)!
			expect(chicken).toMatchObject({
				baseUnit: 'g',
				countUnit: 'kg',
				areaIds: [k.areas.walkin.id],
			})
			expect(chicken.units).toEqual([
				expect.objectContaining({ name: 'Box', baseQuantity: 10_000_000 }),
			])
			const lemon = parsed.items.find((item) => item.name === 'Lemons')!
			expect(lemon.areaIds).toEqual([])
			expect(lemon.countUnit).toBe('piece')

			expect(parsed.areas.map((area) => area.name)).toEqual([
				'Walk-in fridge',
				'Dry store',
			])
			expect(parsed.areas[0]!.itemIds).toHaveLength(2)
			expect(parsed.countLists).toEqual([
				expect.objectContaining({
					id: k.list.id,
					name: 'Weekly count',
					itemIds: expect.arrayContaining([k.items.lemon.id]),
				}),
			])
			expect(parsed.counts).toEqual([])
			expect(parsed.wasteReasons).toEqual([...PICKABLE_WASTE_REASONS])
			expect(parsed.wasteReasons).not.toContain('cancelled_after_cooking')
			expect(parsed.recentWasteItemIds).toEqual([])

			// What the supplier sells: pack names and sizes, never a price or a contact.
			expect(parsed.suppliers).toHaveLength(1)
			expect(parsed.suppliers[0]!.name).toBe('Fresh Produce Co')
			expect(
				parsed.suppliers[0]!.products.map((p) => p.packName).sort(),
			).toEqual(['Box', 'Crate 6 kg'])
			expect(
				parsed.suppliers[0]!.products.find((p) => p.packName === 'Box')!
					.pricedByWeight,
			).toBe(true)
			expect(reply.raw).not.toContain('orders@fresh.example')
			expect(reply.raw).not.toContain('+966500000000')
			expect(reply.raw).not.toContain('Faisal')

			// The open order a delivery can receive, with its outstanding packs.
			expect(parsed.expectedDeliveries).toHaveLength(1)
			const expected = parsed.expectedDeliveries[0]!
			expect(expected).toMatchObject({
				orderId: k.orderId,
				status: 'sent',
				supplierName: 'Fresh Produce Co',
			})
			expect(
				expected.lines.map((line) => [line.itemName, line.outstandingPacks]),
			).toEqual(
				expect.arrayContaining([
					['Tomatoes', 3],
					['Chicken thigh', 2],
				]),
			)

			expect(moneyKeys(reply.body)).toEqual([])
			expect([...new Set(Object.keys(reply.body))].sort()).toEqual(
				[
					'areas',
					'contractVersion',
					'countLists',
					'counts',
					'expectedDeliveries',
					'generatedAt',
					'items',
					'locationId',
					'recentWasteItemIds',
					'settings',
					'suppliers',
					'version',
					'wasteReasons',
				].sort(),
			)
			expect(JSON.stringify(reply.body)).not.toMatch(
				/onHand|lastCount|expected(?!Deliveries|Date)/,
			)
		})

		it('is cacheable by version: ETag, then 304 with no body, then a new version when something changes', async () => {
			const first = await catalog()
			const version = first.body.version as string
			expect(first.headers.get('etag')).toBe(`"${version}"`)

			for (const header of [
				`"${version}"`,
				`W/"${version}"`,
				`"x", "${version}"`,
			]) {
				const again = await cashier(
					'GET',
					`/pos/inventory/catalog?locationId=${STOCK_LOC}`,
					{ headers: { 'If-None-Match': header } },
				)
				expect(again.status, header).toBe(304)
				expect(again.raw).toBe('')
				expect(again.headers.get('cache-control')).toBe('private, no-store')
				expect(again.headers.get('etag')).toBe(`"${version}"`)
			}
			const stale = await cashier(
				'GET',
				`/pos/inventory/catalog?locationId=${STOCK_LOC}`,
				{ headers: { 'If-None-Match': '"cat-0000000000000000" ' } },
			)
			expect(stale.status).toBe(200)
			// A 304 still needs a session, like every call.
			const nobody = await kit.request(
				'GET',
				`/pos/inventory/catalog?locationId=${STOCK_LOC}`,
				{ secret: tablet.secret, headers: { 'If-None-Match': `"${version}"` } },
			)
			expect(nobody.status).toBe(401)

			// A count in progress changes what the tablet must show.
			expect((await startCount()).status).toBe(200)
			const changed = await catalog()
			expect(changed.body.version).not.toBe(version)
			expect(changed.body.counts).toHaveLength(1)
			expect(changed.body.counts[0]).toMatchObject({
				status: 'counting',
				listName: 'Weekly count',
				itemTotal: 5,
				itemsCounted: 0,
			})
			expect(moneyKeys(changed.body)).toEqual([])
		})

		it('lists the terminal’s own recent waste items, newest first, and leaves out the undone', async () => {
			const waste = async (itemId: string) =>
				(
					await cashier('POST', '/pos/inventory/waste', {
						body: {
							entries: [
								{
									clientId: uid('w'),
									locationId: STOCK_LOC,
									itemId,
									amount: 1,
									unit: itemId === k.items.pita.id ? 'piece' : 'kg',
									reason: 'spoiled',
								},
							],
						},
					})
				).body.accepted[0].id as string
			await waste(k.items.tomato.id)
			const undone = await waste(k.items.chicken.id)
			await waste(k.items.pita.id)
			await waste(k.items.tomato.id)
			expect(
				(
					await cashier('POST', `/pos/inventory/waste/${undone}/undo`, {
						body: { clientId: uid('undo') },
					})
				).status,
			).toBe(200)
			const reply = await catalog()
			expect(reply.body.recentWasteItemIds).toEqual([
				k.items.tomato.id,
				k.items.pita.id,
			])
		})

		it('refuses another location and unknown query parameters', async () => {
			const wrong = await cashier(
				'GET',
				'/pos/inventory/catalog?locationId=loc_elsewhere',
			)
			expect(wrong.status).toBe(403)
			expect(wrong.body.error).toBe('wrong_location')
			const missing = await cashier('GET', '/pos/inventory/catalog')
			expect(missing.status).toBe(400)
			expect(missing.body.error).toBe('invalid_request')
			const extra = await cashier(
				'GET',
				`/pos/inventory/catalog?locationId=${STOCK_LOC}&orgId=${ORG_B}`,
			)
			expect(extra.status).toBe(400)
		})

		it('offers no expected deliveries while the organization has no purchasing', async () => {
			kit.enableInventory(ORG_A, {
				...(await import('./pos-inventory-fixture.ts')).ON,
				purchasing: false,
			})
			const reply = await catalog()
			expect(reply.status).toBe(200)
			expect(reply.body.settings.ordersEnabled).toBe(false)
			expect(reply.body.expectedDeliveries).toEqual([])
		})
	})

	// ── Counts ────────────────────────────────────────────────────────────────

	describe('counts', () => {
		it('starts a count, joins it from a second tablet, and answers a replay with the first result', async () => {
			const clientId = uid('start')
			const first = await startCount({ clientId })
			expect(first.status, first.raw).toBe(200)
			expect(first.headers.get('cache-control')).toBe('private, no-store')
			const started = stationStartCountResultSchema.parse(first.body)
			expect(started.joined).toBe(false)
			expect(started.count).toMatchObject({
				status: 'counting',
				locationId: STOCK_LOC,
				listId: k.list.id,
				listName: 'Weekly count',
				itemTotal: 5,
				itemsCounted: 0,
				startedBy: { kind: 'staff', id: tablet.cashier.staffId },
			})
			expect(moneyKeys(first.body)).toEqual([])

			// A second terminal at the same location joins the open count.
			const other = await kit.station(ORG_A, { terminalCode: 'K2' })
			const second = await kit.request('POST', '/pos/inventory/counts', {
				secret: other.secret,
				session: other.cashier.session,
				body: {
					clientId: uid('start'),
					locationId: STOCK_LOC,
					listId: k.list.id,
				},
			})
			expect(second.status, second.raw).toBe(200)
			expect(second.body.joined).toBe(true)
			expect(second.body.count.id).toBe(started.count.id)

			// The first tablet resends the same item after a lost answer.
			const replay = await startCount({ clientId })
			expect(replay.status).toBe(200)
			expect(replay.body).toEqual(first.body)

			// A different count (everything, no list) is its own count; the same id with
			// another body is refused.
			const everything = await startCount({ listId: null })
			expect(everything.body.joined).toBe(false)
			expect(everything.body.count.id).not.toBe(started.count.id)
			const conflict = await startCount({ clientId, listId: null })
			expect(conflict.status).toBe(409)
			expect(conflict.body.error).toBe('idempotency_conflict')
		})

		it('shows the sheet in walking order, with nobody’s expected figure and this person’s own last amounts', async () => {
			const started = (await startCount()).body.count.id as string
			await cashier('POST', `/pos/inventory/counts/${started}/entries`, {
				body: {
					entries: [
						entry(k.items.tomato.id, 2.5),
						entry(k.items.chicken.id, 4),
					],
				},
			})
			const sheet = await cashier('GET', `/pos/inventory/counts/${started}`)
			expect(sheet.status, sheet.raw).toBe(200)
			const parsed = stationCountSheetSchema.parse(sheet.body)
			expect(parsed.count.id).toBe(started)
			expect(parsed.count.itemsCounted).toBe(2)
			expect(parsed.areas.map((area) => area.name)).toEqual([
				'Walk-in fridge',
				'Dry store',
				null,
			])
			const walkin = parsed.areas[0]!.items
			expect(walkin.map((item) => item.name).sort()).toEqual([
				'Chicken thigh',
				'Tomatoes',
			])
			const tomato = walkin.find((item) => item.name === 'Tomatoes')!
			expect(tomato).toMatchObject({
				quantity: 2_500_000,
				mine: { amount: 2.5, unit: 'kg' },
				countUnit: 'kg',
			})
			expect(parsed.areas[2]!.items.map((item) => item.name)).toEqual([
				'Lemons',
			])
			expect(moneyKeys(sheet.body)).toEqual([])
			expect(sheet.raw).not.toMatch(/expected|onHand/)

			// Someone else sees the counted quantity but not the first person's typing.
			const second = await manager('GET', `/pos/inventory/counts/${started}`)
			const secondTomato = second.body.areas[0].items.find(
				(item: { name: string }) => item.name === 'Tomatoes',
			)
			expect(secondTomato).toMatchObject({ quantity: 2_500_000, mine: null })
		})

		it('keeps each person’s latest entry, lets amount null clear it, sums people, and refuses single entries without failing the batch', async () => {
			const id = (await startCount()).body.count.id as string
			const url = `/pos/inventory/counts/${id}/entries`
			const first = entry(k.items.tomato.id, 2)
			const second = entry(k.items.tomato.id, 3.5)
			const answer = await cashier('POST', url, {
				body: { entries: [first, second] },
			})
			expect(answer.status, answer.raw).toBe(200)
			expect(
				stationCountEntriesResultSchema.parse(answer.body).accepted,
			).toEqual([
				{ clientId: first.clientId, quantity: 2_000_000 },
				{ clientId: second.clientId, quantity: 3_500_000 },
			])
			const quantityOf = async (who: 'cashier' | 'manager' = 'cashier') => {
				const sheet = await as(who)('GET', `/pos/inventory/counts/${id}`)
				return sheet.body.areas[0].items.find(
					(item: { itemId: string }) => item.itemId === k.items.tomato.id,
				) as { quantity: number | null; mine: unknown }
			}
			// Latest wins: 3.5 kg, not 5.5.
			expect((await quantityOf()).quantity).toBe(3_500_000)
			// Another person's entry adds to it.
			await manager('POST', url, {
				body: { entries: [entry(k.items.tomato.id, 1)] },
			})
			expect((await quantityOf()).quantity).toBe(4_500_000)
			// Clearing removes only this person's entry.
			const clear = await cashier('POST', url, {
				body: { entries: [entry(k.items.tomato.id, null)] },
			})
			expect(clear.body.accepted[0].quantity).toBeNull()
			const afterClear = await quantityOf()
			expect(afterClear.quantity).toBe(1_000_000)
			expect(afterClear.mine).toBeNull()

			// A resend is a duplicate, not a second entry.
			const resend = await cashier('POST', url, {
				body: { entries: [first] },
			})
			expect(resend.body).toEqual({
				accepted: [],
				duplicates: [first.clientId],
				refused: [],
			})

			// Refusals are per entry, with 200; the rest is saved.
			const good = entry(k.items.oil.id, 2, {
				areaId: k.areas.dry.id,
				unit: 'l',
			})
			const batch = await cashier('POST', url, {
				body: {
					entries: [
						entry(k.items.tomato.id, 1, { unit: 'l' }),
						entry('item-that-never-was', 1),
						entry(k.items.tomato.id, 1, { areaId: 'area-that-never-was' }),
						good,
					],
				},
			})
			expect(batch.status).toBe(200)
			expect(batch.body.accepted).toEqual([
				{ clientId: good.clientId, quantity: 2_000_000 },
			])
			expect(batch.body.refused.map((r: { code: string }) => r.code)).toEqual([
				'unit_mismatch',
				'not_found',
				'not_found',
			])

			// An archived item is refused as such.
			await k.world.ok('POST', `/items/${k.items.lemon.id}/archive`, {
				expectedVersion: k.items.lemon.version,
			})
			const archived = await cashier('POST', url, {
				body: {
					entries: [
						entry(k.items.lemon.id, 3, { areaId: null, unit: 'piece' }),
					],
				},
			})
			expect(archived.body.refused[0].code).toBe('item_archived')
		})

		it('counts entries for the person who made them while they are still on the roster, and records who synced them', async () => {
			const id = (await startCount()).body.count.id as string
			const url = `/pos/inventory/counts/${id}/entries`
			const former = await h.seedStaff(ORG_A, {
				scopeIds: [tablet.cashier.staffId ? 'loc-1' : 'loc-1'],
				status: 'terminated',
			})
			const named = entry(k.items.tomato.id, 2, {
				madeBy: tablet.manager.staffId,
				madeAt: Date.now() - 2 * HOUR,
			})
			const left = entry(k.items.chicken.id, 3, { madeBy: former.staffId })
			const stranger = entry(k.items.oil.id, 1, {
				areaId: k.areas.dry.id,
				unit: 'l',
				madeBy: 'stf-nobody-knows',
			})
			const reply = await cashier('POST', url, {
				body: { entries: [named, left, stranger] },
			})
			expect(reply.status, reply.raw).toBe(200)
			expect(reply.body.accepted).toHaveLength(3)

			const db = await h.db(ORG_A)
			const rows = await db
				.select()
				.from(invCountEntries)
				.where(eq(invCountEntries.countId, id))
			const by = new Map(rows.map((row) => [row.clientId, row]))
			expect(by.get(named.clientId)).toMatchObject({
				counterKind: 'staff',
				counterId: tablet.manager.staffId,
			})
			// Someone no longer on the roster, or unknown: the signed-in person's.
			expect(by.get(left.clientId)!.counterId).toBe(tablet.cashier.staffId)
			expect(by.get(stranger.clientId)!.counterId).toBe(tablet.cashier.staffId)

			const audit = await db
				.select()
				.from(invAuditLog)
				.where(eq(invAuditLog.action, 'count.entries'))
			const forManager = audit.find(
				(row) => row.actorId === tablet.manager.staffId,
			)
			expect(forManager?.detail).toEqual({
				entries: 1,
				syncedBy: tablet.cashier.staffId,
			})
			const own = audit.find((row) => row.actorId === tablet.cashier.staffId)
			expect(own?.detail).toEqual({ entries: 2 })

			// The manager sees their own typing back on the sheet.
			const sheet = await manager('GET', `/pos/inventory/counts/${id}`)
			const tomato = sheet.body.areas[0].items.find(
				(item: { name: string }) => item.name === 'Tomatoes',
			)
			expect(tomato.mine).toEqual({ amount: 2, unit: 'kg' })
		})

		it('sends a count for review once, idempotently, and then answers 409 count_closed to late entries', async () => {
			const id = (await startCount()).body.count.id as string
			const clientId = uid('send')
			const sent = await cashier('POST', `/pos/inventory/counts/${id}/send`, {
				body: { clientId },
			})
			expect(sent.status, sent.raw).toBe(200)
			expect(sent.body).toMatchObject({
				id,
				status: 'in_review',
				sentForReviewAt: expect.any(Number),
			})
			expect(moneyKeys(sent.body)).toEqual([])
			// Another tablet sending too, and a replay, both answer 200.
			const again = await manager('POST', `/pos/inventory/counts/${id}/send`, {
				body: { clientId: uid('send') },
			})
			expect(again.status).toBe(200)
			expect(again.body.status).toBe('in_review')
			const replay = await cashier('POST', `/pos/inventory/counts/${id}/send`, {
				body: { clientId },
			})
			expect(replay.body).toEqual(sent.body)
			const db = await h.db(ORG_A)
			expect(
				(
					await db
						.select()
						.from(invAuditLog)
						.where(eq(invAuditLog.action, 'count.send'))
				).length,
			).toBe(1)

			// Entries after the send: the whole request is refused, nothing is stored.
			const late = await cashier(
				'POST',
				`/pos/inventory/counts/${id}/entries`,
				{
					body: { entries: [entry(k.items.tomato.id, 1)] },
				},
			)
			expect(late.status).toBe(409)
			expect(late.body.error).toBe('count_closed')
			expect(
				await db
					.select()
					.from(invCountEntries)
					.where(eq(invCountEntries.countId, id)),
			).toEqual([])

			// The office cancels it: sending is closed too.
			const operatorRead = await k.world.ok('GET', `/counts/${id}`)
			await k.world.ok('POST', `/counts/${id}/cancel`, {
				expectedVersion: operatorRead.count.version,
			})
			const closed = await cashier('POST', `/pos/inventory/counts/${id}/send`, {
				body: { clientId: uid('send') },
			})
			expect(closed.status).toBe(409)
			expect(closed.body.error).toBe('count_closed')
		})

		it('answers 404 for a count of another location, an unknown count, and an id that cannot be one', async () => {
			const elsewhere = await k.world.ok('POST', '/counts', {
				clientId: uid('op'),
				locationId: 'loc_elsewhere',
				listId: null,
			})
			for (const path of [
				`/pos/inventory/counts/${elsewhere.id}`,
				'/pos/inventory/counts/nothing-here',
				'/pos/inventory/counts/bad%20id',
			]) {
				const reply = await cashier('GET', path)
				expect(reply.status, path).toBe(404)
				expect(reply.body).toEqual({ error: 'not_found' })
			}
			const entries = await cashier(
				'POST',
				`/pos/inventory/counts/${elsewhere.id}/entries`,
				{ body: { entries: [entry(k.items.tomato.id, 1)] } },
			)
			expect(entries.status).toBe(404)
			const send = await cashier(
				'POST',
				`/pos/inventory/counts/${elsewhere.id}/send`,
				{ body: { clientId: uid('send') } },
			)
			expect(send.status).toBe(404)
			const start = await cashier('POST', '/pos/inventory/counts', {
				body: {
					clientId: uid('start'),
					locationId: 'loc_elsewhere',
					listId: null,
				},
			})
			expect(start.status).toBe(403)
			expect(start.body.error).toBe('wrong_location')
		})

		it('refuses a malformed request without echoing it', async () => {
			const id = (await startCount()).body.count.id as string
			const secretish = 'SECRET-VALUE-9f2c'
			const unknownField = await cashier(
				'POST',
				`/pos/inventory/counts/${id}/entries`,
				{
					body: {
						entries: [{ ...entry(k.items.tomato.id, 1), [secretish]: 'x' }],
					},
				},
			)
			expect(unknownField.status).toBe(400)
			expect(unknownField.body.error).toBe('invalid_request')
			expect(unknownField.raw).not.toContain(secretish)
			const tooMany = await cashier(
				'POST',
				`/pos/inventory/counts/${id}/entries`,
				{
					body: {
						entries: Array.from({ length: 201 }, () =>
							entry(k.items.tomato.id, 1),
						),
					},
				},
			)
			expect(tooMany.status).toBe(400)
			const notJson = await cashier(
				'POST',
				`/pos/inventory/counts/${id}/entries`,
				{ rawBody: 'not json' },
			)
			expect(notJson.status).toBe(400)
			expect(notJson.body).toEqual({ error: 'invalid_request' })
			const huge = await cashier(
				'POST',
				`/pos/inventory/counts/${id}/entries`,
				{ rawBody: JSON.stringify({ entries: [], pad: 'x'.repeat(300_000) }) },
			)
			expect(huge.status).toBe(413)
			expect(huge.body.error).toBe('payload_too_large')
		})
	})

	// ── Waste ─────────────────────────────────────────────────────────────────

	describe('waste', () => {
		const wasteEntry = (
			itemId: string,
			extra: Record<string, unknown> = {},
		) => ({
			clientId: uid('waste'),
			locationId: STOCK_LOC,
			itemId,
			amount: 1.5,
			unit: 'kg',
			reason: 'spoiled',
			...extra,
		})
		const waste = (
			entries: unknown[],
			who: 'cashier' | 'manager' = 'cashier',
		) => as(who)('POST', '/pos/inventory/waste', { body: { entries } })

		it('logs waste for the signed-in person at this terminal, takes stock out, and answers a resend as a duplicate', async () => {
			const one = wasteEntry(k.items.tomato.id, { note: 'left out overnight' })
			const reply = await waste([one])
			expect(reply.status, reply.raw).toBe(200)
			expect(reply.headers.get('cache-control')).toBe('private, no-store')
			const parsed = stationWasteResultSchema.parse(reply.body)
			expect(parsed.accepted).toEqual([
				{ clientId: one.clientId, id: expect.any(String), quantity: 1_500_000 },
			])
			expect(parsed.duplicates).toEqual([])
			expect(parsed.refused).toEqual([])
			expect(parsed.lateSync).toEqual([])
			expect(moneyKeys(reply.body)).toEqual([])

			const rows = await kit.wasteRows(ORG_A, tablet.deviceId)
			expect(rows).toHaveLength(1)
			expect(rows[0]).toMatchObject({
				source: 'station',
				deviceId: tablet.deviceId,
				actorKind: 'staff',
				actorId: tablet.cashier.staffId,
				quantity: 1_500_000,
				reason: 'spoiled',
				lateSync: false,
				note: 'left out overnight',
			})
			const db = await h.db(ORG_A)
			const movement = await db
				.select()
				.from(invMovements)
				.where(eq(invMovements.sourceId, rows[0]!.id))
			expect(movement).toEqual([
				expect.objectContaining({
					kind: 'waste',
					quantity: -1_500_000,
					actorKind: 'staff',
					actorId: tablet.cashier.staffId,
				}),
			])

			const resend = await waste([one])
			expect(resend.status).toBe(200)
			expect(resend.body.accepted).toEqual([])
			expect(resend.body.duplicates).toEqual([
				{ clientId: one.clientId, id: parsed.accepted[0]!.id },
			])
			expect(await kit.wasteRows(ORG_A)).toHaveLength(1)
		})

		it('takes the pickable reasons only, refusing the whole request otherwise', async () => {
			const before = await kit.wasteRows(ORG_A)
			for (const reason of ['cancelled_after_cooking', 'remade_at_till']) {
				const reply = await waste([
					wasteEntry(k.items.tomato.id),
					wasteEntry(k.items.tomato.id, { reason }),
				])
				expect(reply.status, reason).toBe(400)
				expect(reply.body.error).toBe('reason_not_allowed')
			}
			expect(await kit.wasteRows(ORG_A)).toHaveLength(before.length)
			const unknown = await waste([
				wasteEntry(k.items.tomato.id, { reason: 'because' }),
			])
			expect(unknown.status).toBe(400)
			expect(unknown.body.error).toBe('invalid_request')
		})

		it('flags waste that arrives more than 48 hours after it happened, and dates it by when it happened', async () => {
			const old = wasteEntry(k.items.tomato.id, {
				madeAt: Date.now() - STATION_LATE_SYNC_MS - HOUR,
			})
			const recent = wasteEntry(k.items.chicken.id, {
				madeAt: Date.now() - 2 * HOUR,
			})
			const reply = await waste([old, recent])
			expect(reply.status, reply.raw).toBe(200)
			expect(reply.body.lateSync).toEqual([old.clientId])
			expect(reply.body.accepted).toHaveLength(2)
			const rows = await kit.wasteRows(ORG_A, tablet.deviceId)
			const oldRow = rows.find((row) => row.clientId === old.clientId)!
			expect(oldRow.lateSync).toBe(true)
			expect(
				rows.find((row) => row.clientId === recent.clientId)!.lateSync,
			).toBe(false)
			const day = new Date(Date.now() - STATION_LATE_SYNC_MS - HOUR)
				.toISOString()
				.slice(0, 10)
			expect(oldRow.businessDate <= day || oldRow.businessDate === day).toBe(
				true,
			)
		})

		it('refuses single entries (unknown or archived item, a unit the item cannot use) and saves the others', async () => {
			await k.world.ok('POST', `/items/${k.items.lemon.id}/archive`, {
				expectedVersion: k.items.lemon.version,
			})
			const good = wasteEntry(k.items.tomato.id)
			const reply = await waste([
				wasteEntry('item-that-never-was'),
				wasteEntry(k.items.lemon.id, { unit: 'piece' }),
				wasteEntry(k.items.tomato.id, { unit: 'l' }),
				good,
			])
			expect(reply.status, reply.raw).toBe(200)
			expect(reply.body.refused.map((r: { code: string }) => r.code)).toEqual([
				'not_found',
				'item_archived',
				'unit_mismatch',
			])
			expect(
				reply.body.accepted.map((a: { clientId: string }) => a.clientId),
			).toEqual([good.clientId])
			expect(await kit.wasteRows(ORG_A)).toHaveLength(1)
		})

		it('refuses a batch that names another location or is too large', async () => {
			const wrong = await waste([
				wasteEntry(k.items.tomato.id),
				wasteEntry(k.items.tomato.id, { locationId: 'loc_elsewhere' }),
			])
			expect(wrong.status).toBe(403)
			expect(wrong.body.error).toBe('wrong_location')
			expect(await kit.wasteRows(ORG_A)).toHaveLength(0)
			const many = await waste(
				Array.from({ length: 51 }, () => wasteEntry(k.items.tomato.id)),
			)
			expect(many.status).toBe(400)
		})

		it('attributes waste to a person named by madeBy only while they are on the roster, and audits who synced it', async () => {
			const former = await h.seedStaff(ORG_A, {
				scopeIds: ['loc-1'],
				status: 'terminated',
			})
			const named = wasteEntry(k.items.tomato.id, {
				madeBy: tablet.manager.staffId,
			})
			const gone = wasteEntry(k.items.chicken.id, { madeBy: former.staffId })
			const reply = await waste([named, gone])
			expect(reply.status, reply.raw).toBe(200)
			const rows = await kit.wasteRows(ORG_A)
			const by = new Map(rows.map((row) => [row.clientId, row]))
			expect(by.get(named.clientId)!.actorId).toBe(tablet.manager.staffId)
			expect(by.get(gone.clientId)!.actorId).toBe(tablet.cashier.staffId)
			const db = await h.db(ORG_A)
			const audit = await db
				.select()
				.from(invAuditLog)
				.where(eq(invAuditLog.action, 'waste.log'))
			expect(
				audit.find((row) => row.actorId === tablet.manager.staffId)?.detail,
			).toEqual({ entries: 1, syncedBy: tablet.cashier.staffId })
		})

		describe('dishes (Kitchen "Log it as waste?")', () => {
			const dishWaste = (
				lines: unknown[],
				extra: Record<string, unknown> = {},
				who: 'cashier' | 'manager' = 'cashier',
			) =>
				as(who)('POST', '/pos/inventory/waste/dishes', {
					body: {
						clientId: uid('dish'),
						locationId: STOCK_LOC,
						lines,
						...extra,
					},
				})

			async function recipeFor(dishId: string) {
				const db = await h.db(ORG_A)
				const id = `rec_${dishId}`
				await db.insert(invRecipes).values({
					id,
					ownerKind: 'menu_item',
					ownerId: dishId,
					version: 1,
					effectiveFrom: 1,
					createdByKind: 'system',
				})
				await db.insert(invRecipeLines).values({
					recipeId: id,
					itemId: k.items.tomato.id,
					quantity: 100_000,
				})
			}

			it('writes the dish as waste of its ingredients, "Cancelled after cooking", against this terminal, once', async () => {
				await recipeFor('dish_shawarma')
				const clientId = uid('dish')
				const lines = [
					{ itemId: 'dish_shawarma', quantity: 2 },
					{ itemId: 'dish_without_recipe', quantity: 1 },
				]
				const reply = await dishWaste(lines, { clientId })
				expect(reply.status, reply.raw).toBe(200)
				expect(reply.headers.get('cache-control')).toBe('private, no-store')
				expect(stationDishWasteResultSchema.parse(reply.body)).toEqual({
					logged: 1,
					withoutRecipe: 1,
					duplicate: false,
				})
				expect(moneyKeys(reply.body)).toEqual([])
				const rows = await kit.wasteRows(ORG_A, tablet.deviceId)
				expect(rows).toHaveLength(1)
				expect(rows[0]).toMatchObject({
					itemId: k.items.tomato.id,
					quantity: 200_000,
					reason: 'cancelled_after_cooking',
					source: 'station',
					deviceId: tablet.deviceId,
					actorKind: 'staff',
					actorId: tablet.cashier.staffId,
				})
				const db = await h.db(ORG_A)
				const moves = await db
					.select()
					.from(invMovements)
					.where(eq(invMovements.sourceId, rows[0]!.id))
				expect(moves).toEqual([
					expect.objectContaining({ kind: 'waste', quantity: -200_000 }),
				])

				// A second tap answers the first result and writes nothing.
				const again = await dishWaste(lines, { clientId })
				expect(again.status).toBe(200)
				expect(again.body).toMatchObject({ duplicate: true })
				expect(await kit.wasteRows(ORG_A, tablet.deviceId)).toHaveLength(1)
			})

			it('needs the recipes flag and refuses another location', async () => {
				await recipeFor('dish_shawarma')
				const lines = [{ itemId: 'dish_shawarma', quantity: 1 }]
				const wrong = await dishWaste(lines, { locationId: 'loc_elsewhere' })
				expect(wrong.status).toBe(403)
				expect(wrong.body).toMatchObject({ error: 'wrong_location' })

				seedInventoryContextForTest(ORG_A, { ...ON, recipes: false })
				const off = await dishWaste(lines)
				expect(off.status).toBe(403)
				expect(off.body).toMatchObject({ error: 'inventory_disabled' })
				expect(await kit.wasteRows(ORG_A)).toHaveLength(0)
			})

			it('refuses a malformed request', async () => {
				for (const lines of [
					[],
					[{ itemId: 'dish_shawarma', quantity: 0 }],
					[{ itemId: 'dish_shawarma', quantity: 1, price: 5 }],
				]) {
					const reply = await dishWaste(lines)
					expect(reply.status).toBe(400)
				}
			})
		})

		describe('undo', () => {
			const logged = async (who: 'cashier' | 'manager' = 'cashier') => {
				const reply = await waste([wasteEntry(k.items.tomato.id)], who)
				return reply.body.accepted[0].id as string
			}
			const undo = (
				id: string,
				clientId = uid('undo'),
				who: 'cashier' | 'manager' = 'cashier',
			) =>
				as(who)('POST', `/pos/inventory/waste/${id}/undo`, {
					body: { clientId },
				})

			it('reverses one’s own entry once, answers a replay with the same entry, and puts the stock back', async () => {
				const id = await logged()
				const clientId = uid('undo')
				const reply = await undo(id, clientId)
				expect(reply.status, reply.raw).toBe(200)
				const { id: reversing } = stationUndoWasteResultSchema.parse(reply.body)
				expect(reversing).not.toBe(id)
				const replay = await undo(id, clientId)
				expect(replay.status).toBe(200)
				expect(replay.body).toEqual({ id: reversing })
				const twice = await undo(id)
				expect(twice.status).toBe(409)
				expect(twice.body.error).toBe('already_undone')

				const db = await h.db(ORG_A)
				const movements = await db
					.select({ quantity: invMovements.quantity })
					.from(invMovements)
					.where(eq(invMovements.kind, 'waste'))
				expect(movements.reduce((sum, row) => sum + row.quantity, 0)).toBe(0)
				const reversal = (await kit.wasteRows(ORG_A)).find(
					(row) => row.id === reversing,
				)!
				expect(reversal).toMatchObject({
					reversesId: id,
					source: 'station',
					deviceId: tablet.deviceId,
					actorId: tablet.cashier.staffId,
				})
			})

			it('is too late after the server window', async () => {
				const id = await logged()
				vi.useFakeTimers({ toFake: ['Date'] })
				vi.setSystemTime(Date.now() + STATION_WASTE_UNDO_SERVER_MS + 1_000)
				const late = await undo(id)
				expect(late.status).toBe(409)
				expect(late.body.error).toBe('undo_expired')
			})

			it('is the person’s own entry from this terminal, otherwise a 404', async () => {
				const mine = await logged('cashier')
				const theirs = await undo(mine, uid('undo'), 'manager')
				expect(theirs.status).toBe(404)
				expect(theirs.body).toEqual({ error: 'not_found' })

				// Waste from another terminal of the same organization.
				const other = await kit.station(ORG_A, { terminalCode: 'K2' })
				const elsewhere = await kit.request('POST', '/pos/inventory/waste', {
					secret: other.secret,
					session: other.cashier.session,
					body: { entries: [wasteEntry(k.items.tomato.id)] },
				})
				const foreign = elsewhere.body.accepted[0].id as string
				expect((await undo(foreign)).status).toBe(404)
				// Waste the office logged in the App.
				const officeWaste = await k.world.ok('POST', '/waste', {
					entries: [wasteEntry(k.items.tomato.id)],
				})
				expect((await undo(officeWaste.accepted[0].id)).status).toBe(404)
				expect((await undo('no-such-waste')).status).toBe(404)
				// Nothing was reversed.
				const rows = await kit.wasteRows(ORG_A)
				expect(rows.filter((row) => row.reversesId !== null)).toEqual([])
			})
		})
	})

	// ── Deliveries ────────────────────────────────────────────────────────────

	describe('prep (Kitchen)', () => {
		async function seedSauce() {
			const db = await h.db(ORG_A)
			await db.insert(invItems).values({
				id: 'prep_sauce',
				name: 'Prep sauce',
				kind: 'made',
				baseUnit: 'ml',
			})
			await db.insert(invRecipes).values({
				id: 'prep_sauce_recipe',
				ownerKind: 'made_item',
				ownerId: 'prep_sauce',
				version: 1,
				makesQuantity: 1_000_000,
				effectiveFrom: 1,
				createdByKind: 'system',
			})
			await db.insert(invRecipeLines).values({
				recipeId: 'prep_sauce_recipe',
				itemId: k.items.tomato.id,
				quantity: 100_000,
			})
			for (let weekday = 0; weekday < 7; weekday++) {
				await db.insert(invPrepLevels).values({
					itemId: 'prep_sauce',
					locationId: STOCK_LOC,
					weekday,
					fillUpToQuantity: 2_000_000,
				})
			}
			return db
		}
		const plan = (query = '') =>
			cashier('GET', `/pos/inventory/prep?locationId=${STOCK_LOC}${query}`)
		const generate = () =>
			cashier('POST', '/pos/inventory/prep/generate', {
				body: { locationId: STOCK_LOC },
			})

		it('plans the day, and a cook starts a task and records what came out', async () => {
			const db = await seedSauce()
			const before = await plan()
			expect(before.status, before.raw).toBe(200)
			expect(prepPlanSchema.parse(before.body)).toMatchObject({
				generated: false,
				canGenerate: true,
				tasks: [],
			})
			expect(before.headers.get('cache-control')).toBe('private, no-store')

			const made = await generate()
			expect(made.status, made.raw).toBe(200)
			const tasks = prepPlanSchema.parse(made.body).tasks
			expect(tasks).toHaveLength(1)
			// Fill up to 2 L, none on hand, a batch makes 1 L: two batches.
			expect(tasks[0]).toMatchObject({
				itemName: 'Prep sauce',
				plannedQuantity: 2_000_000,
				batches: 2,
				status: 'todo',
			})
			expect(moneyKeys(made.body)).toEqual([])

			const started = await cashier(
				'POST',
				`/pos/inventory/prep/tasks/${tasks[0]!.id}/start`,
				{ body: { expectedVersion: tasks[0]!.version } },
			)
			expect(started.status, started.raw).toBe(200)
			const task = prepTaskSchema.parse(started.body)
			expect(task.status).toBe('in_progress')

			const done = await cashier(
				'POST',
				`/pos/inventory/prep/tasks/${task.id}/done`,
				{
					body: {
						expectedVersion: task.version,
						clientId: uid('done'),
						made: { kind: 'batches', count: 2 },
					},
				},
			)
			expect(done.status, done.raw).toBe(200)
			expect(prepTaskSchema.parse(done.body)).toMatchObject({
				status: 'done',
				madeQuantity: 2_000_000,
			})
			const [row] = await db.select().from(invPrepTasks)
			expect(row).toMatchObject({
				status: 'done',
				startedById: tablet.cashier.staffId,
				doneById: tablet.cashier.staffId,
				doneByKind: 'staff',
			})
			const sauce = await db
				.select()
				.from(invMovements)
				.where(eq(invMovements.itemId, 'prep_sauce'))
			expect(sauce.reduce((sum, move) => sum + move.quantity, 0)).toBe(
				2_000_000,
			)
		})

		it('shows a station only its own tasks and the ones nobody routed', async () => {
			await seedSauce()
			await generate()
			const mine = prepPlanSchema.parse((await plan('&stationId=kitchen')).body)
			expect(mine.tasks).toHaveLength(1)
			const db = await h.db(ORG_A)
			await db.update(invPrepTasks).set({ stationId: 'grill' })
			expect(
				prepPlanSchema.parse((await plan('&stationId=kitchen')).body).tasks,
			).toHaveLength(0)
			expect(
				prepPlanSchema.parse((await plan('&stationId=grill')).body).tasks,
			).toHaveLength(1)
		})

		it('needs the prep flag, and refuses another location', async () => {
			await seedSauce()
			const wrong = await cashier(
				'GET',
				'/pos/inventory/prep?locationId=loc_elsewhere',
			)
			expect(wrong.status).toBe(403)
			expect(wrong.body).toMatchObject({ error: 'wrong_location' })
			seedInventoryContextForTest(ORG_A, { ...ON, prep: false })
			const off = await plan()
			expect(off.status).toBe(403)
			expect(off.body).toMatchObject({ error: 'inventory_disabled' })
		})
	})

	describe('deliveries', () => {
		const line = (
			itemId: string,
			quantity: number,
			extra: Record<string, unknown> = {},
		) => ({ itemId, quantity, ...extra })
		const delivery = (
			extra: Record<string, unknown> = {},
			lines: unknown[] = [line(k.items.tomato.id, 6_000_000)],
		) => ({
			clientId: uid('delivery'),
			locationId: STOCK_LOC,
			supplierId: k.supplier.id,
			lines,
			...extra,
		})
		const receive = (body: unknown, who: 'cashier' | 'manager' = 'manager') =>
			as(who)('POST', '/pos/inventory/deliveries', { body })
		const operatorDelivery = async (id: string) =>
			(await k.world.ok('GET', `/deliveries/${id}`)) as Record<string, any>
		const orderStatus = async () =>
			(await k.world.ok('GET', `/orders/${k.orderId}`)).status as string

		it('records quantities only, against an order, with prices left pending', async () => {
			const body = delivery({ orderId: k.orderId, invoiceNumber: 'INV-1' }, [
				line(k.items.tomato.id, 18_000_000, {
					supplierProductId: k.products.tomato.id,
					packs: 3,
					packName: 'Crate 6 kg',
					packBaseQuantity: 6_000_000,
					orderLineId: k.orderLines.find((l) => l.itemId === k.items.tomato.id)!
						.id,
				}),
			])
			const reply = await receive(body)
			expect(reply.status, reply.raw).toBe(200)
			expect(reply.headers.get('cache-control')).toBe('private, no-store')
			const parsed = stationDeliveryResultSchema.parse(reply.body)
			expect(parsed).toMatchObject({
				lineCount: 1,
				pricesPending: true,
				lateSync: false,
				duplicate: false,
				order: { id: k.orderId, status: 'partly_received' },
				orderLinkIgnored: null,
			})
			expect(moneyKeys(reply.body)).toEqual([])

			// What the office sees: a Station delivery, quantities in, prices pending.
			const seen = await operatorDelivery(parsed.id)
			expect(seen).toMatchObject({
				source: 'station',
				pricesPending: true,
				orderId: k.orderId,
				invoiceNumber: 'INV-1',
				receivedBy: { kind: 'staff', id: tablet.manager.staffId },
				status: 'received',
			})
			const db = await h.db(ORG_A)
			const lines = await db
				.select()
				.from(invDeliveryLines)
				.where(eq(invDeliveryLines.deliveryId, parsed.id))
			expect(lines).toEqual([
				expect.objectContaining({
					quantity: 18_000_000,
					pricedAt: null,
					priceMinor: null,
					lineTotalMinor: 0,
				}),
			])
			const movement = await db
				.select()
				.from(invMovements)
				.where(eq(invMovements.sourceId, parsed.id))
			expect(movement).toEqual([
				expect.objectContaining({
					kind: 'delivery',
					quantity: 18_000_000,
					valueMinor: null,
					actorKind: 'staff',
					actorId: tablet.manager.staffId,
				}),
			])
			expect(await orderStatus()).toBe('partly_received')
		})

		it('closes the order it names when nothing more is coming', async () => {
			const reply = await receive(
				delivery({ orderId: k.orderId, closeOrder: true }, [
					line(k.items.tomato.id, 12_000_000, {
						orderLineId: k.orderLines.find(
							(l) => l.itemId === k.items.tomato.id,
						)!.id,
					}),
				]),
			)
			expect(reply.status, reply.raw).toBe(200)
			expect(reply.body.order).toEqual({ id: k.orderId, status: 'received' })
			expect(await orderStatus()).toBe('received')
			// A received order is no longer on the tablet's list.
			const catalog = await cashier(
				'GET',
				`/pos/inventory/catalog?locationId=${STOCK_LOC}`,
			)
			expect(catalog.body.expectedDeliveries).toEqual([])
		})

		it('never refuses goods for the order it names: a closed, unknown or other supplier’s order is recorded unlinked and says why', async () => {
			const other = await k.world.supplier('Other Supplier')
			const wrongSupplier = await receive(
				delivery({ orderId: k.orderId, supplierId: other.id }),
			)
			expect(wrongSupplier.status, wrongSupplier.raw).toBe(200)
			expect(wrongSupplier.body).toMatchObject({
				order: null,
				orderLinkIgnored: 'wrong_supplier',
			})
			const unknown = await receive(delivery({ orderId: 'no-such-order' }))
			expect(unknown.body).toMatchObject({
				order: null,
				orderLinkIgnored: 'not_found',
			})
			// An order at another location is just as unknown.
			const elsewhere = await k.world.ok('POST', '/orders', {
				clientId: uid('ord'),
				locationId: 'loc_elsewhere',
				supplierId: k.supplier.id,
				lines: [
					{
						itemId: k.items.tomato.id,
						supplierProductId: k.products.tomato.id,
						packs: 1,
					},
				],
			})
			expect(
				(await receive(delivery({ orderId: elsewhere.id }))).body
					.orderLinkIgnored,
			).toBe('not_found')
			const closing = await receive(
				delivery({ orderId: k.orderId, closeOrder: true }),
			)
			expect(closing.body.orderLinkIgnored).toBeNull()
			const closed = await receive(delivery({ orderId: k.orderId }))
			expect(closed.status).toBe(200)
			expect(closed.body).toMatchObject({
				order: null,
				orderLinkIgnored: 'closed',
			})
			// Every one of them is real stock.
			const db = await h.db(ORG_A)
			const deliveries = await db.select().from(invDeliveries)
			expect(deliveries).toHaveLength(5)
			expect(deliveries.every((row) => row.source === 'station')).toBe(true)
			// Without an order there is nothing to ignore.
			expect((await receive(delivery())).body.orderLinkIgnored).toBeNull()
		})

		it('needs a till manager unless the organization lets any staff receive', async () => {
			const refused = await receive(delivery(), 'cashier')
			expect(refused.status).toBe(403)
			expect(refused.body).toEqual({ error: 'receive_needs_manager' })
			const db = await h.db(ORG_A)
			expect(await db.select().from(invDeliveries)).toEqual([])
			const catalog = await cashier(
				'GET',
				`/pos/inventory/catalog?locationId=${STOCK_LOC}`,
			)
			expect(catalog.body.settings.receiveRequiresManager).toBe(true)

			const settings = await k.world.ok('GET', '/settings')
			const saved = await k.world.ok('PUT', '/settings', {
				expectedVersion: settings.version,
				anyStaffCanReceive: true,
			})
			expect(saved.anyStaffCanReceive).toBe(true)
			const allowed = await receive(delivery(), 'cashier')
			expect(allowed.status, allowed.raw).toBe(200)
			expect(
				(await cashier('GET', `/pos/inventory/catalog?locationId=${STOCK_LOC}`))
					.body.settings.receiveRequiresManager,
			).toBe(false)
		})

		it('flags a delivery that arrives more than 48 hours after it happened', async () => {
			const madeAt = Date.now() - STATION_LATE_SYNC_MS - HOUR
			const reply = await receive(delivery({ madeAt }))
			expect(reply.status, reply.raw).toBe(200)
			expect(reply.body.lateSync).toBe(true)
			expect(reply.body.receivedAt).toBeLessThanOrEqual(madeAt)
			const seen = await operatorDelivery(reply.body.id)
			expect(seen.lateSync).toBe(true)
			const fresh = await receive(delivery({ madeAt: Date.now() - HOUR }))
			expect(fresh.body.lateSync).toBe(false)
		})

		it('is idempotent by clientId: a resend answers the first result, another body is a conflict, and stock goes in once', async () => {
			const body = delivery()
			const first = await receive(body)
			expect(first.body.duplicate).toBe(false)
			const replay = await receive(body)
			expect(replay.status).toBe(200)
			expect(replay.body).toEqual({ ...first.body, duplicate: true })
			// The same delivery sent by the other manager (a retry after sign-out) is still the same.
			const db = await h.db(ORG_A)
			expect(await db.select().from(invDeliveries)).toHaveLength(1)
			const movements = await db
				.select()
				.from(invMovements)
				.where(eq(invMovements.kind, 'delivery'))
			expect(movements).toHaveLength(1)
			const conflict = await receive({
				...body,
				lines: [line(k.items.tomato.id, 1_000_000)],
			})
			expect(conflict.status).toBe(409)
			expect(conflict.body.error).toBe('idempotency_conflict')
		})

		it('refuses money, unknown fields, an unknown item or supplier, and another location', async () => {
			const withMoney = await receive(
				delivery({}, [
					line(k.items.tomato.id, 1_000_000, { lineTotalMinor: 5 }),
				]),
			)
			expect(withMoney.status).toBe(400)
			expect(withMoney.body.error).toBe('invalid_request')
			for (const extra of [
				{ paid: true },
				{ currency: 'SAR' },
				{ totalMinor: 1 },
			]) {
				expect((await receive(delivery(extra))).status).toBe(400)
			}
			const unknownItem = await receive(
				delivery({}, [line('no-such-item', 1000)]),
			)
			expect(unknownItem.status).toBe(404)
			expect(unknownItem.body.error).toBe('not_found')
			const wrong = await receive(delivery({ locationId: 'loc_elsewhere' }))
			expect(wrong.status).toBe(403)
			expect(wrong.body.error).toBe('wrong_location')
			const db = await h.db(ORG_A)
			expect(await db.select().from(invDeliveries)).toEqual([])
		})

		describe('the invoice photo', () => {
			const storageEnv = {
				RECORDING_S3_BUCKET: 'region-bucket',
				RECORDING_S3_ENDPOINT: 'https://s3.example.test',
				RECORDING_S3_ACCESS_KEY: 'access',
				RECORDING_S3_SECRET: 'secret',
			}
			const objects = new Map<string, { size: number; type: string }>()
			afterEach(() => {
				for (const key of Object.keys(storageEnv)) process.env[key] = ''
				objects.clear()
			})
			function withStorage() {
				Object.assign(process.env, storageEnv)
				vi.stubGlobal(
					'fetch',
					vi.fn(async (url: unknown, init?: RequestInit) => {
						const key = decodeURIComponent(
							new URL(String(url)).pathname,
						).replace('/region-bucket/', '')
						if (init?.method === 'DELETE') {
							objects.delete(key)
							return new Response(null, { status: 204 })
						}
						const object = objects.get(key)
						if (!object) return new Response(null, { status: 404 })
						return new Response(null, {
							status: 200,
							headers: {
								'content-length': String(object.size),
								'content-type': object.type,
							},
						})
					}),
				)
			}
			const record = async () => (await receive(delivery())).body.id as string
			const requestPhoto = (
				id: string,
				body: unknown = { contentType: 'image/jpeg', sizeBytes: 1234 },
				who: 'cashier' | 'manager' = 'manager',
			) => as(who)('POST', `/pos/inventory/deliveries/${id}/photo`, { body })
			const confirm = (
				id: string,
				key: string,
				who: 'cashier' | 'manager' = 'manager',
			) =>
				as(who)('POST', `/pos/inventory/deliveries/${id}/photo/confirm`, {
					body: { key },
				})

			it('answers 503 upload_not_configured on a node with no storage, keeping the delivery', async () => {
				const id = await record()
				const reply = await requestPhoto(id)
				expect(reply.status).toBe(503)
				expect(reply.body).toEqual({ error: 'upload_not_configured' })
				const confirmed = await confirm(
					id,
					`inventory-invoices/${ORG_A}/${id}/00000000-0000-4000-8000-000000000000.jpg`,
				)
				expect(confirmed.status).toBe(503)
				expect(confirmed.body.error).toBe('upload_not_configured')
				expect(await operatorDelivery(id)).toMatchObject({ status: 'received' })
			})

			it('hands out an upload target in the region’s storage, then confirms the stored object', async () => {
				withStorage()
				const id = await record()
				const reply = await requestPhoto(id)
				expect(reply.status, reply.raw).toBe(200)
				const target = stationPhotoUploadSchema.parse(reply.body)
				expect(target.key).toMatch(
					new RegExp(`^inventory-invoices/${ORG_A}/${id}/[0-9a-f-]{36}\\.jpg$`),
				)
				expect(target.method).toBe('PUT')
				expect(target.maxBytes).toBe(5 * 1024 * 1024)

				// Nothing stored yet: the tablet cannot confirm.
				const missing = await confirm(id, target.key)
				expect(missing.status).toBe(400)
				expect(missing.body.error).toBe('invalid_request')
				objects.set(target.key, { size: 1234, type: 'image/jpeg' })
				const done = await confirm(id, target.key)
				expect(done.status, done.raw).toBe(200)
				expect(done.body).toEqual({ ok: true })
				expect((await operatorDelivery(id)).hasPhoto).toBe(true)
				// Resending is harmless.
				expect((await confirm(id, target.key)).status).toBe(200)
				// A key that was not issued for this delivery is refused.
				const other = await record()
				const foreign = await confirm(other, target.key)
				expect(foreign.status).toBe(400)
				// Limits are the operator route's.
				for (const body of [
					{ contentType: 'application/pdf', sizeBytes: 100 },
					{ contentType: 'image/jpeg', sizeBytes: 5 * 1024 * 1024 + 1 },
					{ contentType: 'image/jpeg', sizeBytes: 100, extra: true },
				]) {
					expect((await requestPhoto(id, body)).status).toBe(400)
				}
			})

			it('needs the receive permission, and only takes a photo for a tablet delivery at this location', async () => {
				withStorage()
				const id = await record()
				const cashierTry = await requestPhoto(id, undefined, 'cashier')
				expect(cashierTry.status).toBe(403)
				expect(cashierTry.body.error).toBe('receive_needs_manager')
				expect(
					(await confirm(id, 'inventory-invoices/x', 'cashier')).status,
				).toBe(403)
				// A delivery the office recorded in the App is not the tablet's to change.
				const office = await k.world.ok('POST', '/deliveries', {
					clientId: uid('office'),
					locationId: STOCK_LOC,
					supplierId: k.supplier.id,
					currency: 'SAR',
					lines: [
						{ itemId: k.items.tomato.id, quantity: 1000, lineTotalMinor: 10 },
					],
				})
				expect((await requestPhoto(office.delivery.id)).status).toBe(404)
				expect((await requestPhoto('no-such-delivery')).status).toBe(404)
				expect((await requestPhoto('bad%20id')).status).toBe(404)
			})
		})
	})
})

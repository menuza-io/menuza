import {
	compareSchema,
	prepPlanSchema,
	transferDetailSchema,
	listTransfersResultSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invMovements,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	BASE,
	COST,
	cid,
	makeClient,
	mintToken,
	READ,
	RECIPE,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Transfers and branch requests: both ways in, what stock does when a transfer
 * is sent and received (and what goes missing on the way), who may act at
 * which end, and a central kitchen making what its branches asked for.
 */

const ORG = 'org_inv_transfer_a'
const ORG_B = 'org_inv_transfer_b'
const CENTRAL = 'loc_central'
const BRANCH = 'loc_branch'
const OTHER = 'loc_other'

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

let env: ReturnType<typeof setupTenantEnv>
const features = { transfers: true, prep: true, recipes: true }
let full: string
let noCost: string
let atCentral: string
let atBranch: string
let atOther: string
let readOnly: string
let flagOff: string
let tokenB: string
const world = { flour: '', sauce: '', garlic: '' }

beforeAll(async () => {
	env = setupTenantEnv('inv-transfers')
	for (const id of [ORG, ORG_B]) {
		orgs.set(id, {
			id,
			slug: id,
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
			name: id,
		})
		await provisionTenantDb(id)
	}
	const grants = [READ, UPDATE, COST, RECIPE]
	full = await mintToken(ORG, { grants, features })
	noCost = await mintToken(ORG, { grants: [READ, UPDATE], features })
	atCentral = await mintToken(ORG, {
		grants: [READ, UPDATE],
		locationIds: [CENTRAL],
		features,
	})
	atBranch = await mintToken(ORG, {
		grants: [READ, UPDATE],
		locationIds: [BRANCH],
		features,
	})
	atOther = await mintToken(ORG, {
		grants: [READ, UPDATE],
		locationIds: [OTHER],
		features,
	})
	readOnly = await mintToken(ORG, {
		scope: 'read',
		grants: [READ],
		features,
	})
	flagOff = await mintToken(ORG, { grants, features: { transfers: false } })
	tokenB = await mintToken(ORG_B, { grants, features })

	const flour = await call('POST', `${BASE}/items`, {
		token: full,
		body: {
			clientId: cid('item'),
			name: 'Flour',
			category: 'dry_goods',
			kind: 'bought',
			baseUnit: 'g',
		},
	})
	world.flour = flour.body.id
	// 10 kg of flour at the central kitchen, bought at SAR 3 per kg.
	const delivery = await call('POST', `${BASE}/deliveries`, {
		token: full,
		body: {
			clientId: cid('delivery'),
			locationId: CENTRAL,
			supplierId: null,
			currency: 'SAR',
			lines: [
				{ itemId: world.flour, quantity: 10_000_000, lineTotalMinor: 3000 },
			],
		},
	})
	expect(delivery.status, JSON.stringify(delivery.body)).toBe(200)
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

const onHand = async (itemId: string, locationId: string) => {
	const db = await getTenantDb(ORG)
	const rows = await db
		.select()
		.from(invMovements)
		.where(eq(invMovements.itemId, itemId))
	return rows
		.filter((row) => row.locationId === locationId)
		.reduce((sum, row) => sum + row.quantity, 0)
}

const line = (itemId: string, amount: number, unit = 'kg') => ({
	itemId,
	amount,
	unit,
})

async function create(
	body: Record<string, unknown>,
	token = full,
): Promise<{ status: number; body: any }> {
	return call('POST', `${BASE}/transfers`, {
		token,
		body: { clientId: cid('transfer'), ...body },
	})
}

describe('a request from a branch to the central kitchen', () => {
	it('is asked by the branch, sent by the central kitchen and received by the branch, with the loss in between on the record', async () => {
		const asked = await create(
			{
				kind: 'request',
				fromLocationId: CENTRAL,
				toLocationId: BRANCH,
				lines: [line(world.flour, 3)],
				note: 'For the weekend',
			},
			atBranch,
		)
		expect(asked.status, JSON.stringify(asked.body)).toBe(200)
		const request = transferDetailSchema.parse(asked.body)
		expect(request).toMatchObject({
			kind: 'request',
			status: 'requested',
			number: 1,
			fromLocationId: CENTRAL,
			toLocationId: BRANCH,
			note: 'For the weekend',
			version: 1,
		})
		expect(request.lines[0]).toMatchObject({
			itemName: 'Flour',
			requestedQuantity: 3_000_000,
			sentQuantity: null,
			onHandAtSender: 10_000_000,
		})
		// Nothing has moved yet.
		expect(await onHand(world.flour, CENTRAL)).toBe(10_000_000)

		// The branch cannot send what it asked of someone else.
		const wrongPlace = await call(
			'POST',
			`${BASE}/transfers/${request.id}/send`,
			{
				token: atBranch,
				body: { expectedVersion: 1 },
			},
		)
		expect(wrongPlace.status).toBe(403)
		expect(wrongPlace.body.code).toBe('location_forbidden')

		// The central kitchen sends 2.5 kg of the 3 asked for.
		const sent = await call('POST', `${BASE}/transfers/${request.id}/send`, {
			token: atCentral,
			body: { expectedVersion: 1, lines: [line(world.flour, 2.5)] },
		})
		expect(sent.status, JSON.stringify(sent.body)).toBe(200)
		const out = transferDetailSchema.parse(sent.body)
		expect(out.status).toBe('sent')
		expect(out.lines[0]).toMatchObject({
			requestedQuantity: 3_000_000,
			sentQuantity: 2_500_000,
			onHandAtSender: 7_500_000,
		})
		expect(await onHand(world.flour, CENTRAL)).toBe(7_500_000)
		expect(await onHand(world.flour, BRANCH)).toBe(0)

		// The branch gets 2 kg of the 2.5 sent: half a kilo went missing.
		const arrived = await call(
			'POST',
			`${BASE}/transfers/${request.id}/receive`,
			{
				token: atBranch,
				body: { expectedVersion: out.version, lines: [line(world.flour, 2)] },
			},
		)
		expect(arrived.status, JSON.stringify(arrived.body)).toBe(200)
		const received = transferDetailSchema.parse(arrived.body)
		expect(received.status).toBe('received')
		expect(received.missingLines).toBe(1)
		expect(received.lines[0]).toMatchObject({
			sentQuantity: 2_500_000,
			receivedQuantity: 2_000_000,
			missingQuantity: 500_000,
		})
		expect(await onHand(world.flour, BRANCH)).toBe(2_000_000)
		expect(await onHand(world.flour, CENTRAL)).toBe(7_500_000)

		const db = await getTenantDb(ORG)
		const moves = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.sourceId, request.id))
		expect(
			moves.map((move) => [move.kind, move.locationId, move.quantity]).sort(),
		).toEqual([
			['transfer_in', BRANCH, 2_000_000],
			['transfer_out', CENTRAL, -2_500_000],
		])
		// What arrived is valued at what left: SAR 3 a kilo.
		const incoming = moves.find((move) => move.kind === 'transfer_in')!
		expect(incoming.valueMinor).toBe(600)
		expect(moves.find((move) => move.kind === 'transfer_out')!.valueMinor).toBe(
			-750,
		)

		// Closed: nothing more can happen to it.
		for (const action of ['send', 'receive', 'cancel']) {
			const again = await call(
				'POST',
				`${BASE}/transfers/${request.id}/${action}`,
				{
					token: full,
					body: { expectedVersion: received.version },
				},
			)
			expect(again.status).toBe(409)
			expect(['transfer_closed', 'stale_version']).toContain(again.body.code)
		}
		expect(await onHand(world.flour, CENTRAL)).toBe(7_500_000)
	})

	it('shows each end its own side, newest first, and hides money without the cost grant', async () => {
		const out = listTransfersResultSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/transfers?locationId=${CENTRAL}&direction=out&status=all`,
					{ token: atCentral },
				)
			).body,
		)
		expect(out.transfers.map((entry) => entry.number)).toEqual([1])
		const into = listTransfersResultSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/transfers?locationId=${BRANCH}&direction=in&status=all`,
					{ token: atBranch },
				)
			).body,
		)
		expect(into.transfers).toHaveLength(1)
		// Nothing for the central kitchen to receive.
		const none = listTransfersResultSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/transfers?locationId=${CENTRAL}&direction=in&status=all`,
					{ token: atCentral },
				)
			).body,
		)
		expect(none.transfers).toEqual([])

		const priced = await call(
			'GET',
			`${BASE}/transfers/${out.transfers[0]!.id}`,
			{ token: full },
		)
		expect(transferDetailSchema.parse(priced.body)).toMatchObject({
			valueMinor: 750,
			currency: 'SAR',
		})
		const plain = await call(
			'GET',
			`${BASE}/transfers/${out.transfers[0]!.id}`,
			{ token: noCost },
		)
		expect(JSON.stringify(plain.body)).not.toMatch(/valueMinor|currency/)
	})
})

describe('a transfer from one place to another', () => {
	it('starts as a draft, can be edited, and cancelled before it is sent', async () => {
		const made = await create(
			{
				kind: 'transfer',
				fromLocationId: CENTRAL,
				toLocationId: BRANCH,
				lines: [line(world.flour, 1)],
			},
			atCentral,
		)
		expect(made.status, JSON.stringify(made.body)).toBe(200)
		const draft = transferDetailSchema.parse(made.body)
		expect(draft).toMatchObject({ kind: 'transfer', status: 'draft' })

		const edited = await call('PATCH', `${BASE}/transfers/${draft.id}`, {
			token: atCentral,
			body: {
				expectedVersion: draft.version,
				lines: [line(world.flour, 1.5)],
				note: 'More than planned',
			},
		})
		expect(edited.status, JSON.stringify(edited.body)).toBe(200)
		expect(transferDetailSchema.parse(edited.body)).toMatchObject({
			note: 'More than planned',
			version: draft.version + 1,
			lines: [{ requestedQuantity: 1_500_000 }],
		})
		// Another screen with the old version is stale.
		const stale = await call('PATCH', `${BASE}/transfers/${draft.id}`, {
			token: atCentral,
			body: { expectedVersion: draft.version, note: 'Late' },
		})
		expect(stale.status).toBe(409)
		expect(stale.body.code).toBe('stale_version')

		const cancelled = await call(
			'POST',
			`${BASE}/transfers/${draft.id}/cancel`,
			{
				token: atBranch,
				body: { expectedVersion: draft.version + 1 },
			},
		)
		expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200)
		expect(transferDetailSchema.parse(cancelled.body).status).toBe('cancelled')
		// Cancelling again answers the same.
		const twice = await call('POST', `${BASE}/transfers/${draft.id}/cancel`, {
			token: atBranch,
			body: { expectedVersion: draft.version + 1 },
		})
		expect(twice.status).toBe(200)
		expect(await onHand(world.flour, CENTRAL)).toBe(7_500_000)
	})

	it('refuses an empty send, a line that is not on the record and more than was sent', async () => {
		const made = await create(
			{
				kind: 'transfer',
				fromLocationId: CENTRAL,
				toLocationId: BRANCH,
				lines: [line(world.flour, 1)],
			},
			atCentral,
		)
		const draft = transferDetailSchema.parse(made.body)
		const nothing = await call('POST', `${BASE}/transfers/${draft.id}/send`, {
			token: atCentral,
			body: { expectedVersion: 1, lines: [line(world.flour, 0)] },
		})
		expect(nothing.status).toBe(400)
		const stranger = await call('POST', `${BASE}/transfers/${draft.id}/send`, {
			token: atCentral,
			body: { expectedVersion: 1, lines: [line('not_on_it', 1)] },
		})
		expect(stranger.status).toBe(400)
		const sent = await call('POST', `${BASE}/transfers/${draft.id}/send`, {
			token: atCentral,
			body: { expectedVersion: 1 },
		})
		const out = transferDetailSchema.parse(sent.body)
		expect(out.lines[0]!.sentQuantity).toBe(1_000_000)
		const over = await call('POST', `${BASE}/transfers/${draft.id}/receive`, {
			token: atBranch,
			body: { expectedVersion: out.version, lines: [line(world.flour, 2)] },
		})
		expect(over.status).toBe(400)
		// A sent transfer is received, never cancelled.
		const cancel = await call('POST', `${BASE}/transfers/${draft.id}/cancel`, {
			token: atCentral,
			body: { expectedVersion: out.version },
		})
		expect(cancel.status).toBe(409)
		expect(cancel.body.code).toBe('transfer_closed')
		const received = await call(
			'POST',
			`${BASE}/transfers/${draft.id}/receive`,
			{
				token: atBranch,
				body: { expectedVersion: out.version },
			},
		)
		expect(transferDetailSchema.parse(received.body)).toMatchObject({
			status: 'received',
			missingLines: 0,
		})
	})

	it('answers a replayed clientId with the first record and needs two different places', async () => {
		const body = {
			clientId: 'transfer-replay-0001',
			kind: 'transfer',
			fromLocationId: CENTRAL,
			toLocationId: BRANCH,
			lines: [line(world.flour, 1)],
		}
		const first = await call('POST', `${BASE}/transfers`, {
			token: full,
			body,
		})
		const again = await call('POST', `${BASE}/transfers`, { token: full, body })
		expect(first.status).toBe(200)
		expect(again.body.id).toBe(first.body.id)
		const same = await create({
			kind: 'transfer',
			fromLocationId: CENTRAL,
			toLocationId: CENTRAL,
			lines: [line(world.flour, 1)],
		})
		expect(same.status).toBe(400)
	})
})

describe('who may do what', () => {
	it('keeps a transfer between two places from a token that covers neither', async () => {
		const made = await create({
			kind: 'transfer',
			fromLocationId: CENTRAL,
			toLocationId: BRANCH,
			lines: [line(world.flour, 1)],
		})
		const id = made.body.id
		const hidden = await call('GET', `${BASE}/transfers/${id}`, {
			token: atOther,
		})
		expect(hidden.status).toBe(403)
		expect(hidden.body.code).toBe('location_forbidden')
		expect(
			(
				await call('GET', `${BASE}/transfers?locationId=${CENTRAL}`, {
					token: atOther,
				})
			).status,
		).toBe(403)
		// Creating needs the creating place: a branch cannot send for the centre.
		const forged = await create(
			{
				kind: 'transfer',
				fromLocationId: CENTRAL,
				toLocationId: BRANCH,
				lines: [line(world.flour, 1)],
			},
			atBranch,
		)
		expect(forged.status).toBe(403)
	})

	it('needs the transfers flag, the update grant, and the right organization', async () => {
		const off = await call('GET', `${BASE}/transfers?locationId=${CENTRAL}`, {
			token: flagOff,
		})
		expect(off.status).toBe(403)
		expect(off.body.code).toBe('feature_disabled')
		expect(
			(
				await call('GET', `${BASE}/transfers?locationId=${CENTRAL}`, {
					token: readOnly,
				})
			).status,
		).toBe(200)
		const write = await call('POST', `${BASE}/transfers`, {
			token: readOnly,
			body: {
				clientId: cid('transfer'),
				kind: 'transfer',
				fromLocationId: CENTRAL,
				toLocationId: BRANCH,
				lines: [line(world.flour, 1)],
			},
		})
		expect(write.status).toBe(403)
		const list = listTransfersResultSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/transfers?locationId=${CENTRAL}&status=all`,
					{
						token: full,
					},
				)
			).body,
		)
		const cross = await call(
			'GET',
			`${BASE}/transfers/${list.transfers[0]!.id}`,
			{
				token: tokenB,
			},
		)
		expect(cross.status).toBe(404)
	})
})

describe('a central kitchen makes what its branches asked for', () => {
	it('adds open requests to the prep list of the kitchen that will fill them', async () => {
		const sauce = await call('POST', `${BASE}/items`, {
			token: full,
			body: {
				clientId: cid('item'),
				name: 'Garlic sauce',
				category: 'sauces',
				kind: 'made',
				baseUnit: 'ml',
			},
		})
		world.sauce = sauce.body.id
		const recipe = await call('PUT', `${BASE}/recipes`, {
			token: full,
			body: {
				ownerKind: 'made_item',
				ownerId: world.sauce,
				expectedVersion: 0,
				makes: { amount: 4, unit: 'l' },
				lines: [{ itemId: world.flour, amount: 400, unit: 'g' }],
			},
		})
		expect(recipe.status, JSON.stringify(recipe.body)).toBe(200)
		const levels = await call('PUT', `${BASE}/prep/levels`, {
			token: full,
			body: {
				locationId: CENTRAL,
				itemId: world.sauce,
				stationId: null,
				weekdays: Array.from({ length: 7 }, () => 2_000_000),
				expectedVersion: 0,
			},
		})
		expect(levels.status, JSON.stringify(levels.body)).toBe(200)

		const before = prepPlanSchema.parse(
			(
				await call('POST', `${BASE}/prep/generate`, {
					token: full,
					body: { locationId: CENTRAL },
				})
			).body,
		)
		// Fill up to 2 L, none on hand: one batch of 4 L.
		expect(before.tasks[0]).toMatchObject({
			plannedQuantity: 4_000_000,
			batches: 1,
		})

		// A branch asks for 3 L: 2 L + 3 L needs two batches.
		const ask = await create(
			{
				kind: 'request',
				fromLocationId: CENTRAL,
				toLocationId: BRANCH,
				lines: [line(world.sauce, 3, 'l')],
			},
			atBranch,
		)
		expect(ask.status, JSON.stringify(ask.body)).toBe(200)
		const after = prepPlanSchema.parse(
			(
				await call('POST', `${BASE}/prep/generate`, {
					token: full,
					body: { locationId: CENTRAL },
				})
			).body,
		)
		expect(after.tasks[0]).toMatchObject({
			plannedQuantity: 8_000_000,
			batches: 2,
			explain: { committed: 3_000_000, fillUpTo: 2_000_000 },
		})
		// Once the request is cancelled the plan goes back.
		await call('POST', `${BASE}/transfers/${ask.body.id}/cancel`, {
			token: atBranch,
			body: { expectedVersion: ask.body.version },
		})
		const back = prepPlanSchema.parse(
			(
				await call('POST', `${BASE}/prep/generate`, {
					token: full,
					body: { locationId: CENTRAL },
				})
			).body,
		)
		expect(back.tasks[0]!.plannedQuantity).toBe(4_000_000)
	})
})

describe('location comparison', () => {
	it('puts each location the token covers side by side, with money only for the cost grant', async () => {
		const res = await call(
			'GET',
			`${BASE}/compare?locationIds=${CENTRAL},${BRANCH},${OTHER}`,
			{ token: full },
		)
		expect(res.status, JSON.stringify(res.body)).toBe(200)
		const compared = compareSchema.parse(res.body)
		expect(compared.rows.map((row) => row.locationId)).toEqual([
			CENTRAL,
			BRANCH,
			OTHER,
		])
		const central = compared.rows[0]!
		expect(central).toMatchObject({
			wasteWeekCount: 0,
			lowItems: 0,
			stockValueMinor: expect.any(Number),
			foodCost: { state: 'need_two_counts' },
			currency: 'SAR',
		})
		// The central kitchen has flour in stock (SAR 3 a kilo): worth something.
		expect(central.stockValueMinor).toBeGreaterThan(0)
		// A transfer is waiting at the central kitchen to leave it.
		expect(central.outgoingTransfers).toBeGreaterThan(0)

		const lean = compareSchema.parse(
			(
				await call('GET', `${BASE}/compare?locationIds=${CENTRAL},${BRANCH}`, {
					token: noCost,
				})
			).body,
		)
		expect(JSON.stringify(lean)).not.toMatch(
			/stockValueMinor|wasteWeekMinor|foodCost|currency/,
		)
	})

	it('leaves out the locations the token does not cover and refuses a malformed list', async () => {
		const scoped = compareSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/compare?locationIds=${CENTRAL},${BRANCH},${OTHER}`,
					{ token: atBranch },
				)
			).body,
		)
		expect(scoped.rows.map((row) => row.locationId)).toEqual([BRANCH])
		expect((await call('GET', `${BASE}/compare`, { token: full })).status).toBe(
			400,
		)
		const tooMany = Array.from({ length: 21 }, (_, n) => `loc_${n}`).join(',')
		expect(
			(
				await call('GET', `${BASE}/compare?locationIds=${tooMany}`, {
					token: full,
				})
			).status,
		).toBe(400)
	})
})

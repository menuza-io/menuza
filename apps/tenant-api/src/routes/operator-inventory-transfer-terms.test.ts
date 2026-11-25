import {
	transferDetailSchema,
	transferTermsResultSchema,
	transfersOwedSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invCounts,
	invMovements,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import { computeFoodCost } from '../services/inventory-food-cost.ts'
import {
	BASE,
	COST,
	cid,
	makeClient,
	mintToken,
	READ,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/**
 * Editing a planned transfer (#477) and transfer prices with an order guide
 * (#526): lines change only while the transfer is open, a request the sender
 * changed shows as changed, branches only see what the sender offers, and the
 * price is fixed when the transfer is sent and is what the branch is charged.
 */

const ORG = 'org_inv_transfer_terms'
const CENTRAL = 'loc_terms_central'
const BRANCH = 'loc_terms_branch'

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
const features = { transfers: true }
let full: string
let noCost: string
let atCentral: string
let atBranch: string
const world = { flour: '', sauce: '', secret: '' }

beforeAll(async () => {
	env = setupTenantEnv('inv-transfer-terms')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	const grants = [READ, UPDATE, COST]
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
	for (const [key, name] of [
		['flour', 'Flour'],
		['sauce', 'Garlic sauce'],
		['secret', 'Secret spice'],
	] as const) {
		const made = await call('POST', `${BASE}/items`, {
			token: full,
			body: {
				clientId: cid('item'),
				name,
				category: 'dry_goods',
				kind: 'bought',
				baseUnit: 'g',
				place: {
					locationId: CENTRAL,
					countUnit: 'kg',
					areaIds: [],
					orderBelowQuantity: 0,
					fillUpToQuantity: 0,
				},
			},
		})
		expect(made.status, JSON.stringify(made.body)).toBe(200)
		world[key] = made.body.id
	}
	// 10 kg of flour at the central kitchen, bought at SAR 3 per kg (300 minor).
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
	env.cleanup()
})

const line = (itemId: string, amount: number, unit = 'kg') => ({
	itemId,
	amount,
	unit,
})

async function make(
	kind: 'transfer' | 'request',
	lines: ReturnType<typeof line>[],
	token: string,
) {
	const made = await call('POST', `${BASE}/transfers`, {
		token,
		body: {
			clientId: cid('transfer'),
			kind,
			fromLocationId: CENTRAL,
			toLocationId: BRANCH,
			lines,
		},
	})
	expect(made.status, JSON.stringify(made.body)).toBe(200)
	return transferDetailSchema.parse(made.body)
}

describe('editing a planned transfer (#477)', () => {
	it('changes, adds and removes lines before sending, versioned, and refuses an edit after sending', async () => {
		const draft = await make('transfer', [line(world.flour, 1)], atCentral)
		expect(draft.status).toBe('draft')
		const edited = await call('PATCH', `${BASE}/transfers/${draft.id}`, {
			token: atCentral,
			body: {
				expectedVersion: draft.version,
				lines: [line(world.flour, 2.5), line(world.sauce, 1)],
			},
		})
		expect(edited.status, JSON.stringify(edited.body)).toBe(200)
		const view = transferDetailSchema.parse(edited.body)
		expect(view.version).toBe(draft.version + 1)
		expect(view.lines.map((l) => [l.itemName, l.requestedQuantity])).toEqual([
			['Flour', 2_500_000],
			['Garlic sauce', 1_000_000],
		])
		// A creator's own edit is not "changed by the sender".
		expect(view.changedBySender).toBe(false)

		// An old version is stale.
		const stale = await call('PATCH', `${BASE}/transfers/${draft.id}`, {
			token: atCentral,
			body: { expectedVersion: draft.version, lines: [line(world.flour, 9)] },
		})
		expect([stale.status, stale.body.code]).toEqual([409, 'stale_version'])

		const sent = await call('POST', `${BASE}/transfers/${draft.id}/send`, {
			token: atCentral,
			body: { expectedVersion: view.version },
		})
		expect(sent.status, JSON.stringify(sent.body)).toBe(200)
		const after = transferDetailSchema.parse(sent.body)

		// Once sent, the lines are closed, whatever version the screen holds.
		for (const expectedVersion of [view.version, after.version]) {
			const refused = await call('PATCH', `${BASE}/transfers/${draft.id}`, {
				token: atCentral,
				body: { expectedVersion, lines: [line(world.flour, 1)] },
			})
			expect([refused.status, refused.body.code]).toEqual([
				409,
				'transfer_closed',
			])
		}
		const db = await getTenantDb(ORG)
		const unchanged = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.sourceId, draft.id))
		expect(unchanged.find((m) => m.itemId === world.flour)?.quantity).toBe(
			-2_500_000,
		)
	})

	it('shows a request the sender changed as changed to the branch, with what it first asked for', async () => {
		const request = await make(
			'request',
			[line(world.flour, 3), line(world.sauce, 2)],
			atBranch,
		)
		// The branch edits its own request freely.
		const sender = await call('PATCH', `${BASE}/transfers/${request.id}`, {
			token: atCentral,
			body: {
				expectedVersion: request.version,
				lines: [line(world.flour, 2)],
			},
		})
		expect(sender.status, JSON.stringify(sender.body)).toBe(200)
		const changed = transferDetailSchema.parse(sender.body)
		expect(changed.changedBySender).toBe(true)
		expect(changed.editedAt).not.toBeNull()
		expect(changed.lines).toHaveLength(1)
		expect(changed.lines[0]).toMatchObject({
			itemName: 'Flour',
			requestedQuantity: 2_000_000,
			askedQuantity: 3_000_000,
		})
		// The branch sees it that way in its list too.
		const list = await call(
			'GET',
			`${BASE}/transfers?locationId=${BRANCH}&direction=in&status=open`,
			{ token: atBranch },
		)
		expect(
			list.body.transfers.find((t: { id: string }) => t.id === request.id)
				.changedBySender,
		).toBe(true)

		// The sender cannot touch the note, and a place that is neither end cannot edit.
		const note = await call('PATCH', `${BASE}/transfers/${request.id}`, {
			token: atCentral,
			body: { expectedVersion: changed.version, note: 'Nope' },
		})
		expect(note.status).toBe(400)
		const wrongPlace = await call('PATCH', `${BASE}/transfers/${request.id}`, {
			token: atBranch,
			body: { expectedVersion: changed.version, lines: [line(world.flour, 5)] },
		})
		// The branch made it, so it may edit; that settles what was asked.
		expect(wrongPlace.status).toBe(200)
		expect(transferDetailSchema.parse(wrongPlace.body).changedBySender).toBe(
			false,
		)

		// A transfer (not a request) cannot be edited by the receiving end.
		const transfer = await make('transfer', [line(world.flour, 1)], atCentral)
		const byReceiver = await call('PATCH', `${BASE}/transfers/${transfer.id}`, {
			token: atBranch,
			body: {
				expectedVersion: transfer.version,
				lines: [line(world.flour, 5)],
			},
		})
		expect([byReceiver.status, byReceiver.body.code]).toEqual([
			403,
			'location_forbidden',
		])
	})
})

describe('what branches can request (#526)', () => {
	it('keeps an item the sender switched off out of requests, new and edited', async () => {
		// Setting a price needs the cost grant; the request switch does not.
		const switchOff = await call(
			'PUT',
			`${BASE}/transfer-terms/${world.secret}`,
			{
				token: atCentral,
				body: {
					locationId: CENTRAL,
					expectedVersion: 0,
					branchRequestable: false,
				},
			},
		)
		expect(switchOff.status, JSON.stringify(switchOff.body)).toBe(200)
		expect(switchOff.body).toMatchObject({
			itemName: 'Secret spice',
			branchRequestable: false,
			version: 1,
		})
		expect(JSON.stringify(switchOff.body)).not.toMatch(
			/priceMode|Micro|costMicro/,
		)

		// A branch asks which items are not offered, though its token covers only
		// its own place and so cannot read the sender's prices.
		const hidden = await call(
			'GET',
			`${BASE}/transfers/not-offered?fromLocationId=${CENTRAL}`,
			{ token: atBranch },
		)
		expect(hidden.body).toEqual({ itemIds: [world.secret] })
		const refused = await call('POST', `${BASE}/transfers`, {
			token: atBranch,
			body: {
				clientId: cid('transfer'),
				kind: 'request',
				fromLocationId: CENTRAL,
				toLocationId: BRANCH,
				lines: [line(world.flour, 1), line(world.secret, 1)],
			},
		})
		expect([refused.status, refused.body.code]).toEqual([
			409,
			'item_not_requestable',
		])

		const ok = await make('request', [line(world.flour, 1)], atBranch)
		const edit = await call('PATCH', `${BASE}/transfers/${ok.id}`, {
			token: atBranch,
			body: {
				expectedVersion: ok.version,
				lines: [line(world.flour, 1), line(world.secret, 1)],
			},
		})
		expect([edit.status, edit.body.code]).toEqual([409, 'item_not_requestable'])

		// The sender may still plan to SEND it: the guide is for requests only.
		const planned = await make('transfer', [line(world.secret, 1)], atCentral)
		expect(planned.status).toBe('draft')

		// Switching it on again offers it.
		const stale = await call('PUT', `${BASE}/transfer-terms/${world.secret}`, {
			token: atCentral,
			body: {
				locationId: CENTRAL,
				expectedVersion: 0,
				branchRequestable: true,
			},
		})
		expect([stale.status, stale.body.code]).toEqual([409, 'stale_version'])
		const back = await call('PUT', `${BASE}/transfer-terms/${world.secret}`, {
			token: atCentral,
			body: {
				locationId: CENTRAL,
				expectedVersion: 1,
				branchRequestable: true,
			},
		})
		expect(back.body.branchRequestable).toBe(true)
		const again = await call('POST', `${BASE}/transfers`, {
			token: atBranch,
			body: {
				clientId: cid('transfer'),
				kind: 'request',
				fromLocationId: CENTRAL,
				toLocationId: BRANCH,
				lines: [line(world.secret, 1)],
			},
		})
		expect(again.status, JSON.stringify(again.body)).toBe(200)
	})
})

describe('transfer prices (#526)', () => {
	it('needs the cost grant to set or read a price', async () => {
		const denied = await call('PUT', `${BASE}/transfer-terms/${world.flour}`, {
			token: noCost,
			body: {
				locationId: CENTRAL,
				expectedVersion: 0,
				priceMode: 'fixed',
				fixedPrice: { priceMinor: 500, per: 'kg', currency: 'SAR' },
			},
		})
		expect([denied.status, denied.body.code]).toEqual([403, 'forbidden'])
		const listed = transferTermsResultSchema.parse(
			(
				await call('GET', `${BASE}/transfer-terms?locationId=${CENTRAL}`, {
					token: noCost,
				})
			).body,
		)
		expect(JSON.stringify(listed)).not.toMatch(/priceMode|Micro|currency/)
	})

	it('fixes the price when sent: a later price change never reaches it, and the branch is charged it', async () => {
		const set = await call('PUT', `${BASE}/transfer-terms/${world.flour}`, {
			token: full,
			body: {
				locationId: CENTRAL,
				expectedVersion: 0,
				priceMode: 'fixed',
				fixedPrice: { priceMinor: 500, per: 'kg', currency: 'SAR' },
			},
		})
		expect(set.status, JSON.stringify(set.body)).toBe(200)
		expect(set.body).toMatchObject({
			priceMode: 'fixed',
			fixedPriceMicro: 500_000,
			effectivePriceMicro: 500_000,
			costMicro: 300_000,
		})

		const request = await make('request', [line(world.flour, 2)], atBranch)
		const sent = await call('POST', `${BASE}/transfers/${request.id}/send`, {
			token: atCentral,
			body: { expectedVersion: request.version },
		})
		expect(sent.status, JSON.stringify(sent.body)).toBe(200)

		// The owner raises the price after the send.
		const raised = await call('PUT', `${BASE}/transfer-terms/${world.flour}`, {
			token: full,
			body: {
				locationId: CENTRAL,
				expectedVersion: 1,
				priceMode: 'fixed',
				fixedPrice: { priceMinor: 900, per: 'kg', currency: 'SAR' },
			},
		})
		expect(raised.status).toBe(200)

		const detail = transferDetailSchema.parse(
			(await call('GET', `${BASE}/transfers/${request.id}`, { token: full }))
				.body,
		)
		expect(detail.lines[0]).toMatchObject({
			unitPriceMicro: 500_000,
			priceSource: 'fixed',
			// 2 kg at SAR 5 a kilo.
			valueMinor: 1000,
		})
		const plain = await call('GET', `${BASE}/transfers/${request.id}`, {
			token: noCost,
		})
		expect(JSON.stringify(plain.body)).not.toMatch(
			/unitPriceMicro|priceSource|valueMinor/,
		)

		const arrived = await call(
			'POST',
			`${BASE}/transfers/${request.id}/receive`,
			{ token: atBranch, body: { expectedVersion: detail.version } },
		)
		expect(arrived.status, JSON.stringify(arrived.body)).toBe(200)
		const db = await getTenantDb(ORG)
		const moves = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.sourceId, request.id))
		// The branch takes it in at the transfer price; the central kitchen's stock
		// left at what it cost.
		expect(moves.find((m) => m.kind === 'transfer_in')?.valueMinor).toBe(1000)
		expect(moves.find((m) => m.kind === 'transfer_out')?.valueMinor).toBe(-600)
	})

	it('counts what a branch received at the transfer price in its food cost, and lists what each branch owes', async () => {
		const db = await getTenantDb(ORG)
		const now = Date.now()
		await db.insert(invCounts).values([
			{
				id: 'ct_open',
				locationId: BRANCH,
				status: 'approved',
				businessDate: '2026-11-01',
				startedByKind: 'operator',
				approvedAt: now - 3 * 24 * 3600_000,
				createdAt: now - 3 * 24 * 3600_000 - 1000,
			},
			{
				id: 'ct_close',
				locationId: BRANCH,
				status: 'approved',
				businessDate: '2026-11-30',
				startedByKind: 'operator',
				approvedAt: now + 3600_000,
				createdAt: now + 3600_000 - 1000,
			},
		])
		const cost = await computeFoodCost(db, {
			locationId: BRANCH,
			targetBp: 3000,
		})
		// Everything the branch took in: the 2 kg at SAR 5 (1000), not at cost
		// (600), plus the two transfers earlier in the file at their own prices.
		const received = await db
			.select()
			.from(invMovements)
			.where(eq(invMovements.locationId, BRANCH))
		const transferIn = received
			.filter((m) => m.kind === 'transfer_in')
			.reduce((sum, m) => sum + (m.valueMinor ?? 0), 0)
		expect(transferIn).toBeGreaterThanOrEqual(1000)
		expect(cost.purchasesMinor).toBe(transferIn)

		const today = new Date().toISOString().slice(0, 10)
		const owed = transfersOwedSchema.parse(
			(
				await call(
					'GET',
					`${BASE}/transfers/owed?locationId=${CENTRAL}&from=2000-01-01&to=${today}`,
					{ token: full },
				)
			).body,
		)
		expect(owed.rows).toHaveLength(1)
		expect(owed.rows[0]).toMatchObject({ toLocationId: BRANCH })
		// What was sent at a price is owed at that price, above its cost.
		expect(owed.owedMinor!).toBeGreaterThan(owed.costMinor!)
		const hidden = await call(
			'GET',
			`${BASE}/transfers/owed?locationId=${CENTRAL}&from=2000-01-01&to=${today}`,
			{ token: noCost },
		)
		expect(JSON.stringify(hidden.body)).not.toMatch(/owedMinor|costMinor/)
	})

	it('prices cost plus a percentage from the cost at the moment of sending', async () => {
		const set = await call('PUT', `${BASE}/transfer-terms/${world.sauce}`, {
			token: full,
			body: {
				locationId: CENTRAL,
				expectedVersion: 0,
				priceMode: 'cost_plus',
				markupBp: 5000,
			},
		})
		expect(set.status, JSON.stringify(set.body)).toBe(200)
		// The sauce has no cost yet: nothing to add a percentage to.
		expect(set.body.effectivePriceMicro).toBeNull()
		// Flour is the one with a cost: cost plus 50% is SAR 4.50 a kilo.
		const flourTerms = await call(
			'PUT',
			`${BASE}/transfer-terms/${world.flour}`,
			{
				token: full,
				body: {
					locationId: CENTRAL,
					expectedVersion: 2,
					priceMode: 'cost_plus',
					markupBp: 5000,
				},
			},
		)
		expect(flourTerms.body.effectivePriceMicro).toBe(450_000)
		const draft = await make('transfer', [line(world.flour, 1)], atCentral)
		const sent = await call('POST', `${BASE}/transfers/${draft.id}/send`, {
			token: atCentral,
			body: { expectedVersion: draft.version },
		})
		expect(sent.status, JSON.stringify(sent.body)).toBe(200)
		const view = transferDetailSchema.parse(
			(await call('GET', `${BASE}/transfers/${draft.id}`, { token: full }))
				.body,
		)
		expect(view.lines[0]).toMatchObject({
			unitPriceMicro: 450_000,
			priceSource: 'cost_plus',
			valueMinor: 450,
		})
	})
})

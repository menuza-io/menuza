import { setupChecksResultSchema, type SetupFinding } from '@repo/inventory'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type PublishedOrganization } from '../lib/origin.ts'
import {
	BASE,
	cid,
	COST,
	makeClient,
	mintToken,
	PURCHASING,
	READ,
	RECIPE,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

/** "Check your setup" (#510). */

const ORG = 'org_inv_setup_checks'
const LOC = 'loc_a'

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
let full: string
let noCost: string

async function ok(res: Promise<{ status: number; body: any }>) {
	const reply = await res
	expect(reply.status, JSON.stringify(reply.body)).toBe(200)
	return reply.body
}

async function item(name: string, extra: Record<string, unknown> = {}) {
	const body = await ok(
		call('POST', `${BASE}/items`, {
			token: full,
			body: {
				clientId: cid('item'),
				name,
				category: 'meat',
				kind: 'bought',
				baseUnit: 'g',
				...extra,
			},
		}),
	)
	return body as { id: string; version: number }
}

async function supplier(name: string) {
	const body = await ok(
		call('POST', `${BASE}/suppliers`, {
			token: full,
			body: { clientId: cid('sup'), name, currency: 'SAR' },
		}),
	)
	return body.id as string
}

async function product(
	supplierId: string,
	itemId: string,
	priceMinor: number,
	packBaseQuantity: number,
) {
	return (await ok(
		call('POST', `${BASE}/suppliers/${supplierId}/products`, {
			token: full,
			body: { itemId, packName: 'Pack', packBaseQuantity, priceMinor },
		}),
	)) as { id: string; version: number }
}

async function checks(token = full) {
	return setupChecksResultSchema.parse(
		await ok(call('GET', `${BASE}/setup-checks?locationId=${LOC}`, { token })),
	)
}

function find<K extends SetupFinding['kind']>(
	list: SetupFinding[],
	kind: K,
	predicate: (finding: Extract<SetupFinding, { kind: K }>) => boolean = () =>
		true,
) {
	return list.find(
		(finding): finding is Extract<SetupFinding, { kind: K }> =>
			finding.kind === kind &&
			predicate(finding as Extract<SetupFinding, { kind: K }>),
	)
}

beforeAll(async () => {
	env = setupTenantEnv('inv-setup-checks')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	const features = { recipes: true }
	full = await mintToken(ORG, {
		grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
		features,
	})
	noCost = await mintToken(ORG, { grants: [READ, UPDATE], features })
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

describe('prices', () => {
	it('flags a supplier product priced 1.00 and one priced 0', async () => {
		const salt = await item('Salt')
		const sugar = await item('Sugar')
		const sup = await supplier('Dry goods')
		const one = await product(sup, salt.id, 100, 1_000_000)
		const zero = await product(sup, sugar.id, 0, 1_000_000)
		const result = await checks()
		const flagged = result.findings.filter(
			(finding) => finding.kind === 'price_placeholder',
		)
		expect(flagged.map((finding) => finding.supplierProductId).sort()).toEqual(
			[one.id, zero.id].sort(),
		)
		expect(
			find(result.findings, 'price_placeholder', (f) => f.itemName === 'Salt'),
		).toMatchObject({
			priceMinor: 100,
			currency: 'SAR',
			supplierName: 'Dry goods',
		})
	})

	it('hides every price finding from a caller without the cost grant', async () => {
		const result = await checks(noCost)
		expect(
			result.findings.some((finding) => finding.kind.startsWith('price_')),
		).toBe(false)
	})

	it('suggests the price the other suppliers imply, and fixing writes it', async () => {
		const chicken = await item('Chicken')
		const good = await supplier('Good price')
		const bad = await supplier('Per gram price')
		// SAR 30 for 10 kg (0.003 per gram) against SAR 30 for 100 g typed as the pack price.
		await product(good, chicken.id, 3_000, 10_000_000)
		const odd = await product(bad, chicken.id, 3_000, 100_000)
		const finding = find(
			(await checks()).findings,
			'price_out_of_line',
			(f) => f.supplierProductId === odd.id,
		)!
		expect(finding.suggestedPriceMinor).toBe(30)
		await ok(
			call('POST', `${BASE}/setup-checks/fix`, {
				token: full,
				body: {
					locationId: LOC,
					key: finding.key,
					fingerprint: finding.fingerprint,
				},
			}),
		)
		const after = await checks()
		expect(
			find(
				after.findings,
				'price_out_of_line',
				(f) => f.supplierProductId === odd.id,
			),
		).toBeUndefined()
		const supplierDetail = await ok(
			call('GET', `${BASE}/suppliers/${bad}`, { token: full }),
		)
		expect(supplierDetail.products[0].priceMinor).toBe(30)
	})

	it('spots a pack that is a thousand times off and fixes the pack size', async () => {
		const oil = await item('Olive oil', { baseUnit: 'ml' })
		const a = await supplier('Oil A')
		const b = await supplier('Oil B')
		await product(a, oil.id, 3_000, 10_000_000)
		// SAR 30 typed for a "10 g" pack: the pack should have been 10 kg.
		const mistake = await product(b, oil.id, 3_000, 10_000)
		const finding = find(
			(await checks()).findings,
			'unit_off_1000x',
			(f) => f.supplierProductId === mistake.id,
		)!
		expect(finding.suggestedPackBaseQuantity).toBe(10_000_000)
		await ok(
			call('POST', `${BASE}/setup-checks/fix`, {
				token: full,
				body: {
					locationId: LOC,
					key: finding.key,
					fingerprint: finding.fingerprint,
				},
			}),
		)
		const detail = await ok(
			call('GET', `${BASE}/suppliers/${b}`, { token: full }),
		)
		expect(detail.products[0].packBaseQuantity).toBe(10_000_000)
	})
})

describe('recipes', () => {
	it('flags a made item without a recipe', async () => {
		const sauce = await item('House sauce', {
			kind: 'made',
			category: 'sauces',
		})
		const finding = find(
			(await checks()).findings,
			'made_item_no_recipe',
			(f) => f.itemId === sauce.id,
		)
		expect(finding?.fix).toEqual({
			kind: 'open_recipe',
			ownerKind: 'made_item',
			ownerId: sauce.id,
			lineItemId: null,
		})
	})

	it('flags an archived ingredient and the fix opens that recipe with the line selected', async () => {
		const parsley = await item('Parsley', { category: 'produce' })
		await ok(
			call('PUT', `${BASE}/recipes`, {
				token: full,
				body: {
					ownerKind: 'menu_item',
					ownerId: 'dish_tabbouleh',
					expectedVersion: 0,
					lines: [{ itemId: parsley.id, amount: 30, unit: 'g' }],
				},
			}),
		)
		await ok(
			call('POST', `${BASE}/items/${parsley.id}/archive`, {
				token: full,
				body: { expectedVersion: parsley.version },
			}),
		)
		const finding = find(
			(await checks()).findings,
			'recipe_archived_item',
			(f) => f.itemId === parsley.id,
		)!
		expect(finding).toMatchObject({
			ownerKind: 'menu_item',
			ownerId: 'dish_tabbouleh',
			itemName: 'Parsley',
		})
		expect(finding.fix).toEqual({
			kind: 'open_recipe',
			ownerKind: 'menu_item',
			ownerId: 'dish_tabbouleh',
			lineItemId: parsley.id,
		})
	})
})

describe('storage areas', () => {
	it('flags an item in no area and the fix puts it in the area its category uses', async () => {
		const area = await ok(
			call('POST', `${BASE}/storage-areas`, {
				token: full,
				body: { locationId: LOC, name: 'Walk-in' },
			}),
		)
		const placed = await item('Beef')
		const loose = await item('Lamb')
		for (const [id, areaIds] of [
			[placed.id, [area.id]],
			[loose.id, []],
		] as const) {
			await ok(
				call('PUT', `${BASE}/items/${id}/places/${LOC}`, {
					token: full,
					body: {
						countUnit: 'kg',
						areaIds,
						orderBelowQuantity: null,
						fillUpToQuantity: null,
						expectedVersion: 0,
					},
				}),
			)
		}
		const finding = find(
			(await checks()).findings,
			'item_no_area',
			(f) => f.itemId === loose.id,
		)!
		expect(finding).toMatchObject({
			suggestedAreaId: area.id,
			suggestedAreaName: 'Walk-in',
		})
		await ok(
			call('POST', `${BASE}/setup-checks/fix`, {
				token: full,
				body: {
					locationId: LOC,
					key: finding.key,
					fingerprint: finding.fingerprint,
				},
			}),
		)
		expect(
			find(
				(await checks()).findings,
				'item_no_area',
				(f) => f.itemId === loose.id,
			),
		).toBeUndefined()
		const detail = await ok(
			call('GET', `${BASE}/items/${loose.id}?locationId=${LOC}`, {
				token: full,
			}),
		)
		expect(detail.areaIds).toEqual([area.id])
	})
})

describe('dismissing', () => {
	it('keeps a dismissed finding hidden until the data changes', async () => {
		const pepper = await item('Pepper')
		const sup = await supplier('Spices')
		const created = await product(sup, pepper.id, 100, 1_000_000)
		const before = find(
			(await checks()).findings,
			'price_placeholder',
			(f) => f.supplierProductId === created.id,
		)!
		await ok(
			call('POST', `${BASE}/setup-checks/dismiss`, {
				token: full,
				body: {
					locationId: LOC,
					key: before.key,
					fingerprint: before.fingerprint,
				},
			}),
		)
		const hidden = await checks()
		expect(
			find(
				hidden.findings,
				'price_placeholder',
				(f) => f.supplierProductId === created.id,
			),
		).toBeUndefined()
		expect(hidden.dismissed).toBeGreaterThan(0)
		// Still hidden on the next look.
		expect(
			find(
				(await checks()).findings,
				'price_placeholder',
				(f) => f.supplierProductId === created.id,
			),
		).toBeUndefined()
		// The price changes to another placeholder: the evidence changed, so it is back.
		await ok(
			call('PATCH', `${BASE}/supplier-products/${created.id}`, {
				token: full,
				body: { expectedVersion: created.version, priceMinor: 0 },
			}),
		)
		const back = find(
			(await checks()).findings,
			'price_placeholder',
			(f) => f.supplierProductId === created.id,
		)
		expect(back).toMatchObject({ priceMinor: 0 })
	})

	it('refuses to dismiss or fix a finding whose data moved on', async () => {
		const stale = await call('POST', `${BASE}/setup-checks/dismiss`, {
			token: full,
			body: {
				locationId: LOC,
				key: 'price_placeholder:nope',
				fingerprint: 'x',
			},
		})
		expect(stale.status).toBe(409)
		const fix = await call('POST', `${BASE}/setup-checks/fix`, {
			token: full,
			body: {
				locationId: LOC,
				key: 'price_placeholder:nope',
				fingerprint: 'x',
			},
		})
		expect(fix.status).toBe(409)
	})
})

import {
	itemDetailSchema,
	mergeCandidatesResultSchema,
	mergeItemPreviewSchema,
	mergeResultSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invMerges,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
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

/** Merge duplicate items and suppliers (#493). */

const ORG = 'org_inv_merge_a'
const ORG_B = 'org_inv_merge_b'
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
let noRecipe: string
let tokenB: string

beforeAll(async () => {
	env = setupTenantEnv('inv-merge')
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
	const features = { recipes: true }
	full = await mintToken(ORG, {
		grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
		features,
	})
	noRecipe = await mintToken(ORG, {
		grants: [READ, UPDATE, COST, PURCHASING],
		features,
	})
	tokenB = await mintToken(ORG_B, {
		grants: [READ, UPDATE, COST, PURCHASING, RECIPE],
		features,
	})
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	await destroyTenantDb(ORG_B)
	env.cleanup()
})

async function ok(res: Promise<{ status: number; body: any }>) {
	const reply = await res
	expect(reply.status, JSON.stringify(reply.body)).toBe(200)
	return reply.body
}

async function item(name: string, baseUnit = 'g') {
	const body = await ok(
		call('POST', `${BASE}/items`, {
			token: full,
			body: {
				clientId: cid('item'),
				name,
				category: 'meat',
				kind: 'bought',
				baseUnit,
			},
		}),
	)
	return body.id as string
}

async function supplier(name: string) {
	const body = await ok(
		call('POST', `${BASE}/suppliers`, {
			token: full,
			body: { clientId: cid('sup'), name, currency: 'SAR' },
		}),
	)
	return { id: body.id as string, version: body.version as number }
}

async function deliver(
	itemId: string,
	quantity: number,
	total: number,
	supplierId: string | null = null,
) {
	await ok(
		call('POST', `${BASE}/deliveries`, {
			token: full,
			body: {
				clientId: cid('delivery'),
				locationId: LOC,
				supplierId,
				currency: 'SAR',
				lines: [{ itemId, quantity, lineTotalMinor: total }],
			},
		}),
	)
}

const detail = async (id: string) =>
	itemDetailSchema.parse(
		await ok(
			call('GET', `${BASE}/items/${id}?locationId=${LOC}`, { token: full }),
		),
	)

async function movements(id: string) {
	const body = await ok(
		call('GET', `${BASE}/items/${id}/movements?locationId=${LOC}&limit=50`, {
			token: full,
		}),
	)
	return body.movements as {
		kind: string
		reason: string | null
		quantity: number
		sourceType: string
	}[]
}

async function currentRecipe(ownerId: string) {
	const body = await ok(
		call('GET', `${BASE}/recipes?ownerKind=menu_item&ownerId=${ownerId}`, {
			token: full,
		}),
	)
	return body.recipe
}

describe('merge items', () => {
	it('moves recipes and supplier products, sums on hand, logs a merged line and archives the duplicate', async () => {
		const keep = await item('Chicken breast')
		const dup = await item('Chicken breasts')
		const supA = await supplier('Al Watania')
		const supB = await supplier('Doux')
		await deliver(keep, 3_000_000, 9_000, supA.id)
		await deliver(dup, 5_000_000, 20_000, supB.id)
		const product = await ok(
			call('POST', `${BASE}/suppliers/${supB.id}/products`, {
				token: full,
				body: {
					itemId: dup,
					packName: 'Box 5 kg',
					packBaseQuantity: 5_000_000,
					priceMinor: 20_000,
					preferred: true,
				},
			}),
		)
		await ok(
			call('PUT', `${BASE}/recipes`, {
				token: full,
				body: {
					ownerKind: 'menu_item',
					ownerId: 'dish_shawarma_merge',
					expectedVersion: 0,
					lines: [{ itemId: dup, amount: 180, unit: 'g' }],
				},
			}),
		)
		const [keepBefore, dupBefore] = [await detail(keep), await detail(dup)]
		expect(keepBefore.onHand).toBe(3_000_000)
		expect(dupBefore.onHand).toBe(5_000_000)

		const preview = mergeItemPreviewSchema.parse(
			await ok(
				call('GET', `${BASE}/items/${dup}/merge-preview?intoItemId=${keep}`, {
					token: full,
				}),
			),
		)
		expect(preview).toMatchObject({
			canApply: true,
			moves: { recipes: 1, supplierProducts: 1 },
			onHand: [
				{
					locationId: LOC,
					duplicate: 5_000_000,
					kept: 3_000_000,
					after: 8_000_000,
				},
			],
		})

		const merged = mergeResultSchema.parse(
			await ok(
				call('POST', `${BASE}/items/${dup}/merge`, {
					token: full,
					body: {
						intoItemId: keep,
						expectedVersion: dupBefore.version,
						intoExpectedVersion: keepBefore.version,
					},
				}),
			),
		)
		expect(merged.undoUntil).toBeGreaterThan(Date.now())

		const recipe = await currentRecipe('dish_shawarma_merge')
		expect(recipe.lines.map((line: { itemId: string }) => line.itemId)).toEqual(
			[keep],
		)
		expect(recipe.lines[0].quantity).toBe(180_000)
		const keptAfter = await detail(keep)
		expect(keptAfter.onHand).toBe(8_000_000)
		expect(keptAfter.suppliers.map((row) => row.id)).toContain(product.id)
		expect(keptAfter.mergedFrom?.[0]).toMatchObject({
			id: dup,
			mergeId: merged.mergeId,
		})
		// Weighted average of 3 kg at 3.00/kg and 5 kg at 4.00/kg.
		expect(keptAfter.cost!.avgCostMicro).toBe(
			Math.round((3 * 3_000_000 + 5 * 4_000_000) / 8),
		)
		const dupAfter = await detail(dup)
		expect(dupAfter.archived).toBe(true)
		expect(dupAfter.onHand).toBe(0)
		expect(dupAfter.mergedInto).toMatchObject({ id: keep, undone: false })

		const log = await movements(keep)
		expect(
			log.some((row) => row.reason === 'merged' && row.quantity === 5_000_000),
		).toBe(true)
		// The duplicate's earlier history shows on the kept item too, quantities as written.
		expect(
			log.some((row) => row.kind === 'delivery' && row.quantity === 5_000_000),
		).toBe(true)
		// The dish is on the kept item now.
		const used = await ok(
			call('GET', `${BASE}/items/${keep}/used-in`, { token: full }),
		)
		expect(used.rows.map((row: { ownerId: string }) => row.ownerId)).toContain(
			'dish_shawarma_merge',
		)
	})

	it('undo restores both items as they were', async () => {
		const keep = await item('Beef mince')
		const dup = await item('Mince beef')
		const sup = await supplier('Beef supplier')
		await deliver(keep, 2_000_000, 8_000, sup.id)
		await deliver(dup, 1_000_000, 5_000, sup.id)
		await ok(
			call('POST', `${BASE}/suppliers/${sup.id}/products`, {
				token: full,
				body: {
					itemId: dup,
					packName: 'Bag',
					packBaseQuantity: 1_000_000,
					priceMinor: 5_000,
				},
			}),
		)
		await ok(
			call('PUT', `${BASE}/recipes`, {
				token: full,
				body: {
					ownerKind: 'menu_item',
					ownerId: 'dish_burger_merge',
					expectedVersion: 0,
					lines: [{ itemId: dup, amount: 150, unit: 'g' }],
				},
			}),
		)
		const keepBefore = await detail(keep)
		const dupBefore = await detail(dup)
		const merged = await ok(
			call('POST', `${BASE}/items/${dup}/merge`, {
				token: full,
				body: {
					intoItemId: keep,
					expectedVersion: dupBefore.version,
					intoExpectedVersion: keepBefore.version,
				},
			}),
		)
		const undone = await ok(
			call('POST', `${BASE}/merges/${merged.mergeId}/undo`, {
				token: full,
				body: {},
			}),
		)
		expect(undone).toMatchObject({ undone: true, recipesKept: 0 })
		const dupAfter = await detail(dup)
		const keepAfter = await detail(keep)
		expect(dupAfter.archived).toBe(false)
		expect(dupAfter.mergedInto).toBeNull()
		expect(dupAfter.onHand).toBe(1_000_000)
		expect(keepAfter.onHand).toBe(2_000_000)
		expect(dupAfter.suppliers).toHaveLength(1)
		expect(keepAfter.suppliers).toHaveLength(0)
		expect(keepAfter.cost!.avgCostMicro).toBe(keepBefore.cost!.avgCostMicro)
		const recipe = await currentRecipe('dish_burger_merge')
		expect(recipe.lines[0].itemId).toBe(dup)
		const again = await call('POST', `${BASE}/merges/${merged.mergeId}/undo`, {
			token: full,
			body: {},
		})
		expect(again.status).toBe(409)
		expect(again.body.code).toBe('already_undone')
	})

	it('refuses an undo after 24 hours', async () => {
		const keep = await item('Lamb leg')
		const dup = await item('Lamb legs')
		const keepD = await detail(keep)
		const dupD = await detail(dup)
		const merged = await ok(
			call('POST', `${BASE}/items/${dup}/merge`, {
				token: full,
				body: {
					intoItemId: keep,
					expectedVersion: dupD.version,
					intoExpectedVersion: keepD.version,
				},
			}),
		)
		const db = await getTenantDb(ORG)
		await db
			.update(invMerges)
			.set({ undoUntil: Date.now() - 1000 })
			.where(eq(invMerges.id, merged.mergeId))
		const late = await call('POST', `${BASE}/merges/${merged.mergeId}/undo`, {
			token: full,
			body: {},
		})
		expect(late.status).toBe(409)
		expect(late.body.code).toBe('undo_expired')
	})

	it('is blocked while either item is in an open count', async () => {
		const keep = await item('Salmon')
		const dup = await item('Salmon fillet')
		const count = await ok(
			call('POST', `${BASE}/counts`, {
				token: full,
				body: { clientId: cid('count'), locationId: LOC, listId: null },
			}),
		)
		const preview = mergeItemPreviewSchema.parse(
			await ok(
				call('GET', `${BASE}/items/${dup}/merge-preview?intoItemId=${keep}`, {
					token: full,
				}),
			),
		)
		expect(preview.canApply).toBe(false)
		expect(
			preview.blockers.some(
				(b) => b.kind === 'open_count' && b.id === count.id,
			),
		).toBe(true)
		const keepD = await detail(keep)
		const dupD = await detail(dup)
		const refused = await call('POST', `${BASE}/items/${dup}/merge`, {
			token: full,
			body: {
				intoItemId: keep,
				expectedVersion: dupD.version,
				intoExpectedVersion: keepD.version,
			},
		})
		expect(refused.status).toBe(409)
		expect(refused.body.code).toBe('change_blocked')
		expect((await detail(dup)).archived).toBe(false)
		await ok(
			call('POST', `${BASE}/counts/${count.id}/cancel`, {
				token: full,
				body: { expectedVersion: count.version },
			}),
		)
	})

	it('needs the same unit and the recipe grant, and stays in its organization', async () => {
		const grams = await item('Cream')
		const ml = await item('Cream carton', 'ml')
		const gramsD = await detail(grams)
		const mlD = await detail(ml)
		const mismatch = await call('POST', `${BASE}/items/${ml}/merge`, {
			token: full,
			body: {
				intoItemId: grams,
				expectedVersion: mlD.version,
				intoExpectedVersion: gramsD.version,
			},
		})
		expect(mismatch.status).toBe(409)
		expect(mismatch.body.code).toBe('merge_unit_mismatch')

		const keep = await item('Tomato')
		const dup = await item('Tomatoes')
		await ok(
			call('PUT', `${BASE}/recipes`, {
				token: full,
				body: {
					ownerKind: 'menu_item',
					ownerId: 'dish_salad_merge',
					expectedVersion: 0,
					lines: [{ itemId: dup, amount: 50, unit: 'g' }],
				},
			}),
		)
		const keepD = await detail(keep)
		const dupD = await detail(dup)
		const denied = await call('POST', `${BASE}/items/${dup}/merge`, {
			token: noRecipe,
			body: {
				intoItemId: keep,
				expectedVersion: dupD.version,
				intoExpectedVersion: keepD.version,
			},
		})
		expect(denied.status).toBe(403)
		expect(denied.body.code).toBe('needs_recipe_grant')
		const other = await call('POST', `${BASE}/items/${dup}/merge`, {
			token: tokenB,
			body: {
				intoItemId: keep,
				expectedVersion: dupD.version,
				intoExpectedVersion: keepD.version,
			},
		})
		expect(other.status).toBe(404)
		const same = await call('POST', `${BASE}/items/${dup}/merge`, {
			token: full,
			body: {
				intoItemId: dup,
				expectedVersion: dupD.version,
				intoExpectedVersion: dupD.version,
			},
		})
		expect(same.status).toBe(400)
	})

	it('lists likely matches first (same name words, same supplier product)', async () => {
		const olive = await item('Olive oil extra virgin')
		await item('Basmati rice')
		const oliveB = await item('Extra virgin olive oil 1L')
		const sup = await supplier('Oil supplier')
		for (const id of [olive, oliveB]) {
			await ok(
				call('POST', `${BASE}/suppliers/${sup.id}/products`, {
					token: full,
					body: {
						itemId: id,
						packName: 'Tin 5 L',
						packBaseQuantity: 5_000_000,
						priceMinor: 9_000,
					},
				}),
			)
		}
		const result = mergeCandidatesResultSchema.parse(
			await ok(
				call('GET', `${BASE}/items/${olive}/merge-candidates`, { token: full }),
			),
		)
		expect(result.candidates[0]!.id).toBe(oliveB)
		expect(result.candidates[0]!.reasons).toEqual(['name', 'supplier_product'])
	})
})

describe('merge suppliers', () => {
	it('moves products, keeps history readable under the kept supplier and undoes', async () => {
		const keep = await supplier('Fresh Farms')
		const dup = await supplier('Fresh Farms LLC')
		const it1 = await item('Cucumber')
		await ok(
			call('POST', `${BASE}/suppliers/${dup.id}/products`, {
				token: full,
				body: {
					itemId: it1,
					packName: 'Crate',
					packBaseQuantity: 10_000_000,
					priceMinor: 4_000,
				},
			}),
		)
		// A received, unpaid delivery from the duplicate.
		await deliver(it1, 10_000_000, 4_000, dup.id)
		const preview = await ok(
			call(
				'GET',
				`${BASE}/suppliers/${dup.id}/merge-preview?intoSupplierId=${keep.id}`,
				{
					token: full,
				},
			),
		)
		expect(preview).toMatchObject({
			canApply: true,
			moves: { products: 1, deliveries: 1 },
			unpaidMinor: 4_000,
		})
		const merged = await ok(
			call('POST', `${BASE}/suppliers/${dup.id}/merge`, {
				token: full,
				body: {
					intoSupplierId: keep.id,
					expectedVersion: dup.version,
					intoExpectedVersion: keep.version,
				},
			}),
		)
		const kept = await ok(
			call('GET', `${BASE}/suppliers/${keep.id}`, { token: full }),
		)
		expect(kept.products).toHaveLength(1)
		expect(kept.productCount).toBe(1)
		expect(kept.unpaidMinor).toBe(4_000)
		const deliveries = await ok(
			call(
				'GET',
				`${BASE}/deliveries?locationId=${LOC}&supplierId=${keep.id}`,
				{ token: full },
			),
		)
		expect(deliveries.deliveries).toHaveLength(1)
		await ok(
			call('POST', `${BASE}/merges/${merged.mergeId}/undo`, {
				token: full,
				body: {},
			}),
		)
		const restored = await ok(
			call('GET', `${BASE}/suppliers/${dup.id}`, { token: full }),
		)
		expect(restored.archived).toBe(false)
		expect(restored.products).toHaveLength(1)
		const keptAgain = await ok(
			call('GET', `${BASE}/suppliers/${keep.id}`, { token: full }),
		)
		expect(keptAgain.products).toHaveLength(0)
	})
})

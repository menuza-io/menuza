import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	AUDIENCE_LIMITS,
	namesSensitiveRule,
	type AudienceDefinition,
} from '@repo/common/marketing-audiences'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	marketingCampaigns,
	marketingJourneys,
	provisionTenantDb,
	restaurantOrders,
	type TenantDatabase,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	DAY,
	insertCustomer,
	insertOrder,
	insertPosSale,
	LOC_1,
	LOC_2,
	NOW,
} from './loyalty-test-fixture.ts'
import {
	audienceOutOfScope,
	compileAudience,
} from './marketing-audience-rules.ts'
import {
	countAudience,
	createAudience,
	deleteAudience,
	ensureReadyMadeAudiences,
	listAudiences,
	updateAudience,
} from './marketing-audience-service.ts'
import {
	loadBroadcastAudience,
	setCustomerSubscription,
} from './marketing-audience.ts'

const ORG = 'clw9x0a12000008l00audi01'

describe('saved audiences (#98)', () => {
	let dir: string
	let db: TenantDatabase

	beforeEach(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-audiences-'))
		process.env.TENANT_DB_DIR = dir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		await provisionTenantDb(ORG)
		db = await getTenantDb(ORG)
	})

	afterEach(async () => {
		await destroyTenantDb(ORG).catch(() => {})
		fs.rmSync(dir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id).sort()

	async function matching(definition: AudienceDefinition) {
		const rows = await db
			.select({ id: customers.id })
			.from(customers)
			.where(compileAudience(definition, NOW))
			.all()
		return ids(rows)
	}

	async function guest(id: string, phone?: string) {
		return insertCustomer(ORG, { id, phone: phone ?? `+1555000${id.length}${id}` })
	}

	const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY)

	it('counts orders that count, and leaves out cancelled and fully refunded ones', async () => {
		await guest('a', '+15550000001')
		await guest('b', '+15550000002')
		await guest('c', '+15550000003')
		await insertOrder(ORG, { customerId: 'a', createdAt: at(1) })
		await insertOrder(ORG, { customerId: 'a', createdAt: at(2) })
		// b: one cancelled order and one refunded in full: nothing counts.
		await insertOrder(ORG, { customerId: 'b', status: 'cancelled', createdAt: at(1) })
		await insertOrder(ORG, {
			customerId: 'b',
			createdAt: at(1),
			refundedCents: 1000,
		})
		// c: an online order still waiting for payment does not count.
		await insertOrder(ORG, {
			customerId: 'c',
			status: 'accepted',
			paymentStatus: 'pending',
			createdAt: at(1),
		})
		expect(
			await matching({
				match: 'all',
				rules: [{ field: 'orders_count', op: 'gte', value: 2 }],
			}),
		).toEqual(['a'])
		expect(
			await matching({
				match: 'all',
				rules: [{ field: 'orders_count', op: 'eq', value: 0 }],
			}),
		).toEqual(['b', 'c'])
	})

	it('counts a Station sale linked to a guest by phone, and a partial refund only reduces spend', async () => {
		await guest('a', '+15550000001')
		await insertPosSale(ORG, {
			customerPhone: '+15550000001',
			totalCents: 2000,
			subtotalCents: 2000,
			refundedCents: 500,
			rungUpAt: NOW - DAY,
		})
		// An unlinked sale counts for nobody.
		await insertPosSale(ORG, { customerPhone: '+15559999999', rungUpAt: NOW - DAY })
		expect(
			await matching({
				match: 'all',
				rules: [{ field: 'orders_count', op: 'gte', value: 1 }],
			}),
		).toEqual(['a'])
		expect(
			await matching({
				match: 'all',
				rules: [{ field: 'spend', op: 'eq', value: 1500 }],
			}),
		).toEqual(['a'])
	})

	it('windows spend and orders, filters by location, and finds lapsed guests', async () => {
		await guest('a', '+15550000001')
		await guest('b', '+15550000002')
		await guest('never', '+15550000003')
		await insertOrder(ORG, {
			customerId: 'a',
			createdAt: at(100),
			locationId: LOC_1,
		})
		await insertOrder(ORG, {
			customerId: 'b',
			createdAt: at(10),
			locationId: LOC_2,
		})
		expect(
			await matching({
				match: 'all',
				rules: [{ field: 'days_since_last_order', op: 'gte', value: 60 }],
			}),
		).toEqual(['a'])
		expect(
			await matching({
				match: 'all',
				rules: [
					{ field: 'orders_count', op: 'gte', value: 1, windowDays: 30 },
				],
			}),
		).toEqual(['b'])
		expect(
			await matching({
				match: 'all',
				rules: [
					{ field: 'orders_count', op: 'gte', value: 1, locationIds: [LOC_1] },
				],
			}),
		).toEqual(['a'])
	})

	it('picks the top spenders and joins rules with all-of and any-of', async () => {
		for (let i = 0; i < 20; i += 1) {
			const id = `g${String(i).padStart(2, '0')}`
			await guest(id, `+155500100${String(i).padStart(2, '0')}`)
			await insertOrder(ORG, {
				customerId: id,
				subtotalCents: 1000 + i * 100,
				createdAt: at(5),
			})
		}
		expect(
			await matching({
				match: 'all',
				rules: [{ field: 'top_spenders', percent: 10, windowDays: 90 }],
			}),
		).toEqual(['g18', 'g19'])
		expect(
			await matching({
				match: 'any',
				rules: [
					{ field: 'spend', op: 'gte', value: 2900 },
					{ field: 'spend', op: 'lte', value: 1000 },
				],
			}),
		).toEqual(['g00', 'g19'])
		expect(
			await matching({
				match: 'all',
				rules: [
					{ field: 'spend', op: 'gte', value: 2900 },
					{ field: 'spend', op: 'lte', value: 1000 },
				],
			}),
		).toEqual([])
	})

	it('narrows consent and never widens it: a matching guest without a subscription is not reachable', async () => {
		await db
			.insert(customers)
			.values({
				id: 'a',
				name: 'A',
				email: 'a@example.com',
				phone: '+15550000001',
				phoneVerified: true,
			})
		await db.insert(customers).values({
			id: 'b',
			name: 'B',
			email: 'b@example.com',
			phone: '+15550000002',
			phoneVerified: true,
		})
		await insertOrder(ORG, { customerId: 'a', createdAt: at(1) })
		await insertOrder(ORG, { customerId: 'b', createdAt: at(1) })
		await setCustomerSubscription(db, {
			customerId: 'a',
			topic: 'marketing',
			channel: 'sms',
			subscribed: true,
			source: 'profile',
		})
		const where = compileAudience(
			{ match: 'all', rules: [{ field: 'orders_count', op: 'gte', value: 1 }] },
			NOW,
		)
		const sms = await loadBroadcastAudience(db, {
			channel: 'sms',
			audienceWhere: where,
		})
		expect(sms.map((c) => c.id)).toEqual(['a'])
		// Without a saved audience the broadcast reaches the same consented guest.
		await expect(
			loadBroadcastAudience(db, { channel: 'sms' }),
		).resolves.toHaveLength(1)
	})

	it('shows counts below the floor as null and previews no identities', async () => {
		for (let i = 0; i < 6; i += 1) await guest(`p${i}`, `+155500200${i}`)
		await guest('q', '+15550003000')
		const definition: AudienceDefinition = {
			match: 'all',
			rules: [{ field: 'phone_verified', value: true }],
		}
		const counts = await countAudience(db, definition, NOW)
		expect(counts.size).toBe(7)
		expect(counts.email).toBeNull()
		expect(counts.sms).toBeNull()
		expect(JSON.stringify(counts)).not.toMatch(/\+1555|@/)
		const few = await countAudience(
			db,
			{ match: 'all', rules: [{ field: 'joined_within_days', value: 1 }] },
			NOW + 400 * DAY,
		)
		expect(few.size).toBeNull()
	})

	it('refuses sensitive rule fields and rules outside a location scope', () => {
		expect(namesSensitiveRule({ rules: [{ field: 'allergy_notes' }] })).toBe(true)
		expect(namesSensitiveRule({ rules: [{ field: 'tag', value: 'vip' }] })).toBe(true)
		expect(namesSensitiveRule({ rules: [{ field: 'orders_count' }] })).toBe(false)
		const rule: AudienceDefinition = {
			match: 'all',
			rules: [{ field: 'orders_count', op: 'gte', value: 1, locationIds: [LOC_1] }],
		}
		expect(audienceOutOfScope(rule, undefined)).toBe(false)
		expect(audienceOutOfScope(rule, [LOC_1])).toBe(false)
		expect(audienceOutOfScope(rule, [LOC_2])).toBe(true)
		expect(
			audienceOutOfScope(
				{ match: 'all', rules: [{ field: 'orders_count', op: 'gte', value: 1 }] },
				[LOC_1],
			),
		).toBe(true)
	})

	it('adds the ready-made audiences once, keeps names unique, limits them, and refuses to delete one in use', async () => {
		await ensureReadyMadeAudiences(db)
		await ensureReadyMadeAudiences(db)
		const initial = await listAudiences(db)
		expect(initial.map((a) => a.name)).toEqual([
			'Lapsed 60 days',
			'Loyalty members near a reward',
			'New this month',
			'Top 10% spenders (90 days)',
		])
		// A deleted ready-made audience is not added back.
		await deleteAudience(db, initial[0]!.id)
		expect(await listAudiences(db)).toHaveLength(3)

		const definition: AudienceDefinition = {
			match: 'all',
			rules: [{ field: 'phone_verified', value: true }],
		}
		const created = await createAudience(db, { name: 'Verified', definition })
		expect(created.ok).toBe(true)
		if (!created.ok) return
		expect(
			await createAudience(db, { name: 'verified', definition }),
		).toEqual({ ok: false, error: 'audience_name_taken' })

		const updated = await updateAudience(db, created.value.id, {
			name: 'Verified guests',
			definition,
			expectedVersion: 1,
		})
		expect(updated.ok && updated.value.version).toBe(2)
		expect(
			await updateAudience(db, created.value.id, {
				name: 'Stale',
				definition,
				expectedVersion: 1,
			}),
		).toEqual({ ok: false, error: 'audience_version_changed' })

		await db.insert(marketingCampaigns).values({
			name: 'Uses it',
			status: 'Scheduled',
			content: 'x',
			segmentationRules: { audience: 'all', audienceId: created.value.id },
		})
		expect(await deleteAudience(db, created.value.id)).toEqual({
			ok: false,
			error: 'audience_in_use',
		})
		await db
			.update(marketingCampaigns)
			.set({ status: 'Completed' })
			.where(eq(marketingCampaigns.name, 'Uses it'))
		await db.insert(marketingJourneys).values({
			name: 'Condition',
			nodes: [
				{
					id: 'c',
					type: 'condition',
					data: { field: 'audience', operator: 'equals', value: created.value.id },
				},
			],
		})
		expect(await deleteAudience(db, created.value.id)).toEqual({
			ok: false,
			error: 'audience_in_use',
		})
	})

	it('caps saved audiences at 50', async () => {
		const definition: AudienceDefinition = {
			match: 'all',
			rules: [{ field: 'phone_verified', value: true }],
		}
		for (let i = 0; i < AUDIENCE_LIMITS.audiences; i += 1) {
			const result = await createAudience(db, { name: `A${i}`, definition })
			expect(result.ok).toBe(true)
		}
		expect(await createAudience(db, { name: 'One more', definition })).toEqual({
			ok: false,
			error: 'audience_limit',
		})
	})
})

void restaurantOrders

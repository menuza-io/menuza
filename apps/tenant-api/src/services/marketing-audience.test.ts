import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	loadBroadcastAudience,
	setCustomerSubscription,
} from './marketing-audience.ts'

const orgId = 'clw9x0a12000008l00test41'

describe('loadBroadcastAudience', () => {
	let tempDir: string
	let db: Awaited<ReturnType<typeof getTenantDb>>

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-audience-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		await provisionTenantDb(orgId)
		db = await getTenantDb(orgId)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
		delete process.env.TENANT_DB_DIR
	})

	async function customer(values: Partial<typeof customers.$inferInsert>) {
		const [row] = await db
			.insert(customers)
			.values({ name: 'C', ...values })
			.returning()
		return row!
	}

	it('never includes customers who have not consented', async () => {
		await customer({
			email: 'a@example.com',
			phone: '+15550000101',
			phoneVerified: true,
		})
		await expect(
			loadBroadcastAudience(db, { channel: 'email' }),
		).resolves.toEqual([])
		await expect(
			loadBroadcastAudience(db, { channel: 'sms' }),
		).resolves.toEqual([])
	})

	it('includes an active subscriber and drops one who opted out', async () => {
		const stay = await customer({ email: 'stay@example.com' })
		const leave = await customer({ email: 'leave@example.com' })
		for (const c of [stay, leave]) {
			await setCustomerSubscription(db, {
				customerId: c.id,
				topic: 'marketing',
				channel: 'email',
				subscribed: true,
				source: 'signup',
			})
		}
		await setCustomerSubscription(db, {
			customerId: leave.id,
			topic: 'marketing',
			channel: 'email',
			subscribed: false,
			source: 'profile',
		})
		const audience = await loadBroadcastAudience(db, { channel: 'email' })
		expect(audience.map((c) => c.id)).toEqual([stay.id])
	})

	it('needs a verified phone for texts, plus an sms subscription', async () => {
		const verified = await customer({
			phone: '+15550000111',
			phoneVerified: true,
		})
		const unverified = await customer({
			phone: '+15550000112',
			phoneVerified: false,
		})
		const emailOnly = await customer({
			phone: '+15550000113',
			phoneVerified: true,
		})
		for (const c of [verified, unverified]) {
			await setCustomerSubscription(db, {
				customerId: c.id,
				topic: 'marketing',
				channel: 'sms',
				subscribed: true,
				source: 'signup',
			})
		}
		await setCustomerSubscription(db, {
			customerId: emailOnly.id,
			topic: 'marketing',
			channel: 'email',
			subscribed: true,
			source: 'signup',
		})
		const audience = await loadBroadcastAudience(db, { channel: 'sms' })
		expect(audience.map((c) => c.id)).toEqual([verified.id])
	})

	it('needs an address for email even with a subscription', async () => {
		const noAddress = await customer({ phone: '+15550000121' })
		await setCustomerSubscription(db, {
			customerId: noAddress.id,
			topic: 'marketing',
			channel: 'email',
			subscribed: true,
			source: 'import',
		})
		await expect(
			loadBroadcastAudience(db, { channel: 'email' }),
		).resolves.toEqual([])
	})

	it('filters by topic and defaults to the marketing topic', async () => {
		const updates = await customer({ email: 'u@example.com' })
		const promo = await customer({ email: 'p@example.com' })
		await setCustomerSubscription(db, {
			customerId: updates.id,
			topic: 'product_updates',
			channel: 'email',
			subscribed: true,
			source: 'signup',
		})
		await setCustomerSubscription(db, {
			customerId: promo.id,
			topic: 'marketing',
			channel: 'email',
			subscribed: true,
			source: 'signup',
		})
		expect(
			(await loadBroadcastAudience(db, { channel: 'email' })).map((c) => c.id),
		).toEqual([promo.id])
		expect(
			(
				await loadBroadcastAudience(db, {
					channel: 'email',
					topics: ['product_updates'],
				})
			).map((c) => c.id),
		).toEqual([updates.id])
	})

	it('re-subscribing clears the opt-out on the same row', async () => {
		const c = await customer({ email: 'r@example.com' })
		const base = {
			customerId: c.id,
			topic: 'marketing',
			channel: 'email',
		} as const
		await setCustomerSubscription(db, {
			...base,
			subscribed: true,
			source: 'signup',
		})
		await setCustomerSubscription(db, {
			...base,
			subscribed: false,
			source: 'profile',
		})
		await setCustomerSubscription(db, {
			...base,
			subscribed: true,
			source: 'profile',
		})
		expect(await loadBroadcastAudience(db, { channel: 'email' })).toHaveLength(
			1,
		)
	})
})

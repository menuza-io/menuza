import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	confirmCustomerSubscription,
	emailConsentHash,
	isInStaffConsentCoolingOff,
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
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
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
				confirmedEmail: c.email,
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
			confirmedEmail: 'u@example.com',
		})
		await setCustomerSubscription(db, {
			customerId: promo.id,
			topic: 'marketing',
			channel: 'email',
			subscribed: true,
			source: 'signup',
			confirmedEmail: 'p@example.com',
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
			confirmedEmail: 'r@example.com',
		})
		expect(await loadBroadcastAudience(db, { channel: 'email' })).toHaveLength(
			1,
		)
	})

	it('keeps a customer-made email subscription out until the address is confirmed', async () => {
		const c = await customer({ email: 'pending@example.com' })
		await setCustomerSubscription(db, {
			customerId: c.id,
			topic: 'marketing',
			channel: 'email',
			subscribed: true,
			source: 'signup',
		})
		await expect(
			loadBroadcastAudience(db, { channel: 'email' }),
		).resolves.toEqual([])
		await expect(
			confirmCustomerSubscription(db, {
				customerId: c.id,
				topic: 'marketing',
				email: 'Pending@Example.com',
			}),
		).resolves.toBe(true)
		expect(
			(await loadBroadcastAudience(db, { channel: 'email' })).map((x) => x.id),
		).toEqual([c.id])
	})

	it('drops a confirmed subscription when the address changes', async () => {
		const c = await customer({ email: 'old@example.com' })
		await setCustomerSubscription(db, {
			customerId: c.id,
			topic: 'marketing',
			channel: 'email',
			subscribed: true,
			source: 'import',
		})
		expect(await loadBroadcastAudience(db, { channel: 'email' })).toHaveLength(
			1,
		)
		await db
			.update(customers)
			.set({ email: 'someone-else@example.com' })
			.where(eq(customers.id, c.id))
		await expect(
			loadBroadcastAudience(db, { channel: 'email' }),
		).resolves.toEqual([])
	})

	it('does not confirm an opted-out subscription', async () => {
		const c = await customer({ email: 'out@example.com' })
		await setCustomerSubscription(db, {
			customerId: c.id,
			topic: 'marketing',
			channel: 'email',
			subscribed: true,
			source: 'signup',
		})
		await setCustomerSubscription(db, {
			customerId: c.id,
			topic: 'marketing',
			channel: 'email',
			subscribed: false,
			source: 'profile',
		})
		await expect(
			confirmCustomerSubscription(db, {
				customerId: c.id,
				topic: 'marketing',
				email: 'out@example.com',
			}),
		).resolves.toBe(false)
	})

	describe('consent provenance', () => {
		const rowOf = (customerId: string) =>
			db
				.select()
				.from(customerSubscriptions)
				.where(eq(customerSubscriptions.customerId, customerId))
				.get()

		it('does not auto-confirm a staff-recorded email, unlike an operator one', async () => {
			const staff = await customer({ email: 'staff@example.com' })
			const operator = await customer({ email: 'op@example.com' })
			await setCustomerSubscription(db, {
				customerId: staff.id,
				topic: 'marketing',
				channel: 'email',
				subscribed: true,
				source: 'staff',
				consentTextVersion: 'staff-2026-11',
				recordedBy: 'user_123',
				consentMethod: 'paper_form',
			})
			await setCustomerSubscription(db, {
				customerId: operator.id,
				topic: 'marketing',
				channel: 'email',
				subscribed: true,
				source: 'operator',
			})
			expect(await rowOf(staff.id)).toMatchObject({
				source: 'staff',
				confirmedEmailHash: null,
				consentTextVersion: 'staff-2026-11',
				recordedBy: 'user_123',
				consentMethod: 'paper_form',
			})
			expect((await rowOf(operator.id))!.confirmedEmailHash).toBe(
				emailConsentHash('op@example.com'),
			)
			// An explicit address still wins for staff.
			await setCustomerSubscription(db, {
				customerId: staff.id,
				topic: 'marketing',
				channel: 'email',
				subscribed: true,
				source: 'staff',
				confirmedEmail: 'staff@example.com',
			})
			expect((await rowOf(staff.id))!.confirmedEmailHash).toBe(
				emailConsentHash('staff@example.com'),
			)
		})

		it('keeps the opt-in record on opt-out and clears it on the next opt-in', async () => {
			const c = await customer({ phone: '+15550000201', phoneVerified: true })
			const base = {
				customerId: c.id,
				topic: 'marketing' as const,
				channel: 'sms' as const,
			}
			await setCustomerSubscription(db, {
				...base,
				subscribed: true,
				source: 'staff',
				consentTextVersion: 'staff-2026-11',
				recordedBy: 'user_9',
				consentMethod: 'in_person',
			})
			await setCustomerSubscription(db, {
				...base,
				subscribed: false,
				source: 'profile',
			})
			const out = await rowOf(c.id)
			expect(out).toMatchObject({
				source: 'staff',
				consentTextVersion: 'staff-2026-11',
				recordedBy: 'user_9',
				consentMethod: 'in_person',
				unsubscribedSource: 'self',
			})
			expect(out!.unsubscribedAt).toBeInstanceOf(Date)

			await setCustomerSubscription(db, {
				...base,
				subscribed: true,
				source: 'checkout',
			})
			expect(await rowOf(c.id)).toMatchObject({
				source: 'checkout',
				consentTextVersion: null,
				recordedBy: null,
				consentMethod: null,
				unsubscribedAt: null,
				unsubscribedSource: null,
			})
		})

		it.each([
			['operator', 'operator'],
			['staff', 'operator'],
			['import', 'import'],
			['profile', 'self'],
			['checkout', 'self'],
		] as const)(
			'an opt-out with source %s defaults to unsubscribed_source %s',
			async (source, expected) => {
				const c = await customer({ phone: '+15550000202', phoneVerified: true })
				const base = {
					customerId: c.id,
					topic: 'marketing' as const,
					channel: 'sms' as const,
				}
				await setCustomerSubscription(db, {
					...base,
					subscribed: true,
					source: 'signup',
				})
				await setCustomerSubscription(db, {
					...base,
					subscribed: false,
					source,
				})
				expect((await rowOf(c.id))!.unsubscribedSource).toBe(expected)
			},
		)

		it('blocks a staff opt-in only within the cooling-off after a self opt-out', async () => {
			const c = await customer({ phone: '+15550000203', phoneVerified: true })
			const base = {
				customerId: c.id,
				topic: 'marketing' as const,
				channel: 'sms' as const,
			}
			const day = 24 * 60 * 60 * 1000
			const outAt = new Date('2026-11-01T00:00:00Z')
			await expect(isInStaffConsentCoolingOff(db, base)).resolves.toBe(false)
			await setCustomerSubscription(db, {
				...base,
				subscribed: true,
				source: 'signup',
			})
			await setCustomerSubscription(db, {
				...base,
				subscribed: false,
				source: 'profile',
				now: outAt,
			})
			await expect(
				isInStaffConsentCoolingOff(db, {
					...base,
					now: new Date(outAt.getTime() + 29 * day),
				}),
			).resolves.toBe(true)
			await expect(
				isInStaffConsentCoolingOff(db, {
					...base,
					now: new Date(outAt.getTime() + 30 * day),
				}),
			).resolves.toBe(false)

			// A staff opt-out does not block; a legacy one (no source) does.
			await setCustomerSubscription(db, {
				...base,
				subscribed: false,
				source: 'operator',
				now: outAt,
			})
			await expect(
				isInStaffConsentCoolingOff(db, {
					...base,
					now: new Date(outAt.getTime() + day),
				}),
			).resolves.toBe(false)
			await db
				.update(customerSubscriptions)
				.set({ unsubscribedSource: null })
				.where(eq(customerSubscriptions.customerId, c.id))
			await expect(
				isInStaffConsentCoolingOff(db, {
					...base,
					now: new Date(outAt.getTime() + day),
				}),
			).resolves.toBe(true)
		})
	})
})

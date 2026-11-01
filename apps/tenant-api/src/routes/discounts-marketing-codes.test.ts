import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sendSms } from '@repo/sms'
import {
	customers,
	destroyTenantDb,
	discountIssuedCodes,
	discountRedemptions,
	getTenantDb,
	journeyRuns,
	marketingJourneys,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeDiscount } from '../../../../packages/discounts/src/test-fixtures.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import {
	codesWithIssuedCode,
	couponCodeForRecipient,
} from '../services/discount-marketing-codes.ts'
import { executeJourneyStep } from '../services/journey-service.ts'
import { erasePerson } from '../services/person-erasure-service.ts'
import { publicOrderRoutes } from './orders.ts'

vi.mock('../lib/origin.ts', () => {
	const findActiveOrganizationById = vi.fn()
	return {
		findActiveOrganizationById,
		lookupActiveOrganization: vi.fn(async (id: string) => {
			const organization = await findActiveOrganizationById(id)
			return organization
				? { status: 'found', organization }
				: { status: 'missing' }
		}),
		resolveOrganizationForBrowserAuth: vi.fn(),
		resolvePublishedOrganization: vi.fn(async () => null),
	}
})

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn(async () => ({ success: true, sid: 'sms-1', mock: true })),
}))

/**
 * Single-use coupon codes sent in marketing messages: minted once per
 * recipient, applied at checkout like a code with one use, and refused once
 * used, expired, or when their discount is gone.
 */

const orgId = 'org_discount_marketing_1'
const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
const DAY = 24 * 60 * 60 * 1000
const ALL_DAYS = [
	'sunday',
	'monday',
	'tuesday',
	'wednesday',
	'thursday',
	'friday',
	'saturday',
].map((day) => ({
	day,
	isOpen: true,
	slots: [{ start: '00:00', end: '23:59' }],
}))

/** A code discount with no public code: only marketing codes reach it. */
function codeOnlyDiscounts(discounts = [welcome()]) {
	return { features: { automatic: true, coupons: true }, discounts, codes: [] }
}

function welcome() {
	return makeDiscount({
		id: 'disc_welcome',
		name: 'Welcome back',
		application: 'code',
		percentBp: 1000,
	})
}

function menuContext(discounts: Record<string, unknown>) {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: { id: orgId, slug: 'test-org', currency: 'USD' },
			locations: [
				{
					id: 'loc-1',
					name: 'Main Street',
					timezone: 'UTC',
					taxRate: 0,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: {
						pickup: true,
						delivery: false,
						dineIn: false,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: true,
						deliveryTips: true,
						dineInTips: true,
					},
					onlineHours: ALL_DAYS,
				},
			],
			menus: [
				{
					id: 'menu-1',
					displayName: 'Main',
					menuType: 'regular',
					specialInstructions: true,
					availabilityStatus: 'available',
					categories: [
						{
							id: 'cat-food',
							displayName: 'Food',
							availabilityStatus: 'available',
							items: [
								{
									id: 'item-burger',
									displayName: 'Burger',
									price: 10,
									availabilityStatus: 'available',
								},
							],
						},
					],
				},
			],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: false, processor: null },
		discounts,
	}
}

function orderBody(code: string, overrides: Record<string, unknown> = {}) {
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'pickup',
		paymentMethod: 'handoff',
		contact: { name: 'Rana Khalid', phone: '+1 555 123 4567' },
		tipPercent: 0,
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		discounts: { code, expectedDiscountMinor: 200 },
		...overrides,
	}
}

describe('marketing coupon codes', () => {
	let directory: string
	let app: Hono
	let activeContext: Record<string, unknown>

	function post(pathname: string, body: unknown) {
		return app.request(pathname, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
				'cf-connecting-ip': '203.0.113.20',
			},
			body: JSON.stringify(body),
		})
	}

	async function quote(code: string) {
		const response = await post(
			'/orders/quote',
			orderBody(code, { idempotencyKey: undefined, contact: undefined }),
		)
		expect(response.status).toBe(200)
		return (await response.json()) as {
			coupon: { status: string; reason?: string } | null
		}
	}

	async function customer(name = 'Maya Ortiz', phone = '+15550001111') {
		const db = await getTenantDb(orgId)
		const [row] = await db
			.insert(customers)
			.values({ name, phone, phoneVerified: true })
			.returning()
		return row!
	}

	async function issue(customerId: string, validDays = 30, now = new Date()) {
		const db = await getTenantDb(orgId)
		return couponCodeForRecipient(
			db,
			{ mode: 'unique', discountId: 'disc_welcome', prefix: 'HI', validDays },
			{ sourceType: 'campaign', sourceId: 'campaign-1', customerId },
			now,
		)
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'discount-mkt-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', 'test-internal-token-very-long-12345')
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('DISCOUNTS_ENABLED', 'true')

		activeContext = menuContext(codeOnlyDiscounts())
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context')) {
					return Response.json(activeContext)
				}
				return new Response('not found', { status: 404 })
			}),
		)
		vi.mocked(resolveOrganizationForBrowserAuth).mockImplementation(
			async (_origin, identity) =>
				identity?.slug === 'test-org' ? (ORG as never) : null,
		)
		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === orgId ? (ORG as never) : null,
		)
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {
			// Already gone when a test failed mid-setup.
		}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	describe('minting', () => {
		it('gives a recipient the same code on a retry, and others their own', async () => {
			const maya = await customer()
			const omar = await customer('Omar Saleh', '+15550002222')
			const first = await issue(maya.id)
			expect(first).toMatch(/^HI-[A-HJ-NP-Z2-9]{8}$/)
			expect(await issue(maya.id)).toBe(first)
			const other = await issue(omar.id)
			expect(other).not.toBe(first)
			const db = await getTenantDb(orgId)
			expect(await db.select().from(discountIssuedCodes)).toHaveLength(2)
		})

		it('returns a shared code as typed, without minting', async () => {
			const maya = await customer()
			const db = await getTenantDb(orgId)
			const code = await couponCodeForRecipient(
				db,
				{ mode: 'shared', discountId: 'disc_welcome', code: 'save-10' },
				{ sourceType: 'campaign', sourceId: 'campaign-1', customerId: maya.id },
			)
			expect(code).toBe('SAVE-10')
			expect(await db.select().from(discountIssuedCodes)).toHaveLength(0)
		})

		it('lets a public code win over an issued one with the same text', async () => {
			const maya = await customer()
			const code = await issue(maya.id)
			const db = await getTenantDb(orgId)
			const publicCode = {
				id: 'code_public',
				discountId: 'disc_other',
				normalizedCode: code.replace('-', ''),
				maxUses: null,
			}
			expect(await codesWithIssuedCode(db, [publicCode], code)).toEqual([
				publicCode,
			])
		})
	})

	describe('at checkout', () => {
		it('applies an issued code once, then refuses it as used', async () => {
			const maya = await customer()
			const code = await issue(maya.id)

			expect((await quote(code.toLowerCase())).coupon).toMatchObject({
				status: 'applied',
			})
			const placed = await post('/orders', orderBody(code))
			expect(placed.status).toBe(201)

			const db = await getTenantDb(orgId)
			const [issued] = await db.select().from(discountIssuedCodes)
			const [use] = await db.select().from(discountRedemptions)
			expect(use).toMatchObject({
				discountId: 'disc_welcome',
				codeId: issued!.id,
				amountMinor: 200,
				state: 'reserved',
			})

			expect((await quote(code)).coupon).toMatchObject({
				status: 'refused',
				reason: 'limit_reached',
			})
			const again = await post('/orders', orderBody(code))
			expect(again.status).toBe(409)
		})

		it('works again once its order gives the use back', async () => {
			const maya = await customer()
			const code = await issue(maya.id)
			expect((await post('/orders', orderBody(code))).status).toBe(201)
			const db = await getTenantDb(orgId)
			await db
				.update(discountRedemptions)
				.set({ state: 'released' })
				.where(eq(discountRedemptions.discountId, 'disc_welcome'))
			expect((await quote(code)).coupon).toMatchObject({ status: 'applied' })
		})

		it('does not find an expired code', async () => {
			const maya = await customer()
			const code = await issue(maya.id, 1, new Date(Date.now() - 2 * DAY))
			expect((await quote(code)).coupon).toMatchObject({
				status: 'refused',
				reason: 'not_found',
			})
		})

		it('does not find a code whose discount is no longer offered', async () => {
			const maya = await customer()
			const code = await issue(maya.id)
			// Paused or archived discounts are left out of the order context.
			activeContext = menuContext(codeOnlyDiscounts([]))
			expect((await quote(code)).coupon).toMatchObject({
				status: 'refused',
				reason: 'not_found',
			})
		})

		it('does not find a made-up code', async () => {
			expect((await quote('HI-ABCDEFGH')).coupon).toMatchObject({
				status: 'refused',
				reason: 'not_found',
			})
		})
	})

	describe('in an automation step', () => {
		async function run(customerId: string) {
			const db = await getTenantDb(orgId)
			const [journey] = await db
				.insert(marketingJourneys)
				.values({
					name: 'Win back',
					status: 'active',
					triggerType: 'manual',
				})
				.returning()
			const [row] = await db
				.insert(journeyRuns)
				.values({
					journeyId: journey!.id,
					customerId,
					status: 'running',
					contextData: '{}',
				})
				.returning()
			return { journeyId: journey!.id, runId: row!.id }
		}

		it('texts a unique code and reuses it when the step is retried', async () => {
			const maya = await customer()
			const ids = await run(maya.id)
			const payload = {
				orgId,
				...ids,
				customerId: maya.id,
				nodeId: 'sms-1',
				nodeType: 'action_sms' as const,
				config: {
					messageText: 'Hi {{firstName}}, {{couponCode}} gets you 10% off',
					discountOffer: {
						mode: 'unique',
						discountId: 'disc_welcome',
						prefix: '',
						validDays: 7,
					},
				},
			}
			const result = await executeJourneyStep(orgId, payload)
			expect(result).toMatchObject({ success: true, status: 'delivered' })

			const db = await getTenantDb(orgId)
			const [issued] = await db.select().from(discountIssuedCodes)
			expect(issued).toMatchObject({
				sourceType: 'journey',
				sourceId: `${ids.runId}:sms-1`,
				customerId: maya.id,
			})
			expect(issued!.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/)
			expect(vi.mocked(sendSms)).toHaveBeenCalledWith({
				to: maya.phone,
				message: `Hi Maya, ${issued!.code} gets you 10% off`,
			})

			// A replay of the same step does not mint a second code.
			await executeJourneyStep(orgId, payload)
			expect(await db.select().from(discountIssuedCodes)).toHaveLength(1)
		})

		it('fails the step instead of sending a broken coupon', async () => {
			const maya = await customer()
			const ids = await run(maya.id)
			const result = await executeJourneyStep(orgId, {
				orgId,
				...ids,
				customerId: maya.id,
				nodeId: 'sms-2',
				nodeType: 'action_sms',
				config: {
					messageText: 'Code: {{couponCode}}',
					discountOffer: { mode: 'unique' },
				},
			})
			expect(result).toMatchObject({ success: false, status: 'failed' })
			expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
		})
	})

	it('keeps an erased person’s code working but no longer linked to them', async () => {
		const maya = await customer()
		const code = await issue(maya.id)
		const db = await getTenantDb(orgId)
		await erasePerson(db, { customerId: maya.id }, { actorId: 'user_1' })
		const [issued] = await db.select().from(discountIssuedCodes)
		expect(issued).toMatchObject({ code, customerId: null })
	})
})

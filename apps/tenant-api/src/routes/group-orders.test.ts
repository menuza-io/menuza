import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	GROUP_FIRST_NAME_MAX,
	GROUP_INACTIVE_PURGE_MS,
	GROUP_MAX_OPEN_PER_HOST,
	GROUP_MAX_PEOPLE,
	GROUP_TOKEN_HEADER,
	groupAcceptsEdits,
	groupLimitBreak,
	type GroupJoined,
	type GroupView,
} from '@repo/common/group-orders'
import {
	destroyTenantDb,
	getTenantDb,
	groupCartLines,
	groupCartPeople,
	loyaltyRateCounters,
	groupCarts,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makeDiscount } from '../../../../packages/discounts/src/test-fixtures.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import {
	clearGroupContextCacheForTest,
	deriveGroupShareToken,
	runGroupOrdersTick,
} from '../services/group-orders-service.ts'
import { erasePerson } from '../services/person-erasure-service.ts'
import { kitchenFeed } from '../services/kds-service.ts'
import { insertCustomer } from '../services/loyalty-test-fixture.ts'
import { renderOrderEmail } from '../lib/order-messages-email.ts'
import { receiptOrder } from '../services/order-service.ts'
import { linkReceiptOrder } from '../services/order-link-access.ts'
import { groupOrderRoutes } from './group-orders.ts'
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

const orgId = 'org_group_orders_1'
const jwtSecret = 'test-jwt-secret-123456789'
const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
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

function menuContext(
	guestOrdering: Record<string, boolean> | null = { group: true },
) {
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
					taxRate: 8.25,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: { pickup: true, delivery: false, dineIn: false },
					inHouseTips: { pickupTips: true },
					onlineHours: ALL_DAYS,
				},
				{
					id: 'loc-2',
					name: 'Second Street',
					timezone: 'UTC',
					taxRate: 8.25,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: { pickup: true, delivery: false, dineIn: false },
					onlineHours: ALL_DAYS,
				},
			],
			menus: [
				{
					id: 'menu-1',
					displayName: 'Main',
					menuType: 'regular',
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
		// Online payment is off on purpose: a test order must not need it.
		onlinePayment: { enabled: false, processor: null },
		discounts: {
			features: { automatic: true, coupons: true },
			discounts: [
				makeDiscount({ id: 'disc_half', name: 'Half off', percentBp: 5000 }),
			],
			codes: [],
		},
		guestMessages: {
			enabled: true,
			receipt: true,
			ready: true,
			cancelled: true,
		},
		...(guestOrdering ? { guestOrdering } : {}),
	}
}

function orderBody(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'pickup',
		paymentMethod: 'handoff',
		contact: {
			name: 'Rana Khalid',
			phone: '+1 555 123 4567',
			email: 'owner@restaurant.test',
		},
		tipPercent: 0,
		lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
		...overrides,
	}
}

const HOST = 'cust_host_1'

describe('group orders (#170)', () => {
	let directory: string
	let app: Hono
	let context: Record<string, unknown>

	async function db() {
		return getTenantDb(orgId)
	}
	async function customerJwt(customerId = HOST) {
		return new SignJWT({
			customerId,
			orgId,
			orgSlug: 'test-org',
			type: 'access',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setIssuer(brand.slug)
			.setAudience('tenant-api')
			.setExpirationTime('1h')
			.sign(new TextEncoder().encode(jwtSecret))
	}
	function call(
		pathname: string,
		options: {
			method?: string
			body?: Record<string, unknown>
			token?: string | null
			jwt?: string
		} = {},
	) {
		const method = options.method ?? 'GET'
		const headers: Record<string, string> = {
			origin: 'https://test-org.example.com',
		}
		if (options.token) headers[GROUP_TOKEN_HEADER] = options.token
		if (options.jwt) headers.authorization = `Bearer ${options.jwt}`
		let url = `/orders/group${pathname}`
		let body: string | undefined
		if (options.body) {
			headers['content-type'] = 'application/json'
			body = JSON.stringify({ slug: 'test-org', ...options.body })
		} else {
			url += `${pathname.includes('?') ? '&' : '?'}slug=test-org`
		}
		return app.request(url, { method, headers, body })
	}
	async function json<T>(response: Response): Promise<T> {
		return (await response.json()) as T
	}
	async function start(
		body: Record<string, unknown> = {},
		customerId = HOST,
	): Promise<GroupJoined> {
		const response = await call('', {
			method: 'POST',
			body: { locationId: 'loc-1', ...body },
			jwt: await customerJwt(customerId),
		})
		expect(response.status, JSON.stringify(await response.clone().json())).toBe(
			201,
		)
		return json<GroupJoined>(response)
	}
	async function join(group: GroupJoined, firstName: string) {
		const response = await call(`/${group.groupId}/join`, {
			method: 'POST',
			body: { firstName },
			token: group.shareToken,
		})
		expect(response.status, JSON.stringify(await response.clone().json())).toBe(
			201,
		)
		return json<GroupJoined>(response)
	}
	const burger = { line: { itemId: 'item-burger', quantity: 1, options: [] } }
	const fries = { line: { itemId: 'item-fries', quantity: 2, options: [] } }
	function add(group: GroupJoined, who: GroupJoined, body = burger) {
		return call(`/${group.groupId}/lines`, {
			method: 'POST',
			body,
			token: who.personToken,
		})
	}
	async function addOk(group: GroupJoined, who: GroupJoined, body = burger) {
		const response = await add(group, who, body)
		expect(response.status, JSON.stringify(await response.clone().json())).toBe(
			201,
		)
		return json<GroupView>(response)
	}
	async function checkout(
		group: GroupJoined,
		view: GroupView,
		overrides: Record<string, unknown> = {},
		token: string | null = group.personToken,
		jwt?: string,
	) {
		const headers: Record<string, string> = {
			'content-type': 'application/json',
			origin: 'https://test-org.example.com',
			authorization: `Bearer ${jwt ?? (await customerJwt())}`,
		}
		if (token) headers[GROUP_TOKEN_HEADER] = token
		return app.request('/orders', {
			method: 'POST',
			headers,
			body: JSON.stringify(
				orderBody({
					groupId: group.groupId,
					groupVersion: view.version,
					lines: view.lines.map((l) => ({ ...l.line, options: [] })),
					...overrides,
				}),
			),
		})
	}
	async function errorOf(response: Response) {
		return (await response.json()) as {
			error: string
			details?: Record<string, unknown>
		}
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'group-orders-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
		vi.stubEnv(
			'TENANT_OPERATOR_TOKEN',
			'test-operator-token-very-long-and-secure-12345',
		)
		vi.stubEnv('JWT_SECRET', jwtSecret)
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		clearGroupContextCacheForTest()
		context = menuContext()
		const menus = (
			context.menu as {
				menus: Array<{ categories: Array<{ items: unknown[] }> }>
			}
		).menus
		menus[0]!.categories[0]!.items.push({
			id: 'item-fries',
			displayName: 'Fries',
			price: 4,
			availabilityStatus: 'available',
		})
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context'))
					return Response.json(context)
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
		await insertCustomer(orgId, { id: HOST, name: 'Hana Host Khalid' })
		await insertCustomer(orgId, { id: 'cust_other', name: 'Olive Other' })
		app = new Hono()
		app.route('/orders/group', groupOrderRoutes)
		app.route('/orders', publicOrderRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	describe('starting a group', () => {
		it('needs a signed-in host, the flag, a real location and a deadline 15 minutes to 7 days ahead', async () => {
			const anonymous = await call('', {
				method: 'POST',
				body: { locationId: 'loc-1' },
			})
			expect(anonymous.status).toBe(401)
			const group = await start({
				deadlineAt: new Date(Date.now() + 60 * 60_000).toISOString(),
				perPersonLimitMinor: 2500,
				totalLimitMinor: 20_000,
			})
			expect(group.view).toMatchObject({
				status: 'open',
				hostFirstName: 'Hana',
				perPersonLimitMinor: 2500,
				totalLimitMinor: 20_000,
				canAdd: true,
				you: { isHost: true },
			})
			expect(group.shareToken).toBe(
				deriveGroupShareToken(orgId, group.groupId, 1),
			)
			// The host's token is stored only as a hash.
			const rows = await (await db()).select().from(groupCartPeople)
			expect(JSON.stringify(rows)).not.toContain(group.personToken)

			for (const [offset, code] of [
				[5 * 60_000, 'group_deadline_too_soon'],
				[8 * 24 * 60 * 60_000, 'group_deadline_too_far'],
			] as const) {
				const response = await call('', {
					method: 'POST',
					body: {
						locationId: 'loc-1',
						deadlineAt: new Date(Date.now() + offset).toISOString(),
					},
					jwt: await customerJwt(),
				})
				expect(response.status).toBe(422)
				expect((await errorOf(response)).error).toBe(code)
			}
			expect(
				(
					await call('', {
						method: 'POST',
						body: { locationId: 'nowhere' },
						jwt: await customerJwt(),
					})
				).status,
			).toBe(404)
			context = menuContext({ group: false })
			clearGroupContextCacheForTest()
			const off = await call('', {
				method: 'POST',
				body: { locationId: 'loc-1' },
				jwt: await customerJwt(),
			})
			expect(off.status).toBe(403)
			expect((await errorOf(off)).error).toBe('group_disabled')
		})

		it('limits the groups a host has open', async () => {
			for (let i = 0; i < GROUP_MAX_OPEN_PER_HOST; i += 1) await start()
			const response = await call('', {
				method: 'POST',
				body: { locationId: 'loc-1' },
				jwt: await customerJwt(),
			})
			expect(response.status).toBe(429)
			expect((await errorOf(response)).error).toBe('group_host_limit')
			// Another host is not affected.
			await expect(start({}, 'cust_other')).resolves.toBeDefined()
		})
	})

	describe('three people, one checkout', () => {
		it('lets friends join by first name, add dishes, and the host check out once with the kitchen reading it by person', async () => {
			const host = await start()
			const sam = await join(host, '  Sam  ')
			const lee = await join(host, 'Lee')
			await addOk(host, lee, fries)
			await addOk(host, host, burger)
			await addOk(host, sam, burger)
			const afterAll = await addOk(host, sam, fries)

			// What a poll shows the host: everyone, and every dish.
			const polled = await json<GroupView>(
				await call(`/${host.groupId}`, { token: host.personToken }),
			)
			expect(polled.people.map((p) => p.firstName)).toEqual([
				'Hana',
				'Sam',
				'Lee',
			])
			expect(polled.people.find((p) => p.firstName === 'Sam')).toMatchObject({
				lineCount: 2,
				subtotalMinor: 1800,
				isHost: false,
				isYou: false,
			})
			expect(polled.lines).toHaveLength(4)
			expect(polled.totalMinor).toBe(3600)

			// The link alone shows who is in, not what they chose.
			const preview = await json<GroupView>(
				await call(`/${host.groupId}`, { token: host.shareToken }),
			)
			expect(preview.people).toHaveLength(3)
			expect(preview.lines).toEqual([])
			expect(preview.you).toBeNull()
			expect(preview.canAdd).toBe(false)

			const placed = await checkout(host, afterAll)
			expect(placed.status, JSON.stringify(await placed.clone().json())).toBe(
				201,
			)
			const body = await json<{ order: { id: string } }>(placed)
			const [row] = await (
				await db()
			)
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, body.order.id))
			expect(row!.groupId).toBe(host.groupId)
			// The dishes of each person together, the host first, and "For Sam" on each.
			const lines = row!.lines as Array<{ itemId: string; forName?: string }>
			expect(lines.map((l) => l.forName)).toEqual(['Hana', 'Sam', 'Sam', 'Lee'])
			expect(row!.subtotalCents).toBe(10_00 + 10_00 + 8_00 + 8_00)

			// The Kitchen shows each ticket line by person.
			const feed = await kitchenFeed(await db(), orgId, 'loc-1')
			const ticket = feed.tickets.find((t) => t.lines.some((l) => l.forName))
			expect(ticket).toBeDefined()
			expect(ticket!.lines.map((l) => l.forName)).toEqual([
				'Hana',
				'Sam',
				'Sam',
				'Lee',
			])

			// The receipt groups them too (the order link keeps the names out).
			const receipt = receiptOrder(row!)
			expect(receipt.lines.map((l) => l.forName)).toEqual([
				'Hana',
				'Sam',
				'Sam',
				'Lee',
			])
			expect(linkReceiptOrder(row!).lines.every((l) => !('forName' in l))).toBe(
				true,
			)
			const email = renderOrderEmail({
				kind: 'receipt',
				locale: 'en',
				theme: null,
				restaurantName: 'Acme',
				order: row as never,
				timeZone: 'UTC',
				linkUrl: null,
			})
			expect(email.text.indexOf('For Sam')).toBeGreaterThan(
				email.text.indexOf('For Hana'),
			)
			expect(email.text.indexOf('For Lee')).toBeGreaterThan(
				email.text.indexOf('For Sam'),
			)
			expect(email.html).toContain('For Sam')

			// Once: another checkout is refused, the same one is answered again.
			const again = await checkout(host, afterAll, {
				idempotencyKey: crypto.randomUUID(),
			})
			expect(again.status).toBe(409)
			expect((await errorOf(again)).error).toBe('group_already_ordered')
			expect(await (await db()).select().from(restaurantOrders)).toHaveLength(1)

			// The link now shows the order, and nobody can add.
			const after = await json<GroupView>(
				await call(`/${host.groupId}`, { token: sam.personToken }),
			)
			expect(after.status).toBe('ordered')
			expect(after.order).toMatchObject({ id: body.order.id })
			expect(after.canAdd).toBe(false)
			const late = await add(host, sam)
			expect(late.status).toBe(409)
			expect((await errorOf(late)).error).toBe('group_already_ordered')
		})

		it('answers a retried checkout with the order it placed', async () => {
			const host = await start()
			const view = await addOk(host, host)
			const key = crypto.randomUUID()
			const first = await checkout(host, view, { idempotencyKey: key })
			expect(first.status).toBe(201)
			const retry = await checkout(host, view, { idempotencyKey: key })
			expect(retry.status).toBe(200)
			expect((await json<{ order: { id: string } }>(retry)).order.id).toBe(
				(await json<{ order: { id: string } }>(first)).order.id,
			)
			expect(await (await db()).select().from(restaurantOrders)).toHaveLength(1)
		})
	})

	describe('who may change what', () => {
		it('lets a person change only their own dishes; the host may remove anyone’s', async () => {
			const host = await start()
			const sam = await join(host, 'Sam')
			const lee = await join(host, 'Lee')
			const samView = await addOk(host, sam)
			const samLine = samView.lines[0]!
			// Lee cannot remove Sam's dish, and it is still there.
			const refused = await call(`/${host.groupId}/lines/${samLine.id}`, {
				method: 'DELETE',
				token: lee.personToken,
			})
			expect(refused.status).toBe(403)
			expect((await errorOf(refused)).error).toBe('forbidden')
			expect(await (await db()).select().from(groupCartLines)).toHaveLength(1)
			// Lee's view marks only their own as removable.
			const leeView = await json<GroupView>(
				await call(`/${host.groupId}`, { token: lee.personToken }),
			)
			expect(leeView.lines[0]!.canRemove).toBe(false)
			// Sam can; the host can remove another's.
			const own = await call(`/${host.groupId}/lines/${samLine.id}`, {
				method: 'DELETE',
				token: sam.personToken,
			})
			expect(own.status).toBe(200)
			const again = await addOk(host, sam)
			const byHost = await call(
				`/${host.groupId}/lines/${again.lines[0]!.id}`,
				{
					method: 'DELETE',
					token: host.personToken,
				},
			)
			expect(byHost.status).toBe(200)
			expect(await (await db()).select().from(groupCartLines)).toHaveLength(0)
		})

		it('refuses a token of another group, a forged one, the link on a write, and a person on join', async () => {
			const mine = await start()
			const other = await start({}, 'cust_other')
			const sam = await join(mine, 'Sam')
			const tokens = [
				other.personToken,
				other.shareToken!,
				`gp1.${'0'.repeat(64)}`,
				'not-a-token',
			]
			for (const token of tokens) {
				const read = await call(`/${mine.groupId}`, { token })
				expect(read.status).toBe(404)
				expect((await errorOf(read)).error).toBe('group_not_found')
				const write = await call(`/${mine.groupId}/lines`, {
					method: 'POST',
					body: burger,
					token,
				})
				expect(write.status).toBe(404)
			}
			// The link only reads and joins.
			const withLink = await call(`/${mine.groupId}/lines`, {
				method: 'POST',
				body: burger,
				token: mine.shareToken,
			})
			expect(withLink.status).toBe(404)
			// A person already in cannot "join" with their own token.
			const joinAgain = await call(`/${mine.groupId}/join`, {
				method: 'POST',
				body: { firstName: 'Sam' },
				token: sam.personToken,
			})
			expect(joinAgain.status).toBe(404)
			// No token at all.
			expect((await call(`/${mine.groupId}`)).status).toBe(404)
			// A missing group reads exactly the same.
			const missing = await call('/no-such-group', { token: sam.personToken })
			expect(missing.status).toBe(404)
			expect(await errorOf(missing)).toEqual(
				await errorOf(
					await call(`/${mine.groupId}`, { token: other.personToken }),
				),
			)
			// Burning the link: a bumped share version kills the old token.
			await (
				await db()
			)
				.update(groupCarts)
				.set({ shareTokenVersion: 2 })
				.where(eq(groupCarts.id, mine.groupId))
			const burned = await call(`/${mine.groupId}/join`, {
				method: 'POST',
				body: { firstName: 'Late' },
				token: mine.shareToken,
			})
			expect(burned.status).toBe(404)
		})

		it('refuses a share token made for another organization', async () => {
			const host = await start()
			const foreign = deriveGroupShareToken(
				'org_somewhere_else',
				host.groupId,
				1,
			)
			const read = await call(`/${host.groupId}`, { token: foreign })
			expect(read.status).toBe(404)
			const joined = await call(`/${host.groupId}/join`, {
				method: 'POST',
				body: { firstName: 'Eve' },
				token: foreign,
			})
			expect(joined.status).toBe(404)
			expect(await (await db()).select().from(groupCartPeople)).toHaveLength(1)
		})

		it('the host burns the share link: the old link stops working, the new one joins, people keep their own tokens', async () => {
			const host = await start()
			const sam = await join(host, 'Sam')
			const sam2 = await call(`/${host.groupId}/share/rotate`, {
				method: 'POST',
				body: {},
				token: sam.personToken,
			})
			expect(sam2.status).toBe(403)
			const rotated = await call(`/${host.groupId}/share/rotate`, {
				method: 'POST',
				body: {},
				token: host.personToken,
			})
			expect(rotated.status).toBe(200)
			const { shareToken } = await json<{ shareToken: string }>(rotated)
			expect(shareToken).not.toBe(host.shareToken)
			const oldLink = await call(`/${host.groupId}`, { token: host.shareToken })
			expect(oldLink.status).toBe(404)
			const newLink = await call(`/${host.groupId}`, { token: shareToken })
			expect(newLink.status).toBe(200)
			const stillSam = await call(`/${host.groupId}`, {
				token: sam.personToken,
			})
			expect(stillSam.status).toBe(200)
		})

		it('a made-up group or a wrong token writes no per-group counter row', async () => {
			const host = await start()
			const before = await (await db()).select().from(loyaltyRateCounters)
			for (const token of [
				null,
				'x'.repeat(40),
				host.shareToken.slice(0, -1),
			]) {
				const read = await call(`/${crypto.randomUUID()}`, { token })
				expect(read.status).toBe(404)
				const wrong = await call(`/${host.groupId}`, { token })
				expect(wrong.status).toBe(404)
			}
			const after = await (await db()).select().from(loyaltyRateCounters)
			const groupRows = after.filter((row) => row.bucket.endsWith('.group'))
			expect(groupRows).toHaveLength(
				before.filter((row) => row.bucket.endsWith('.group')).length,
			)
		})

		it('only the host changes the group, locks it and places the order', async () => {
			const host = await start()
			const sam = await join(host, 'Sam')
			const view = await addOk(host, sam)
			const patch = await call(`/${host.groupId}`, {
				method: 'PATCH',
				body: { locked: true },
				token: sam.personToken,
			})
			expect(patch.status).toBe(403)
			const ask = await call(`/${host.groupId}`, {
				method: 'DELETE',
				token: sam.personToken,
			})
			expect(ask.status).toBe(403)
			// Sam cannot check out, with his own token or with the host's customer.
			const asSam = await checkout(host, view, {}, sam.personToken)
			expect(asSam.status).toBe(403)
			const asOther = await checkout(
				host,
				view,
				{},
				host.personToken,
				await customerJwt('cust_other'),
			)
			expect(asOther.status).toBe(403)
			const noToken = await checkout(host, view, {}, null)
			expect(noToken.status).toBe(404)
			expect(await (await db()).select().from(restaurantOrders)).toHaveLength(0)
		})
	})

	describe('lock, deadline and limits', () => {
		it('refuses adding after the host locks, and again once unlocked it works', async () => {
			const host = await start()
			const sam = await join(host, 'Sam')
			const locked = await call(`/${host.groupId}`, {
				method: 'PATCH',
				body: { locked: true },
				token: host.personToken,
			})
			expect(locked.status).toBe(200)
			const refused = await add(host, sam)
			expect(refused.status).toBe(409)
			expect((await errorOf(refused)).error).toBe('group_locked')
			// Nobody joins a locked group either.
			const joinLate = await call(`/${host.groupId}/join`, {
				method: 'POST',
				body: { firstName: 'Late' },
				token: host.shareToken,
			})
			expect(joinLate.status).toBe(409)
			// The host may still add (their own dishes are the host's call) after unlocking.
			await call(`/${host.groupId}`, {
				method: 'PATCH',
				body: { locked: false },
				token: host.personToken,
			})
			expect((await add(host, sam)).status).toBe(201)
		})

		it('refuses adding after the deadline, but the host can still remove and check out', async () => {
			const host = await start({
				deadlineAt: new Date(Date.now() + 30 * 60_000).toISOString(),
			})
			const sam = await join(host, 'Sam')
			const view = await addOk(host, sam)
			await (
				await db()
			)
				.update(groupCarts)
				.set({ deadlineAt: Date.now() - 1000 })
				.where(eq(groupCarts.id, host.groupId))
			const refused = await add(host, sam)
			expect(refused.status).toBe(409)
			expect((await errorOf(refused)).error).toBe('group_deadline_passed')
			const fresh = await json<GroupView>(
				await call(`/${host.groupId}`, { token: sam.personToken }),
			)
			expect(fresh.canAdd).toBe(false)
			expect(fresh.lines[0]!.canRemove).toBe(false)
			// Sam's own dish is now fixed too.
			const remove = await call(`/${host.groupId}/lines/${view.lines[0]!.id}`, {
				method: 'DELETE',
				token: sam.personToken,
			})
			expect(remove.status).toBe(409)
			const placed = await checkout(host, fresh)
			expect(placed.status).toBe(201)
		})

		it('refuses a dish over the per-person or the total limit with group_limit_reached', async () => {
			const host = await start({
				perPersonLimitMinor: 1500,
				totalLimitMinor: 2200,
			})
			const sam = await join(host, 'Sam')
			const lee = await join(host, 'Lee')
			await addOk(host, sam, burger)
			const overPerson = await add(host, sam, fries)
			expect(overPerson.status).toBe(409)
			expect((await errorOf(overPerson)).error).toBe('group_limit_reached')
			await addOk(host, lee, burger)
			// 10 + 10 = 20 of 22: another 8 is over the group's total.
			const overTotal = await add(host, lee, {
				line: { itemId: 'item-fries', quantity: 1, options: [] },
			})
			expect(overTotal.status).toBe(409)
			expect((await errorOf(overTotal)).error).toBe('group_limit_reached')
			expect(await (await db()).select().from(groupCartLines)).toHaveLength(2)
		})

		it('caps the people and the dishes, and refuses a dish the menu does not have', async () => {
			const host = await start()
			for (let i = 1; i < GROUP_MAX_PEOPLE; i += 1) await join(host, `P${i}`)
			const full = await call(`/${host.groupId}/join`, {
				method: 'POST',
				body: { firstName: 'Extra' },
				token: host.shareToken,
			})
			expect(full.status).toBe(409)
			expect((await errorOf(full)).error).toBe('group_full')
			const unknown = await add(host, host, {
				line: { itemId: 'nothing', quantity: 1, options: [] },
			})
			expect(unknown.status).toBeGreaterThanOrEqual(400)
			expect(unknown.status).toBeLessThan(500)
			expect(await (await db()).select().from(groupCartLines)).toHaveLength(0)
			const long = await call(`/${host.groupId}/join`, {
				method: 'POST',
				body: { firstName: 'x'.repeat(GROUP_FIRST_NAME_MAX + 1) },
				token: host.shareToken,
			})
			expect(long.status).toBe(400)
		})
	})

	describe('checkout', () => {
		it('refuses a group the host did not see (group_changed), an empty one, and one for another location', async () => {
			const host = await start()
			const sam = await join(host, 'Sam')
			const empty = await json<GroupView>(
				await call(`/${host.groupId}`, { token: host.personToken }),
			)
			const none = await checkout(host, empty, {
				lines: [{ itemId: 'item-burger', quantity: 1, options: [] }],
			})
			expect(none.status).toBe(409)
			const seen = await addOk(host, sam)
			await addOk(host, sam, fries)
			const stale = await checkout(host, seen)
			expect(stale.status).toBe(409)
			const staleBody = await errorOf(stale)
			expect(staleBody.error).toBe('group_changed')
			expect(staleBody.details).toMatchObject({ version: expect.any(Number) })
			const elsewhere = await json<GroupView>(
				await call(`/${host.groupId}`, { token: host.personToken }),
			)
			const wrongPlace = await checkout(host, elsewhere, {
				locationId: 'loc-2',
			})
			expect(wrongPlace.status).toBe(422)
			expect(await (await db()).select().from(restaurantOrders)).toHaveLength(0)
		})

		it('lists dishes that left the menu and places the order once they are removed', async () => {
			const host = await start()
			const sam = await join(host, 'Sam')
			await addOk(host, host, burger)
			const view = await addOk(host, sam, fries)
			const items = (
				context.menu as {
					menus: Array<{
						categories: Array<{
							items: Array<{ id: string; availabilityStatus: string }>
						}>
					}>
				}
			).menus[0]!.categories[0]!.items
			items.find((i) => i.id === 'item-fries')!.availabilityStatus =
				'unavailable'
			clearGroupContextCacheForTest()
			const listed = await json<GroupView>(
				await call(`/${host.groupId}`, { token: host.personToken }),
			)
			expect(listed.lines.map((l) => l.available)).toEqual([true, false])
			const refused = await checkout(host, view)
			expect(refused.status).toBe(409)
			const body = await errorOf(refused)
			expect(body.error).toBe('group_items_unavailable')
			expect(body.details).toEqual({ lineIds: [listed.lines[1]!.id] })
			// Nothing was placed and the group is still open.
			expect(await (await db()).select().from(restaurantOrders)).toHaveLength(0)
			const removed = await json<GroupView>(
				await call(`/${host.groupId}/lines/${listed.lines[1]!.id}`, {
					method: 'DELETE',
					token: host.personToken,
				}),
			)
			const placed = await checkout(host, removed)
			expect(placed.status, JSON.stringify(await placed.clone().json())).toBe(
				201,
			)
		})

		it('a group order never mixes with a table round or a test', async () => {
			const host = await start()
			const view = await addOk(host, host)
			const headers = {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
				authorization: `Bearer ${await customerJwt()}`,
				[GROUP_TOKEN_HEADER]: host.personToken,
				'x-test-order': 'tc1.loc-1.nonce.1.mac',
			}
			const response = await app.request('/orders', {
				method: 'POST',
				headers,
				body: JSON.stringify(
					orderBody({ groupId: host.groupId, groupVersion: view.version }),
				),
			})
			expect(response.status).toBe(422)
			expect((await errorOf(response)).error).toBe('group_unsupported')
		})
	})

	describe('leaving, ending and clearing', () => {
		it('lets a friend leave with their dishes, never the host, and the host end the group for good', async () => {
			const host = await start()
			const sam = await join(host, 'Sam')
			await addOk(host, sam)
			const hostLeaves = await call(`/${host.groupId}/people/me`, {
				method: 'DELETE',
				token: host.personToken,
			})
			expect(hostLeaves.status).toBe(409)
			expect((await errorOf(hostLeaves)).error).toBe('host_cannot_leave')
			const left = await call(`/${host.groupId}/people/me`, {
				method: 'DELETE',
				token: sam.personToken,
			})
			expect(left.status).toBe(200)
			expect(await (await db()).select().from(groupCartLines)).toHaveLength(0)
			// Sam's token is dead.
			expect(
				(await call(`/${host.groupId}`, { token: sam.personToken })).status,
			).toBe(404)
			const ended = await call(`/${host.groupId}`, {
				method: 'DELETE',
				token: host.personToken,
			})
			expect(ended.status).toBe(200)
			expect(await (await db()).select().from(groupCarts)).toHaveLength(0)
			expect(await (await db()).select().from(groupCartPeople)).toHaveLength(0)
			expect(
				(await call(`/${host.groupId}`, { token: host.personToken })).status,
			).toBe(404)
		})

		it('cannot end a group that was ordered', async () => {
			const host = await start()
			const view = await addOk(host, host)
			expect((await checkout(host, view)).status).toBe(201)
			const ended = await call(`/${host.groupId}`, {
				method: 'DELETE',
				token: host.personToken,
			})
			expect(ended.status).toBe(409)
			expect((await errorOf(ended)).error).toBe('group_already_ordered')
		})

		it('deletes a group with no activity for seven days, and keeps a recent one', async () => {
			const old = await start()
			const recent = await start({}, 'cust_other')
			await addOk(old, old)
			await (
				await db()
			)
				.update(groupCarts)
				.set({ updatedAt: Date.now() - GROUP_INACTIVE_PURGE_MS - 1000 })
				.where(eq(groupCarts.id, old.groupId))
			const tick = await runGroupOrdersTick(orgId, await db())
			expect(tick.purged).toBe(1)
			expect(tick.nextDueAt).toBeGreaterThan(Date.now())
			const rows = await (await db()).select().from(groupCarts)
			expect(rows.map((r) => r.id)).toEqual([recent.groupId])
			expect(await (await db()).select().from(groupCartLines)).toHaveLength(0)
		})

		it('erasing the host deletes the group and the names of friends on the order', async () => {
			const host = await start()
			const sam = await join(host, 'Sam')
			await addOk(host, host)
			const view = await addOk(host, sam)
			const open = await start()
			await addOk(open, open)
			expect((await checkout(host, view)).status).toBe(201)
			await erasePerson(
				await db(),
				{ customerId: HOST },
				{ actorId: 'op_erase' },
			)
			expect(await (await db()).select().from(groupCarts)).toHaveLength(0)
			expect(await (await db()).select().from(groupCartPeople)).toHaveLength(0)
			expect(await (await db()).select().from(groupCartLines)).toHaveLength(0)
			const [order] = await (await db()).select().from(restaurantOrders)
			const lines = order!.lines as Array<Record<string, unknown>>
			expect(lines).toHaveLength(2)
			expect(lines.every((line) => !('forName' in line))).toBe(true)
			expect(JSON.stringify(order)).not.toContain('Sam')
		})
	})

	it('the pure rules agree with the service', () => {
		expect(groupAcceptsEdits({ status: 'open', deadlineAt: null }, 1)).toBe(
			'open',
		)
		expect(groupAcceptsEdits({ status: 'locked', deadlineAt: null }, 1)).toBe(
			'group_locked',
		)
		expect(groupAcceptsEdits({ status: 'open', deadlineAt: 5 }, 5)).toBe(
			'group_deadline_passed',
		)
		expect(
			groupLimitBreak({
				personSubtotalMinor: 0,
				groupSubtotalMinor: 0,
				amountMinor: 10,
				perPersonLimitMinor: 9,
				totalLimitMinor: null,
			}),
		).toBe('group_limit_reached')
	})
})

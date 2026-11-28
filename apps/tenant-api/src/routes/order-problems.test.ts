import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	ORDER_PROBLEM_MAX_GUEST_ENTRIES,
	ORDER_PROBLEM_MAX_PER_ORDER,
	ORDER_PROBLEM_UNANSWERED_MS,
	ORDER_PROBLEM_WINDOW_MS,
	affectedItemsCents,
} from '@repo/common/order-problems'
import {
	destroyTenantDb,
	discountRedemptions,
	discountIssuedCodes,
	getTenantDb,
	orderProblemReplies,
	orderProblems,
	provisionTenantDb,
	restaurantOrderRefunds,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type ReportDefinition } from '@repo/reports'
import { loadOrderProblemRecords } from '../services/sales-report-records.ts'
import { makeDiscount } from '../../../../packages/discounts/src/test-fixtures.ts'
import { TEST_ORDER_HEADER } from '@repo/common/test-orders'
import { deriveReceiptToken } from '../services/order-service.ts'
import { renderOrderEmail } from '../lib/order-messages-email.ts'
import { setTenantEmailDevCapture } from '../lib/tenant-email.ts'
import { deriveOrderLinkToken } from '../lib/order-link.ts'
import { applyProviderRefundStatus } from '../services/order-provider-refund-service.ts'
import { setProblemNotifyDepsForTest } from '../lib/order-problem-notify.ts'
import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import {
	clearProblemFlagCacheForTest,
	openProblemsOlderThan,
	runOrderProblemsTickForOrg,
	submitGuestProblem,
} from '../services/order-problems-service.ts'
import { mintTestOrderCodeForOrg } from '../services/test-orders-service.ts'
import {
	operatorOrderRoutes,
	setOperatorProblemStorageForTest,
} from './operator-orders.ts'
import { publicOrderRoutes, setOrderProblemRouteDepsForTest } from './orders.ts'

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

const orgId = 'org_order_problems_1'
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
	guestOrdering: Record<string, boolean> | null = { problemReports: true },
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

function makeJpegWithExif(): Uint8Array {
	const exifBody = new TextEncoder().encode(
		'Exif\x00\x00II*\x00GPS_LAT_37_7749',
	)
	const app1 = new Uint8Array(4 + exifBody.length)
	app1.set(
		[
			0xff,
			0xe1,
			((exifBody.length + 2) >> 8) & 0xff,
			(exifBody.length + 2) & 0xff,
		],
		0,
	)
	app1.set(exifBody, 4)
	const sof0 = new Uint8Array([
		0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x0c, 0x00, 0x10, 0x01, 0x01, 0x11,
		0x00,
	])
	const sos = new Uint8Array([
		0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xaa, 0xbb,
	])
	const out = new Uint8Array(2 + app1.length + sof0.length + sos.length + 2)
	let o = 0
	out.set([0xff, 0xd8], o)
	o += 2
	out.set(app1, o)
	o += app1.length
	out.set(sof0, o)
	o += sof0.length
	out.set(sos, o)
	o += sos.length
	out.set([0xff, 0xd9], o)
	return out
}

const operatorToken = 'test-operator-token-very-long-and-secure-12345'

type Stored = Map<string, { bytes: Uint8Array; contentType: string }>

function fakeStorage(bucket: Stored) {
	return {
		putObject: vi.fn(
			async (key: string, body: Uint8Array, contentType: string) => {
				bucket.set(key, { bytes: body, contentType })
				return 'uploaded' as const
			},
		),
		headObject: vi.fn(async () => ({ status: 'missing' as const })),
		deleteObject: vi.fn(async (key: string) => {
			bucket.delete(key)
			return 'deleted' as const
		}),
		presignRead: vi.fn((key: string) => ({
			url: `https://bucket.test/${key}?signed=1`,
			expiresAt: Date.now() + 300_000,
		})),
	}
}

describe('guest order problem reports (#191)', () => {
	let directory: string
	let app: Hono
	let context: Record<string, unknown>
	let bucket: Stored
	let alerts: Array<Record<string, unknown>>
	let storage: ReturnType<typeof fakeStorage>
	const sentEmails: Array<{ to: string; subject: string; text: string }> = []
	/** The problem alerts among everything posted to the App (a placed order posts its own). */
	const problemAlerts = () =>
		alerts.filter((event) => event.kind === 'order_problem')

	async function db() {
		return getTenantDb(orgId)
	}
	async function operatorJwt({
		scope = 'orders:write',
		locationIds,
		refundProvider = false,
	}: {
		scope?: 'orders:read' | 'orders:write'
		locationIds?: string[] | null
		refundProvider?: boolean
	} = {}) {
		return new SignJWT({
			orgId,
			role: 'operator',
			scope,
			...(locationIds === undefined ? {} : { locationIds }),
			...(refundProvider ? { refundProvider: true } : {}),
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setSubject('operator-1')
			.setExpirationTime('1h')
			.sign(new TextEncoder().encode(operatorToken))
	}
	async function operator(
		pathname: string,
		options: { method?: string; body?: unknown; jwt?: string } = {},
	) {
		return app.request(`/operator/orders${pathname}`, {
			method: options.method ?? 'GET',
			headers: {
				authorization: `Bearer ${options.jwt ?? (await operatorJwt())}`,
				'content-type': 'application/json',
			},
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
		})
	}
	async function place(overrides: Record<string, unknown> = {}) {
		const response = await app.request('/orders', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
			},
			body: JSON.stringify(orderBody(overrides)),
		})
		expect(response.status).toBe(201)
		const body = (await response.json()) as {
			order: { id: string; number: string }
			receiptToken: string
		}
		return {
			id: body.order.id,
			number: body.order.number,
			receiptToken: body.receiptToken,
		}
	}
	async function complete(
		orderId: string,
		values: Partial<typeof restaurantOrders.$inferInsert> = {},
	) {
		await (
			await db()
		)
			.update(restaurantOrders)
			.set({ status: 'completed', completedAt: new Date(), ...values })
			.where(eq(restaurantOrders.id, orderId))
	}
	function guest(
		orderId: string,
		suffix: string,
		credentials: { receiptToken?: string; link?: string },
		init: {
			method?: string
			body?: unknown
			key?: string
			raw?: Uint8Array
			contentType?: string
		} = {},
	) {
		const headers: Record<string, string> = {
			origin: 'https://test-org.example.com',
		}
		if (credentials.receiptToken) {
			headers.authorization = `Bearer ${credentials.receiptToken}`
		}
		if (credentials.link) headers['x-order-link'] = credentials.link
		if (init.key) headers['idempotency-key'] = init.key
		const method = init.method ?? 'GET'
		let body: BodyInit | undefined
		if (init.raw) {
			headers['content-type'] = init.contentType ?? 'image/jpeg'
			body = init.raw
		} else if (init.body !== undefined) {
			headers['content-type'] = 'application/json'
			body = JSON.stringify({ slug: 'test-org', ...(init.body as object) })
		}
		const separator = suffix.includes('?') ? '&' : '?'
		const url =
			method === 'GET' || init.raw
				? `/orders/${orderId}${suffix}${separator}slug=test-org`
				: `/orders/${orderId}${suffix}`
		return app.request(url, { method, headers, body })
	}
	const key = () => crypto.randomUUID()

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'order-problems-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv(
			'INTERNAL_COMMAND_TOKEN',
			'test-internal-token-very-long-and-secure-12345',
		)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('JWT_SECRET', jwtSecret)
		vi.stubEnv('AUTH_HMAC_SECRET', 'test-hmac-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		clearProblemFlagCacheForTest()
		setTenantEmailDevCapture(async (record) => {
			sentEmails.push({
				to: record.to,
				subject: record.subject,
				text: record.text,
			})
		})
		context = menuContext()
		bucket = new Map()
		storage = fakeStorage(bucket)
		alerts = []
		sentEmails.length = 0
		setOrderProblemRouteDepsForTest({ storage })
		setOperatorProblemStorageForTest(storage)
		setProblemNotifyDepsForTest({
			getContext: async () =>
				({
					organization: {
						name: 'Test Org',
						defaultLocale: 'en',
						siteOrigin: 'https://test-org.example.com',
						emailTheme: { organizationName: 'Test Org' },
					},
					locations: [],
				}) as never,
			sendSms: vi.fn(async () => undefined),
		})
		vi.stubGlobal(
			'fetch',
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = typeof input === 'string' ? input : input.toString()
				if (url.includes('/resources/order-context'))
					return Response.json(context)
				if (url.includes('/resources/orders/notify')) {
					alerts.push(JSON.parse(String(init?.body)))
					return Response.json({ inApp: 1, emailed: 0, pushed: 0, texted: 0 })
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
		app.route('/operator/orders', operatorOrderRoutes)
	})

	afterEach(async () => {
		setOrderProblemRouteDepsForTest(null)
		setOperatorProblemStorageForTest(null)
		setProblemNotifyDepsForTest(null)
		setTenantEmailDevCapture(null)
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	async function report(
		orderId: string,
		credentials: { receiptToken?: string; link?: string },
		body: Record<string, unknown> = {
			kind: 'missing_item',
			items: [{ lineIndex: 0, quantity: 1 }],
			note: 'The burger never came',
		},
		idempotency = key(),
	) {
		return guest(orderId, '/problems', credentials, {
			method: 'POST',
			body,
			key: idempotency,
		})
	}

	describe('reporting', () => {
		it('a guest reports a missing item from the order page and the operator sees it at once', async () => {
			const order = await place()
			await complete(order.id)
			const page = await guest(order.id, '/problems', {
				receiptToken: order.receiptToken,
			})
			expect(page.status).toBe(200)
			const view = (await page.json()) as {
				enabled: boolean
				reportable: { allowed: boolean }
				lines: Array<{ name: string }>
			}
			expect(view.enabled).toBe(true)
			expect(view.reportable.allowed).toBe(true)
			expect(view.lines).toEqual([
				expect.objectContaining({ lineIndex: 0, name: 'Burger', quantity: 2 }),
			])

			const sent = await report(order.id, { receiptToken: order.receiptToken })
			expect(sent.status).toBe(201)
			const created = (await sent.json()) as {
				problemId: string
				added: boolean
				canAttachPhoto: boolean
			}
			expect(created).toMatchObject({ added: false, canAttachPhoto: true })

			const inbox = await operator('/problems?status=open')
			expect(inbox.status).toBe(200)
			const list = (await inbox.json()) as {
				problems: Array<{
					id: string
					orderNumber: string
					kind: string
					note: string
					items: Array<{ name: string; quantity: number; amountCents: number }>
					affectedCents: number
				}>
				counts: { open: number }
			}
			expect(list.counts.open).toBe(1)
			expect(list.problems[0]).toMatchObject({
				id: created.problemId,
				orderNumber: order.number,
				kind: 'missing_item',
				note: 'The burger never came',
				affectedCents: 1000,
			})
			expect(list.problems[0]!.items[0]).toMatchObject({
				name: 'Burger',
				quantity: 1,
				amountCents: 1000,
			})
			// The managers were told with ids and one fixed word, no guest data.
			await vi.waitFor(() => expect(problemAlerts()).toHaveLength(1))
			expect(problemAlerts()[0]).toEqual({
				kind: 'order_problem',
				orgId,
				eventId: `problem:${created.problemId}`,
				locationId: 'loc-1',
				orderNumber: order.number,
				problemKind: 'missing_item',
				unanswered: false,
			})
			expect(JSON.stringify(problemAlerts())).not.toContain('burger')
			expect(JSON.stringify(problemAlerts())).not.toContain('Rana')
		})

		it('an open report takes at most ten additions', async () => {
			const order = await place()
			await complete(order.id)
			const [row] = await (
				await db()
			)
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, order.id))
			const send = () =>
				submitGuestProblem(orgId, row!, {
					request: {
						kind: 'missing_item',
						items: [{ lineIndex: 0, quantity: 1 }],
						note: 'again',
					},
					idempotencyKey: key(),
				})
			for (let index = 0; index < ORDER_PROBLEM_MAX_GUEST_ENTRIES; index++) {
				expect((await send()).ok).toBe(true)
			}
			const over = await send()
			expect(over.ok).toBe(false)
			if (!over.ok) expect(over.failure.status).toBe(429)
		})

		it('a repeated submission is the same entry, and a second one adds to the open report', async () => {
			const order = await place()
			const first = key()
			const a = await report(
				order.id,
				{ receiptToken: order.receiptToken },
				undefined,
				first,
			)
			const again = await report(
				order.id,
				{ receiptToken: order.receiptToken },
				undefined,
				first,
			)
			expect(again.status).toBe(200)
			expect(again.headers.get('Idempotent-Replayed')).toBe('true')
			const created = (await a.json()) as { problemId: string }
			expect(((await again.json()) as { problemId: string }).problemId).toBe(
				created.problemId,
			)
			const more = await report(
				order.id,
				{ receiptToken: order.receiptToken },
				{
					kind: 'quality',
					items: [{ lineIndex: 0 }],
					note: 'And the other one was cold',
				},
			)
			expect(more.status).toBe(201)
			const added = (await more.json()) as { problemId: string; added: boolean }
			expect(added).toMatchObject({ problemId: created.problemId, added: true })
			const rows = await (await db()).select().from(orderProblems)
			expect(rows).toHaveLength(1)
			expect(rows[0]!.itemRefs).toEqual([
				expect.objectContaining({ lineIndex: 0, quantity: 2 }),
			])
			const entries = await (await db()).select().from(orderProblemReplies)
			expect(entries.map((entry) => entry.kind).sort()).toEqual([
				'addition',
				'report',
			])
		})

		it('refuses another person’s order, a forged token and a missing one with the same 404', async () => {
			const mine = await place()
			const theirs = await place()
			const wrongToken = await report(mine.id, {
				receiptToken: theirs.receiptToken,
			})
			expect(wrongToken.status).toBe(404)
			const forged = await report(mine.id, { receiptToken: 'x'.repeat(40) })
			expect(forged.status).toBe(404)
			const wrongLink = await report(mine.id, {
				link: deriveOrderLinkToken(orgId, theirs.id),
			})
			expect(wrongLink.status).toBe(404)
			const none = await report(mine.id, {})
			expect(none.status).toBe(404)
			const unknown = await report('no-such-order', {
				receiptToken: mine.receiptToken,
			})
			expect(unknown.status).toBe(404)
			expect(await wrongToken.json()).toEqual(await unknown.json())
			expect(await (await db()).select().from(orderProblems)).toHaveLength(0)
			// Reading is just as closed.
			const read = await guest(mine.id, '/problems', {
				receiptToken: theirs.receiptToken,
			})
			expect(read.status).toBe(404)
		})

		it('the forwardable order link reads a redacted view and can neither report nor attach a photo', async () => {
			const order = await place()
			await complete(order.id)
			const created = (await (
				await report(order.id, { receiptToken: order.receiptToken })
			).json()) as { problemId: string }
			const link = deriveOrderLinkToken(orgId, order.id)
			const read = await guest(order.id, '/problems', { link })
			expect(read.status).toBe(200)
			const view = (await read.json()) as {
				reportable: { allowed: boolean; reason: string | null }
				problems: Array<{
					note: string | null
					entries: Array<{ body: string | null }>
				}>
			}
			expect(view.reportable).toMatchObject({
				allowed: false,
				reason: 'receipt_required',
			})
			expect(view.problems).toHaveLength(1)
			expect(view.problems[0]!.note).toBeNull()
			expect(
				view.problems[0]!.entries.every((entry) => entry.body === null),
			).toBe(true)
			const filed = await report(order.id, { link })
			expect(filed.status).toBe(403)
			const photo = await guest(
				order.id,
				`/problems/${created.problemId}/photo`,
				{ link },
				{ method: 'POST', raw: new Uint8Array([1, 2, 3]) },
			)
			expect(photo.status).toBe(403)
			expect(await (await db()).select().from(orderProblems)).toHaveLength(1)
		})

		it('refuses a capability made for another organization', async () => {
			const order = await place()
			const foreignReceipt = deriveReceiptToken('org_somewhere_else', order.id)
			expect(
				(await report(order.id, { receiptToken: foreignReceipt })).status,
			).toBe(404)
			expect(
				(
					await report(order.id, {
						link: deriveOrderLinkToken('org_somewhere_else', order.id),
					})
				).status,
			).toBe(404)
			expect(await (await db()).select().from(orderProblems)).toHaveLength(0)
		})

		it('is refused 48 hours after the order was completed, but not before', async () => {
			const order = await place()
			await complete(order.id, {
				completedAt: new Date(Date.now() - ORDER_PROBLEM_WINDOW_MS - 60_000),
			})
			const late = await report(order.id, { receiptToken: order.receiptToken })
			expect(late.status).toBe(409)
			expect(((await late.json()) as { error: string }).error).toBe(
				'problem_window_closed',
			)
			const fresh = await place()
			await complete(fresh.id, {
				completedAt: new Date(Date.now() - ORDER_PROBLEM_WINDOW_MS + 60_000),
			})
			expect(
				(await report(fresh.id, { receiptToken: fresh.receiptToken })).status,
			).toBe(201)
		})

		it('is off while the flag is off, and fails closed when the context is unreadable', async () => {
			const order = await place()
			context = menuContext({ problemReports: false })
			clearProblemFlagCacheForTest()
			const off = await report(order.id, { receiptToken: order.receiptToken })
			expect(off.status).toBe(403)
			expect(((await off.json()) as { error: string }).error).toBe(
				'problem_reports_disabled',
			)
			const read = (await (
				await guest(order.id, '/problems', { receiptToken: order.receiptToken })
			).json()) as { enabled: boolean; reportable: { reason: string } }
			expect(read).toMatchObject({ enabled: false })
			expect(read.reportable.reason).toBe('disabled')
			context = menuContext(null)
			clearProblemFlagCacheForTest()
			expect(
				(await report(order.id, { receiptToken: order.receiptToken })).status,
			).toBe(403)
		})

		it('does not take a test order, an item that is not on the order, or a sixth report', async () => {
			context = menuContext({ problemReports: true, testOrders: true })
			const { code } = await mintTestOrderCodeForOrg(orgId, await db(), {
				locationId: 'loc-1',
			})
			const placedTest = await app.request('/orders', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: 'https://test-org.example.com',
					[TEST_ORDER_HEADER]: code,
				},
				body: JSON.stringify(orderBody()),
			})
			expect(placedTest.status).toBe(201)
			const order = (await placedTest.json()) as {
				order: { id: string }
				receiptToken: string
			}
			expect(
				(await report(order.order.id, { receiptToken: order.receiptToken }))
					.status,
			).toBe(409)
			const real = await place()
			const badItem = await report(
				real.id,
				{ receiptToken: real.receiptToken },
				{
					kind: 'missing_item',
					items: [{ lineIndex: 7 }],
				},
			)
			expect(badItem.status).toBe(422)
			const tooMany = await report(
				real.id,
				{ receiptToken: real.receiptToken },
				{
					kind: 'missing_item',
					items: [{ lineIndex: 0, quantity: 3 }],
				},
			)
			expect(tooMany.status).toBe(422)
			const huge = await report(
				real.id,
				{ receiptToken: real.receiptToken },
				{
					kind: 'other',
					items: [],
					note: 'x'.repeat(1001),
				},
			)
			expect(huge.status).toBe(400)
			// The cap: answered reports count, so the sixth is refused.
			for (let i = 0; i < ORDER_PROBLEM_MAX_PER_ORDER; i += 1) {
				const sent = await report(
					real.id,
					{ receiptToken: real.receiptToken },
					{
						kind: 'other',
						items: [],
						note: `n${i}`,
					},
				)
				expect([201]).toContain(sent.status)
				const row = (await (await db()).select().from(orderProblems)).find(
					(p) => p.status === 'open',
				)!
				await (
					await db()
				)
					.update(orderProblems)
					.set({ status: 'closed', resolution: 'closed' })
					.where(eq(orderProblems.id, row.id))
			}
			const sixth = await report(
				real.id,
				{ receiptToken: real.receiptToken },
				{
					kind: 'other',
					items: [],
				},
			)
			expect(sixth.status).toBe(429)
		})
	})

	describe('the photo', () => {
		it('is checked by its bytes, stripped of location data and stored in the region', async () => {
			const order = await place()
			const created = (await (
				await report(order.id, { receiptToken: order.receiptToken })
			).json()) as { problemId: string }
			const sent = await guest(
				order.id,
				`/problems/${created.problemId}/photo`,
				{ receiptToken: order.receiptToken },
				{ method: 'POST', raw: makeJpegWithExif(), contentType: 'image/jpeg' },
			)
			expect(sent.status).toBe(201)
			expect(bucket.size).toBe(1)
			const [[objectKey, stored]] = [...bucket.entries()]
			expect(objectKey.startsWith(`order-problems/${orgId}/`)).toBe(true)
			expect(stored.contentType).toBe('image/jpeg')
			expect(new TextDecoder('latin1').decode(stored.bytes)).not.toContain(
				'GPS_LAT',
			)
			const detail = (await (
				await operator(`/problems/${created.problemId}`)
			).json()) as { problem: { photoUrl: string | null; hasPhoto: boolean } }
			expect(detail.problem.hasPhoto).toBe(true)
			expect(detail.problem.photoUrl).toContain(objectKey)
			// A second photo is refused.
			const second = await guest(
				order.id,
				`/problems/${created.problemId}/photo`,
				{ receiptToken: order.receiptToken },
				{ method: 'POST', raw: makeJpegWithExif() },
			)
			expect(second.status).toBe(409)
		})

		it('refuses a file that is not an image, whatever it claims to be, and one that is too big', async () => {
			const order = await place()
			const created = (await (
				await report(order.id, { receiptToken: order.receiptToken })
			).json()) as { problemId: string }
			const fake = await guest(
				order.id,
				`/problems/${created.problemId}/photo`,
				{ receiptToken: order.receiptToken },
				{
					method: 'POST',
					raw: new TextEncoder().encode('<script>alert(1)</script>'),
					contentType: 'image/png',
				},
			)
			expect(fake.status).toBe(400)
			expect(((await fake.json()) as { error: string }).error).toBe(
				'photo_invalid',
			)
			const big = await guest(
				order.id,
				`/problems/${created.problemId}/photo`,
				{ receiptToken: order.receiptToken },
				{ method: 'POST', raw: new Uint8Array(6 * 1024 * 1024) },
			)
			expect(big.status).toBe(413)
			expect(bucket.size).toBe(0)
		})

		it('cannot be attached to another order’s report', async () => {
			const mine = await place()
			const theirs = await place()
			const created = (await (
				await report(theirs.id, { receiptToken: theirs.receiptToken })
			).json()) as { problemId: string }
			const sent = await guest(
				mine.id,
				`/problems/${created.problemId}/photo`,
				{ receiptToken: mine.receiptToken },
				{ method: 'POST', raw: makeJpegWithExif() },
			)
			expect(sent.status).toBe(404)
			expect(bucket.size).toBe(0)
		})
	})

	describe('answering', () => {
		async function open(overrides: Record<string, unknown> = {}) {
			const order = await place(overrides)
			await complete(order.id)
			const created = (await (
				await report(order.id, { receiptToken: order.receiptToken })
			).json()) as { problemId: string }
			return { order, problemId: created.problemId }
		}
		function answer(
			problemId: string,
			body: unknown,
			jwt?: Promise<string> | string,
		) {
			// A credit is a cash-equivalent code: it needs the refund grant.
			const grant =
				jwt === undefined &&
				typeof body === 'object' &&
				body !== null &&
				(body as { action?: string }).action === 'credit'
					? operatorJwt({ refundProvider: true })
					: jwt
			return Promise.resolve(grant).then((token) =>
				operator(`/problems/${problemId}/answer`, {
					method: 'POST',
					body,
					jwt: token,
				}),
			)
		}

		it('refunds the affected items of an order paid at handoff, records it on the order and tells the guest', async () => {
			const { order, problemId } = await open()
			await (
				await db()
			)
				.update(restaurantOrders)
				.set({ paymentStatus: 'paid' })
				.where(eq(restaurantOrders.id, order.id))
			const response = await answer(problemId, {
				action: 'refund',
				message: 'So sorry about that',
			})
			expect(response.status).toBe(200)
			const body = (await response.json()) as {
				problem: { status: string; resolution: string; refundCents: number }
			}
			expect(body.problem).toMatchObject({
				status: 'answered',
				resolution: 'refund',
				refundCents: 1000,
			})
			// Recorded on the order through the normal refund path.
			const refunds = await (await db()).select().from(restaurantOrderRefunds)
			expect(refunds).toHaveLength(1)
			expect(refunds[0]).toMatchObject({
				orderId: order.id,
				amountCents: 1000,
				note: 'Order problem',
			})
			const [row] = await (
				await db()
			)
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, order.id))
			expect(row!.refundedCents).toBe(1000)
			// The guest sees it on the order page.
			const page = (await (
				await guest(order.id, '/problems', { receiptToken: order.receiptToken })
			).json()) as {
				problems: Array<{
					status: string
					refund: { amountCents: number } | null
					entries: Array<{ kind: string; author: string; body: string | null }>
				}>
			}
			expect(page.problems[0]).toMatchObject({
				status: 'answered',
				refund: { amountCents: 1000 },
			})
			expect(page.problems[0]!.entries.map((e) => e.kind)).toEqual([
				'report',
				'refund',
			])
			expect(page.problems[0]!.entries[1]).toMatchObject({
				author: 'operator',
				body: 'So sorry about that',
			})
			// A second answer is refused and refunds nothing more.
			const twice = await answer(problemId, { action: 'refund' })
			expect(twice.status).toBe(409)
			expect(
				await (await db()).select().from(restaurantOrderRefunds),
			).toHaveLength(1)
		})

		it('refunds an online order through the provider only for someone who may refund', async () => {
			const { order, problemId } = await open()
			await (
				await db()
			)
				.update(restaurantOrders)
				.set({
					paymentMethod: 'online',
					paymentStatus: 'paid',
					paymentProcessor: 'connect',
					paymentSessionId: 'cs_test_1',
					paidAt: new Date(),
				})
				.where(eq(restaurantOrders.id, order.id))
			const denied = await answer(problemId, { action: 'refund' })
			expect(denied.status).toBe(403)
			expect(((await denied.json()) as { error: string }).error).toBe(
				'refund_forbidden',
			)
			expect(
				await (await db()).select().from(restaurantOrderRefunds),
			).toHaveLength(0)
			const allowed = await answer(
				problemId,
				{ action: 'refund', amountCents: 700 },
				operatorJwt({ refundProvider: true }),
			)
			expect(allowed.status).toBe(200)
			const refunds = await (await db()).select().from(restaurantOrderRefunds)
			expect(refunds).toHaveLength(1)
			expect(refunds[0]).toMatchObject({
				amountCents: 700,
				kind: 'provider',
				status: 'pending',
			})
			// More than is left is refused by the normal limits.
			const over = await open()
			await (
				await db()
			)
				.update(restaurantOrders)
				.set({
					paymentMethod: 'online',
					paymentStatus: 'paid',
					paymentProcessor: 'connect',
					paymentSessionId: 'cs_test_2',
				})
				.where(eq(restaurantOrders.id, over.order.id))
			const tooMuch = await answer(
				over.problemId,
				{ action: 'refund', amountCents: 5000 },
				operatorJwt({ refundProvider: true }),
			)
			expect(tooMuch.status).toBe(422)
		})

		it('does not refund an order nothing was paid for', async () => {
			const { problemId } = await open()
			const response = await answer(problemId, { action: 'refund' })
			expect(response.status).toBe(409)
			expect(((await response.json()) as { error: string }).error).toBe(
				'refund_not_allowed',
			)
			const stillOpen = (await (await db()).select().from(orderProblems))[0]!
			expect(stillOpen.status).toBe('open')
		})

		it('gives a single-use credit that checkout accepts once, and tells the guest the code', async () => {
			context = {
				...menuContext(),
				discounts: {
					features: { automatic: true, coupons: true },
					discounts: [],
					codes: [],
				},
			}
			const { order, problemId } = await open()
			const response = await answer(problemId, {
				action: 'credit',
				amountCents: 500,
				validDays: 30,
			})
			expect(response.status).toBe(200)
			const body = (await response.json()) as {
				problem: {
					creditCents: number
					creditExpiresAt: number
					status: string
				}
			}
			expect(body.problem).toMatchObject({
				status: 'answered',
				creditCents: 500,
			})
			const page = (await (
				await guest(order.id, '/problems', { receiptToken: order.receiptToken })
			).json()) as {
				problems: Array<{
					credit: {
						code: string
						amountCents: number
						expiresAt: number
					} | null
				}>
			}
			const credit = page.problems[0]!.credit!
			expect(credit.amountCents).toBe(500)
			expect(credit.code).toMatch(/^CR-/)
			expect(credit.expiresAt).toBe(body.problem.creditExpiresAt)
			const [issued] = await (await db()).select().from(discountIssuedCodes)
			expect(issued).toMatchObject({
				sourceType: 'order_problem',
				sourceId: problemId,
			})

			// Checkout: the code takes 5.00 off the next order, once.
			const withCode = await app.request('/orders', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: 'https://test-org.example.com',
				},
				body: JSON.stringify(
					orderBody({
						discounts: { code: credit.code, expectedDiscountMinor: 500 },
						lines: [{ itemId: 'item-burger', quantity: 2, options: [] }],
					}),
				),
			})
			expect(
				withCode.status,
				JSON.stringify(await withCode.clone().json()),
			).toBe(201)
			const placed = (await withCode.json()) as {
				order: { id: string; totalCents: number }
			}
			const [stored] = await (
				await db()
			)
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, placed.order.id))
			expect(stored!.discountCents).toBe(500)
			const redemptions = await (await db()).select().from(discountRedemptions)
			expect(redemptions.some((r) => r.codeId === issued!.id)).toBe(true)

			const again = await app.request('/orders', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: 'https://test-org.example.com',
				},
				body: JSON.stringify(orderBody({ discounts: { code: credit.code } })),
			})
			// The used code no longer applies: refused, or placed without it.
			if (again.status === 201) {
				const second = (await again.json()) as { order: { id: string } }
				const [row] = await (
					await db()
				)
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.id, second.order.id))
				expect(row!.discountCents).toBe(0)
			} else {
				expect(again.status).toBeGreaterThanOrEqual(400)
			}
		})

		it('a credit needs the refund grant, never an impersonated session, and never exceeds the order', async () => {
			const { order, problemId } = await open()
			const denied = await answer(
				problemId,
				{ action: 'credit', amountCents: 100 },
				operatorJwt(),
			)
			expect(denied.status).toBe(403)
			expect(((await denied.json()) as { error: string }).error).toBe(
				'credit_forbidden',
			)
			const tooMuch = await answer(
				problemId,
				{ action: 'credit', amountCents: 5_000_000 },
				operatorJwt({ refundProvider: true }),
			)
			expect(tooMuch.status).toBe(422)
			expect(((await tooMuch.json()) as { error: string }).error).toBe(
				'credit_too_large',
			)
			expect(
				await (await db()).select().from(discountIssuedCodes),
			).toHaveLength(0)
			const [row] = await (await db()).select().from(orderProblems)
			expect(row!.status).toBe('open')
		})

		it('a refund claims the report first: a credit answered in the middle is refused and no code is minted', async () => {
			const { order, problemId } = await open()
			await (
				await db()
			)
				.update(restaurantOrders)
				.set({ paymentStatus: 'paid' })
				.where(eq(restaurantOrders.id, order.id))
			// Somebody else's refund has claimed the report and is still booking.
			await (
				await db()
			)
				.update(orderProblems)
				.set({
					status: 'answered',
					resolution: 'refund',
					resolvedBy: 'someone-else',
					resolvedAt: Date.now(),
				})
				.where(eq(orderProblems.id, problemId))
			const credit = await answer(problemId, {
				action: 'credit',
				amountCents: 100,
			})
			expect(credit.status).toBe(409)
			expect(
				await (await db()).select().from(discountIssuedCodes),
			).toHaveLength(0)
			const again = await answer(problemId, { action: 'refund' })
			expect(again.status).toBe(409)
			expect(
				await (await db()).select().from(restaurantOrderRefunds),
			).toHaveLength(0)
		})

		it('gives the claim back when the refund is refused, so the report can be answered again', async () => {
			const { order, problemId } = await open()
			await (
				await db()
			)
				.update(restaurantOrders)
				.set({
					paymentMethod: 'online',
					paymentStatus: 'paid',
					paymentProcessor: 'connect',
					paymentSessionId: 'cs_test_claim',
					paidAt: new Date(),
				})
				.where(eq(restaurantOrders.id, order.id))
			const tooMuch = await answer(
				problemId,
				{ action: 'refund', amountCents: order.totalCents + 5000 },
				operatorJwt({ refundProvider: true }),
			)
			expect(tooMuch.status).toBeGreaterThanOrEqual(400)
			const [row] = await (await db()).select().from(orderProblems)
			expect(row).toMatchObject({
				status: 'open',
				resolution: null,
				resolvedBy: null,
				refundId: null,
			})
			const reply = await answer(problemId, {
				action: 'reply',
				message: 'Looking into it',
			})
			expect(reply.status).toBe(200)
		})

		it('a provider refund that later fails opens the report again', async () => {
			const { order, problemId } = await open()
			await (
				await db()
			)
				.update(restaurantOrders)
				.set({
					paymentMethod: 'online',
					paymentStatus: 'paid',
					paymentProcessor: 'connect',
					paymentSessionId: 'cs_test_fail',
					paidAt: new Date(),
				})
				.where(eq(restaurantOrders.id, order.id))
			const response = await answer(
				problemId,
				{ action: 'refund', amountCents: 300 },
				operatorJwt({ refundProvider: true }),
			)
			expect(response.status).toBe(200)
			const [refund] = await (await db()).select().from(restaurantOrderRefunds)
			const settled = await applyProviderRefundStatus({
				orgId,
				refundId: refund!.id,
				status: 'failed',
				failureCode: 'card_declined',
			})
			expect(settled.ok).toBe(true)
			const [row] = await (await db()).select().from(orderProblems)
			expect(row).toMatchObject({
				status: 'open',
				resolution: null,
				refundId: null,
				refundCents: null,
			})
		})

		it('an expired credit does not apply', async () => {
			const { problemId } = await open()
			await answer(problemId, { action: 'credit', amountCents: 500 })
			const [issued] = await (await db()).select().from(discountIssuedCodes)
			// The table's update guard keeps an issued code's expiry fixed; this
			// test database is private to the test, so lift it to age the code.
			await (await db()).run(sql`DROP TRIGGER discount_issued_codes_fixed`)
			await (
				await db()
			)
				.update(discountIssuedCodes)
				.set({ expiresAt: Date.now() - 1000 })
				.where(eq(discountIssuedCodes.id, issued!.id))
			const response = await app.request('/orders', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					origin: 'https://test-org.example.com',
				},
				body: JSON.stringify(orderBody({ discounts: { code: issued!.code } })),
			})
			if (response.status === 201) {
				const placed = (await response.json()) as { order: { id: string } }
				const [row] = await (
					await db()
				)
					.select()
					.from(restaurantOrders)
					.where(eq(restaurantOrders.id, placed.order.id))
				expect(row!.discountCents).toBe(0)
			} else {
				expect(response.status).toBeGreaterThanOrEqual(400)
			}
		})

		it('a reply and a close settle the report and show to the guest', async () => {
			const first = await open()
			const reply = await answer(first.problemId, {
				action: 'reply',
				message: 'We are checking with the kitchen',
			})
			expect(reply.status).toBe(200)
			expect(
				((await reply.json()) as { problem: { resolution: string } }).problem
					.resolution,
			).toBe('reply')
			const second = await open()
			const closed = await answer(second.problemId, { action: 'close' })
			expect(
				((await closed.json()) as { problem: { status: string } }).problem
					.status,
			).toBe('closed')
			// A reply needs words.
			const third = await open()
			expect((await answer(third.problemId, { action: 'reply' })).status).toBe(
				400,
			)
		})

		it('needs the write scope, and a location-scoped token cannot see or answer another location’s report', async () => {
			const { problemId } = await open()
			const readOnly = await answer(
				problemId,
				{ action: 'close' },
				operatorJwt({ scope: 'orders:read' }),
			)
			expect(readOnly.status).toBe(403)
			const elsewhere = await operatorJwt({ locationIds: ['loc-2'] })
			const list = (await (
				await operator('/problems', { jwt: elsewhere })
			).json()) as { problems: unknown[]; counts: { open: number } }
			expect(list.problems).toHaveLength(0)
			expect(list.counts.open).toBe(0)
			expect(
				(await operator(`/problems/${problemId}`, { jwt: elsewhere })).status,
			).toBe(404)
			expect(
				(await answer(problemId, { action: 'close' }, elsewhere)).status,
			).toBe(404)
			const attention = (await (
				await operator('/attention', { jwt: elsewhere })
			).json()) as { problems: unknown[] }
			expect(attention.problems).toEqual([])
		})

		it('emails the guest the answer, with the credit code, in their language', async () => {
			const { problemId } = await open({ locale: 'es' })
			const response = await answer(problemId, {
				action: 'credit',
				amountCents: 500,
				message: 'Gracias por avisar',
			})
			expect(response.status).toBe(200)
			await vi.waitFor(() => expect(sentEmails).toHaveLength(1))
			const [issued] = await (await db()).select().from(discountIssuedCodes)
			expect(sentEmails[0]!.to).toBe('owner@restaurant.test')
			expect(sentEmails[0]!.subject).toContain('Sobre tu pedido')
			expect(sentEmails[0]!.text).toContain(issued!.code)
			expect(sentEmails[0]!.text).toContain('Gracias por avisar')
			expect(sentEmails[0]!.text).toContain('/menu?')
		})
	})

	describe('Needs attention and the alerts', () => {
		it('counts open and unanswered reports per location', async () => {
			const order = await place()
			await complete(order.id)
			const created = (await (
				await report(order.id, { receiptToken: order.receiptToken })
			).json()) as { problemId: string }
			const fresh = (await (await operator('/attention')).json()) as {
				problems: Array<{
					locationId: string
					open: number
					unanswered: number
				}>
			}
			expect(fresh.problems).toEqual([
				{ locationId: 'loc-1', open: 1, unanswered: 0 },
			])
			await (
				await db()
			)
				.update(orderProblems)
				.set({ createdAt: Date.now() - ORDER_PROBLEM_UNANSWERED_MS - 1000 })
				.where(eq(orderProblems.id, created.problemId))
			const late = (await (await operator('/attention')).json()) as {
				problems: Array<{ open: number; unanswered: number }>
			}
			expect(late.problems[0]).toMatchObject({ open: 1, unanswered: 1 })
		})

		it('tells the managers once more after 24 hours without an answer', async () => {
			const order = await place()
			const created = (await (
				await report(order.id, { receiptToken: order.receiptToken })
			).json()) as { problemId: string }
			await vi.waitFor(() => expect(problemAlerts()).toHaveLength(1))
			const early = await runOrderProblemsTickForOrg(orgId, await db())
			expect(early.alerted).toBe(0)
			expect(early.nextDueAt).not.toBeNull()
			await (
				await db()
			)
				.update(orderProblems)
				.set({ createdAt: Date.now() - ORDER_PROBLEM_UNANSWERED_MS - 1000 })
				.where(eq(orderProblems.id, created.problemId))
			const late = await runOrderProblemsTickForOrg(orgId, await db())
			expect(late.alerted).toBe(1)
			expect(problemAlerts()[1]).toMatchObject({
				kind: 'order_problem',
				unanswered: true,
				eventId: `problem:${created.problemId}:late`,
			})
			// Only once.
			const after = await runOrderProblemsTickForOrg(orgId, await db())
			expect(after.alerted).toBe(0)
			expect(await openProblemsOlderThan(await db(), Date.now())).toHaveLength(
				1,
			)
		})

		it('keeps an alert the App could not take for the next tick', async () => {
			let failing = true
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = typeof input === 'string' ? input : input.toString()
					if (url.includes('/resources/order-context'))
						return Response.json(context)
					if (url.includes('/resources/orders/notify')) {
						if (failing) return new Response('down', { status: 503 })
						alerts.push(JSON.parse(String(init?.body)))
						return Response.json({ inApp: 1, emailed: 0, pushed: 0, texted: 0 })
					}
					return new Response('not found', { status: 404 })
				}),
			)
			const order = await place()
			await report(order.id, { receiptToken: order.receiptToken })
			await new Promise((resolve) => setTimeout(resolve, 20))
			expect(problemAlerts()).toHaveLength(0)
			const [row] = await (await db()).select().from(orderProblems)
			expect(row!.notifiedAt).toBeNull()
			failing = false
			const tick = await runOrderProblemsTickForOrg(orgId, await db())
			expect(tick.alerted).toBe(1)
			expect(problemAlerts()).toHaveLength(1)
		})
	})

	describe('the receipt email', () => {
		it('says where to report a problem only when the restaurant took reports at placement', async () => {
			const withReports = await place()
			const [stored] = await (
				await db()
			)
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, withReports.id))
			expect(stored!.guestMessages).toMatchObject({
				receipt: true,
				problemReports: true,
			})
			const email = (order: unknown, linkUrl: string | null) =>
				renderOrderEmail({
					kind: 'receipt',
					locale: 'es',
					theme: null,
					restaurantName: 'Acme',
					order: order as never,
					timeZone: 'UTC',
					linkUrl,
				})
			const link = 'https://acme.example/menu/success?order=o1#link=abc'
			expect(email(stored, link).text).toContain(
				'¿Algún problema con tu pedido?',
			)
			expect(email(stored, link).html).toContain(
				'¿Algún problema con tu pedido?',
			)
			// No link to the order page, no hint: there would be nowhere to report.
			expect(email(stored, null).text).not.toContain('problema')
			// A restaurant with reports off at placement never promises them.
			context = menuContext({ problemReports: false })
			const without = await place()
			const [plain] = await (
				await db()
			)
				.select()
				.from(restaurantOrders)
				.where(eq(restaurantOrders.id, without.id))
			expect(plain!.guestMessages).not.toHaveProperty('problemReports')
			expect(email(plain, link).text).not.toContain('problema')
		})
	})

	describe('reports', () => {
		it('count problems by type, location and dish, with refund and credit totals, and nothing a guest wrote', async () => {
			const first = await place()
			await complete(first.id)
			await (
				await db()
			)
				.update(restaurantOrders)
				.set({ paymentStatus: 'paid' })
				.where(eq(restaurantOrders.id, first.id))
			const a = (await (
				await report(first.id, { receiptToken: first.receiptToken })
			).json()) as { problemId: string }
			await operator(`/problems/${a.problemId}/answer`, {
				method: 'POST',
				body: { action: 'refund' },
			})
			const second = await place()
			await complete(second.id)
			const b = (await (
				await report(
					second.id,
					{ receiptToken: second.receiptToken },
					{
						kind: 'late',
						items: [],
						note: 'Waited an hour, secret-note',
					},
				)
			).json()) as { problemId: string }
			await operator(`/problems/${b.problemId}/answer`, {
				method: 'POST',
				body: { action: 'credit', amountCents: 300 },
				jwt: await operatorJwt({ refundProvider: true }),
			})
			const definition = {
				timeframe: { preset: 'last_30_days' },
			} as unknown as ReportDefinition
			const ctx = {
				db: await db(),
				orgId,
				locationIds: null,
				now: new Date(),
			}
			const problems = await loadOrderProblemRecords(
				ctx,
				'order_problems',
				definition,
			)
			expect(problems.records).toHaveLength(2)
			const refunded = problems.records.find((r) => r.kind === 'missing_item')!
			expect(refunded).toMatchObject({
				problems: 1,
				refunded: 10,
				credited: 0,
				resolution: 'refund',
				affected: 10,
				currency: 'USD',
				location: 'Main Street',
				locationId: 'loc-1',
			})
			expect(refunded.minutesToAnswer).toBeGreaterThanOrEqual(0)
			const credited = problems.records.find((r) => r.kind === 'late')!
			expect(credited).toMatchObject({
				refunded: 0,
				credited: 3,
				resolution: 'credit',
			})
			expect(JSON.stringify(problems.records)).not.toContain('secret-note')
			const dishes = await loadOrderProblemRecords(
				ctx,
				'order_problem_dishes',
				definition,
			)
			expect(dishes.records).toHaveLength(2)
			expect(
				dishes.records.find((r) => r.kind === 'missing_item'),
			).toMatchObject({ dish: 'Burger', units: 1, amount: 10 })
			expect(dishes.records.find((r) => r.kind === 'late')).toMatchObject({
				dish: 'No dish named',
				units: 0,
			})
			// A token limited to another location reads nothing.
			const other = await loadOrderProblemRecords(
				{ ...ctx, locationIds: ['loc-2'] },
				'order_problems',
				definition,
			)
			expect(other.records).toHaveLength(0)
			expect(
				(
					await loadOrderProblemRecords(
						{ ...ctx, locationIds: [] },
						'order_problems',
						definition,
					)
				).records,
			).toHaveLength(0)
		})
	})

	it('affectedItemsCents prices only the units named', () => {
		expect(
			affectedItemsCents(
				[{ totalCents: 2000, quantity: 2 }],
				[{ lineIndex: 0, quantity: 1 }],
			),
		).toBe(1000)
		expect(makeDiscount).toBeDefined()
	})
})

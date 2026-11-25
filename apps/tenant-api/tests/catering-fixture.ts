import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	defaultCateringSettings,
	type CateringSettings,
} from '@repo/common/catering'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	restaurantOrders,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import { vi } from 'vitest'
import { ORG_A, ORG_B, ORIGIN, OTHER_ORIGIN, type Org } from './catering-orgs.ts'
import {
	resetReservationsContextCache,
	seedReservationsContextForTest,
} from '../src/lib/reservations-context.ts'
import { setTenantEmailDevCapture } from '../src/lib/tenant-email.ts'
import { publicContext } from '../src/routes/reservations-public-fixture.ts'
import { cateringRoutes } from '../src/routes/catering.ts'
import { operatorCateringRoutes } from '../src/routes/operator-catering.ts'
import { orderSystemRoutes } from '../src/routes/order-system.ts'
import { publicOrderRoutes } from '../src/routes/orders.ts'

/**
 * Shared harness for the catering tests (#124, #255, #361): a real tenant
 * database per organization, the App faked (order context, notices) and the
 * email transport captured, so every payment, deposit, reminder and link works
 * with no live provider, host or restaurant data.
 */

export const OPERATOR_SECRET = 'catering-operator-secret-0123456789abcdef'
export const INTERNAL_TOKEN = 'catering-internal-token-very-long-and-secure'
export const LOC = 'loc-1'
export const LOC_2 = 'loc-2'
export const TIME_ZONE = 'America/New_York'
/** Monday 2026-06-01 12:00 in New York. */
export const NOW = new Date('2026-06-01T16:00:00.000Z')

export { ORG_A, ORG_B, ORIGIN, OTHER_ORIGIN, type Org }

const EVERY_DAY = [
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
	slots: [{ start: '08:00', end: '20:00' }],
}))

function cateringMenu() {
	return {
		id: 'catering-menu',
		displayName: 'Catering',
		menuType: 'catering',
		specialInstructions: true,
		availabilityStatus: 'available',
		categories: [
			{
				id: 'cat-trays',
				displayName: 'Trays',
				availabilityStatus: 'available',
				items: [
					{
						id: 'item-tray',
						displayName: 'Sandwich tray',
						price: 100,
						availabilityStatus: 'available',
					},
					{
						id: 'item-salad',
						displayName: 'Salad tray',
						price: 60,
						availabilityStatus: 'available',
					},
				],
			},
		],
	}
}

function location(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		name: id === LOC ? 'Main Street' : 'Harbor',
		timezone: TIME_ZONE,
		taxRate: 10,
		prepTime: 15,
		currency: 'USD',
		fulfillmentOptions: { pickup: true, delivery: false, dineIn: false },
		inHouseTips: { pickupTips: false, deliveryTips: false, dineInTips: false },
		onlineHours: EVERY_DAY,
		...overrides,
	}
}

export type ContextOptions = {
	/** Settings per location; a location without one has catering off. */
	settings?: Record<string, Partial<CateringSettings>>
	quotes?: boolean
	/** Drops the `catering` key entirely, like an App with the flag off. */
	flagOff?: boolean
	location?: Record<string, unknown>
}

export function settingsFor(
	patch: Partial<CateringSettings> = {},
): CateringSettings {
	return { ...defaultCateringSettings(), enabled: true, ...patch }
}

/** The App's order context for an organization. */
export function cateringContext(orgId: string, options: ContextOptions = {}) {
	const settings = options.settings ?? { [LOC]: {} }
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: {
				id: orgId,
				slug: orgId === ORG_A.id ? 'acme' : 'other',
				currency: 'USD',
				defaultLocale: 'en',
			},
			locations: [
				location(LOC, options.location),
				location(LOC_2, options.location),
			],
			menus: [cateringMenu()],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: true, processor: 'connect' },
		...(options.flagOff
			? {}
			: {
					catering: {
						version: 1,
						quotes: options.quotes ?? true,
						locations: Object.fromEntries(
							Object.entries(settings).map(([id, patch]) => [
								id,
								settingsFor(patch),
							]),
						),
					},
				}),
	}
}

export type SentEmail = { to: string; subject: string; html: string; text: string }
export type AppNotice = Record<string, unknown>

export type Harness = {
	app: Hono
	emails: SentEmail[]
	notices: AppNotice[]
	setContext: (orgId: string, context: unknown) => void
	token: (claims?: Record<string, unknown>, options?: TokenOptions) => Promise<string>
	op: (
		method: string,
		path: string,
		body?: unknown,
		options?: TokenOptions & { claims?: Record<string, unknown> },
	) => Promise<Response>
	guest: (
		method: string,
		path: string,
		options?: {
			body?: unknown
			headers?: Record<string, string>
			origin?: string
		},
	) => Promise<Response>
	system: (path: string, body: unknown) => Promise<Response>
	postOrder: (body: unknown) => Promise<Response>
	cleanup: () => Promise<void>
}

export type TokenOptions = {
	orgId?: string
	secret?: string
	audience?: string
}

export function linkFragment(html: string): string {
	const match = /href="[^"#]+#([^"]+)"/.exec(html)
	if (!match) throw new Error('No link with a fragment in the email')
	// The link carries a `q=` or `b=` key before the token.
	return match[1]!.replace(/^[qb]=/, '')
}

/**
 * Starts the harness for the given organizations. Call from `beforeEach`; the
 * caller supplies the hoisted `orgs` map the `../lib/origin.ts` mock reads.
 */
export async function startHarness(orgs: Org[]): Promise<Harness> {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'catering-'))
	vi.stubEnv('TENANT_DB_DIR', directory)
	vi.stubEnv('DATA_REGION', 'us')
	vi.stubEnv('INTERNAL_COMMAND_TOKEN', INTERNAL_TOKEN)
	vi.stubEnv('TENANT_OPERATOR_TOKEN', OPERATOR_SECRET)
	vi.stubEnv('JWT_SECRET', 'catering-jwt-secret-123456789')
	vi.stubEnv('AUTH_HMAC_SECRET', 'catering-hmac-secret-123456789')
	vi.stubEnv('APP_URL', 'https://app.test')
	vi.stubEnv('CATERING_PUBLIC_ENABLED', 'true')
	vi.stubEnv('ORDERS_EMAIL_ENABLED', 'true')
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(NOW)

	const contexts = new Map<string, unknown>()
	const emails: SentEmail[] = []
	const notices: AppNotice[] = []
	for (const org of orgs) {
		contexts.set(org.id, cateringContext(org.id))
		await provisionTenantDb(org.id)
		// Fresh for good: the tests move the clock by weeks, and a stale
		// context (no site address, no restaurant name) would send blank links.
		seedReservationsContextForTest(
			org.id,
			publicContext(org.id),
			NOW.getTime() + 400 * 86_400_000,
		)
	}
	setTenantEmailDevCapture(async (record) => {
		emails.push({
			to: record.to,
			subject: record.subject,
			html: record.html,
			text: record.text,
		})
	})
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === 'string' ? input : input.toString()
			if (url.includes('/resources/order-context')) {
				const orgId = new URL(url).searchParams.get('orgId') ?? ''
				const context = contexts.get(orgId)
				return context
					? new Response(JSON.stringify(context), {
							status: 200,
							headers: { 'content-type': 'application/json' },
						})
					: new Response('not found', { status: 404 })
			}
			if (url.includes('/resources/catering/notify')) {
				notices.push(JSON.parse(String(init?.body ?? '{}')))
				return new Response('{}', { status: 200 })
			}
			return new Response('not found', { status: 404 })
		}),
	)

	const app = new Hono()
	app.route('/orders', publicOrderRoutes)
	app.route('/catering', cateringRoutes)
	app.route('/operator/catering', operatorCateringRoutes)
	app.route('/api/orders', orderSystemRoutes)

	async function token(
		claims: Record<string, unknown> = {},
		options: TokenOptions = {},
	) {
		const now = Math.floor(Date.now() / 1000)
		return new jose.SignJWT({
			role: 'operator',
			orgId: options.orgId ?? ORG_A.id,
			scope: 'orders:write',
			...claims,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setSubject('usr_catering')
			.setIssuer(brand.shortName)
			.setAudience(options.audience ?? 'tenant-api-operator')
			.setIssuedAt(now)
			.setExpirationTime(now + 3600)
			.sign(new TextEncoder().encode(options.secret ?? OPERATOR_SECRET))
	}

	const harness: Harness = {
		app,
		emails,
		notices,
		setContext: (orgId, context) => contexts.set(orgId, context),
		token,
		op: async (method, path, body, options = {}) =>
			app.request(`/operator/catering${path}`, {
				method,
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${await token(options.claims ?? {}, options)}`,
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			}),
		guest: async (method, path, options = {}) =>
			app.request(`/catering${path}`, {
				method,
				headers: {
					'content-type': 'application/json',
					origin: options.origin ?? ORIGIN,
					...(options.headers ?? {}),
				},
				...(options.body === undefined
					? {}
					: { body: JSON.stringify(options.body) }),
			}),
		system: async (path, body) =>
			app.request(`/api/orders${path}`, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					authorization: `Bearer ${INTERNAL_TOKEN}`,
				},
				body: JSON.stringify(body),
			}),
		postOrder: async (body) =>
			app.request('/orders', {
				method: 'POST',
				headers: { 'content-type': 'application/json', origin: ORIGIN },
				body: JSON.stringify(body),
			}),
		cleanup: async () => {
			vi.useRealTimers()
			setTenantEmailDevCapture(null)
			resetReservationsContextCache()
			for (const org of orgs) {
				try {
					await destroyTenantDb(org.id)
				} catch {}
			}
			try {
				fs.rmSync(directory, { recursive: true, force: true })
			} catch {}
			vi.unstubAllEnvs()
			vi.unstubAllGlobals()
			vi.clearAllMocks()
		},
	}
	return harness
}

/** A catering order body: 2 sandwich trays (200.00 + 10% tax), three days out. */
export function orderBody(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'acme',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: LOC,
		fulfillment: 'pickup',
		paymentMethod: 'online',
		contact: {
			name: 'Rana Khalid',
			phone: '+1 555 123 4567',
			email: 'rana@example.com',
		},
		guestCount: 30,
		catering: { notes: 'Office lunch, no nuts' },
		// Thursday 2026-06-04 12:00 in New York.
		scheduledFor: '2026-06-04T16:00:00.000Z',
		lines: [{ itemId: 'item-tray', quantity: 2, options: [] }],
		...overrides,
	}
}

export function quoteRequestBody(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'acme',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: LOC,
		fulfillment: 'pickup',
		eventAt: '2026-06-05T16:00:00.000Z',
		guestCount: 40,
		notes: 'Board lunch, two vegetarian trays',
		contact: {
			name: 'Rana Khalid',
			phone: '+1 555 123 4567',
			email: 'rana@example.com',
		},
		lines: [{ itemId: 'item-tray', quantity: 3 }],
		...overrides,
	}
}

export async function storedOrder(orgId: string, id: string) {
	const db = await getTenantDb(orgId)
	const [row] = await db
		.select()
		.from(restaurantOrders)
		.where(eq(restaurantOrders.id, id))
	return row!
}

/** Marks an order's deposit paid through the payment bridge, like the App's webhook does. */
export async function payOrder(
	h: Harness,
	orgId: string,
	orderId: string,
	sessionId = `cs_${crypto.randomBytes(6).toString('hex')}`,
	ref: string = orderId,
) {
	const order = await storedOrder(orgId, orderId)
	const amountCents = order.depositCents ?? order.totalCents
	const bound = await h.system('/payment-session', {
		orgId,
		orderId: ref,
		sessionId,
		processor: 'connect',
	})
	const paid = await h.system('/payment-status', {
		orgId,
		orderId: ref,
		sessionId,
		processor: 'connect',
		status: 'paid',
		amountCents,
		currency: 'USD',
		paymentId: `pi_${sessionId}`,
	})
	return { bound, paid, sessionId, amountCents }
}

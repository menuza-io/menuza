import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
	issuePosFiscalDocument,
	newPosFiscalChain,
	type PosFiscalChainHead,
	posRefundTaxCents,
} from '@repo/common/pos-fiscal'
import { formatPosPairingCode, randomPosToken } from '@repo/common/pos-orders'
import { brand } from '@repo/config/brand'
import {
	fromHex,
	fromSale,
	readCertificate,
	signDocument,
	ZATCA_GENESIS_PIH,
	type ZatcaSeller,
} from '@repo/zatca'
import {
	destroyTenantDb,
	customers,
	getTenantDb,
	loyaltyPurchases,
	posDevices,
	posManagers,
	staffMembers,
	staffScopeAssignments,
	posCashMovements,
	posFiscalDocuments,
	posHeldUploads,
	posOrderLines,
	posOrderTransfers,
	posZatcaSubmissions,
	posZatcaUnits,
	posOrderRevisions,
	posOrders,
	posPairingCodes,
	posPayments,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	invalidateLoyaltyContext,
	seedLoyaltyContextForTest,
} from '../lib/loyalty-context.ts'
import { findActiveOrganizationById } from '../lib/origin.ts'
import { pinLookupFor } from '../services/kiosk-pin-service.ts'
import {
	identifyMemberByCode,
	issueMemberCode,
} from '../services/loyalty-code-service.ts'
import {
	activateProgram,
	balanceOf,
	cartLine,
	givePoints,
	insertCustomer,
	loyaltyCart,
	makeMember,
	makeReward,
	programConfig,
	reserveReward,
	rewardDefinition,
} from '../services/loyalty-test-fixture.ts'
import { fiscalChainGaps, purgePosGuestNames } from '../services/pos-service.ts'
import { eraseLinkedUser } from '../services/staff-internal-service.ts'
import { erasePerson } from '../services/person-erasure-service.ts'
import { runStaffTickForOrg } from '../services/staff-tick-service.ts'
import { reportDueZatca } from '../services/zatca-service.ts'
import { sealContext, seal as sealForTest } from '../lib/zatca-seal.ts'
import { operatorPosRoutes } from './operator-pos.ts'
import { clearPosMenuCache, posRoutes } from './pos.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const ORG_A = 'org_pos_a'
const ORG_B = 'org_pos_b'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'
const hmacSecret = 'test-hmac-secret-123456789'

const org = (id: string) => ({
	id,
	slug: id,
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
})

const DAYS = [
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

const burger = {
	id: 'item-burger',
	displayName: 'Burger',
	price: 10,
	availabilityStatus: 'available',
	modifierGroups: [
		{
			id: 'grp-size',
			name: 'Size',
			selectionType: 'single',
			minSelections: 1,
			availabilityStatus: 'available',
			options: [
				{
					id: 'opt-reg',
					displayName: 'Regular',
					price: 0,
					availabilityStatus: 'available',
				},
				{
					id: 'opt-large',
					displayName: 'Large',
					price: 3,
					availabilityStatus: 'available',
				},
			],
		},
		{
			id: 'grp-top',
			name: 'Toppings',
			selectionType: 'multiple',
			minSelections: 0,
			maxSelections: 2,
			availabilityStatus: 'available',
			options: [
				{
					id: 'opt-cheese',
					displayName: 'Cheese',
					price: 1,
					availabilityStatus: 'available',
				},
				{
					id: 'opt-donate',
					displayName: 'Donation',
					price: 1,
					applySalesTax: false,
					availabilityStatus: 'available',
				},
			],
		},
	],
}
const fries = {
	id: 'item-fries',
	displayName: 'Fries',
	price: 4,
	availabilityStatus: 'available',
}

const TAX = 8.25

function menuContext(
	orgId: string,
	{ onlineClosed = false }: { onlineClosed?: boolean } = {},
) {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: { id: orgId, slug: orgId, currency: 'USD' },
			locations: [
				{
					id: 'loc-1',
					name: 'Main Street',
					timezone: 'UTC',
					taxRate: TAX,
					prepTime: 15,
					currency: 'USD',
					fulfillmentOptions: {
						pickup: false,
						delivery: false,
						dineIn: true,
						curbside: false,
					},
					inHouseTips: {
						pickupTips: false,
						deliveryTips: false,
						dineInTips: true,
					},
					onlineHours: onlineClosed
						? DAYS.map((d) => ({ ...d, isOpen: false, slots: [] }))
						: DAYS,
				},
				{
					id: 'loc-2',
					name: 'Harbor',
					timezone: 'UTC',
					taxRate: TAX,
					prepTime: 15,
					currency: 'USD',
					onlineHours: DAYS,
				},
			],
			menus: [
				{
					id: 'menu-1',
					displayName: 'Main',
					menuType: 'regular',
					specialInstructions: false,
					availabilityStatus: 'available',
					categories: [
						{
							id: 'cat-food',
							displayName: 'Food',
							availabilityStatus: 'available',
							items: [burger, fries],
						},
					],
				},
			],
			locationOverrides: {},
		},
		drop: null,
		onlinePayment: { enabled: false, processor: null },
	}
}

type LineSpec = {
	itemId: string
	name: string
	baseCents: number
	quantity?: number
	options?: Array<{
		groupId: string
		optionId: string
		optionName: string
		unitCents: number
		taxable?: boolean
	}>
	instructions?: string
}

const BURGER: LineSpec = {
	itemId: 'item-burger',
	name: 'Burger',
	baseCents: 1000,
	options: [
		{
			groupId: 'grp-size',
			optionId: 'opt-reg',
			optionName: 'Regular',
			unitCents: 0,
		},
	],
}
const FRIES: LineSpec = { itemId: 'item-fries', name: 'Fries', baseCents: 400 }

const wireLine = (spec: LineSpec) => ({
	itemId: spec.itemId,
	name: spec.name,
	variantId: null,
	variantLabel: null,
	quantity: spec.quantity ?? 1,
	baseCents: spec.baseCents,
	instructions: spec.instructions ?? '',
	options: (spec.options ?? []).map((o) => ({
		groupId: o.groupId,
		groupName: o.groupId,
		optionId: o.optionId,
		optionName: o.optionName,
		quantity: 1,
		unitCents: o.unitCents,
		taxable: o.taxable ?? true,
	})),
})

/** Builds a valid, arithmetically consistent wire order the way the till does. */
function wireOrder(
	input: {
		id?: string
		number?: string
		businessDate?: string
		revision?: number
		status?: 'open' | 'paid' | 'void'
		lines?: LineSpec[]
		tipCents?: number
		payments?: Array<{
			id?: string
			method?: 'cash' | 'card' | 'other'
			amountCents: number
			tenderedCents?: number
		}>
		locationId?: string
		staff?: { id: string; name: string } | null
		signIn?: 'online' | 'offline' | null
		voidedBy?: { id: string; name: string } | null
		paymentStaff?: { id: string; name: string } | null
	} = {},
) {
	const specs = input.lines ?? [BURGER]
	const lines = specs.map(wireLine)
	let subtotal = 0
	let taxable = 0
	for (const l of lines) {
		const opts = l.options.reduce((s, o) => s + o.unitCents * o.quantity, 0)
		const taxOpts = l.options.reduce(
			(s, o) => s + (o.taxable ? o.unitCents * o.quantity : 0),
			0,
		)
		subtotal += (l.baseCents + opts) * l.quantity
		taxable += (l.baseCents + taxOpts) * l.quantity
	}
	const taxCents = Math.round((taxable * TAX) / 100)
	const tipCents = input.tipCents ?? 0
	const totalCents = subtotal + taxCents + tipCents
	const payments = (input.payments ?? []).map((p) => ({
		id: p.id ?? crypto.randomUUID(),
		method: p.method ?? 'cash',
		amountCents: p.amountCents,
		tenderedCents: p.tenderedCents ?? p.amountCents,
		at: new Date().toISOString(),
		staff: input.paymentStaff ?? null,
	}))
	const paid = payments.reduce((s, p) => s + p.amountCents, 0)
	return {
		id: input.id ?? crypto.randomUUID(),
		revision: input.revision ?? 1,
		status: input.status ?? (paid >= totalCents && paid > 0 ? 'paid' : 'open'),
		number: input.number ?? 'T1-0001',
		businessDate: input.businessDate ?? '2026-10-21',
		createdAt: new Date().toISOString(),
		// A till that refreshed its menu a moment ago: price differences are real ones.
		catalogFetchedAt: new Date(Date.now() - 60_000).toISOString(),
		locationId: input.locationId ?? 'loc-1',
		currency: 'USD',
		orderType: 'dine_in' as const,
		customerName: null,
		tableLabel: '12',
		staff: input.staff ?? null,
		signIn: input.signIn ?? null,
		voidedBy: input.voidedBy ?? null,
		lines,
		adjustments: [],
		totals: {
			subtotalCents: subtotal,
			adjustmentCents: 0,
			taxCents,
			tipCents,
			totalCents,
		},
		payments,
	}
}

describe('POS terminals: pairing, upload and sync', () => {
	let directory: string
	let app: Hono
	let contextFor: (orgId: string) => unknown
	let fetchMock: ReturnType<typeof vi.fn>
	let contextStatus = 200

	const mintOperator = (
		scope: 'orders:read' | 'orders:write' | 'mailbox' = 'orders:write',
		orgId = ORG_A,
		sub = 'user_manager_1',
	) =>
		new SignJWT({ orgId, role: 'operator', scope })
			.setSubject(sub)
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('15m')
			.sign(new TextEncoder().encode(operatorToken))

	const operator = async (
		method: string,
		pathname: string,
		options: {
			scope?: 'orders:read' | 'orders:write'
			orgId?: string
			body?: unknown
		} = {},
	) =>
		app.request(`/operator/pos${pathname}`, {
			method,
			headers: {
				authorization: `Bearer ${await mintOperator(options.scope ?? 'orders:write', options.orgId ?? ORG_A)}`,
				'content-type': 'application/json',
			},
			body:
				options.body === undefined ? undefined : JSON.stringify(options.body),
		})

	const post = (pathname: string, body: unknown, token?: string) =>
		app.request(`/pos${pathname}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				...(token ? { authorization: `Bearer ${token}` } : {}),
			},
			body: typeof body === 'string' ? body : JSON.stringify(body),
		})

	async function pair(
		options: {
			orgId?: string
			terminalCode?: string
			label?: string
			locationId?: string | null
			signInRequired?: boolean
		} = {},
	) {
		const created = await operator('POST', '/pairing-codes', {
			orgId: options.orgId,
			body: {
				label: options.label ?? 'Front counter',
				terminalCode: options.terminalCode ?? 'T1',
				locationId: options.locationId ?? null,
				signInRequired: options.signInRequired ?? false,
			},
		})
		expect(created.status).toBe(201)
		const { code } = (await created.json()) as { code: string }
		const paired = await post('/pair', { code })
		expect(paired.status).toBe(201)
		const body = (await paired.json()) as {
			deviceSecret: string
			device: { id: string; terminalCode: string }
		}
		return body
	}

	async function pairWith(options: {
		signInRequired?: boolean
		terminalCode?: string
		scopeId?: string
	}) {
		const created = await operator('POST', '/pairing-codes', {
			body: {
				label: 'Terminal',
				terminalCode: options.terminalCode ?? 'T1',
				...(options.signInRequired === undefined
					? {}
					: { signInRequired: options.signInRequired }),
				...(options.scopeId ? { scopeId: options.scopeId } : {}),
			},
		})
		const { code } = (await created.json()) as { code: string }
		return (await (await post('/pair', { code })).json()) as {
			deviceSecret: string
			device: { id: string; signInRequired: boolean; scopeId: string }
		}
	}

	const upload = (secret: string, order: unknown) =>
		post('/orders', order, secret)

	describe('staff-entered phone pickups', () => {
		const phone = () => ({
			...wireOrder(),
			orderType: 'takeaway',
			orderSource: 'phone',
			customerName: 'Sam',
			customerPhone: '+15550001111',
			tableLabel: null,
			pickupAt: new Date(Date.now() + 3_600_000).toISOString(),
			pickupTimeZone: 'America/New_York',
		})

		it('stores contact regionally, redacts history, and carries pickup details through terminal takeover', async () => {
			const t1 = await pair({ terminalCode: 'T1' })
			const t2 = await pair({ terminalCode: 'T2' })
			const order = phone()
			const response = await upload(t1.deviceSecret, order)
			expect(response.status).toBe(201)
			expect(
				((await response.json()) as { order: unknown }).order,
			).toMatchObject({
				orderSource: 'phone',
				customerPhone: order.customerPhone,
				pickupAt: Date.parse(order.pickupAt),
			})
			const claimed = await post(
				`/tabs/${order.id}/claim`,
				{ revision: 1 },
				t2.deviceSecret,
			)
			expect(claimed.status).toBe(200)
			expect(
				((await claimed.json()) as { order: unknown }).order,
			).toMatchObject({
				orderSource: 'phone',
				customerName: 'Sam',
				customerPhone: order.customerPhone,
				pickupAt: order.pickupAt,
				pickupTimeZone: order.pickupTimeZone,
			})
			const db = await getTenantDb(ORG_A)
			const history = JSON.stringify(await db.select().from(posOrderRevisions))
			expect(history).not.toContain(order.customerPhone)
			expect(history).not.toContain('"Sam"')
			expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
				order.customerPhone,
			)
		})

		it('keeps callback details out of held uploads and expires closed contacts but not open pickups', async () => {
			const { deviceSecret } = await pair()
			const order = phone()
			const total = order.totals.totalCents
			const paidOrder = {
				...order,
				status: 'paid',
				payments: wireOrder({ payments: [{ amountCents: total }] }).payments,
			}
			expect((await upload(deviceSecret, paidOrder)).status).toBe(201)
			await expectHeld(
				await upload(deviceSecret, {
					...paidOrder,
					revision: 2,
					pickupAt: new Date(Date.now() + 7_200_000).toISOString(),
				}),
				'order_closed',
			)
			const db = await getTenantDb(ORG_A)
			const held = JSON.stringify(await db.select().from(posHeldUploads))
			expect(held).not.toContain(order.customerPhone)
			expect(held).not.toContain('Sam')
			expect(
				(await upload(deviceSecret, { ...phone(), number: 'T1-0002' })).status,
			).toBe(201)
			expect(await purgePosGuestNames(db, Date.now() + 31 * 86_400_000)).toBe(1)
			const rows = await db.select().from(posOrders)
			expect(rows.find((o) => o.status === 'paid')).toMatchObject({
				guestName: null,
				customerPhone: null,
			})
			expect(rows.find((o) => o.status === 'open')).toMatchObject({
				guestName: 'Sam',
				customerPhone: order.customerPhone,
			})
		})

		it('erases matching local-format phone contacts and does not restore them on a later payment', async () => {
			const { deviceSecret } = await pair()
			const db = await getTenantDb(ORG_A)
			const [customer] = await db
				.insert(customers)
				.values({ phone: '+15550001111', name: 'Sam' })
				.returning()
			const order = { ...phone(), customerPhone: '5550001111' }
			expect((await upload(deviceSecret, order)).status).toBe(201)
			await erasePerson(db, { customerId: customer!.id }, { actorId: 'test' })
			expect((await db.select().from(posOrders))[0]).toMatchObject({
				guestName: null,
				customerPhone: null,
			})
			const paid = {
				...order,
				revision: 2,
				status: 'paid',
				payments: wireOrder({
					payments: [{ amountCents: order.totals.totalCents }],
				}).payments,
			}
			expect((await upload(deviceSecret, paid)).status).toBe(200)
			expect((await db.select().from(posOrders))[0]).toMatchObject({
				status: 'paid',
				guestName: null,
				customerPhone: null,
				totalCents: order.totals.totalCents,
			})
		})
	})

	/** The server could not apply the upload: it kept it for review and told the till to stop sending it. */
	async function expectHeld(response: Response, error?: string) {
		expect(response.status).toBe(202)
		const body = (await response.json()) as { result: string; error: string }
		expect(body.result).toBe('held')
		if (error) expect(body.error).toBe(error)
		return body
	}

	/** A staff member with a PIN at a workplace, written the way the staff module writes it. */
	async function addStaff(
		options: {
			first?: string
			last?: string
			pin?: string | null
			orgId?: string
			scopeId?: string
			status?: 'active' | 'on_leave' | 'terminated' | 'invited'
			assignmentActive?: boolean
			manager?: boolean
		} = {},
	) {
		const orgId = options.orgId ?? ORG_A
		const db = await getTenantDb(orgId)
		const id = crypto.randomUUID()
		await db.insert(staffMembers).values({
			id,
			firstName: options.first ?? 'Ana',
			lastName: options.last ?? 'Karim',
			status: (options.status ?? 'active') as never,
		})
		await db.insert(staffScopeAssignments).values({
			staffId: id,
			scopeId: options.scopeId ?? 'main',
			pinLookup:
				options.pin === null
					? null
					: pinLookupFor(
							orgId,
							options.scopeId ?? 'main',
							options.pin ?? '4321',
						),
			active: options.assignmentActive ?? true,
		})
		if (options.manager)
			await db.insert(posManagers).values({ staffId: id, addedBy: 'test' })
		return id
	}
	const signIn = (secret: string, pin: string) =>
		post('/sign-in', { pin }, secret)

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('AUTH_HMAC_SECRET', hmacSecret)
		vi.stubEnv('JWT_SECRET', 'test-jwt-secret-123456789')
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('POS_ENABLED', '')

		clearPosMenuCache()
		contextStatus = 200
		contextFor = (orgId) => menuContext(orgId)
		fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === 'string' ? input : input.toString())
			if (url.pathname.endsWith('/resources/order-context')) {
				if (contextStatus !== 200)
					return new Response('down', { status: contextStatus })
				return Response.json(contextFor(url.searchParams.get('orgId') ?? ''))
			}
			return new Response('not found', { status: 404 })
		})
		vi.stubGlobal('fetch', fetchMock)

		vi.mocked(findActiveOrganizationById).mockImplementation(async (id) =>
			id === ORG_A || id === ORG_B ? (org(id) as never) : null,
		)
		await provisionTenantDb(ORG_A)
		await provisionTenantDb(ORG_B)
		app = new Hono()
		app.route('/pos', posRoutes)
		app.route('/operator/pos', operatorPosRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(ORG_A)
			await destroyTenantDb(ORG_B)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	// -----------------------------------------------------------------------
	// Pairing
	// -----------------------------------------------------------------------

	describe('pairing', () => {
		it('pairs a terminal with a one-time code and returns an org-prefixed secret', async () => {
			const { deviceSecret, device } = await pair({ terminalCode: 'bar2' })
			expect(deviceSecret).toMatch(
				new RegExp(`^pdv1\\.${ORG_A}\\.${device.id}\\.`),
			)
			expect(device.terminalCode).toBe('BAR2')
			const me = await app.request('/pos/me', {
				headers: { authorization: `Bearer ${deviceSecret}` },
			})
			expect(me.status).toBe(200)
			expect(
				((await me.json()) as { device: { label: string } }).device.label,
			).toBe('Front counter')
		})

		it('never stores the secret or the code, only keyed hashes', async () => {
			const created = await operator('POST', '/pairing-codes', {
				body: { label: 'A', terminalCode: 'T1' },
			})
			const { code } = (await created.json()) as { code: string }
			const { deviceSecret } = await (async () => {
				const r = await post('/pair', { code })
				return (await r.json()) as { deviceSecret: string }
			})()
			const db = await getTenantDb(ORG_A)
			const dump = JSON.stringify([
				await db.select().from(posDevices),
				await db.select().from(posPairingCodes),
			])
			expect(dump).not.toContain(code)
			expect(dump).not.toContain(deviceSecret)
			expect(dump).not.toContain(deviceSecret.split('.').pop()!)
		})

		it('lets a code be used once', async () => {
			const created = await operator('POST', '/pairing-codes', {
				body: { label: 'A', terminalCode: 'T1' },
			})
			const { code } = (await created.json()) as { code: string }
			expect((await post('/pair', { code })).status).toBe(201)
			const second = await post('/pair', { code })
			expect(second.status).toBe(401)
			expect(await second.json()).toEqual({ error: 'invalid_pairing_code' })
		})

		it('refuses an expired code', async () => {
			const created = await operator('POST', '/pairing-codes', {
				body: { label: 'A', terminalCode: 'T1' },
			})
			const { code } = (await created.json()) as { code: string }
			const db = await getTenantDb(ORG_A)
			await db.update(posPairingCodes).set({ expiresAt: Date.now() - 1 })
			expect((await post('/pair', { code })).status).toBe(401)
		})

		it('answers every bad code the same, so codes cannot be probed', async () => {
			const answers = await Promise.all(
				[
					{ code: 'garbage' },
					{ code: `ppc1.${ORG_A}.${'a'.repeat(43)}` },
					{ code: `ppc1.${'nonexistent_org'}.${'a'.repeat(43)}` },
					{ code: 'x'.repeat(1000) },
					{},
					'not json',
				].map(async (body) => {
					const r = await post('/pair', body)
					return [r.status, await r.json()]
				}),
			)
			for (const answer of answers)
				expect(answer).toEqual([401, { error: 'invalid_pairing_code' }])
		})

		it('does not accept a revoked pairing code', async () => {
			const created = await operator('POST', '/pairing-codes', {
				body: { label: 'A', terminalCode: 'T1' },
			})
			const { id, code } = (await created.json()) as {
				id: string
				code: string
			}
			expect((await operator('DELETE', `/pairing-codes/${id}`)).status).toBe(
				200,
			)
			expect((await post('/pair', { code })).status).toBe(401)
		})

		it('lists pending codes without the code itself', async () => {
			await operator('POST', '/pairing-codes', {
				body: { label: 'Bar', terminalCode: 'BAR' },
			})
			const listed = await operator('GET', '/terminals', {
				scope: 'orders:read',
			})
			const body = (await listed.json()) as {
				pendingCodes: Array<Record<string, unknown>>
			}
			expect(body.pendingCodes).toHaveLength(1)
			expect(JSON.stringify(body)).not.toContain('ppc1.')
			expect(body.pendingCodes[0]).toMatchObject({
				label: 'Bar',
				terminalCode: 'BAR',
			})
		})

		it('rejects an invalid or duplicate terminal code', async () => {
			for (const bad of ['', 'toolong1', 'a b', 'é1']) {
				const r = await operator('POST', '/pairing-codes', {
					body: { label: 'A', terminalCode: bad },
				})
				expect([400, 422]).toContain(r.status)
			}
			await pair({ terminalCode: 'T1' })
			const dup = await operator('POST', '/pairing-codes', {
				body: { label: 'B', terminalCode: 't1' },
			})
			expect(dup.status).toBe(409)
			expect(((await dup.json()) as { error: string }).error).toBe(
				'terminal_code_taken',
			)
			const pendingDup = await (async () => {
				await operator('POST', '/pairing-codes', {
					body: { label: 'C', terminalCode: 'T9' },
				})
				return operator('POST', '/pairing-codes', {
					body: { label: 'D', terminalCode: 'T9' },
				})
			})()
			expect(pendingDup.status).toBe(409)
		})

		it('frees a terminal code when its terminal is removed', async () => {
			const first = await pair({ terminalCode: 'T1' })
			expect(
				(await operator('DELETE', `/terminals/${first.device.id}`)).status,
			).toBe(200)
			const replacement = await pair({
				terminalCode: 'T1',
				label: 'Replacement',
			})
			expect(replacement.device.terminalCode).toBe('T1')
			expect(replacement.device.id).not.toBe(first.device.id)
		})

		it('caps unredeemed codes', async () => {
			for (let i = 0; i < 10; i++) {
				const r = await operator('POST', '/pairing-codes', {
					body: { label: `L${i}`, terminalCode: `C${i}` },
				})
				expect(r.status).toBe(201)
			}
			const over = await operator('POST', '/pairing-codes', {
				body: { label: 'x', terminalCode: 'CX' },
			})
			expect(over.status).toBe(409)
			expect(((await over.json()) as { error: string }).error).toBe(
				'too_many_pending_codes',
			)
		})

		it('only the redeeming org can use a code (an org-A code never opens org B)', async () => {
			const created = await operator('POST', '/pairing-codes', {
				body: { label: 'A', terminalCode: 'T1' },
			})
			const { code } = (await created.json()) as { code: string }
			const forged = code.replace(`.${ORG_A}.`, `.${ORG_B}.`)
			expect((await post('/pair', { code: forged })).status).toBe(401)
			const dbB = await getTenantDb(ORG_B)
			expect(await dbB.select().from(posDevices)).toHaveLength(0)
		})

		it('honors the kill switch for pairing and uploads, but looking and revoking still work while it is off', async () => {
			const { deviceSecret, device } = await pair()
			vi.stubEnv('POS_ENABLED', 'false')
			const code = await operator('POST', '/pairing-codes', {
				body: { label: 'A', terminalCode: 'T2' },
			})
			expect(code.status).toBe(503)
			expect((await upload(deviceSecret, wireOrder())).status).toBe(503)
			expect((await post('/pair', { code: 'ppc1.x.y' })).status).toBe(503)
			// A lost terminal can be removed even with the switch off.
			expect(
				(await operator('GET', '/terminals', { scope: 'orders:read' })).status,
			).toBe(200)
			expect(
				(await operator('GET', '/orders', { scope: 'orders:read' })).status,
			).toBe(200)
			expect((await operator('DELETE', `/terminals/${device.id}`)).status).toBe(
				200,
			)
			vi.stubEnv('POS_ENABLED', '')
			// And it stays removed when the switch comes back on.
			const after = await upload(deviceSecret, wireOrder({ number: 'T1-0002' }))
			expect(((await after.json()) as { error: string }).error).toBe(
				'device_revoked',
			)
		})
	})

	// -----------------------------------------------------------------------
	// Authentication of terminals and operators
	// -----------------------------------------------------------------------

	describe('authentication', () => {
		it('refuses missing, malformed and forged secrets with one answer', async () => {
			const { deviceSecret } = await pair()
			const tampered =
				deviceSecret.slice(0, -2) + (deviceSecret.endsWith('AA') ? 'BB' : 'AA')
			const parts = deviceSecret.split('.')
			const otherDevice = [
				parts[0],
				parts[1],
				'device-00000000',
				parts[3],
			].join('.')
			for (const token of [
				undefined,
				'',
				'nope',
				tampered,
				otherDevice,
				deviceSecret.replace('pdv1', 'kdv1'),
			]) {
				const r = await upload(token as string, wireOrder())
				expect(r.status).toBe(401)
				expect(await r.json()).toEqual({ error: 'invalid_device' })
			}
		})

		it('does not accept an operator token as a device secret, nor a device secret on operator routes', async () => {
			const { deviceSecret } = await pair()
			expect((await upload(await mintOperator(), wireOrder())).status).toBe(401)
			const asOperator = await app.request('/operator/pos/terminals', {
				headers: { authorization: `Bearer ${deviceSecret}` },
			})
			expect(asOperator.status).toBe(401)
		})

		it('keeps organizations apart: a device cannot touch another organization', async () => {
			const a = await pair({ orgId: ORG_A })
			const b = await pair({ orgId: ORG_B })
			const id = crypto.randomUUID()
			expect(
				(await upload(a.deviceSecret, wireOrder({ id, number: 'T1-0001' })))
					.status,
			).toBe(201)
			const dbB = await getTenantDb(ORG_B)
			expect(await dbB.select().from(posOrders)).toHaveLength(0)
			// B uploading the same order id is its own, separate record.
			expect(
				(await upload(b.deviceSecret, wireOrder({ id, number: 'T1-0001' })))
					.status,
			).toBe(201)
			// Operator lists are scoped to the token's organization.
			const listB = (await (
				await operator('GET', '/orders', { scope: 'orders:read', orgId: ORG_B })
			).json()) as {
				orders: unknown[]
			}
			expect(listB.orders).toHaveLength(1)
		})

		it('refuses a revoked terminal with a distinct code', async () => {
			const { deviceSecret, device } = await pair()
			expect((await upload(deviceSecret, wireOrder())).status).toBe(201)
			await operator('DELETE', `/terminals/${device.id}`)
			const r = await upload(deviceSecret, wireOrder({ number: 'T1-0002' }))
			expect(r.status).toBe(401)
			expect(await r.json()).toEqual({ error: 'device_revoked' })
			const me = await app.request('/pos/me', {
				headers: { authorization: `Bearer ${deviceSecret}` },
			})
			expect(((await me.json()) as { error: string }).error).toBe(
				'device_revoked',
			)
		})

		it('requires the right operator scope', async () => {
			expect(
				(
					await operator('POST', '/pairing-codes', {
						scope: 'orders:read',
						body: { label: 'A', terminalCode: 'T1' },
					})
				).status,
			).toBe(403)
			expect(
				(await operator('DELETE', '/terminals/x', { scope: 'orders:read' }))
					.status,
			).toBe(403)
			expect(
				(await operator('GET', '/terminals', { scope: 'orders:read' })).status,
			).toBe(200)
			const wrongScope = await app.request('/operator/pos/terminals', {
				headers: { authorization: `Bearer ${await mintOperator('mailbox')}` },
			})
			expect(wrongScope.status).toBe(403)
			const anonymous = await app.request('/operator/pos/terminals')
			expect(anonymous.status).toBe(401)
		})

		it('records which operator paired a terminal', async () => {
			await pair()
			const db = await getTenantDb(ORG_A)
			const [device] = await db.select().from(posDevices)
			expect(device!.pairedBy).toBe('user_manager_1')
		})

		it('rejects removing a terminal that does not exist or was already removed', async () => {
			const { device } = await pair()
			expect((await operator('DELETE', `/terminals/${device.id}`)).status).toBe(
				200,
			)
			expect((await operator('DELETE', `/terminals/${device.id}`)).status).toBe(
				404,
			)
			expect((await operator('DELETE', '/terminals/nope')).status).toBe(404)
		})
	})

	// -----------------------------------------------------------------------
	// Order upload
	// -----------------------------------------------------------------------

	describe('order upload', () => {
		it('stores an open tab with what the till rang up', async () => {
			const { deviceSecret } = await pair()
			const order = wireOrder({ lines: [{ ...BURGER, quantity: 2 }, FRIES] })
			const r = await upload(deviceSecret, order)
			expect(r.status).toBe(201)
			const body = (await r.json()) as {
				result: string
				order: Record<string, unknown>
			}
			expect(body.result).toBe('created')
			expect(body.order).toMatchObject({
				id: order.id,
				status: 'open',
				revision: 1,
				totalCents: order.totals.totalCents,
				tableLabel: '12',
				currency: 'USD',
				locationName: 'Main Street',
				reviewReason: null,
				payments: [],
			})
		})

		it('is idempotent: a replay stores nothing new and answers with what is stored', async () => {
			const { deviceSecret } = await pair()
			const order = wireOrder({ payments: [{ amountCents: 1083 }] })
			const first = await upload(deviceSecret, order)
			expect(first.status).toBe(201)
			const replay = await upload(deviceSecret, order)
			expect(replay.status).toBe(200)
			expect(((await replay.json()) as { result: string }).result).toBe(
				'replay',
			)
			const db = await getTenantDb(ORG_A)
			expect(await db.select().from(posOrders)).toHaveLength(1)
			expect(await db.select().from(posPayments)).toHaveLength(1)
		})

		it('records the full life of a tab: open, items added, split payments, closed', async () => {
			const { deviceSecret } = await pair()
			const id = crypto.randomUUID()
			const lines1 = [BURGER]
			expect(
				(
					await upload(
						deviceSecret,
						wireOrder({ id, revision: 1, lines: lines1 }),
					)
				).status,
			).toBe(201)
			// Guest orders fries: revision 2, still open.
			const lines2 = [BURGER, FRIES]
			const r2 = await upload(
				deviceSecret,
				wireOrder({ id, revision: 2, lines: lines2 }),
			)
			expect(r2.status).toBe(200)
			const total = wireOrder({ lines: lines2 }).totals.totalCents
			// Part paid in cash, then the rest on a card.
			const p1 = {
				id: crypto.randomUUID(),
				amountCents: 1000,
				tenderedCents: 1000,
			}
			const r3 = await upload(
				deviceSecret,
				wireOrder({ id, revision: 3, lines: lines2, payments: [p1] }),
			)
			expect(r3.status).toBe(200)
			expect(
				((await r3.json()) as { order: { status: string } }).order.status,
			).toBe('open')
			const p2 = {
				id: crypto.randomUUID(),
				method: 'card' as const,
				amountCents: total - 1000,
			}
			const r4 = await upload(
				deviceSecret,
				wireOrder({ id, revision: 4, lines: lines2, payments: [p1, p2] }),
			)
			const done = (await r4.json()) as {
				order: { status: string; paidAt: number; payments: unknown[] }
			}
			expect(done.order.status).toBe('paid')
			expect(done.order.payments).toHaveLength(2)
			expect(done.order.paidAt).toBeGreaterThan(0)
		})

		it('ignores an older revision that arrives late (uploads can reorder)', async () => {
			const { deviceSecret } = await pair()
			const id = crypto.randomUUID()
			await upload(
				deviceSecret,
				wireOrder({ id, revision: 1, lines: [BURGER] }),
			)
			await upload(
				deviceSecret,
				wireOrder({ id, revision: 2, lines: [BURGER, FRIES] }),
			)
			const stale = await upload(
				deviceSecret,
				wireOrder({ id, revision: 1, lines: [BURGER] }),
			)
			expect(stale.status).toBe(200)
			const body = (await stale.json()) as {
				result: string
				order: { revision: number; lines: unknown[] }
			}
			expect(body.result).toBe('replay')
			expect(body.order.revision).toBe(2)
			expect(body.order.lines).toHaveLength(2)
		})

		it('refuses to change or remove a payment it already holds', async () => {
			const { deviceSecret } = await pair()
			const id = crypto.randomUUID()
			const total = wireOrder().totals.totalCents
			const p1 = { id: crypto.randomUUID(), amountCents: 500 }
			await upload(deviceSecret, wireOrder({ id, revision: 1, payments: [p1] }))
			const dropped = await upload(
				deviceSecret,
				wireOrder({ id, revision: 2, payments: [] }),
			)
			await expectHeld(dropped, 'payments_changed')
			const altered = await upload(
				deviceSecret,
				wireOrder({ id, revision: 3, payments: [{ ...p1, amountCents: 400 }] }),
			)
			await expectHeld(altered, 'payments_changed')
			const retyped = await upload(
				deviceSecret,
				wireOrder({ id, revision: 4, payments: [{ ...p1, method: 'card' }] }),
			)
			await expectHeld(retyped, 'payments_changed')
			void total
			const db = await getTenantDb(ORG_A)
			const rows = await db.select().from(posPayments)
			expect(rows).toHaveLength(1)
			expect(rows[0]!.amountCents).toBe(500)
			// Nothing the till sent is lost: each refused revision is kept for a person.
			expect(await db.select().from(posHeldUploads)).toHaveLength(3)
		})

		it('freezes the bill once a payment exists', async () => {
			const { deviceSecret } = await pair()
			const id = crypto.randomUUID()
			const p1 = { id: crypto.randomUUID(), amountCents: 500 }
			await upload(deviceSecret, wireOrder({ id, revision: 1, payments: [p1] }))
			const edited = await upload(
				deviceSecret,
				wireOrder({ id, revision: 2, lines: [BURGER, FRIES], payments: [p1] }),
			)
			await expectHeld(edited, 'paid_order_changed')
		})

		it('keeps a closed order closed', async () => {
			const { deviceSecret } = await pair()
			const id = crypto.randomUUID()
			const total = wireOrder().totals.totalCents
			await upload(
				deviceSecret,
				wireOrder({ id, revision: 1, payments: [{ amountCents: total }] }),
			)
			const reopen = await upload(deviceSecret, wireOrder({ id, revision: 2 }))
			await expectHeld(reopen, 'payments_changed')
			// A cancelled tab is closed too.
			const voidId = crypto.randomUUID()
			await upload(
				deviceSecret,
				wireOrder({ id: voidId, number: 'T1-0002', revision: 1 }),
			)
			expect(
				(
					await upload(
						deviceSecret,
						wireOrder({
							id: voidId,
							number: 'T1-0002',
							revision: 2,
							status: 'void',
						}),
					)
				).status,
			).toBe(200)
			const after = await upload(
				deviceSecret,
				wireOrder({ id: voidId, number: 'T1-0002', revision: 3 }),
			)
			await expectHeld(after, 'order_closed')
		})

		it('records a cancelled tab', async () => {
			const { deviceSecret } = await pair()
			const id = crypto.randomUUID()
			await upload(deviceSecret, wireOrder({ id, revision: 1 }))
			const r = await upload(
				deviceSecret,
				wireOrder({ id, revision: 2, status: 'void' }),
			)
			const body = (await r.json()) as {
				order: { status: string; voidedAt: number }
			}
			expect(body.order.status).toBe('void')
			expect(body.order.voidedAt).toBeGreaterThan(0)
		})

		it("keeps one terminal from overwriting another's order, or reusing a number", async () => {
			const t1 = await pair({ terminalCode: 'T1' })
			const t2 = await pair({ terminalCode: 'T2' })
			const id = crypto.randomUUID()
			await upload(t1.deviceSecret, wireOrder({ id, number: 'T1-0001' }))
			const hijack = await upload(
				t2.deviceSecret,
				wireOrder({ id, revision: 2, number: 'T2-0001' }),
			)
			await expectHeld(hijack, 'order_id_conflict')

			const dupNumber = await upload(
				t1.deviceSecret,
				wireOrder({ number: 'T1-0001' }),
			)
			expect(dupNumber.status).toBe(409)
			expect(((await dupNumber.json()) as { error: string }).error).toBe(
				'number_conflict',
			)
			// Different terminals may each have a number the other also used.
			expect(
				(await upload(t2.deviceSecret, wireOrder({ number: 'T1-0001' })))
					.status,
			).toBe(201)
		})

		it('a re-paired terminal continues the tabs its predecessor started', async () => {
			const first = await pair({ terminalCode: 'T1' })
			const id = crypto.randomUUID()
			expect(
				(await upload(first.deviceSecret, wireOrder({ id, revision: 1 })))
					.status,
			).toBe(201)
			await operator('DELETE', `/terminals/${first.device.id}`)
			const second = await pair({ terminalCode: 'T1', label: 'Replacement' })
			const total = wireOrder().totals.totalCents
			const r = await upload(
				second.deviceSecret,
				wireOrder({ id, revision: 2, payments: [{ amountCents: total }] }),
			)
			expect(r.status).toBe(200)
			const body = (await r.json()) as {
				order: { status: string; deviceId: string; payments: unknown[] }
			}
			// The replacement owns the tab from now on.
			expect(body.order).toMatchObject({
				status: 'paid',
				deviceId: second.device.id,
			})
			expect(body.order.payments).toHaveLength(1)
			const db = await getTenantDb(ORG_A)
			expect(await db.select().from(posOrders)).toHaveLength(1)
		})

		it('but never takes over an order that belongs to a terminal that is still active', async () => {
			const a = await pair({ terminalCode: 'T1' })
			const b = await pair({ terminalCode: 'T2' })
			const id = crypto.randomUUID()
			await upload(a.deviceSecret, wireOrder({ id, revision: 1 }))
			const r = await upload(b.deviceSecret, wireOrder({ id, revision: 2 }))
			await expectHeld(r, 'order_id_conflict')
		})

		it('takes many payments in one revision (split bill taken offline), within the database parameter limit', async () => {
			const { deviceSecret } = await pair()
			const base = wireOrder({ lines: [{ ...BURGER, quantity: 15 }] })
			const total = base.totals.totalCents
			const share = Math.floor(total / 15)
			const payments = Array.from({ length: 15 }, (_, i) => ({
				amountCents: i === 14 ? total - share * 14 : share,
			}))
			const r = await upload(
				deviceSecret,
				wireOrder({ lines: [{ ...BURGER, quantity: 15 }], payments }),
			)
			expect(r.status).toBe(201)
			const body = (await r.json()) as {
				order: { status: string; payments: unknown[] }
			}
			expect(body.order.status).toBe('paid')
			expect(body.order.payments).toHaveLength(15)
		})

		it('a paid bill is frozen in every part: tax, adjustments and order type, not only lines and total', async () => {
			const { deviceSecret } = await pair()
			const id = crypto.randomUUID()
			const p1 = { id: crypto.randomUUID(), amountCents: 500 }
			const first = wireOrder({ id, revision: 1, payments: [p1] })
			await upload(deviceSecret, first)
			const moved = {
				...first,
				revision: 2,
				totals: {
					...first.totals,
					taxCents: first.totals.taxCents + 10,
					subtotalCents: first.totals.subtotalCents - 10,
				},
			}
			// Same total, different split between subtotal and tax.
			expect(moved.totals.totalCents).toBe(first.totals.totalCents)
			const r1 = await upload(deviceSecret, moved)
			// Subtotal no longer matches the lines: unreadable as an order, held as sent.
			await expectHeld(r1, 'invalid_request')
			const retyped = await upload(deviceSecret, {
				...first,
				revision: 3,
				orderType: 'takeaway',
			})
			await expectHeld(retyped, 'paid_order_changed')
		})

		it('flags a wrong till clock instead of trusting it silently', async () => {
			const { deviceSecret } = await pair()
			const old = {
				...wireOrder({ number: 'T1-0001' }),
				createdAt: '2020-01-01T00:00:00.000Z',
			}
			const future = {
				...wireOrder({ number: 'T1-0002' }),
				createdAt: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString(),
			}
			for (const order of [old, future]) {
				const r = await upload(deviceSecret, order)
				expect(r.status).toBe(201)
				expect(
					((await r.json()) as { order: { reviewReason: string } }).order
						.reviewReason,
				).toBe('clock_skew')
			}
			const fine = await upload(deviceSecret, wireOrder({ number: 'T1-0003' }))
			expect(
				((await fine.json()) as { order: { reviewReason: string | null } })
					.order.reviewReason,
			).toBeNull()
		})

		it('numbers restart each day: the same number on a new business day is a different order', async () => {
			const { deviceSecret } = await pair()
			expect(
				(
					await upload(
						deviceSecret,
						wireOrder({ number: 'T1-0001', businessDate: '2026-10-21' }),
					)
				).status,
			).toBe(201)
			expect(
				(
					await upload(
						deviceSecret,
						wireOrder({ number: 'T1-0001', businessDate: '2026-10-22' }),
					)
				).status,
			).toBe(201)
			const same = await upload(
				deviceSecret,
				wireOrder({ number: 'T1-0001', businessDate: '2026-10-22' }),
			)
			expect(same.status).toBe(409)
			expect(((await same.json()) as { error: string }).error).toBe(
				'number_conflict',
			)
			const db = await getTenantDb(ORG_A)
			expect(await db.select().from(posOrders)).toHaveLength(2)
		})

		it('on a number collision it offers the next free number for that terminal and day', async () => {
			const t1 = await pair({ terminalCode: 'T1' })
			const t2 = await pair({ terminalCode: 'T2' })
			for (const n of ['T1-0001', 'T1-0002', 'T1-0009'])
				await upload(t1.deviceSecret, wireOrder({ number: n }))
			await upload(
				t1.deviceSecret,
				wireOrder({ number: 'T1-0050', businessDate: '2026-10-22' }),
			)
			await upload(t2.deviceSecret, wireOrder({ number: 'T1-0500' })) // another terminal's history is not ours
			const clash = await upload(
				t1.deviceSecret,
				wireOrder({ number: 'T1-0002' }),
			)
			expect(clash.status).toBe(409)
			expect(await clash.json()).toMatchObject({
				error: 'number_conflict',
				nextNumber: 'T1-0010',
			})
			// Offered numbers really are free.
			expect(
				(await upload(t1.deviceSecret, wireOrder({ number: 'T1-0010' })))
					.status,
			).toBe(201)
		})

		it('an order with adjustments is stored without a comparable server total and no false tax flag', async () => {
			const { deviceSecret } = await pair()
			const order = wireOrder()
			const adjustment = 230
			const subtotal = order.totals.subtotalCents
			const taxCents = Math.round(((subtotal - adjustment) * TAX) / 100)
			const adjusted = {
				...order,
				adjustments: [
					{
						id: 'd1',
						kind: 'discount',
						label: '10% off',
						amountCents: adjustment,
					},
				],
				totals: {
					...order.totals,
					adjustmentCents: adjustment,
					taxCents,
					totalCents: subtotal - adjustment + taxCents,
				},
			}
			const r = await upload(deviceSecret, adjusted)
			expect(r.status).toBe(201)
			const body = (await r.json()) as {
				order: { serverTotalCents: number | null; reviewReason: string | null }
			}
			expect(body.order.serverTotalCents).toBeNull()
			expect(body.order.reviewReason).toBeNull()
		})

		it('an order cannot be renumbered or moved to another day by a later revision', async () => {
			const { deviceSecret } = await pair()
			const id = crypto.randomUUID()
			await upload(
				deviceSecret,
				wireOrder({ id, revision: 1, number: 'T1-0001' }),
			)
			for (const change of [
				{ number: 'T1-0099' },
				{ businessDate: '2026-10-22' },
			]) {
				const r = await upload(
					deviceSecret,
					wireOrder({ id, revision: 2, ...change }),
				)
				await expectHeld(r, 'order_identity_changed')
			}
		})

		it('does not let a payment id be reused on another order', async () => {
			const { deviceSecret } = await pair()
			const shared = crypto.randomUUID()
			const total = wireOrder().totals.totalCents
			await upload(
				deviceSecret,
				wireOrder({
					number: 'T1-0001',
					payments: [{ id: shared, amountCents: total }],
				}),
			)
			const r = await upload(
				deviceSecret,
				wireOrder({
					number: 'T1-0002',
					payments: [{ id: shared, amountCents: total }],
				}),
			)
			await expectHeld(r, 'payment_id_conflict')
		})

		it('holds arithmetic that does not add up, and unknown fields, for review without storing an order', async () => {
			const { deviceSecret } = await pair()
			const good = wireOrder()
			const cases: unknown[] = [
				{
					...good,
					totals: { ...good.totals, totalCents: good.totals.totalCents - 100 },
				},
				{ ...good, totals: { ...good.totals, subtotalCents: 1 } },
				{ ...good, status: 'paid' },
				{ ...good, customerPhone: '+15551234567' },
				{ ...good, id: 'not-a-uuid' },
				{ ...good, lines: [] },
				'{',
			]
			for (const body of cases) {
				const r = await upload(deviceSecret, body)
				await expectHeld(r, 'invalid_request')
			}
			const db = await getTenantDb(ORG_A)
			expect(await db.select().from(posOrders)).toHaveLength(0)
			// Kept verbatim (an unknown field may be a newer till's), never dropped.
			const held = await db.select().from(posHeldUploads)
			expect(held.length).toBeGreaterThanOrEqual(cases.length - 1)
			expect(held.some((h) => h.payload.includes('customerPhone'))).toBe(true)
		})

		it('refuses an oversized body', async () => {
			const { deviceSecret } = await pair()
			const r = await app.request('/pos/orders', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${deviceSecret}`,
					'content-type': 'application/json',
					'content-length': '999999',
				},
				body: '{}',
			})
			expect(r.status).toBe(413)
		})

		it('keeps a terminal paired to one location to that location', async () => {
			const { deviceSecret } = await pair({ locationId: 'loc-1' })
			const wrong = await upload(
				deviceSecret,
				wireOrder({ locationId: 'loc-2' }),
			)
			await expectHeld(wrong, 'wrong_location')
			expect(
				(await upload(deviceSecret, wireOrder({ locationId: 'loc-1' }))).status,
			).toBe(201)
		})

		it('a till bound to a location later still uploads the orders it started before', async () => {
			const { deviceSecret, device } = await pair({ locationId: null })
			const tab = wireOrder({ locationId: 'loc-2' })
			expect((await upload(deviceSecret, tab)).status).toBe(201)
			// A manager binds the till to loc-1 (as PATCH does) after the tab was opened.
			const db = await getTenantDb(ORG_A)
			await db
				.update(posDevices)
				.set({
					locationId: 'loc-1',
					locationBoundAt: Date.parse(tab.createdAt) + 1,
				})
				.where(eq(posDevices.id, device.id))
			const settled = await upload(deviceSecret, {
				...wireOrder({
					id: tab.id,
					locationId: 'loc-2',
					revision: 2,
					payments: [{ amountCents: tab.totals.totalCents }],
				}),
				createdAt: tab.createdAt,
			})
			expect(settled.status).toBeLessThan(300)
			// Anything started after the binding belongs to the bound location.
			const later = {
				...wireOrder({ locationId: 'loc-2' }),
				createdAt: new Date(Date.now() + 60_000).toISOString(),
			}
			await expectHeld(await upload(deviceSecret, later), 'wrong_location')
		})

		it('takes sales while online ordering is closed, with kitchen notes the menu disables online', async () => {
			contextFor = (orgId) => menuContext(orgId, { onlineClosed: true })
			const { deviceSecret } = await pair()
			const order = wireOrder({
				lines: [{ ...BURGER, instructions: 'no pickles' }],
			})
			const r = await upload(deviceSecret, order)
			expect(r.status).toBe(201)
			expect(
				((await r.json()) as { order: { reviewReason: string | null } }).order
					.reviewReason,
			).toBeNull()
		})

		it('supports a tip and records it without affecting the menu comparison', async () => {
			const { deviceSecret } = await pair()
			const order = wireOrder({
				tipCents: 250,
				payments: [
					{ amountCents: wireOrder({ tipCents: 250 }).totals.totalCents },
				],
			})
			const r = await upload(deviceSecret, order)
			expect(r.status).toBe(201)
			const body = (await r.json()) as {
				order: { tipCents: number; reviewReason: string | null; status: string }
			}
			expect(body.order).toMatchObject({
				tipCents: 250,
				reviewReason: null,
				status: 'paid',
			})
		})

		it('treats tax-exempt options as the engine does (no false review flag)', async () => {
			const { deviceSecret } = await pair()
			const order = wireOrder({
				lines: [
					{
						...BURGER,
						options: [
							BURGER.options![0]!,
							{
								groupId: 'grp-top',
								optionId: 'opt-cheese',
								optionName: 'Cheese',
								unitCents: 100,
							},
							{
								groupId: 'grp-top',
								optionId: 'opt-donate',
								optionName: 'Donation',
								unitCents: 100,
								taxable: false,
							},
						],
					},
				],
			})
			const r = await upload(deviceSecret, order)
			expect(r.status).toBe(201)
			expect(
				((await r.json()) as { order: { reviewReason: string | null } }).order
					.reviewReason,
			).toBeNull()
		})
	})

	// -----------------------------------------------------------------------
	// Menu drift: what was collected is kept, a person is told
	// -----------------------------------------------------------------------

	describe('menu drift', () => {
		it('keeps the sale and flags it when the menu price changed since the till cached it', async () => {
			const { deviceSecret } = await pair()
			const stale = wireOrder({
				lines: [{ ...BURGER, baseCents: 900 }],
				payments: [
					{
						amountCents: wireOrder({ lines: [{ ...BURGER, baseCents: 900 }] })
							.totals.totalCents,
					},
				],
			})
			const r = await upload(deviceSecret, stale)
			expect(r.status).toBe(201)
			const body = (await r.json()) as {
				order: {
					reviewReason: string
					totalCents: number
					serverTotalCents: number
				}
			}
			expect(body.order.reviewReason).toBe('price_mismatch')
			// The money collected stays authoritative; the live figure is kept beside it.
			expect(body.order.totalCents).toBe(stale.totals.totalCents)
			expect(body.order.serverTotalCents).toBe(
				wireOrder().totals.subtotalCents + wireOrder().totals.taxCents,
			)
		})

		it('keeps the sale and flags it when an item has since left the menu', async () => {
			const { deviceSecret } = await pair()
			const gone: LineSpec = {
				itemId: 'item-removed',
				name: 'Seasonal Special',
				baseCents: 1500,
			}
			const r = await upload(deviceSecret, wireOrder({ lines: [gone] }))
			expect(r.status).toBe(201)
			expect(
				((await r.json()) as { order: { reviewReason: string } }).order
					.reviewReason,
			).toBe('catalog:unknown_item')
		})

		it('flags a tax mismatch when the rate changed', async () => {
			const { deviceSecret } = await pair()
			const order = wireOrder()
			order.totals = {
				...order.totals,
				taxCents: order.totals.taxCents + 5,
				totalCents: order.totals.totalCents + 5,
			}
			const r = await upload(deviceSecret, order)
			expect(r.status).toBe(201)
			expect(
				((await r.json()) as { order: { reviewReason: string } }).order
					.reviewReason,
			).toBe('tax_mismatch')
		})

		it('flags an unknown location rather than losing the sale', async () => {
			const { deviceSecret } = await pair()
			const r = await upload(
				deviceSecret,
				wireOrder({ locationId: 'loc-gone' }),
			)
			expect(r.status).toBe(201)
			expect(
				((await r.json()) as { order: { reviewReason: string } }).order
					.reviewReason,
			).toBe('catalog:location_not_found')
		})

		it('stores the sale for review, rather than holding it on the tablet, when the menu cannot be checked', async () => {
			const { deviceSecret } = await pair()
			contextStatus = 503
			const order = wireOrder()
			const r = await upload(deviceSecret, order)
			expect(r.status).toBe(201)
			const body = (await r.json()) as {
				order: {
					reviewReason: string
					serverTotalCents: number | null
					totalCents: number
				}
			}
			expect(body.order).toMatchObject({
				reviewReason: 'unverified',
				serverTotalCents: null,
				totalCents: order.totals.totalCents,
			})
			// The flag stays until a person has looked: a later clean revision does not hide it.
			contextStatus = 200
			const next = await upload(deviceSecret, {
				...wireOrder({
					id: order.id,
					number: order.number,
					lines: [BURGER, FRIES],
				}),
				revision: 2,
			})
			expect(
				((await next.json()) as { order: { reviewReason: string | null } })
					.order.reviewReason,
			).toBe('unverified')
		})

		it('a replay or a cancellation needs no menu check, so an outage never blocks them', async () => {
			const { deviceSecret } = await pair()
			const tab = wireOrder()
			expect((await upload(deviceSecret, tab)).status).toBe(201)
			contextStatus = 503
			const replay = await upload(deviceSecret, tab)
			expect(replay.status).toBe(200)
			expect(((await replay.json()) as { result: string }).result).toBe(
				'replay',
			)
			const cancelled = await upload(deviceSecret, {
				...tab,
				revision: 2,
				status: 'void',
			})
			expect(cancelled.status).toBe(200)
			expect(
				(
					(await cancelled.json()) as {
						order: { status: string; reviewReason: string | null }
					}
				).order,
			).toMatchObject({ status: 'void', reviewReason: null })
		})

		it('keeps the first flag when a later revision matches the live menu, and every verdict in the history', async () => {
			const { deviceSecret } = await pair()
			const id = crypto.randomUUID()
			await upload(
				deviceSecret,
				wireOrder({ id, revision: 1, lines: [{ ...BURGER, baseCents: 900 }] }),
			)
			const fixed = await upload(
				deviceSecret,
				wireOrder({ id, revision: 2, lines: [BURGER] }),
			)
			expect(
				((await fixed.json()) as { order: { reviewReason: string | null } })
					.order.reviewReason,
			).toBe('price_mismatch')
			const history = (await (
				await operator('GET', `/orders/${id}/revisions`, {
					scope: 'orders:read',
				})
			).json()) as {
				revisions: Array<{ revision: number; reviewReason: string | null }>
			}
			expect(
				history.revisions.map((r) => [r.revision, r.reviewReason]),
			).toEqual([
				[1, 'price_mismatch'],
				[2, null],
			])
		})
	})

	// -----------------------------------------------------------------------
	// Operator views
	// -----------------------------------------------------------------------

	describe('operator views', () => {
		it('lists terminals with last-seen and revocation state', async () => {
			const { deviceSecret, device } = await pair()
			await upload(deviceSecret, wireOrder())
			const listed = (await (
				await operator('GET', '/terminals', { scope: 'orders:read' })
			).json()) as {
				devices: Array<{
					id: string
					lastSeenAt: number
					revokedAt: number | null
					terminalCode: string
				}>
			}
			expect(listed.devices).toHaveLength(1)
			expect(listed.devices[0]).toMatchObject({
				id: device.id,
				terminalCode: 'T1',
				revokedAt: null,
			})
			expect(JSON.stringify(listed)).not.toContain('secret')
		})

		it('lists orders newest first, filters by status, and surfaces the ones to review', async () => {
			const { deviceSecret } = await pair()
			const total = wireOrder().totals.totalCents
			await upload(
				deviceSecret,
				wireOrder({ number: 'T1-0001', payments: [{ amountCents: total }] }),
			)
			await upload(deviceSecret, wireOrder({ number: 'T1-0002' }))
			await upload(
				deviceSecret,
				wireOrder({
					number: 'T1-0003',
					lines: [{ ...BURGER, baseCents: 900 }],
				}),
			)
			const get = async (query = '') =>
				(
					(await (
						await operator('GET', `/orders${query}`, { scope: 'orders:read' })
					).json()) as {
						orders: Array<{
							number: string
							status: string
							payments: unknown[]
						}>
					}
				).orders
			expect((await get()).map((o) => o.number)).toHaveLength(3)
			expect((await get('?status=paid')).map((o) => o.number)).toEqual([
				'T1-0001',
			])
			expect((await get('?status=open')).map((o) => o.number).sort()).toEqual([
				'T1-0002',
				'T1-0003',
			])
			expect((await get('?review=1')).map((o) => o.number)).toEqual(['T1-0003'])
			expect((await get('?status=paid'))[0]!.payments).toHaveLength(1)
			const bad = await operator('GET', '/orders?status=nonsense', {
				scope: 'orders:read',
			})
			expect(bad.status).toBe(400)
		})
	})

	describe('large lists', () => {
		it('lists more orders than one SQL statement can bind (130 orders with payments)', async () => {
			const { device } = await pair()
			const db = await getTenantDb(ORG_A)
			const now = Date.now()
			const ids = Array.from({ length: 130 }, () => crypto.randomUUID())
			for (const [index, id] of ids.entries()) {
				await db.insert(posOrders).values({
					id,
					deviceId: device.id,
					number: `T1-${String(index).padStart(4, '0')}`,
					businessDate: '2026-10-21',
					revision: 1,
					status: 'paid',
					orderType: 'dine_in',
					locationId: 'loc-1',
					currency: 'USD',
					subtotalCents: 1000,
					taxCents: 83,
					totalCents: 1083,
					lines: [],
					adjustments: [],
					rungUpAt: now - index,
				})
				await db.insert(posPayments).values({
					id: crypto.randomUUID(),
					orderId: id,
					deviceId: device.id,
					method: 'cash',
					amountCents: 1083,
					tenderedCents: 1083,
					paidAt: now,
				})
			}
			const listed = (await (
				await operator('GET', '/orders?limit=200', { scope: 'orders:read' })
			).json()) as {
				orders: Array<{ payments: unknown[] }>
			}
			expect(listed.orders).toHaveLength(130)
			expect(listed.orders.every((o) => o.payments.length === 1)).toBe(true)
		})
	})

	// -----------------------------------------------------------------------
	// Staff sign-in
	// -----------------------------------------------------------------------

	describe('staff sign-in', () => {
		it('a staff PIN names the person: first name and last initial, never the PIN', async () => {
			const { deviceSecret } = await pair({ signInRequired: true })
			const id = await addStaff({ first: 'Ana', last: 'Karim', pin: '4321' })
			const r = await signIn(deviceSecret, '4321')
			expect(r.status).toBe(200)
			const body = (await r.json()) as {
				staff: { id: string; name: string }
				role: string
				sessionToken: string
				sessionExpiresAt: number
			}
			expect(body).toEqual({
				staff: { id, name: 'Ana K.' },
				role: 'cashier',
				// Proof of this sign-in for the Station apps (reservations).
				sessionToken: expect.any(String),
				sessionExpiresAt: expect.any(Number),
			})
			expect(JSON.stringify(body)).not.toContain('4321')
		})

		it('a person designated a manager signs in as one', async () => {
			const { deviceSecret } = await pair({ signInRequired: true })
			await addStaff({
				first: 'Lina',
				last: 'Mansour',
				pin: '9999',
				manager: true,
			})
			expect(
				(
					(await (await signIn(deviceSecret, '9999')).json()) as {
						role: string
					}
				).role,
			).toBe('manager')
		})

		it('a wrong PIN is refused without saying who it nearly was', async () => {
			const { deviceSecret } = await pair({ signInRequired: true })
			await addStaff({ pin: '4321' })
			const r = await signIn(deviceSecret, '1111')
			expect(r.status).toBe(401)
			expect(await r.json()).toMatchObject({ error: 'invalid_pin' })
			// Same answer for something that cannot be a PIN at all.
			for (const bad of ['', '12', 'abcd', '1234567', 12]) {
				const x = await post('/sign-in', { pin: bad }, deviceSecret)
				expect(x.status).toBe(401)
			}
		})

		it('slows the terminal down after repeated wrong PINs, and then refuses even the right one', async () => {
			const { deviceSecret } = await pair({ signInRequired: true })
			await addStaff({ pin: '4321' })
			for (let i = 0; i < 5; i++)
				expect((await signIn(deviceSecret, '0000')).status).toBe(401)
			const during = await signIn(deviceSecret, '4321')
			expect(during.status).toBe(429)
			const body = (await during.json()) as {
				error: string
				retryAfterSeconds: number
			}
			expect(body.error).toBe('backoff')
			expect(body.retryAfterSeconds).toBeGreaterThan(0)
			expect(Number(during.headers.get('retry-after'))).toBeGreaterThan(0)
		})

		it('the backoff belongs to one terminal, not the whole restaurant', async () => {
			const a = await pair({ terminalCode: 'T1', signInRequired: true })
			const b = await pair({ terminalCode: 'T2', signInRequired: true })
			await addStaff({ pin: '4321' })
			for (let i = 0; i < 6; i++) await signIn(a.deviceSecret, '0000')
			expect((await signIn(a.deviceSecret, '4321')).status).toBe(429)
			expect((await signIn(b.deviceSecret, '4321')).status).toBe(200)
		})

		it('a correct PIN forgives one mistake, not all: guesses cannot be reset by mixing in a known PIN', async () => {
			const { deviceSecret } = await pair({ signInRequired: true })
			await addStaff({ pin: '4321' })
			for (let i = 0; i < 4; i++)
				expect((await signIn(deviceSecret, '0000')).status).toBe(401) // still free
			expect((await signIn(deviceSecret, '4321')).status).toBe(200) // forgives one: 4 -> 3
			expect((await signIn(deviceSecret, '0000')).status).toBe(401) // 4
			expect((await signIn(deviceSecret, '0000')).status).toBe(401) // 5: the delay starts here
			expect((await signIn(deviceSecret, '4321')).status).toBe(429) // even the right PIN waits
		})

		it('refuses people who are not active, or not assigned here, or in another workplace or restaurant', async () => {
			const { deviceSecret } = await pair({ signInRequired: true })
			await addStaff({
				first: 'On',
				last: 'Leave',
				pin: '1001',
				status: 'on_leave',
			})
			await addStaff({
				first: 'Gone',
				last: 'Away',
				pin: '1002',
				status: 'terminated',
			})
			await addStaff({
				first: 'Not',
				last: 'Assigned',
				pin: '1003',
				assignmentActive: false,
			})
			await addStaff({
				first: 'Other',
				last: 'Place',
				pin: '1004',
				scopeId: 'patio',
			})
			await addStaff({ first: 'Other', last: 'Org', pin: '1005', orgId: ORG_B })
			for (const pin of ['1001', '1002', '1003', '1004', '1005']) {
				expect((await signIn(deviceSecret, pin)).status, pin).toBe(401)
			}
		})

		it("a terminal paired to a workplace signs in that workplace's people", async () => {
			// A workplace is real once someone is assigned to it.
			await addStaff({
				first: 'Pat',
				last: 'Io',
				pin: '5555',
				scopeId: 'patio',
			})
			const created = await operator('POST', '/pairing-codes', {
				body: { label: 'Patio', terminalCode: 'PAT', scopeId: 'patio' },
			})
			const { code } = (await created.json()) as { code: string }
			const paired = (await (await post('/pair', { code })).json()) as {
				deviceSecret: string
				device: { scopeId: string }
			}
			expect(paired.device.scopeId).toBe('patio')
			await addStaff({ first: 'Main', last: 'Room', pin: '6666' })
			expect((await signIn(paired.deviceSecret, '5555')).status).toBe(200)
			expect((await signIn(paired.deviceSecret, '6666')).status).toBe(401)
		})

		it("needs the terminal's own secret, and says so when sign-in is switched off", async () => {
			expect((await post('/sign-in', { pin: '4321' })).status).toBe(401)
			expect((await signIn('pdv1.nope', '4321')).status).toBe(401)
			const off = await pairWith({ signInRequired: false, terminalCode: 'T3' })
			expect((await signIn(off.deviceSecret, '4321')).status).toBe(409)
		})

		it('the terminal learns its settings when it checks in', async () => {
			const on = await pair({ terminalCode: 'T1', signInRequired: true })
			const off = await pairWith({ signInRequired: false, terminalCode: 'T2' })
			const me = async (secret: string) =>
				(
					(await (
						await app.request('/pos/me', {
							headers: { authorization: `Bearer ${secret}` },
						})
					).json()) as { device: { signInRequired: boolean; scopeId: string } }
				).device
			expect(await me(on.deviceSecret)).toMatchObject({
				signInRequired: true,
				scopeId: 'main',
			})
			expect(await me(off.deviceSecret)).toMatchObject({
				signInRequired: false,
			})
		})

		it('a manager can switch sign-in on or off for an existing terminal', async () => {
			const { device, deviceSecret } = await pair({ signInRequired: true })
			expect(
				(
					await operator('PATCH', `/terminals/${device.id}`, {
						body: { signInRequired: false },
					})
				).status,
			).toBe(200)
			expect((await signIn(deviceSecret, '4321')).status).toBe(409)
			expect(
				(
					await operator('PATCH', `/terminals/${device.id}`, {
						body: { signInRequired: true },
					})
				).status,
			).toBe(200)
			expect(
				(
					await operator('PATCH', `/terminals/${device.id}`, {
						scope: 'orders:read',
						body: { signInRequired: false },
					})
				).status,
			).toBe(403)
			expect(
				(
					await operator('PATCH', '/terminals/nope', {
						body: { signInRequired: true },
					})
				).status,
			).toBe(404)
			expect(
				(
					await operator('PATCH', `/terminals/${device.id}`, {
						body: { signInRequired: 'maybe' },
					})
				).status,
			).toBe(400)
		})

		it('a terminal that already existed before sign-in was added keeps working unlocked', async () => {
			const { device } = await pair({ signInRequired: true })
			const db = await getTenantDb(ORG_A)
			await db
				.update(posDevices)
				.set({ signInRequired: false })
				.where(eq(posDevices.id, device.id))
			const listed = (await (
				await operator('GET', '/terminals', { scope: 'orders:read' })
			).json()) as { devices: Array<{ signInRequired: boolean }> }
			expect(listed.devices[0]!.signInRequired).toBe(false)
		})
	})

	describe('who may manage a till', () => {
		it("lists the workplace's staff with who has a PIN and who is a manager", async () => {
			await addStaff({
				first: 'Ana',
				last: 'Karim',
				pin: '1111',
				manager: true,
			})
			await addStaff({ first: 'Omar', last: 'Rahman', pin: null })
			await addStaff({
				first: 'Gone',
				last: 'Away',
				pin: '2222',
				status: 'terminated',
			})
			await addStaff({
				first: 'Elsewhere',
				last: 'X',
				pin: '3333',
				scopeId: 'patio',
			})
			const body = (await (
				await operator('GET', '/staff', { scope: 'orders:read' })
			).json()) as {
				staff: Array<{ name: string; hasPin: boolean; isManager: boolean }>
			}
			expect(body.staff.map((s) => [s.name, s.hasPin, s.isManager])).toEqual([
				['Ana K.', true, true],
				['Omar R.', false, false],
			])
			expect(JSON.stringify(body)).not.toMatch(/pin_?lookup|1111/i)
			const patio = (await (
				await operator('GET', '/staff?scopeId=patio', { scope: 'orders:read' })
			).json()) as { staff: Array<{ name: string }> }
			expect(patio.staff.map((s) => s.name)).toEqual(['Elsewhere X.'])
			expect(
				(await operator('GET', '/staff?scopeId=../x', { scope: 'orders:read' }))
					.status,
			).toBe(400)
		})

		it('designates and removes managers, only with write access, only for real active staff', async () => {
			const id = await addStaff({ pin: '4321' })
			expect(
				(await operator('PUT', `/managers/${id}`, { scope: 'orders:read' }))
					.status,
			).toBe(403)
			expect((await operator('PUT', '/managers/nobody')).status).toBe(404)
			expect((await operator('PUT', `/managers/${id}`)).status).toBe(200)
			expect((await operator('PUT', `/managers/${id}`)).status).toBe(200) // idempotent
			const roster = (await (
				await operator('GET', '/staff', { scope: 'orders:read' })
			).json()) as { staff: Array<{ isManager: boolean }> }
			expect(roster.staff[0]!.isManager).toBe(true)
			expect((await operator('DELETE', `/managers/${id}`)).status).toBe(200)
			expect((await operator('DELETE', `/managers/${id}`)).status).toBe(404)
		})

		it('cannot make an inactive person a manager', async () => {
			const id = await addStaff({ status: 'terminated', pin: '4321' })
			expect((await operator('PUT', `/managers/${id}`)).status).toBe(404)
		})

		it('managers of one restaurant mean nothing in another', async () => {
			const idB = await addStaff({ orgId: ORG_B, pin: '4321' })
			expect(
				(await operator('PUT', `/managers/${idB}`, { orgId: ORG_A })).status,
			).toBe(404)
			expect(
				(await operator('PUT', `/managers/${idB}`, { orgId: ORG_B })).status,
			).toBe(200)
		})
	})

	describe('who took the order', () => {
		it('stores who rang it up, who took each payment, who cancelled it, and how they signed in', async () => {
			const { deviceSecret } = await pair()
			const ana = await addStaff({ first: 'Ana', last: 'Karim' })
			const omar = await addStaff({
				first: 'Omar',
				last: 'Rahman',
				pin: '7777',
			})
			const total = wireOrder().totals.totalCents
			const id = crypto.randomUUID()
			const r = await upload(
				deviceSecret,
				wireOrder({
					id,
					staff: { id: ana, name: 'Ana K.' },
					signIn: 'online',
					paymentStaff: { id: omar, name: 'Omar R.' },
					payments: [{ amountCents: total }],
				}),
			)
			expect(r.status).toBe(201)
			const body = (await r.json()) as {
				order: {
					staff: unknown
					signIn: string
					reviewReason: string | null
					payments: Array<{ staff: unknown }>
				}
			}
			expect(body.order).toMatchObject({
				staff: { id: ana, name: 'Ana K.' },
				signIn: 'online',
				reviewReason: null,
			})
			expect(body.order.payments[0]!.staff).toEqual({
				id: omar,
				name: 'Omar R.',
			})
			const listed = (await (
				await operator('GET', '/orders', { scope: 'orders:read' })
			).json()) as { orders: Array<{ staff: { name: string } }> }
			expect(listed.orders[0]!.staff.name).toBe('Ana K.')
		})

		it('records who cancelled a tab, apart from who opened it', async () => {
			const { deviceSecret } = await pair()
			const ana = await addStaff({ first: 'Ana', last: 'Karim' })
			const lina = await addStaff({
				first: 'Lina',
				last: 'Mansour',
				pin: '8888',
			})
			const id = crypto.randomUUID()
			await upload(
				deviceSecret,
				wireOrder({ id, staff: { id: ana, name: 'Ana K.' }, signIn: 'online' }),
			)
			const r = await upload(
				deviceSecret,
				wireOrder({
					id,
					revision: 2,
					status: 'void',
					staff: { id: ana, name: 'Ana K.' },
					signIn: 'online',
					voidedBy: { id: lina, name: 'Lina M.' },
				}),
			)
			const body = (await r.json()) as {
				order: { staff: { name: string }; voidedBy: { name: string } }
			}
			expect(body.order.staff.name).toBe('Ana K.')
			expect(body.order.voidedBy.name).toBe('Lina M.')
		})

		it('keeps the name as it was at the time, even if the person is later renamed or leaves', async () => {
			const { deviceSecret } = await pair()
			const ana = await addStaff({ first: 'Ana', last: 'Karim' })
			const id = crypto.randomUUID()
			await upload(
				deviceSecret,
				wireOrder({ id, staff: { id: ana, name: 'Ana K.' }, signIn: 'online' }),
			)
			const db = await getTenantDb(ORG_A)
			await db
				.update(staffMembers)
				.set({ firstName: 'Anna', status: 'terminated' as never })
				.where(eq(staffMembers.id, ana))
			const listed = (await (
				await operator('GET', '/orders', { scope: 'orders:read' })
			).json()) as { orders: Array<{ staff: { name: string } }> }
			expect(listed.orders[0]!.staff.name).toBe('Ana K.')
		})

		it('flags, but keeps, an order that names a person this restaurant never had', async () => {
			const { deviceSecret } = await pair()
			const r = await upload(
				deviceSecret,
				wireOrder({
					staff: { id: 'someone-invented', name: 'Eve X.' },
					signIn: 'offline',
				}),
			)
			expect(r.status).toBe(201)
			expect(
				(
					(await r.json()) as {
						order: { reviewReason: string; staff: unknown }
					}
				).order,
			).toMatchObject({
				reviewReason: 'unknown_staff',
				staff: { id: 'someone-invented' },
			})
			// A person from another restaurant is just as unknown here.
			const other = await addStaff({ orgId: ORG_B })
			const r2 = await upload(
				deviceSecret,
				wireOrder({
					number: 'T1-0002',
					staff: { id: other, name: 'Ana K.' },
					signIn: 'offline',
				}),
			)
			expect(
				((await r2.json()) as { order: { reviewReason: string } }).order
					.reviewReason,
			).toBe('unknown_staff')
		})

		it('a terminal without sign-in sends no staff and is not flagged for it', async () => {
			const { deviceSecret } = await pair()
			const r = await upload(deviceSecret, wireOrder())
			expect(
				(
					(await r.json()) as {
						order: { staff: unknown; reviewReason: string | null }
					}
				).order,
			).toMatchObject({ staff: null, reviewReason: null })
		})

		it('a person who is not on the books at upload time is not flagged if they were, and a real reason is never hidden', async () => {
			const { deviceSecret } = await pair()
			const ana = await addStaff()
			const drift = wireOrder({
				staff: { id: ana, name: 'Ana K.' },
				signIn: 'online',
				lines: [{ ...BURGER, baseCents: 900 }],
			})
			const r = await upload(deviceSecret, drift)
			expect(
				((await r.json()) as { order: { reviewReason: string } }).order
					.reviewReason,
			).toBe('price_mismatch')
		})
	})

	// -----------------------------------------------------------------------
	// Data hygiene
	// -----------------------------------------------------------------------

	describe('data hygiene', () => {
		it('stores no phone contact on counter orders, or email and address columns', async () => {
			const { deviceSecret } = await pair()
			const order = { ...wireOrder(), customerName: 'Sam', tableLabel: null }
			await upload(deviceSecret, order)
			const db = await getTenantDb(ORG_A)
			const [row] = await db
				.select()
				.from(posOrders)
				.where(eq(posOrders.id, order.id))
			expect(row!.guestName).toBe('Sam')
			const columns = Object.keys(row!)
			expect(row!.customerPhone).toBeNull()
			expect(columns.filter((c) => /email|address/i.test(c))).toEqual([])
		})
	})

	// -----------------------------------------------------------------------
	// Refunds, removed items, fiscal chain, tab transfer, held uploads
	// -----------------------------------------------------------------------

	describe('ledger', () => {
		const chainId = crypto.randomUUID()
		/** A paid order with its invoice, the way a version 2 till sends it. */
		function paidWithInvoice(
			options: {
				head?: PosFiscalChainHead
				method?: 'cash' | 'card'
				number?: string
			} = {},
		) {
			const base = wireOrder({ number: options.number })
			const payment = {
				id: crypto.randomUUID(),
				method: options.method ?? 'card',
				amountCents: base.totals.totalCents,
				tenderedCents: base.totals.totalCents,
				at: new Date().toISOString(),
				staff: null,
				reference: 'AUTH 4411',
			}
			const issued = issuePosFiscalDocument(
				options.head ?? newPosFiscalChain(chainId),
				{
					kind: 'invoice',
					docId: base.id,
					orderId: base.id,
					at: new Date().toISOString(),
					currency: 'USD',
					totalCents: base.totals.totalCents,
					taxCents: base.totals.taxCents,
				},
			)
			return {
				order: {
					...base,
					status: 'paid' as const,
					payments: [payment],
					fiscal: [issued.document],
				},
				head: issued.head,
			}
		}
		function withRefund(
			sale: ReturnType<typeof paidWithInvoice>,
			amountCents: number,
		) {
			const { order, head } = sale
			const refund = {
				id: crypto.randomUUID(),
				paymentId: order.payments[0]!.id,
				method: order.payments[0]!.method,
				amountCents,
				at: new Date().toISOString(),
				by: null,
				approvedBy: null,
				reason: 'wrong_charge' as const,
				reference: null,
			}
			const credit = issuePosFiscalDocument(head, {
				kind: 'credit_note',
				docId: refund.id,
				orderId: order.id,
				at: refund.at,
				currency: 'USD',
				totalCents: amountCents,
				taxCents: posRefundTaxCents(order.totals, amountCents),
			})
			const full = amountCents === order.totals.totalCents
			return {
				order: {
					...order,
					revision: order.revision + 1,
					status: full ? ('refunded' as const) : ('paid' as const),
					refunds: [refund],
					fiscal: [...order.fiscal, credit.document],
				},
				head: credit.head,
			}
		}

		it('records a refund against a closed sale, in its own ledger row, and keeps it', async () => {
			const { deviceSecret } = await pair()
			const sale = paidWithInvoice()
			expect((await upload(deviceSecret, sale.order)).status).toBe(201)
			const refunded = withRefund(sale, sale.order.totals.totalCents)
			const r = await upload(deviceSecret, refunded.order)
			expect(r.status).toBe(200)
			const body = (await r.json()) as {
				order: {
					status: string
					refundedCents: number
					refunds: Array<{ reason: string }>
					payments: Array<{ reference: string }>
				}
			}
			expect(body.order).toMatchObject({
				status: 'refunded',
				refundedCents: sale.order.totals.totalCents,
			})
			expect(body.order.refunds[0]!.reason).toBe('wrong_charge')
			expect(body.order.payments[0]!.reference).toBe('AUTH 4411')
			const db = await getTenantDb(ORG_A)
			const rows = await db.select().from(posPayments)
			expect(rows.map((r) => r.kind).sort()).toEqual(['payment', 'refund'])
			// A later revision may not drop the refund, nor edit the bill of a closed sale.
			await expectHeld(
				await upload(deviceSecret, {
					...refunded.order,
					revision: 3,
					status: 'paid',
					refunds: [],
					fiscal: sale.order.fiscal,
				}),
				'refunds_changed',
			)
			await expectHeld(
				await upload(deviceSecret, {
					...refunded.order,
					revision: 3,
					orderType: 'takeaway',
				}),
				'order_closed',
			)
		})

		it('keeps every item taken off a tab, and every revision, even after the tab changes again', async () => {
			const { deviceSecret } = await pair()
			const id = crypto.randomUUID()
			await upload(
				deviceSecret,
				wireOrder({ id, revision: 1, lines: [BURGER, FRIES] }),
			)
			const lineVoid = {
				id: crypto.randomUUID(),
				itemId: 'item-fries',
				name: 'Fries',
				variantLabel: null,
				quantity: 1,
				unitCents: 400,
				at: new Date().toISOString(),
				by: null,
				approvedBy: null,
				reason: 'guest_request' as const,
			}
			const r2 = await upload(deviceSecret, {
				...wireOrder({ id, revision: 2, lines: [BURGER] }),
				lineVoids: [lineVoid],
			})
			expect(r2.status).toBe(200)
			expect(
				((await r2.json()) as { order: { lineVoids: unknown[] } }).order
					.lineVoids,
			).toHaveLength(1)
			await expectHeld(
				await upload(
					deviceSecret,
					wireOrder({ id, revision: 3, lines: [BURGER] }),
				),
				'line_voids_changed',
			)
			const history = (await (
				await operator('GET', `/orders/${id}/revisions`, {
					scope: 'orders:read',
				})
			).json()) as {
				revisions: Array<{ revision: number; snapshot: { lines: unknown[] } }>
			}
			expect(history.revisions.map((h) => h.snapshot.lines.length)).toEqual([
				2, 1,
			])
			const db = await getTenantDb(ORG_A)
			expect(
				await db
					.select()
					.from(posOrderLines)
					.where(eq(posOrderLines.orderId, id)),
			).toHaveLength(1)
		})

		it('checks the fiscal chain and flags a break or a tampered document without refusing the sale', async () => {
			const { deviceSecret, device } = await pair()
			const first = paidWithInvoice({ number: 'T1-0001' })
			const r1 = await upload(deviceSecret, first.order)
			expect(
				((await r1.json()) as { order: { reviewReason: string | null } }).order
					.reviewReason,
			).toBeNull()
			// The next document claims a different predecessor.
			const broken = paidWithInvoice({
				number: 'T1-0002',
				head: { chainId, counter: first.head.counter, hash: 'f'.repeat(64) },
			})
			const r2 = await upload(deviceSecret, broken.order)
			expect(r2.status).toBe(201)
			expect(
				((await r2.json()) as { order: { reviewReason: string } }).order
					.reviewReason,
			).toBe('fiscal:chain_break')
			// A document whose figures were changed after it was hashed.
			const tampered = paidWithInvoice({ number: 'T1-0003', head: broken.head })
			tampered.order.fiscal = [
				{ ...tampered.order.fiscal[0]!, hash: '0'.repeat(63) + '1' },
			]
			const r3 = await upload(deviceSecret, tampered.order)
			expect(
				((await r3.json()) as { order: { reviewReason: string } }).order
					.reviewReason,
			).toBe('fiscal:hash_mismatch')
			const db = await getTenantDb(ORG_A)
			const docs = await db.select().from(posFiscalDocuments)
			expect(docs).toHaveLength(3)
			// The terminal can pick up its chain from the server.
			const me = (await (
				await app.request('/pos/me', {
					headers: { authorization: `Bearer ${deviceSecret}` },
				})
			).json()) as {
				fiscalChains: Array<{ chainId: string; counter: number }>
			}
			expect(me.fiscalChains[0]).toMatchObject({ chainId, counter: 3 })
			void device
		})

		it('moves an open tab to another terminal, and holds what the old one sends for it afterwards', async () => {
			const t1 = await pair({ terminalCode: 'T1' })
			const t2 = await pair({ terminalCode: 'T2' })
			const id = crypto.randomUUID()
			await upload(
				t1.deviceSecret,
				wireOrder({ id, revision: 1, number: 'T1-0001' }),
			)
			const tabs = (await (
				await app.request('/pos/tabs', {
					headers: { authorization: `Bearer ${t2.deviceSecret}` },
				})
			).json()) as {
				tabs: Array<{
					terminal: { code: string }
					order: { id: string; revision: number }
				}>
			}
			expect(tabs.tabs.map((t) => [t.terminal.code, t.order.id])).toEqual([
				['T1', id],
			])
			expect(
				(await post(`/tabs/${id}/claim`, { revision: 5 }, t2.deviceSecret))
					.status,
			).toBe(409)
			const claimed = await post(
				`/tabs/${id}/claim`,
				{ revision: 1 },
				t2.deviceSecret,
			)
			expect(claimed.status).toBe(200)
			expect(
				((await claimed.json()) as { order: { number: string } }).order.number,
			).toBe('T1-0001')
			const me = (await (
				await app.request('/pos/me', {
					headers: { authorization: `Bearer ${t1.deviceSecret}` },
				})
			).json()) as {
				transfers: Array<{ orderId: string; terminalCode: string }>
			}
			expect(me.transfers).toEqual([{ orderId: id, terminalCode: 'T2' }])
			await expectHeld(
				await upload(
					t1.deviceSecret,
					wireOrder({
						id,
						revision: 2,
						number: 'T1-0001',
						lines: [BURGER, FRIES],
					}),
				),
				'order_transferred',
			)
			const r = await upload(
				t2.deviceSecret,
				wireOrder({
					id,
					revision: 2,
					number: 'T1-0001',
					lines: [BURGER, FRIES],
				}),
			)
			expect(r.status).toBe(200)
			expect(
				((await r.json()) as { order: { deviceId: string } }).order.deviceId,
			).toBe(t2.device.id)
		})

		it('offers the tabs of a removed terminal, so a lost tablet strands nothing', async () => {
			const lost = await pair({ terminalCode: 'T1' })
			const spare = await pair({ terminalCode: 'T2' })
			const id = crypto.randomUUID()
			await upload(lost.deviceSecret, wireOrder({ id, number: 'T1-0001' }))
			await operator('DELETE', `/terminals/${lost.device.id}`)
			const tabs = (await (
				await app.request('/pos/tabs', {
					headers: { authorization: `Bearer ${spare.deviceSecret}` },
				})
			).json()) as {
				tabs: Array<{ terminal: { removed: boolean }; order: { id: string } }>
			}
			expect(tabs.tabs).toMatchObject([
				{ terminal: { removed: true }, order: { id } },
			])
			expect(
				(await post(`/tabs/${id}/claim`, { revision: 1 }, spare.deviceSecret))
					.status,
			).toBe(200)
		})

		it('flags a sale with nobody signed in, a departed person, or an approval by a non-manager', async () => {
			const { deviceSecret } = await pair({ signInRequired: true })
			const nobody = await upload(
				deviceSecret,
				wireOrder({ number: 'T1-0001' }),
			)
			expect(
				((await nobody.json()) as { order: { reviewReason: string } }).order
					.reviewReason,
			).toBe('missing_staff')
			const gone = await addStaff({
				first: 'Gone',
				status: 'terminated',
				pin: '1212',
			})
			const r2 = await upload(
				deviceSecret,
				wireOrder({
					number: 'T1-0002',
					staff: { id: gone, name: 'Gone K.' },
					signIn: 'offline',
				}),
			)
			expect(
				((await r2.json()) as { order: { reviewReason: string } }).order
					.reviewReason,
			).toBe('inactive_staff')
			const ana = await addStaff({ first: 'Ana', pin: '1313' })
			const omar = await addStaff({ first: 'Omar', pin: '7777' })
			const order = wireOrder({
				number: 'T1-0003',
				staff: { id: ana, name: 'Ana K.' },
				signIn: 'online',
			})
			await upload(deviceSecret, order)
			const r3 = await upload(deviceSecret, {
				...order,
				revision: 2,
				status: 'void',
				voidedBy: { id: ana, name: 'Ana K.' },
				voidReason: 'mistake',
				voidApprovedBy: { id: omar, name: 'Omar K.' },
				voidedAt: new Date().toISOString(),
			})
			const voided = (await r3.json()) as {
				order: { reviewReason: string; voidReason: string }
			}
			expect(voided.order).toMatchObject({
				reviewReason: 'approver_not_manager',
				voidReason: 'mistake',
			})
		})

		it('calls a price difference from an old menu stale, not wrong', async () => {
			const { deviceSecret } = await pair()
			const order = {
				...wireOrder({ lines: [{ ...BURGER, baseCents: 900 }] }),
				catalogFetchedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
			}
			const r = await upload(deviceSecret, order)
			expect(
				((await r.json()) as { order: { reviewReason: string } }).order
					.reviewReason,
			).toBe('stale_price')
		})

		it('lets a manager set when the business day turns over, and the till learns it', async () => {
			const created = await operator('POST', '/pairing-codes', {
				body: {
					label: 'Bar',
					terminalCode: 'B1',
					dayStartMinutes: 300,
					signInRequired: false,
				},
			})
			const { code } = (await created.json()) as { code: string }
			const { deviceSecret, device } = (await (
				await post('/pair', { code })
			).json()) as {
				deviceSecret: string
				device: { id: string; dayStartMinutes: number }
			}
			expect(device.dayStartMinutes).toBe(300)
			expect(
				(
					await operator('PATCH', `/terminals/${device.id}`, {
						body: { dayStartMinutes: 800 },
					})
				).status,
			).toBe(400)
			expect(
				(
					await operator('PATCH', `/terminals/${device.id}`, {
						body: { dayStartMinutes: 0 },
					})
				).status,
			).toBe(200)
			const me = (await (
				await app.request('/pos/me', {
					headers: { authorization: `Bearer ${deviceSecret}` },
				})
			).json()) as { device: { dayStartMinutes: number } }
			expect(me.device.dayStartMinutes).toBe(0)
		})

		it('shows held uploads to managers until one settles them', async () => {
			const { deviceSecret } = await pair()
			await expectHeld(
				await upload(deviceSecret, { ...wireOrder(), customerPhone: '+1555' }),
				'invalid_request',
			)
			const terminals = (await (
				await operator('GET', '/terminals', { scope: 'orders:read' })
			).json()) as { heldUploads: number }
			expect(terminals.heldUploads).toBe(1)
			const held = (await (
				await operator('GET', '/held', { scope: 'orders:read' })
			).json()) as {
				held: Array<{ id: string; error: string; terminalCode: string }>
			}
			expect(held.held[0]).toMatchObject({
				error: 'invalid_request',
				terminalCode: 'T1',
			})
			expect(
				(
					await operator('POST', `/held/${held.held[0]!.id}/resolve`, {
						scope: 'orders:read',
					})
				).status,
			).toBe(403)
			expect(
				(await operator('POST', `/held/${held.held[0]!.id}/resolve`)).status,
			).toBe(200)
			expect(
				(
					(await (
						await operator('GET', '/terminals', { scope: 'orders:read' })
					).json()) as { heldUploads: number }
				).heldUploads,
			).toBe(0)
		})

		it('keeps money and history append-only in the database itself', async () => {
			const { deviceSecret } = await pair()
			const sale = paidWithInvoice()
			await upload(deviceSecret, sale.order)
			const db = await getTenantDb(ORG_A)
			await expect(db.delete(posPayments)).rejects.toThrow()
			await expect(
				db.update(posPayments).set({ amountCents: 1 }),
			).rejects.toThrow()
			await expect(db.delete(posOrderRevisions)).rejects.toThrow()
			await expect(db.delete(posFiscalDocuments)).rejects.toThrow()
			await expect(db.delete(posOrders)).rejects.toThrow()
			// Erasing a person may still replace a name.
			await db.update(posPayments).set({ staffName: 'Erased' })
		})

		it('erasing a staff member removes their name from orders, payments and removed items; history never held it', async () => {
			const { deviceSecret } = await pair()
			const ana = await addStaff({ first: 'Ana', last: 'Karim' })
			const db = await getTenantDb(ORG_A)
			await db
				.update(staffMembers)
				.set({ userId: 'user-ana' })
				.where(eq(staffMembers.id, ana))
			const who = { id: ana, name: 'Ana K.' }
			const id = crypto.randomUUID()
			await upload(
				deviceSecret,
				wireOrder({
					id,
					revision: 1,
					lines: [BURGER, FRIES],
					staff: who,
					signIn: 'online',
				}),
			)
			const lineVoid = {
				id: crypto.randomUUID(),
				itemId: 'item-fries',
				name: 'Fries',
				variantLabel: null,
				quantity: 1,
				unitCents: 400,
				at: new Date().toISOString(),
				by: who,
				approvedBy: null,
				reason: 'mistake' as const,
			}
			const total = wireOrder({ lines: [BURGER] }).totals.totalCents
			await upload(deviceSecret, {
				...wireOrder({
					id,
					revision: 2,
					lines: [BURGER],
					staff: who,
					signIn: 'online',
					paymentStaff: who,
					payments: [{ amountCents: total }],
				}),
				lineVoids: [lineVoid],
			})
			await eraseLinkedUser(db, { userId: 'user-ana' })
			const dump = JSON.stringify([
				await db.select().from(posOrders),
				await db.select().from(posPayments),
				await db.select().from(posOrderRevisions),
			])
			expect(dump).not.toContain('Ana K.')
			expect(dump).toContain(ana)
		})

		it('clears guest names some time after the order closes', async () => {
			const { deviceSecret } = await pair()
			const total = wireOrder().totals.totalCents
			await upload(deviceSecret, {
				...wireOrder({ payments: [{ amountCents: total }] }),
				customerName: 'Sam',
			})
			await upload(deviceSecret, {
				...wireOrder({ number: 'T1-0002' }),
				customerName: 'Still here',
			})
			const db = await getTenantDb(ORG_A)
			expect(
				await purgePosGuestNames(db, Date.now() + 31 * 24 * 3600_000),
			).toBe(1)
			const names = (
				await db.select({ name: posOrders.guestName }).from(posOrders)
			).map((r) => r.name)
			expect(names).toHaveLength(2)
			expect(names).toEqual(expect.arrayContaining([null, 'Still here']))
			// No guest name ever reaches the revision history.
			expect(
				JSON.stringify(await db.select().from(posOrderRevisions)),
			).not.toContain('Sam')
		})
	})

	describe('cash drawer shifts', () => {
		const shift = (over: Record<string, unknown> = {}) => ({
			id: '6f9d1d6e-3c3d-4d3f-9d4a-0d6a3a1b2c50',
			revision: 1,
			status: 'open',
			businessDate: '2026-10-21',
			openedAt: new Date().toISOString(),
			openedBy: null,
			openingFloatCents: 10_000,
			movements: [] as unknown[],
			closedAt: null,
			closedBy: null,
			countedCashCents: null,
			expectedCashCents: null,
			...over,
		})
		const movement = (over: Record<string, unknown> = {}) => ({
			id: crypto.randomUUID(),
			kind: 'pay_out',
			amountCents: 1500,
			note: 'Milk from the shop',
			at: new Date().toISOString(),
			by: null,
			approvedBy: null,
			...over,
		})

		it('works out the drawer from the payments it holds, and reports over or short against the count', async () => {
			const { deviceSecret } = await pair()
			const shiftId = shift().id
			expect((await post('/shifts', shift(), deviceSecret)).status).toBe(201)
			// A cash sale and a card sale in the shift.
			const cashSale = wireOrder({
				number: 'T1-0001',
				payments: [
					{ amountCents: wireOrder().totals.totalCents, tenderedCents: 2000 },
				],
			})
			const cardSale = wireOrder({
				number: 'T1-0002',
				payments: [
					{ method: 'card', amountCents: wireOrder().totals.totalCents },
				],
			})
			for (const o of [cashSale, cardSale]) {
				await upload(deviceSecret, {
					...o,
					shiftId,
					payments: o.payments.map((p) => ({ ...p, shiftId })),
				})
			}
			const out = movement()
			expect(
				(
					await post(
						'/shifts',
						shift({ revision: 2, movements: [out] }),
						deviceSecret,
					)
				).status,
			).toBe(200)
			const total = wireOrder().totals.totalCents
			const expected = 10_000 + total - 1500
			const closed = shift({
				revision: 3,
				status: 'closed',
				movements: [out],
				closedAt: new Date().toISOString(),
				countedCashCents: expected - 25,
				expectedCashCents: expected,
			})
			expect((await post('/shifts', closed, deviceSecret)).status).toBe(200)
			const report = (await (
				await operator('GET', `/shifts/${shiftId}`, { scope: 'orders:read' })
			).json()) as {
				summary: {
					cash: { expectedCents: number }
					byTender: { card: { netCents: number } }
					orders: { paid: number }
				}
				overShortCents: number
			}
			expect(report.summary.cash.expectedCents).toBe(expected)
			expect(report.summary.byTender.card.netCents).toBe(total)
			expect(report.summary.orders.paid).toBe(2)
			expect(report.overShortCents).toBe(-25)
			// A closed shift does not change, and recorded movements cannot be dropped.
			await expectHeld(
				await post(
					'/shifts',
					{ ...closed, revision: 4, countedCashCents: expected },
					deviceSecret,
				),
				'shift_closed',
			)
		})

		it('keeps cash movements append-only', async () => {
			const { deviceSecret } = await pair()
			const out = movement()
			await post('/shifts', shift({ movements: [out] }), deviceSecret)
			await expectHeld(
				await post(
					'/shifts',
					shift({ revision: 2, movements: [] }),
					deviceSecret,
				),
				'movements_changed',
			)
			const db = await getTenantDb(ORG_A)
			await expect(db.delete(posCashMovements)).rejects.toThrow()
		})

		it('a day report covers every terminal and the day’s shifts', async () => {
			const t1 = await pair({ terminalCode: 'T1' })
			const t2 = await pair({ terminalCode: 'T2' })
			const total = wireOrder().totals.totalCents
			await upload(
				t1.deviceSecret,
				wireOrder({ number: 'T1-0001', payments: [{ amountCents: total }] }),
			)
			await upload(
				t2.deviceSecret,
				wireOrder({
					number: 'T2-0001',
					payments: [{ method: 'card', amountCents: total }],
				}),
			)
			await upload(
				t2.deviceSecret,
				wireOrder({
					number: 'T2-0002',
					businessDate: '2026-10-22',
					payments: [{ amountCents: total }],
				}),
			)
			const day = (await (
				await operator('GET', '/reports/day?businessDate=2026-10-21', {
					scope: 'orders:read',
				})
			).json()) as {
				summary: {
					grossSalesCents: number
					byTender: { cash: { netCents: number }; card: { netCents: number } }
				}
				byTerminal: Array<{ terminal: { code: string } }>
			}
			expect(day.summary.grossSalesCents).toBe(2 * total)
			expect(day.summary.byTender.cash.netCents).toBe(total)
			expect(day.summary.byTender.card.netCents).toBe(total)
			expect(day.byTerminal.map((t) => t.terminal.code).sort()).toEqual([
				'T1',
				'T2',
			])
			expect(
				(
					await operator('GET', '/reports/day?businessDate=nope', {
						scope: 'orders:read',
					})
				).status,
			).toBe(400)
		})

		it('lets a manager require shifts on a terminal, and the till learns it', async () => {
			const { deviceSecret, device } = await pair()
			expect(
				(
					await operator('PATCH', `/terminals/${device.id}`, {
						body: { shiftsRequired: true },
					})
				).status,
			).toBe(200)
			const me = (await (
				await app.request('/pos/me', {
					headers: { authorization: `Bearer ${deviceSecret}` },
				})
			).json()) as { device: { shiftsRequired: boolean } }
			expect(me.device.shiftsRequired).toBe(true)
		})
	})

	describe('ZATCA e-invoicing', () => {
		const settings = {
			environment: 'sandbox',
			sellerName: 'Al Hara Kitchen',
			vatNumber: '399999999900003',
			crNumber: '1010010000',
			street: 'Prince Sultan',
			buildingNumber: '2322',
			district: 'Al-Murabba',
			city: 'Riyadh',
			postalCode: '23333',
			businessCategory: 'Restaurant',
			branchName: 'Riyadh Branch',
		}
		/** A secp256k1 certificate from openssl, standing in for a CSID. */
		function certificateToken() {
			const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zatca-cert-'))
			const key = path.join(dir, 'k.pem')
			const cert = path.join(dir, 'c.pem')
			execFileSync('openssl', [
				'ecparam',
				'-name',
				'secp256k1',
				'-genkey',
				'-noout',
				'-out',
				key,
			])
			execFileSync('openssl', [
				'req',
				'-new',
				'-x509',
				'-key',
				key,
				'-out',
				cert,
				'-days',
				'1',
				'-subj',
				'/DC=local/DC=gov/DC=extgazt/CN=TSZEINVOICE-SubCA-1',
			])
			const base64 = fs
				.readFileSync(cert, 'utf8')
				.replace(/-----[^-]+-----/g, '')
				.replace(/\s+/g, '')
			fs.rmSync(dir, { recursive: true, force: true })
			return Buffer.from(base64).toString('base64')
		}
		let hasOpenssl = true
		try {
			execFileSync('openssl', ['version'], { stdio: 'ignore' })
		} catch {
			hasOpenssl = false
		}

		/** Routes Fatoora calls to `answer`, everything else to the usual harness. */
		function fatoora(
			answer: (
				path: string,
				body: Record<string, unknown>,
				headers: Headers,
			) => Response,
		) {
			const calls: string[] = []
			const base = fetchMock.getMockImplementation()!
			vi.stubGlobal(
				'fetch',
				vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
					const url = typeof input === 'string' ? input : input.toString()
					if (!url.startsWith('https://gw-fatoora.zatca.gov.sa/'))
						return base(input)
					const pathname = url.replace(
						'https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal',
						'',
					)
					calls.push(pathname)
					return answer(
						pathname,
						JSON.parse(String(init?.body ?? '{}')),
						new Headers(init?.headers),
					)
				}),
			)
			return calls
		}

		it('checks the seller details before saving them', async () => {
			expect(
				(
					await operator('PUT', '/zatca/settings', {
						body: { ...settings, vatNumber: '123' },
					})
				).status,
			).toBe(400)
			expect(
				(
					await operator('PUT', '/zatca/settings', {
						body: settings,
						scope: 'orders:read',
					})
				).status,
			).toBe(403)
			expect(
				(await operator('PUT', '/zatca/settings', { body: settings })).status,
			).toBe(200)
			const overview = (await (
				await operator('GET', '/zatca', { scope: 'orders:read' })
			).json()) as { settings: { vatNumber: string } }
			expect(overview.settings.vatNumber).toBe(settings.vatNumber)
		})

		it.skipIf(!hasOpenssl)(
			'onboards a terminal, gives the till its key and certificate, and reports what it signs',
			async () => {
				const { deviceSecret, device } = await pair()
				await operator('PUT', '/zatca/settings', { body: settings })
				const token = certificateToken()
				const reported: string[] = []
				const calls = fatoora((pathname, body, headers) => {
					if (pathname === '/compliance') {
						expect(headers.get('OTP')).toBe('123345')
						expect(Buffer.from(String(body.csr), 'base64').toString()).toMatch(
							/^-----BEGIN CERTIFICATE REQUEST-----/,
						)
						return Response.json({
							requestID: 1234,
							binarySecurityToken: token,
							secret: 'compliance-secret',
						})
					}
					if (pathname === '/compliance/invoices')
						return Response.json({ reportingStatus: 'REPORTED' })
					if (pathname === '/production/csids')
						return Response.json({
							requestID: 1234,
							binarySecurityToken: token,
							secret: 'production-secret',
						})
					if (pathname === '/invoices/reporting/single') {
						reported.push(String(body.uuid))
						expect(headers.get('Authorization')).toBe(
							`Basic ${Buffer.from(`${token}:production-secret`).toString('base64')}`,
						)
						return Response.json({ reportingStatus: 'REPORTED' })
					}
					return new Response('?', { status: 404 })
				})
				const onboarded = await operator(
					'POST',
					`/zatca/units/${device.id}/onboard`,
					{ body: { otp: '123345' } },
				)
				expect(onboarded.status).toBe(200)
				// The CSR, three compliance samples (invoice, credit note, debit note), then the production CSID.
				expect(calls).toEqual([
					'/compliance',
					'/compliance/invoices',
					'/compliance/invoices',
					'/compliance/invoices',
					'/production/csids',
				])
				const me = (await (
					await app.request('/pos/me', {
						headers: { authorization: `Bearer ${deviceSecret}` },
					})
				).json()) as { zatca: { status: string } }
				expect(me.zatca.status).toBe('active')
				const credentials = (await (
					await app.request('/pos/zatca', {
						headers: { authorization: `Bearer ${deviceSecret}` },
					})
				).json()) as {
					privateKeyHex: string
					certificate: string
					seller: { vatNumber: string }
				}
				expect(credentials.privateKeyHex).toMatch(/^[0-9a-f]{64}$/)
				expect(credentials.certificate).toBe(token)
				// The secret never leaves the server, and the key is sealed at rest.
				expect(JSON.stringify(credentials)).not.toContain('production-secret')
				const db = await getTenantDb(ORG_A)
				const [unit] = await db.select().from(posZatcaUnits)
				expect(unit!.privateKeySealed).not.toContain(credentials.privateKeyHex)

				// The till signs a sale and uploads it; the server reports it.
				const sale = wireOrder({
					payments: [{ amountCents: wireOrder().totals.totalCents }],
				})
				const signed = signDocument(
					fromSale(
						{
							lines: sale.lines,
							taxRatePercent: 15,
							taxInclusive: false,
							totals: sale.totals,
							payments: sale.payments.map((p) => ({ method: p.method })),
						},
						{
							id: 'T1-0001-20261021',
							uuid: crypto.randomUUID(),
							issuedAt: new Date(),
							counter: 1,
							previousHash: ZATCA_GENESIS_PIH,
							seller: credentials.seller as ZatcaSeller,
						},
					),
					fromHex(credentials.privateKeyHex),
					readCertificate(credentials.certificate),
				)
				const zatcaDoc = {
					invoiceNumber: 'T1-0001-20261021',
					uuid: signed.uuid,
					invoiceHash: signed.invoiceHash,
					xml: signed.xmlBase64,
					qr: signed.qr,
					totalCents: signed.totalCents,
					taxCents: signed.taxCents,
				}
				const doc = issuePosFiscalDocument(
					newPosFiscalChain(crypto.randomUUID()),
					{
						kind: 'invoice',
						docId: sale.id,
						orderId: sale.id,
						at: new Date().toISOString(),
						currency: 'USD',
						totalCents: sale.totals.totalCents,
						taxCents: sale.totals.taxCents,
					},
				).document
				expect(
					(
						await upload(deviceSecret, {
							...sale,
							fiscal: [{ ...doc, zatca: zatcaDoc }],
						})
					).status,
				).toBe(201)
				await expect.poll(() => reported).toEqual([zatcaDoc.uuid])
				await expect
					.poll(
						async () =>
							(await db.select().from(posZatcaSubmissions))[0]?.status,
					)
					.toBe('reported')
				// The till can continue its PIH chain from here if its storage is lost.
				const after = (await (
					await app.request('/pos/me', {
						headers: { authorization: `Bearer ${deviceSecret}` },
					})
				).json()) as { zatca: { lastInvoiceHash: string } }
				expect(after.zatca.lastInvoiceHash).toBe(zatcaDoc.invoiceHash)

				// A reconnect that fails (a mistyped password) leaves the working unit alone.
				fatoora(() =>
					Response.json({ errors: ['Invalid OTP'] }, { status: 400 }),
				)
				const retry = await operator(
					'POST',
					`/zatca/units/${device.id}/onboard`,
					{ body: { otp: '000000' } },
				)
				expect(retry.status).toBe(422)
				const [kept] = await db.select().from(posZatcaUnits)
				expect(kept).toMatchObject({
					status: 'active',
					privateKeySealed: unit!.privateKeySealed,
					productionToken: token,
					lastError: 'compliance: Invalid OTP',
				})
			},
		)

		it.skipIf(!hasOpenssl)(
			'stops where onboarding failed and says why',
			async () => {
				const { device } = await pair()
				await operator('PUT', '/zatca/settings', { body: settings })
				fatoora(() =>
					Response.json({ errors: ['Invalid OTP'] }, { status: 400 }),
				)
				const r = await operator('POST', `/zatca/units/${device.id}/onboard`, {
					body: { otp: '000000' },
				})
				expect(r.status).toBe(422)
				expect(await r.json()).toMatchObject({
					error: 'onboarding_failed',
					step: 'compliance',
					message: 'Invalid OTP',
				})
				const overview = (await (
					await operator('GET', '/zatca', { scope: 'orders:read' })
				).json()) as { units: Array<{ status: string; lastError: string }> }
				expect(overview.units[0]).toMatchObject({
					status: 'failed',
					lastError: 'compliance: Invalid OTP',
				})
			},
		)

		it('keeps a refused document as rejected with ZATCA’s reason, and retries an outage later', async () => {
			const db = await getTenantDb(ORG_A)
			const { device } = await pair()
			await db.insert(posZatcaUnits).values({
				deviceId: device.id,
				environment: 'sandbox',
				status: 'active',
				privateKeySealed: 'v1.x.y.z',
				productionToken: 'dG9rZW4=',
				productionSecretSealed: sealForTest(
					's',
					sealContext(device.id, 'production_secret'),
				),
			})
			const base = {
				deviceId: device.id,
				orderId: crypto.randomUUID(),
				kind: 'invoice' as const,
				invoiceHash: 'h',
				xmlBase64: 'eA==',
				status: 'pending' as const,
				issuedAt: Date.now(),
			}
			await db.insert(posZatcaSubmissions).values([
				{ ...base, docId: crypto.randomUUID(), counter: 1, uuid: 'refused' },
				{ ...base, docId: crypto.randomUUID(), counter: 2, uuid: 'outage' },
			])
			fatoora((_path, body) =>
				body.uuid === 'refused'
					? Response.json(
							{
								validationResults: {
									errorMessages: [
										{
											code: 'BR-KSA-37',
											message:
												'The seller address building number must contain 4 digits.',
										},
									],
								},
							},
							{ status: 400 },
						)
					: new Response('busy', { status: 503 }),
			)
			expect(await reportDueZatca(db)).toMatchObject({ rejected: 1, retry: 1 })
			const rows = await db.select().from(posZatcaSubmissions)
			expect(rows.find((r) => r.uuid === 'refused')).toMatchObject({
				status: 'rejected',
				lastError:
					'BR-KSA-37: The seller address building number must contain 4 digits.',
			})
			expect(rows.find((r) => r.uuid === 'outage')).toMatchObject({
				status: 'pending',
				attempts: 1,
			})
			await expect(db.delete(posZatcaSubmissions)).rejects.toThrow()
		})
	})

	describe('fiscal chain checks', () => {
		const chainId = crypto.randomUUID()
		const paidOrder = (number: string) => {
			const o = wireOrder({ number })
			return {
				...o,
				status: 'paid' as const,
				payments: [
					{
						id: crypto.randomUUID(),
						method: 'cash' as const,
						amountCents: o.totals.totalCents,
						tenderedCents: o.totals.totalCents,
						at: new Date().toISOString(),
						staff: null,
						reference: null,
					},
				],
			}
		}
		const withDoc = (
			o: ReturnType<typeof paidOrder>,
			head: PosFiscalChainHead,
		) => {
			const issued = issuePosFiscalDocument(head, {
				kind: 'invoice',
				docId: o.id,
				orderId: o.id,
				at: new Date().toISOString(),
				currency: 'USD',
				totalCents: o.totals.totalCents,
				taxCents: o.totals.taxCents,
			})
			return { order: { ...o, fiscal: [issued.document] }, head: issued.head }
		}

		it('a first document must start from the genesis value', async () => {
			const { deviceSecret } = await pair()
			const bad = withDoc(paidOrder('T1-0001'), {
				chainId,
				counter: 0,
				hash: 'e'.repeat(64),
			})
			const r = await upload(deviceSecret, bad.order)
			expect(
				((await r.json()) as { order: { reviewReason: string } }).order
					.reviewReason,
			).toBe('fiscal:chain_break')
		})

		it('checks a link when the earlier document arrives after the later one, and lists gaps after a day', async () => {
			const { deviceSecret } = await pair()
			const first = withDoc(paidOrder('T1-0001'), newPosFiscalChain(chainId))
			// The second document was issued on a different (tampered) predecessor, and arrives first.
			const second = withDoc(paidOrder('T1-0002'), {
				chainId,
				counter: 1,
				hash: 'f'.repeat(64),
			})
			const third = withDoc(paidOrder('T1-0004'), {
				chainId,
				counter: 3,
				hash: 'a'.repeat(64),
			})
			expect(
				(
					(await (await upload(deviceSecret, second.order)).json()) as {
						order: { reviewReason: string | null }
					}
				).order.reviewReason,
			).toBeNull()
			await upload(deviceSecret, first.order)
			const db = await getTenantDb(ORG_A)
			const [stored] = await db
				.select()
				.from(posOrders)
				.where(eq(posOrders.id, second.order.id))
			expect(stored!.reviewReason).toBe('fiscal:chain_break')
			await upload(deviceSecret, third.order)
			// Counter 3 is missing; it is a gap only once it has had a day to arrive.
			expect(
				(
					(await (
						await operator('GET', '/fiscal/gaps', { scope: 'orders:read' })
					).json()) as { gaps: unknown[] }
				).gaps,
			).toEqual([])
			expect(await fiscalChainGaps(db, Date.now() + 2 * 24 * 3600_000)).toEqual(
				[expect.objectContaining({ chainId, missingFrom: 3, missingTo: 3 })],
			)
		})
	})

	describe('day report by location', () => {
		it('shows only the shifts of terminals at that location', async () => {
			const here = await pair({ terminalCode: 'T1', locationId: 'loc-1' })
			const there = await pair({ terminalCode: 'T2', locationId: 'loc-2' })
			const shiftFor = (id: string) => ({
				id,
				revision: 1,
				status: 'open',
				businessDate: '2026-10-21',
				openedAt: new Date().toISOString(),
				openedBy: null,
				openingFloatCents: 0,
				movements: [],
				closedAt: null,
				closedBy: null,
				countedCashCents: null,
				expectedCashCents: null,
			})
			const hereShift = crypto.randomUUID()
			await post('/shifts', shiftFor(hereShift), here.deviceSecret)
			await post('/shifts', shiftFor(crypto.randomUUID()), there.deviceSecret)
			const day = (await (
				await operator(
					'GET',
					'/reports/day?businessDate=2026-10-21&locationId=loc-1',
					{ scope: 'orders:read' },
				)
			).json()) as { shifts: Array<{ shift: { id: string } }> }
			expect(day.shifts.map((s) => s.shift.id)).toEqual([hereShift])
			const all = (await (
				await operator('GET', '/reports/day?businessDate=2026-10-21', {
					scope: 'orders:read',
				})
			).json()) as { shifts: unknown[] }
			expect(all.shifts).toHaveLength(2)
		})
	})

	describe('ZATCA reporting keeps the tick awake', () => {
		it('asks for a follow-up while documents are waiting for a retry, even with no staff module', async () => {
			const db = await getTenantDb(ORG_A)
			await db.insert(posZatcaSubmissions).values({
				docId: crypto.randomUUID(),
				deviceId: 'd',
				orderId: crypto.randomUUID(),
				kind: 'invoice',
				counter: 1,
				uuid: 'u',
				invoiceHash: 'h',
				xmlBase64: 'eA==',
				status: 'pending',
				nextAttemptAt: Date.now() + 3600_000,
				issuedAt: Date.now(),
			})
			const result = await runStaffTickForOrg(ORG_A, { db })
			expect(result).toMatchObject({ status: 'skipped', needsFollowUp: true })
		})
	})

	describe('review hardening', () => {
		const paidOrder = (number: string, extra: Record<string, unknown> = {}) => {
			const o = wireOrder({ number })
			return {
				...o,
				...extra,
				status: 'paid' as const,
				payments: [
					{
						id: crypto.randomUUID(),
						method: 'cash' as const,
						amountCents: o.totals.totalCents,
						tenderedCents: o.totals.totalCents,
						at: new Date().toISOString(),
						staff: null,
						reference: null,
					},
				],
			}
		}
		const withDoc = (
			o: ReturnType<typeof paidOrder>,
			head: PosFiscalChainHead,
		) => {
			const issued = issuePosFiscalDocument(head, {
				kind: 'invoice',
				docId: o.id,
				orderId: o.id,
				at: new Date().toISOString(),
				currency: 'USD',
				totalCents: o.totals.totalCents,
				taxCents: o.totals.taxCents,
			})
			return { order: { ...o, fiscal: [issued.document] }, head: issued.head }
		}
		const reviewOf = async (response: Response) =>
			((await response.json()) as { order: { reviewReason: string | null } })
				.order.reviewReason
		const remove = (deviceId: string) =>
			operator('DELETE', `/terminals/${deviceId}`)

		describe("a removed terminal's tabs", () => {
			it('are continued by the same terminal paired again, with a transfer on record', async () => {
				const first = await pair({ terminalCode: 'T1' })
				const id = crypto.randomUUID()
				expect(
					(await upload(first.deviceSecret, wireOrder({ id }))).status,
				).toBe(201)
				expect((await remove(first.device.id)).status).toBe(200)
				const again = await pair({ terminalCode: 'T1' })
				const next = await upload(
					again.deviceSecret,
					wireOrder({ id, revision: 2, lines: [BURGER, FRIES] }),
				)
				expect(next.status).toBe(200)
				const db = await getTenantDb(ORG_A)
				const [row] = await db
					.select()
					.from(posOrders)
					.where(eq(posOrders.id, id))
				expect(row!.deviceId).toBe(again.device.id)
				const transfers = await db
					.select()
					.from(posOrderTransfers)
					.where(eq(posOrderTransfers.orderId, id))
				expect(transfers).toEqual([
					expect.objectContaining({
						fromDeviceId: first.device.id,
						toDeviceId: again.device.id,
						revision: 1,
					}),
				])
			})

			it('are held for any other terminal, which must take the tab over explicitly', async () => {
				const first = await pair({ terminalCode: 'T1' })
				const id = crypto.randomUUID()
				await upload(first.deviceSecret, wireOrder({ id }))
				await remove(first.device.id)
				const other = await pair({ terminalCode: 'T2' })
				await expectHeld(
					await upload(
						other.deviceSecret,
						wireOrder({ id, revision: 2, number: 'T2-0001' }),
					),
					'order_owned_by_removed_terminal',
				)
				const db = await getTenantDb(ORG_A)
				const [row] = await db
					.select()
					.from(posOrders)
					.where(eq(posOrders.id, id))
				expect(row).toMatchObject({ deviceId: first.device.id, revision: 1 })
				const claimed = await post(
					`/tabs/${id}/claim`,
					{ revision: 1 },
					other.deviceSecret,
				)
				expect(claimed.status).toBe(200)
				expect(
					await db
						.select()
						.from(posOrderTransfers)
						.where(eq(posOrderTransfers.orderId, id)),
				).toHaveLength(1)
			})

			it('are held for a terminal with the same code at another location', async () => {
				const first = await pair({ terminalCode: 'T1', locationId: 'loc-1' })
				const id = crypto.randomUUID()
				await upload(first.deviceSecret, wireOrder({ id }))
				await remove(first.device.id)
				const elsewhere = await pair({ terminalCode: 'T1', locationId: null })
				await expectHeld(
					await upload(elsewhere.deviceSecret, wireOrder({ id, revision: 2 })),
					'order_owned_by_removed_terminal',
				)
			})
		})

		describe('fiscal chains belong to the terminal that started them', () => {
			it("flags a document filed under another terminal's chain, without spoiling the owner's checks", async () => {
				const a = await pair({ terminalCode: 'TA' })
				const b = await pair({ terminalCode: 'TB' })
				const chainId = crypto.randomUUID()
				const one = withDoc(paidOrder('TA-0001'), newPosFiscalChain(chainId))
				expect(await reviewOf(await upload(a.deviceSecret, one.order))).toBe(
					null,
				)
				// B takes A's next counter, correctly linked, and a later one.
				const squat = withDoc(paidOrder('TB-0001'), one.head)
				expect(await reviewOf(await upload(b.deviceSecret, squat.order))).toBe(
					'fiscal:chain_owner_mismatch',
				)
				const far = withDoc(paidOrder('TB-0002'), {
					chainId,
					counter: 8,
					hash: 'c'.repeat(64),
				})
				await upload(b.deviceSecret, far.order)
				// A's real counter 2 is neither a reused counter nor a break.
				const two = withDoc(paidOrder('TA-0002'), one.head)
				expect(await reviewOf(await upload(a.deviceSecret, two.order))).toBe(
					null,
				)
				const db = await getTenantDb(ORG_A)
				const docs = await db
					.select()
					.from(posFiscalDocuments)
					.where(eq(posFiscalDocuments.chainId, chainId))
				expect(
					docs.filter((d) => d.deviceId === b.device.id).map((d) => d.problem),
				).toEqual(['chain_owner_mismatch', 'chain_owner_mismatch'])
				// A's recovery head and the gap list ignore B's documents.
				const me = (await (
					await app.request('/pos/me', {
						headers: { authorization: `Bearer ${a.deviceSecret}` },
					})
				).json()) as {
					fiscalChains: Array<{ chainId: string; counter: number }>
				}
				expect(me.fiscalChains).toEqual([
					expect.objectContaining({ chainId, counter: 2 }),
				])
				expect(await fiscalChainGaps(db, Date.now() + 3 * 86_400_000)).toEqual(
					[],
				)
			})

			it("never flags another terminal's order from a link check", async () => {
				const a = await pair({ terminalCode: 'TA' })
				const b = await pair({ terminalCode: 'TB' })
				const chainId = crypto.randomUUID()
				// B's chain: counter 2 arrives first and is clean on its own.
				const bTwo = withDoc(paidOrder('TB-0001'), {
					chainId,
					counter: 1,
					hash: 'd'.repeat(64),
				})
				expect(await reviewOf(await upload(b.deviceSecret, bTwo.order))).toBe(
					null,
				)
				// A files counter 1 under B's chain: A's order is flagged, B's is not touched.
				const aOne = withDoc(paidOrder('TA-0001'), newPosFiscalChain(chainId))
				expect(await reviewOf(await upload(a.deviceSecret, aOne.order))).toBe(
					'fiscal:chain_owner_mismatch',
				)
				const db = await getTenantDb(ORG_A)
				const [bRow] = await db
					.select()
					.from(posOrders)
					.where(eq(posOrders.id, bTwo.order.id))
				expect(bRow!.reviewReason).toBeNull()
			})

			it('lets a terminal paired again continue its own chain', async () => {
				const first = await pair({ terminalCode: 'T1' })
				const chainId = crypto.randomUUID()
				const one = withDoc(paidOrder('T1-0001'), newPosFiscalChain(chainId))
				await upload(first.deviceSecret, one.order)
				await remove(first.device.id)
				const again = await pair({ terminalCode: 'T1' })
				const two = withDoc(paidOrder('T1-0002'), one.head)
				expect(
					await reviewOf(await upload(again.deviceSecret, two.order)),
				).toBe(null)
				const reused = withDoc(paidOrder('T1-0003'), one.head)
				expect(
					await reviewOf(await upload(again.deviceSecret, reused.order)),
				).toBe('fiscal:counter_reused')
			})
		})

		describe('held uploads keep no personal data', () => {
			it('strips guest, table and staff names from a held order, keeping ids and the bill', async () => {
				const { deviceSecret } = await pair()
				const order = {
					...wireOrder({ staff: { id: 'staff-bob-1', name: 'Bob Builder' } }),
					customerName: 'Alice Guest',
					tableLabel: 'Window seat for Alice',
					totals: { ...wireOrder().totals, totalCents: 1 },
				}
				await expectHeld(await upload(deviceSecret, order), 'invalid_request')
				const db = await getTenantDb(ORG_A)
				const [held] = await db.select().from(posHeldUploads)
				expect(held!.payload).not.toContain('Alice')
				expect(held!.payload).not.toContain('Bob Builder')
				expect(held!.payload).toContain('staff-bob-1')
				expect(held!.payload).toContain('Burger')
				expect(JSON.parse(held!.payload)).toMatchObject({
					customerName: null,
					tableLabel: null,
					staff: { id: 'staff-bob-1' },
				})
			})

			it('redacts, shortens and dedupes a body that is not JSON, and caps how many are kept', async () => {
				const { deviceSecret } = await pair()
				const broken = `{"customerName":"Alice Guest","staff":{"id":"s-1","name":"Bob Builder"},"note":"${'x'.repeat(10_000)}`
				await expectHeld(await post('/orders', broken, deviceSecret))
				await expectHeld(await post('/orders', broken, deviceSecret))
				const db = await getTenantDb(ORG_A)
				const rows = await db.select().from(posHeldUploads)
				expect(rows).toHaveLength(1)
				expect(rows[0]!.payload).not.toContain('Alice')
				expect(rows[0]!.payload).not.toContain('Bob')
				expect(rows[0]!.payload).toContain('"id":"s-1"')
				expect(rows[0]!.payload.length).toBeLessThanOrEqual(4_000)
				for (let i = 1; i < 20; i++)
					await expectHeld(await post('/orders', `{"n":${i}`, deviceSecret))
				const over = await post('/orders', '{"n":99', deviceSecret)
				expect(over.status).toBe(429)
				expect(await db.select().from(posHeldUploads)).toHaveLength(20)
			})

			it('keeps a held payload under 64 KB, dropping signed XML first', async () => {
				const { deviceSecret } = await pair()
				const big = {
					...wireOrder(),
					fiscal: 'x',
					lines: Array.from({ length: 50 }, () => ({
						...wireLine(BURGER),
						instructions: 'y'.repeat(2_000),
					})),
				}
				await expectHeld(await upload(deviceSecret, big), 'invalid_request')
				const db = await getTenantDb(ORG_A)
				const [held] = await db.select().from(posHeldUploads)
				expect(held!.payload.length).toBeLessThanOrEqual(64_000)
			})

			it('stops holding when the organization already has too many waiting', async () => {
				const { deviceSecret } = await pair()
				const db = await getTenantDb(ORG_A)
				await db.run(
					sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
						INSERT INTO pos_held_uploads (id, device_id, error, payload, received_at)
						SELECT 'h' || i, 'device-' || (i % 50), 'invalid_request', '{}', 0 FROM n`,
				)
				const r = await upload(deviceSecret, { ...wireOrder(), lines: [] })
				expect(r.status).toBe(429)
			})

			it('the tick deletes settled records after 30 days and redacts any kept before redaction', async () => {
				const db = await getTenantDb(ORG_A)
				const old = Date.now() - 31 * 86_400_000
				await db.insert(posHeldUploads).values([
					{
						id: 'settled-old',
						deviceId: 'd',
						error: 'order_closed',
						payload: '{}',
						receivedAt: old,
						resolvedAt: old,
						resolvedBy: 'u',
					},
					{
						id: 'settled-recent',
						deviceId: 'd',
						error: 'order_closed',
						payload: '{}',
						receivedAt: old,
						resolvedAt: Date.now(),
						resolvedBy: 'u',
					},
					{
						id: 'legacy',
						deviceId: 'd',
						error: 'order_closed',
						payload: JSON.stringify({
							customerName: 'Alice Guest',
							customerPhone: '+15550001111',
						}),
						receivedAt: old,
					},
				])
				await runStaffTickForOrg(ORG_A, { db })
				const rows = await db.select().from(posHeldUploads)
				expect(rows.map((r) => r.id).sort()).toEqual([
					'legacy',
					'settled-recent',
				])
				expect(JSON.stringify(rows)).not.toContain('Alice')
				expect(JSON.stringify(rows)).not.toContain('5550001111')
			})

			it('erasing a staff member or a customer reaches held payloads kept before redaction', async () => {
				const db = await getTenantDb(ORG_A)
				const ana = await addStaff({ first: 'Ana', last: 'K' })
				await db
					.update(staffMembers)
					.set({ userId: 'user-ana-held' })
					.where(eq(staffMembers.id, ana))
				const [customer] = await db
					.insert(customers)
					.values({ phone: '+15550002222', name: 'Sam' })
					.returning()
				await db.insert(posHeldUploads).values([
					{
						id: 'legacy-staff',
						deviceId: 'd',
						error: 'order_closed',
						payload: JSON.stringify({ staff: { id: ana, name: 'Ana K.' } }),
						receivedAt: Date.now(),
					},
					{
						id: 'legacy-phone',
						deviceId: 'd',
						error: 'order_closed',
						payload: JSON.stringify({
							customerName: 'Sam Guest',
							customerPhone: '+15550002222',
						}),
						receivedAt: Date.now(),
					},
				])
				await eraseLinkedUser(db, { userId: 'user-ana-held' })
				await erasePerson(db, { customerId: customer!.id }, { actorId: 'test' })
				const dump = JSON.stringify(await db.select().from(posHeldUploads))
				expect(dump).not.toContain('Ana K.')
				expect(dump).toContain(ana)
				expect(dump).not.toContain('Sam Guest')
				expect(dump).not.toContain('5550002222')
			})
		})

		describe('menu review of later revisions', () => {
			it('checks again when the lines stay but the tax or the discount changes', async () => {
				const { deviceSecret } = await pair()
				const id = crypto.randomUUID()
				const first = wireOrder({ id })
				expect(await reviewOf(await upload(deviceSecret, first))).toBeNull()
				const t = first.totals
				const lowerTax = {
					...first,
					revision: 2,
					totals: {
						...t,
						taxCents: t.taxCents - 50,
						totalCents: t.totalCents - 50,
					},
				}
				await upload(deviceSecret, lowerTax)
				const db = await getTenantDb(ORG_A)
				const [revision] = await db
					.select()
					.from(posOrderRevisions)
					.where(eq(posOrderRevisions.revision, 2))
				expect(revision!.reviewReason).toBe('tax_mismatch')
			})

			it('flags a discount of more than half the bill', async () => {
				const { deviceSecret } = await pair()
				const o = wireOrder()
				const discount = Math.ceil(o.totals.subtotalCents * 0.6)
				const r = await upload(deviceSecret, {
					...o,
					adjustments: [
						{
							id: 'adj-1',
							kind: 'discount',
							label: 'Comp',
							amountCents: discount,
						},
					],
					totals: {
						...o.totals,
						adjustmentCents: discount,
						totalCents: o.totals.totalCents - discount,
					},
				})
				expect(await reviewOf(r)).toBe('large_discount')
				const small = wireOrder({ number: 'T1-0002' })
				const r2 = await upload(deviceSecret, {
					...small,
					adjustments: [
						{ id: 'adj-2', kind: 'discount', label: 'Promo', amountCents: 100 },
					],
					totals: {
						...small.totals,
						adjustmentCents: 100,
						totalCents: small.totals.totalCents - 100,
					},
				})
				expect(await reviewOf(r2)).toBeNull()
			})

			/** A sale discounted by a `loyalty` line worth 60% of its subtotal. */
			function loyaltyLabelled(o: ReturnType<typeof wireOrder>) {
				const amount = Math.ceil(o.totals.subtotalCents * 0.6)
				return {
					amount,
					order: {
						...o,
						adjustments: [
							{
								id: 'adj-1',
								kind: 'loyalty' as const,
								label: 'Reward',
								amountCents: amount,
							},
						],
						totals: {
							...o.totals,
							adjustmentCents: amount,
							totalCents: o.totals.totalCents - amount,
						},
					},
				}
			}

			it('flags a large manual discount labelled as a loyalty reward', async () => {
				const { deviceSecret } = await pair()
				const { order } = loyaltyLabelled(wireOrder())
				expect(await reviewOf(await upload(deviceSecret, order))).toBe(
					'large_discount',
				)
			})

			it('does not flag a large loyalty reward the member approved on this sale', async () => {
				const { deviceSecret, device } = await pair()
				const o = wireOrder()
				const { amount, order } = loyaltyLabelled(o)
				await activateProgram(ORG_A, programConfig(), Date.now() - 60 * 60_000)
				await insertCustomer(ORG_A, {
					id: 'cust_reward',
					phone: '+15550003333',
				})
				const memberId = await makeMember(ORG_A, { customerId: 'cust_reward' })
				await givePoints(ORG_A, memberId, 50)
				const reward = await makeReward(
					ORG_A,
					rewardDefinition({
						discount: { type: 'fixed', amountMinor: amount },
					}),
				)
				const redemption = await reserveReward(ORG_A, {
					memberId,
					rewardId: reward.id,
					cart: loyaltyCart([
						cartLine({
							unitBaseMinor: o.totals.subtotalCents,
							unitMinor: o.totals.subtotalCents,
						}),
					]),
					source: { type: 'pos_order', id: o.id },
					channel: 'pos',
					deviceId: device.id,
				})
				expect(redemption.discountMinor).toBe(amount)
				expect(await reviewOf(await upload(deviceSecret, order))).toBeNull()
			})

			it('still flags the part of a loyalty line the approved reward does not cover', async () => {
				const { deviceSecret, device } = await pair()
				const o = wireOrder()
				const { amount, order } = loyaltyLabelled(o)
				await activateProgram(ORG_A, programConfig(), Date.now() - 60 * 60_000)
				await insertCustomer(ORG_A, {
					id: 'cust_reward',
					phone: '+15550003333',
				})
				const memberId = await makeMember(ORG_A, { customerId: 'cust_reward' })
				await givePoints(ORG_A, memberId, 50)
				// A 0.50 reward approved, a 60% "loyalty" line sent.
				const reward = await makeReward(
					ORG_A,
					rewardDefinition({ discount: { type: 'fixed', amountMinor: 50 } }),
				)
				await reserveReward(ORG_A, {
					memberId,
					rewardId: reward.id,
					cart: loyaltyCart([
						cartLine({
							unitBaseMinor: o.totals.subtotalCents,
							unitMinor: o.totals.subtotalCents,
						}),
					]),
					source: { type: 'pos_order', id: o.id },
					channel: 'pos',
					deviceId: device.id,
				})
				expect(amount).toBeGreaterThan(50)
				expect(await reviewOf(await upload(deviceSecret, order))).toBe(
					'large_discount',
				)
			})

			it('stores the holding reason when a large discount and an unknown staff both flag', async () => {
				const { deviceSecret } = await pair()
				const o = wireOrder({
					staff: { id: 'someone-invented', name: 'Eve X.' },
					signIn: 'offline',
				})
				const discount = Math.ceil(o.totals.subtotalCents * 0.6)
				const r = await upload(deviceSecret, {
					...o,
					adjustments: [
						{
							id: 'adj-3',
							kind: 'discount',
							label: 'Comp',
							amountCents: discount,
						},
					],
					totals: {
						...o.totals,
						adjustmentCents: discount,
						totalCents: o.totals.totalCents - discount,
					},
				})
				expect(await reviewOf(r)).toBe('unknown_staff')
			})
		})

		it('holds the same revision sent again with different contents', async () => {
			const { deviceSecret } = await pair()
			const order = wireOrder()
			expect((await upload(deviceSecret, order)).status).toBe(201)
			const replay = await upload(deviceSecret, order)
			expect(((await replay.json()) as { result: string }).result).toBe(
				'replay',
			)
			await expectHeld(
				await upload(deviceSecret, {
					...order,
					lines: [wireLine(BURGER), wireLine(FRIES)],
					totals: wireOrder({ lines: [BURGER, FRIES] }).totals,
				}),
				'revision_conflict',
			)
		})

		describe('retention on the regional tick', () => {
			it('clears names on closed orders after 30 days and on abandoned open tabs after 90', async () => {
				const { deviceSecret } = await pair()
				const total = wireOrder().totals.totalCents
				const closed = {
					...wireOrder({ payments: [{ amountCents: total }] }),
					customerName: 'Closed Sam',
				}
				const abandoned = {
					...wireOrder({ number: 'T1-0002' }),
					customerName: 'Abandoned Ann',
				}
				const recent = {
					...wireOrder({ number: 'T1-0003' }),
					customerName: 'Recent Rob',
				}
				for (const o of [closed, abandoned, recent])
					await upload(deviceSecret, o)
				const db = await getTenantDb(ORG_A)
				const ago = (days: number) => Date.now() - days * 86_400_000
				await db
					.update(posOrders)
					.set({ updatedAt: ago(31) })
					.where(eq(posOrders.id, closed.id))
				await db
					.update(posOrders)
					.set({ updatedAt: ago(91) })
					.where(eq(posOrders.id, abandoned.id))
				await db
					.update(posOrders)
					.set({ updatedAt: ago(60) })
					.where(eq(posOrders.id, recent.id))
				// POS is off: no terminal checks in, the tick still purges.
				vi.stubEnv('POS_ENABLED', 'false')
				await runStaffTickForOrg(ORG_A, { db })
				const names = Object.fromEntries(
					(await db.select().from(posOrders)).map((o) => [o.id, o.guestName]),
				)
				expect(names).toEqual({
					[closed.id]: null,
					[abandoned.id]: null,
					[recent.id]: 'Recent Rob',
				})
			})
		})

		describe('pairing codes name real places', () => {
			const create = (body: Record<string, unknown>) =>
				operator('POST', '/pairing-codes', {
					body: { label: 'Bar', terminalCode: 'B1', ...body },
				})

			it('refuses a workplace nobody is assigned to, and a location the organization does not have', async () => {
				const scope = await create({ scopeId: 'nowhere' })
				expect(scope.status).toBe(422)
				expect(await scope.json()).toMatchObject({ error: 'invalid_scope' })
				const location = await create({ locationId: 'loc-typo' })
				expect(location.status).toBe(422)
				expect(await location.json()).toMatchObject({
					error: 'invalid_location',
				})
				expect((await create({ locationId: 'loc-2' })).status).toBe(201)
				await addStaff({ scopeId: 'patio' })
				expect(
					(await create({ terminalCode: 'B2', scopeId: 'patio' })).status,
				).toBe(201)
			})

			it('trusts the manager when the catalog cannot be reached', async () => {
				contextStatus = 503
				expect((await create({ locationId: 'loc-typo' })).status).toBe(201)
			})
		})

		describe('configuration faults', () => {
			it('answers 503, not 500, when AUTH_HMAC_SECRET is missing or short', async () => {
				const { deviceSecret } = await pair()
				vi.stubEnv('AUTH_HMAC_SECRET', 'short')
				const me = await app.request('/pos/me', {
					headers: { authorization: `Bearer ${deviceSecret}` },
				})
				expect(me.status).toBe(503)
				expect(await me.json()).toEqual({ error: 'service_unavailable' })
				const paired = await post('/pair', {
					code: formatPosPairingCode(ORG_A, randomPosToken()),
				})
				expect(paired.status).toBe(503)
				const code = await operator('POST', '/pairing-codes', {
					body: { label: 'Bar', terminalCode: 'B9' },
				})
				expect(code.status).toBe(503)
			})
		})

		it('removing a terminal revokes its ZATCA unit', async () => {
			const { device } = await pair()
			const db = await getTenantDb(ORG_A)
			await db.insert(posZatcaUnits).values({
				deviceId: device.id,
				environment: 'sandbox',
				status: 'active',
				privateKeySealed: 'sealed',
			})
			expect((await remove(device.id)).status).toBe(200)
			const [unit] = await db
				.select()
				.from(posZatcaUnits)
				.where(eq(posZatcaUnits.deviceId, device.id))
			expect(unit).toMatchObject({ status: 'revoked' })
			expect(unit!.revokedAt).toEqual(expect.any(Number))
		})
	})

	describe('loyalty on an upload', () => {
		const FLAGS_ON = { enabled: true, redemption: true }

		/** A member the till identified by their code: the binding it keeps. */
		async function identifiedMember(deviceId: string) {
			const since = Date.now() - 60 * 60_000
			await activateProgram(ORG_A, programConfig(), since)
			await insertCustomer(ORG_A, { id: 'cust_till', phone: '+15550002222' })
			const memberId = await makeMember(ORG_A, {
				customerId: 'cust_till',
				now: since,
			})
			const { code } = await issueMemberCode(ORG_A, {
				customerId: 'cust_till',
				features: FLAGS_ON,
			})
			const till = await identifyMemberByCode(ORG_A, {
				code,
				device: { id: deviceId, locationId: null },
				features: FLAGS_ON,
			})
			return { memberId, binding: till.member.binding }
		}

		const paidSale = (binding: string, number = 'T1-0001') => ({
			...wireOrder({ number, payments: [{ amountCents: 1083 }] }),
			// A newer till may send fields this server does not know yet.
			loyalty: { binding, lines: [], tier: 'gold' },
		})

		afterEach(() => invalidateLoyaltyContext())

		it('credits the member while App cannot be asked for the flags, asking App once', async () => {
			const { deviceSecret, device } = await pair()
			const { memberId, binding } = await identifiedMember(device.id)
			invalidateLoyaltyContext(ORG_A)
			let flagReads = 0
			fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
				const url = new URL(
					typeof input === 'string' ? input : input.toString(),
				)
				if (url.pathname.endsWith('/resources/order-context')) {
					return Response.json(contextFor(url.searchParams.get('orgId') ?? ''))
				}
				if (url.pathname.endsWith('/resources/loyalty/context')) {
					flagReads += 1
					throw new TypeError('fetch failed')
				}
				return new Response('not found', { status: 404 })
			})
			const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
			try {
				for (const number of ['T1-0001', 'T1-0002']) {
					expect(
						(await upload(deviceSecret, paidSale(binding, number))).status,
					).toBe(201)
				}
				expect(flagReads).toBe(1)
				expect(errors).toHaveBeenCalledWith('Loyalty flags could not be read', {
					orgId: ORG_A,
					reason: 'unreachable',
					status: 'unknown',
					stale: false,
				})
			} finally {
				errors.mockRestore()
			}
			const db = await getTenantDb(ORG_A)
			const purchases = await db.select().from(loyaltyPurchases).all()
			expect(purchases).toHaveLength(2)
			expect(purchases.every((row) => row.memberId === memberId)).toBe(true)
			// Each paid sale earned 10 points on 10.00 before tax.
			expect((await balanceOf(ORG_A, memberId)).points).toBe(20)
		})

		it('credits nobody when App says loyalty is off', async () => {
			const { deviceSecret, device } = await pair()
			const { memberId, binding } = await identifiedMember(device.id)
			seedLoyaltyContextForTest(ORG_A, {
				enabled: false,
				redemption: false,
			})
			expect((await upload(deviceSecret, paidSale(binding))).status).toBe(201)
			const db = await getTenantDb(ORG_A)
			expect(await db.select().from(loyaltyPurchases).all()).toHaveLength(0)
			expect((await balanceOf(ORG_A, memberId)).points).toBe(0)
		})
	})
})

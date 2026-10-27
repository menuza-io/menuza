import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	qrTabs,
	restaurantOrders,
	rsvAreas,
	rsvTables,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	findActiveOrganizationById,
	resolveOrganizationForBrowserAuth,
} from '../lib/origin.ts'
import { deriveTableToken } from '../lib/qr-tokens.ts'
import { updateOperatorOrder } from '../services/order-service.ts'
import { operatorQrRoutes } from './operator-qr.ts'
import { publicOrderRoutes } from './orders.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(async () => null),
}))

const orgId = 'org_qr_ordering_1'
const otherOrgId = 'org_qr_ordering_2'
const internalToken = 'test-internal-token-very-long-and-secure-12345'
const operatorToken = 'test-operator-token-very-long-and-secure-12345'
const hmacSecret = 'test-hmac-secret-123456789'

const ORG = {
	id: orgId,
	slug: 'test-org',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}
const OTHER_ORG = { ...ORG, id: otherOrgId, slug: 'other-org' }

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

function location(id: string, name: string) {
	return {
		id,
		name,
		timezone: 'UTC',
		taxRate: 10,
		prepTime: 15,
		currency: 'USD',
		fulfillmentOptions: {
			pickup: true,
			delivery: false,
			dineIn: true,
			curbside: false,
		},
		inHouseTips: { pickupTips: true, deliveryTips: true, dineInTips: true },
		onlineHours: ALL_DAYS,
	}
}

function context(
	qrOrdering: unknown = { enabled: true, dineIn: true, online: true },
) {
	return {
		orgId,
		dataRegion: 'us',
		menu: {
			organization: { id: orgId, slug: 'test-org', currency: 'USD' },
			locations: [location('loc-1', 'Main'), location('loc-2', 'Harbor')],
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
									id: 'item-tea',
									displayName: 'Tea',
									price: 4,
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
		onlinePayment: { enabled: true, processor: 'connect' },
		...(qrOrdering === 'omit' ? {} : { qrOrdering }),
	}
}

function roundBody(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'test-org',
		idempotencyKey: crypto.randomUUID(),
		locale: 'en',
		locationId: 'loc-1',
		fulfillment: 'dine_in',
		paymentMethod: 'handoff',
		contact: {},
		tipPercent: 0,
		lines: [{ itemId: 'item-tea', quantity: 2, options: [] }],
		...overrides,
	}
}

async function operatorJwt(
	scope: string,
	claims: Record<string, unknown> = {},
	tokenOrgId = orgId,
	secret = operatorToken,
) {
	return new SignJWT({ orgId: tokenOrgId, role: 'operator', scope, ...claims })
		.setSubject('user_1')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(secret))
}

describe('QR ordering: dine-in tabs and the operator surface', () => {
	let directory: string
	let app: Hono
	let activeContext: unknown

	async function request(
		pathname: string,
		init: {
			method?: string
			body?: unknown
			headers?: Record<string, string>
		} = {},
	) {
		return app.request(pathname, {
			method: init.method ?? 'GET',
			headers: {
				'content-type': 'application/json',
				origin: 'https://test-org.example.com',
				...init.headers,
			},
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
		})
	}

	async function operator(
		pathname: string,
		init: {
			method?: string
			body?: unknown
			scope?: string
			claims?: Record<string, unknown>
		} = {},
	) {
		const jwt = await operatorJwt(init.scope ?? 'qr:write', init.claims)
		return request(`/operator/qr${pathname}`, {
			method: init.method,
			body: init.body,
			headers: { authorization: `Bearer ${jwt}` },
		})
	}

	async function createTable(label = 'T1', locationId = 'loc-1') {
		const response = await operator('/tables', {
			method: 'POST',
			body: { locationId, label },
		})
		expect(response.status).toBe(201)
		return (await response.json()).table as { id: string; token: string }
	}

	async function placeRound(
		headers: Record<string, string>,
		overrides: Record<string, unknown> = {},
	) {
		return request('/orders', {
			method: 'POST',
			body: roundBody(overrides),
			headers,
		})
	}

	beforeEach(async () => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qr-ordering-'))
		vi.stubEnv('TENANT_DB_DIR', directory)
		vi.stubEnv('DATA_REGION', 'us')
		vi.stubEnv('INTERNAL_COMMAND_TOKEN', internalToken)
		vi.stubEnv('TENANT_OPERATOR_TOKEN', operatorToken)
		vi.stubEnv('AUTH_HMAC_SECRET', hmacSecret)
		vi.stubEnv('APP_URL', 'https://app.test')
		vi.stubEnv('QR_DINE_IN_ENABLED', '')

		activeContext = context()
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
			id === orgId
				? (ORG as never)
				: id === otherOrgId
					? (OTHER_ORG as never)
					: null,
		)

		await provisionTenantDb(orgId)
		await provisionTenantDb(otherOrgId)
		app = new Hono()
		app.route('/orders', publicOrderRoutes)
		app.route('/operator/qr', operatorQrRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId)
			await destroyTenantDb(otherOrgId)
			fs.rmSync(directory, { recursive: true, force: true })
		} catch {}
		vi.unstubAllEnvs()
		vi.unstubAllGlobals()
		vi.clearAllMocks()
	})

	// -----------------------------------------------------------------------
	// Guest flow
	// -----------------------------------------------------------------------

	it('opens a tab with the first round, adds rounds with the tab token and resumes on re-scan', async () => {
		const table = await createTable()

		const first = await placeRound({ 'X-Table-Token': table.token })
		expect(first.status).toBe(201)
		const firstBody = await first.json()
		expect(firstBody.order.totalCents).toBe(880)
		expect(firstBody.tab.tabNumber).toBe('001')
		const tabToken = firstBody.tab.tabToken as string

		const second = await placeRound({ 'X-Tab-Token': tabToken })
		expect(second.status).toBe(201)
		expect((await second.json()).tab.id).toBe(firstBody.tab.id)

		// Another phone at the table joins the same tab with the table code.
		const third = await placeRound({ 'X-Table-Token': table.token })
		expect((await third.json()).tab.id).toBe(firstBody.tab.id)

		const options = await request(
			'/orders/options?slug=test-org&locationId=loc-1',
			{ headers: { 'X-Table-Token': table.token } },
		)
		expect(options.status).toBe(200)
		const optionsBody = await options.json()
		expect(optionsBody.table).toEqual({ label: 'T1', locationId: 'loc-1' })
		expect(optionsBody.dineIn.enabled).toBe(true)
		expect(optionsBody.dineIn.onlineTabPayAvailable).toBe(true)
		expect(optionsBody.openTab.id).toBe(firstBody.tab.id)
		expect(optionsBody.openTab.roundsCount).toBe(3)
		expect(optionsBody.openTab.totalCents).toBe(2640)

		const tab = await request('/orders/tab?slug=test-org', {
			headers: { 'X-Tab-Token': optionsBody.openTab.tabToken },
		})
		expect(tab.status).toBe(200)
		const tabBody = (await tab.json()).tab
		expect(tabBody.rounds).toHaveLength(3)
		expect(tabBody.totals.totalCents).toBe(2640)
		expect(tabBody.roundsPending).toBe(true)
		expect(JSON.stringify(tabBody)).not.toContain('guest')

		const db = await getTenantDb(orgId)
		const rows = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.tabId, firstBody.tab.id))
		expect(rows.every((row) => row.fulfillment === 'dine_in')).toBe(true)
		expect(rows.every((row) => row.source === 'qr_table')).toBe(true)
		expect(rows.every((row) => row.tableLabel === 'T1')).toBe(true)
		expect(rows.every((row) => row.paymentStatus === 'unpaid')).toBe(true)
	})

	it('rejects forged, burned, archived and cross-location table codes', async () => {
		const table = await createTable()
		const forged = `${table.id}.1.${'0'.repeat(64)}`
		expect((await placeRound({ 'X-Table-Token': forged })).status).toBe(404)
		expect((await placeRound({ 'X-Table-Token': 'garbage' })).status).toBe(404)

		const crossLocation = await placeRound(
			{ 'X-Table-Token': table.token },
			{ locationId: 'loc-2' },
		)
		expect(crossLocation.status).toBe(422)
		expect((await crossLocation.json()).error).toBe('table_location_mismatch')

		const regenerated = await operator(`/tables/${table.id}`, {
			method: 'PATCH',
			body: { regenerateToken: true },
		})
		expect(regenerated.status).toBe(200)
		const burned = await placeRound({ 'X-Table-Token': table.token })
		expect(burned.status).toBe(404)
		const fresh = (await regenerated.json()).table.token as string
		expect((await placeRound({ 'X-Table-Token': fresh })).status).toBe(201)

		const other = await createTable('T2')
		await operator(`/tables/${other.id}`, {
			method: 'PATCH',
			body: { archived: true },
		})
		const archived = await placeRound({ 'X-Table-Token': other.token })
		expect(archived.status).toBe(410)
		expect((await archived.json()).error).toBe('table_archived')
	})

	it('a token minted for another organization proves nothing here', async () => {
		const foreign = deriveTableToken(otherOrgId, crypto.randomUUID(), 1)
		expect((await placeRound({ 'X-Table-Token': foreign })).status).toBe(404)
	})

	it('answers a uniform 404 when the QR flags are off and 503 under the kill switch', async () => {
		const table = await createTable()
		for (const flags of [
			'omit',
			{ enabled: true, dineIn: false, online: true },
			{ enabled: false, dineIn: true, online: true },
			'yes',
		]) {
			activeContext = context(flags)
			const response = await placeRound({ 'X-Table-Token': table.token })
			expect(response.status).toBe(404)
			expect((await response.json()).error).toBe('dine_in_unavailable')
			const options = await request(
				'/orders/options?slug=test-org&locationId=loc-1',
				{ headers: { 'X-Table-Token': table.token } },
			)
			expect(options.status).toBe(404)
		}

		activeContext = context()
		vi.stubEnv('QR_DINE_IN_ENABLED', 'off')
		expect((await placeRound({ 'X-Table-Token': table.token })).status).toBe(
			503,
		)
		expect(
			(
				await request('/orders/tab?slug=test-org', {
					headers: { 'X-Tab-Token': 'anything' },
				})
			).status,
		).toBe(503)
	})

	it('needs a table code for dine-in and refuses one on other orders', async () => {
		const table = await createTable()
		expect((await placeRound({})).status).toBe(400)
		const pickupWithTable = await placeRound(
			{ 'X-Table-Token': table.token },
			{
				fulfillment: 'pickup',
				contact: { name: 'Sam', phone: '+15551234567' },
			},
		)
		expect(pickupWithTable.status).toBe(400)
	})

	it('rejects dine-in bodies that carry tips, prepay, drops or schedules', async () => {
		const table = await createTable()
		for (const overrides of [
			{ tipPercent: 10 },
			{ paymentMethod: 'online' },
			{ dropSlug: 'friday' },
			{ scheduledFor: new Date(Date.now() + 3_600_000).toISOString() },
			{ source: 'qr_poster' },
		]) {
			const response = await placeRound(
				{ 'X-Table-Token': table.token },
				overrides,
			)
			expect(response.status).toBe(400)
		}
	})

	it('enforces the contact policy on the round that opens the tab', async () => {
		const table = await createTable()
		await operator('/settings', {
			method: 'PATCH',
			body: { requireGuestName: true, requireGuestPhone: true },
		})
		const noName = await placeRound({ 'X-Table-Token': table.token })
		expect((await noName.json()).error).toBe('contact_name_required')
		const noPhone = await placeRound(
			{ 'X-Table-Token': table.token },
			{ contact: { name: 'Lina' } },
		)
		expect((await noPhone.json()).error).toBe('contact_phone_required')
		const ok = await placeRound(
			{ 'X-Table-Token': table.token },
			{ contact: { name: 'Lina', phone: '+15551230000' } },
		)
		expect(ok.status).toBe(201)
		// Later rounds inherit the tab's guest.
		const later = await placeRound({
			'X-Tab-Token': (await ok.json()).tab.tabToken,
		})
		expect(later.status).toBe(201)
	})

	it('caps rounds per table per hour from durable rows', async () => {
		const table = await createTable()
		await operator('/settings', {
			method: 'PATCH',
			body: { perTableLimitPerHour: 2 },
		})
		expect((await placeRound({ 'X-Table-Token': table.token })).status).toBe(
			201,
		)
		expect((await placeRound({ 'X-Table-Token': table.token })).status).toBe(
			201,
		)
		const third = await placeRound({ 'X-Table-Token': table.token })
		expect(third.status).toBe(429)
		expect((await third.json()).error).toBe('table_rate_limited')
	})

	it('replays an idempotent round with the same tab', async () => {
		const table = await createTable()
		const body = roundBody()
		const first = await request('/orders', {
			method: 'POST',
			body,
			headers: { 'X-Table-Token': table.token },
		})
		const replay = await request('/orders', {
			method: 'POST',
			body,
			headers: { 'X-Table-Token': table.token },
		})
		expect(replay.status).toBe(200)
		expect((await replay.json()).tab.id).toBe((await first.json()).tab.id)
	})

	it('settles a tab once at the counter and refuses per-round payment', async () => {
		const table = await createTable()
		const first = await (
			await placeRound({ 'X-Table-Token': table.token })
		).json()
		await placeRound({ 'X-Tab-Token': first.tab.tabToken })

		const markPaid = await updateOperatorOrder(orgId, first.order.id, {
			status: 'accepted',
			markPaid: true,
		})
		expect(markPaid.ok).toBe(false)
		if (!markPaid.ok)
			expect(markPaid.failure.code).toBe('tab_settlement_required')

		// Cancelling a round only removes it from the running total.
		await updateOperatorOrder(orgId, first.order.id, { status: 'cancelled' })

		const closed = await operator(`/tabs/${first.tab.id}/close`, {
			method: 'POST',
			body: { paymentMethod: 'counter', tipCents: 100 },
		})
		expect(closed.status).toBe(200)
		const tab = (await closed.json()).tab
		expect(tab.status).toBe('closed')
		expect(tab.paymentStatus).toBe('paid')
		expect(tab.totals.totalCents).toBe(980)

		const db = await getTenantDb(orgId)
		const rounds = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.tabId, first.tab.id))
		expect(
			rounds.find((round) => round.id === first.order.id)?.paymentStatus,
		).toBe('unpaid')
		expect(
			rounds.filter((round) => round.paymentStatus === 'paid'),
		).toHaveLength(1)

		const afterClose = await placeRound({ 'X-Tab-Token': first.tab.tabToken })
		expect(afterClose.status).toBe(409)
		expect((await afterClose.json()).error).toBe('tab_closed')

		// The table code opens a new tab for the next party.
		const next = await (
			await placeRound({ 'X-Table-Token': table.token })
		).json()
		expect(next.tab.id).not.toBe(first.tab.id)
		expect(next.tab.tabNumber).toBe('002')

		// The guest receipt still reads with the old tab token.
		const receipt = await request('/orders/tab?slug=test-org', {
			headers: { 'X-Tab-Token': first.tab.tabToken },
		})
		expect((await receipt.json()).tab.status).toBe('closed')
	})

	it('voids a tab with a reason and cancels unfinished rounds', async () => {
		const table = await createTable()
		const first = await (
			await placeRound({ 'X-Table-Token': table.token })
		).json()
		const noReason = await operator(`/tabs/${first.tab.id}/void`, {
			method: 'POST',
			body: { reason: ' ' },
		})
		expect(noReason.status).toBe(400)
		const voided = await operator(`/tabs/${first.tab.id}/void`, {
			method: 'POST',
			body: { reason: 'Walked out' },
		})
		expect(voided.status).toBe(200)
		const tab = (await voided.json()).tab
		expect(tab.status).toBe('cancelled')
		expect(tab.rounds[0].status).toBe('cancelled')
		expect(tab.voidReason).toBe('Walked out')
	})

	it('locks a tab against every phone, including a re-scan', async () => {
		const table = await createTable()
		const first = await (
			await placeRound({ 'X-Table-Token': table.token })
		).json()
		const locked = await operator(`/tabs/${first.tab.id}/lock`, {
			method: 'POST',
		})
		expect(locked.status).toBe(200)
		expect(
			(await placeRound({ 'X-Tab-Token': first.tab.tabToken })).status,
		).toBe(404)
		const rescan = await placeRound({ 'X-Table-Token': table.token })
		expect(rescan.status).toBe(423)
		const db = await getTenantDb(orgId)
		const [row] = await db
			.select()
			.from(qrTabs)
			.where(eq(qrTabs.id, first.tab.id))
		expect(row?.lockedAt).not.toBeNull()
		// Staff can still close it.
		const closed = await operator(`/tabs/${first.tab.id}/close`, {
			method: 'POST',
			body: { paymentMethod: 'counter' },
		})
		expect(closed.status).toBe(200)
	})

	it('refuses to archive a table with an open tab', async () => {
		const table = await createTable()
		await placeRound({ 'X-Table-Token': table.token })
		const response = await operator(`/tables/${table.id}`, {
			method: 'PATCH',
			body: { archived: true },
		})
		expect(response.status).toBe(409)
		expect((await response.json()).error).toBe('tab_open')
	})

	it('tags an order-ahead poster order only while QR ordering is on', async () => {
		const pickup = {
			fulfillment: 'pickup',
			contact: { name: 'Sam', phone: '+15551234567' },
			source: 'qr_poster',
		}
		const on = await (await placeRound({}, pickup)).json()
		activeContext = context({ enabled: false, dineIn: false, online: false })
		const off = await (await placeRound({}, pickup)).json()
		const db = await getTenantDb(orgId)
		const [onRow] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, on.order.id))
		const [offRow] = await db
			.select()
			.from(restaurantOrders)
			.where(eq(restaurantOrders.id, off.order.id))
		expect(onRow?.source).toBe('qr_poster')
		expect(offRow?.source).toBeNull()
		expect(on.tab).toBeUndefined()
	})

	// -----------------------------------------------------------------------
	// Operator surface
	// -----------------------------------------------------------------------

	it('imports the floor plan only with the signed claim, and re-syncs idempotently', async () => {
		const db = await getTenantDb(orgId)
		const [area] = await db
			.insert(rsvAreas)
			.values({ locationId: 'loc-1', name: 'Patio' })
			.returning()
		await db.insert(rsvTables).values([
			{ locationId: 'loc-1', areaId: area!.id, label: 'P1' },
			{ locationId: 'loc-1', areaId: area!.id, label: 'P2' },
		])
		await createTable('P2')

		const denied = await operator('/tables/import-floor-plan', {
			method: 'POST',
			body: { locationId: 'loc-1' },
		})
		expect(denied.status).toBe(403)

		const imported = await operator('/tables/import-floor-plan', {
			method: 'POST',
			body: { locationId: 'loc-1' },
			claims: { canImportFloorPlan: true },
		})
		expect(imported.status).toBe(200)
		expect((await imported.json()).import).toEqual({
			created: 1,
			updated: 0,
			linked: 1,
			archived: 0,
		})
		const again = await operator('/tables/import-floor-plan', {
			method: 'POST',
			body: { locationId: 'loc-1' },
			claims: { canImportFloorPlan: true },
		})
		expect((await again.json()).import).toEqual({
			created: 0,
			updated: 0,
			linked: 0,
			archived: 0,
		})
	})

	it('hands out table tokens to writers only', async () => {
		await createTable()
		const asReader = await operator('/tables', { scope: 'qr:read' })
		expect((await asReader.json()).tables[0].token).toBeNull()
		const asWriter = await operator('/tables')
		expect((await asWriter.json()).tables[0].token).toMatch(
			/\.1\.[0-9a-f]{64}$/,
		)
	})

	describe('every operator route refuses missing, forged and grantless tokens', () => {
		const routes: Array<{
			method: string
			path: string
			write: boolean
			body?: unknown
		}> = [
			{ method: 'GET', path: '/tables', write: false },
			{
				method: 'POST',
				path: '/tables',
				write: true,
				body: { locationId: 'loc-1', label: 'X' },
			},
			{
				method: 'POST',
				path: '/tables/bulk',
				write: true,
				body: { locationId: 'loc-1', labels: ['X'] },
			},
			{
				method: 'POST',
				path: '/tables/import-floor-plan',
				write: true,
				body: { locationId: 'loc-1' },
			},
			{
				method: 'PATCH',
				path: '/tables/t1',
				write: true,
				body: { label: 'Y' },
			},
			{ method: 'GET', path: '/settings', write: false },
			{
				method: 'PATCH',
				path: '/settings',
				write: true,
				body: { requireGuestName: true },
			},
			{ method: 'GET', path: '/tabs', write: false },
			{ method: 'GET', path: '/tabs/t1', write: false },
			{
				method: 'POST',
				path: '/tabs/t1/close',
				write: true,
				body: { paymentMethod: 'counter' },
			},
			{
				method: 'POST',
				path: '/tabs/t1/void',
				write: true,
				body: { reason: 'x' },
			},
			{ method: 'POST', path: '/tabs/t1/lock', write: true },
		]

		it.each(routes)('$method $path', async (route) => {
			const call = (headers: Record<string, string>) =>
				request(`/operator/qr${route.path}`, {
					method: route.method,
					body: route.body,
					headers,
				})
			expect((await call({})).status).toBe(401)
			const forged = await operatorJwt('qr:write', {}, orgId, 'x'.repeat(40))
			expect((await call({ authorization: `Bearer ${forged}` })).status).toBe(
				401,
			)
			const ordersScope = await operatorJwt('orders:write')
			expect(
				(await call({ authorization: `Bearer ${ordersScope}` })).status,
			).toBe(403)
			const notOperator = await new SignJWT({
				orgId,
				role: 'customer',
				scope: 'qr:write',
			})
				.setProtectedHeader({ alg: 'HS256' })
				.setAudience('tenant-api-operator')
				.setIssuer(brand.shortName)
				.setExpirationTime('15m')
				.sign(new TextEncoder().encode(operatorToken))
			expect(
				(await call({ authorization: `Bearer ${notOperator}` })).status,
			).toBe(403)
			if (route.write) {
				const reader = await operatorJwt('qr:read')
				expect((await call({ authorization: `Bearer ${reader}` })).status).toBe(
					403,
				)
			}
			const unknownOrg = await operatorJwt('qr:write', {}, 'org_unknown_x')
			expect(
				(await call({ authorization: `Bearer ${unknownOrg}` })).status,
			).toBe(404)
		})
	})

	it('keeps each organization to its own tables and tabs', async () => {
		const table = await createTable()
		const first = await (
			await placeRound({ 'X-Table-Token': table.token })
		).json()
		const foreign = await operatorJwt('qr:write', {}, otherOrgId)
		const headers = { authorization: `Bearer ${foreign}` }
		const tables = await request('/operator/qr/tables', { headers })
		expect((await tables.json()).tables).toEqual([])
		const close = await request(`/operator/qr/tabs/${first.tab.id}/close`, {
			method: 'POST',
			body: { paymentMethod: 'counter' },
			headers,
		})
		expect(close.status).toBe(404)
		const patch = await request(`/operator/qr/tables/${table.id}`, {
			method: 'PATCH',
			body: { regenerateToken: true },
			headers,
		})
		expect(patch.status).toBe(404)
	})
})

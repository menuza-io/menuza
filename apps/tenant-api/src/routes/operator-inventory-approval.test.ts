import { brand } from '@repo/config/brand'
import {
	INVENTORY_PERMISSIONS,
	INVENTORY_TOKEN_AUDIENCE,
	INVENTORY_TOKEN_TYP,
	inventoryLocationSettingsSchema,
	inventorySettingsSchema,
	orderDetailSchema,
	sendOrderResultSchema,
} from '@repo/inventory'
import {
	destroyTenantDb,
	getTenantDb,
	invLocationSettings,
	invOrders,
	provisionTenantDb,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import * as jose from 'jose'
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	vi,
} from 'vitest'
import { seedInventoryContextForTest } from '../lib/inventory-context.ts'
import { type PublishedOrganization } from '../lib/origin.ts'
import { setTenantEmailDevCapture } from '../lib/tenant-email.ts'
import { runInventoryTickForOrg } from '../services/inventory-tick-service.ts'
import { makeWorld } from './inventory-orders-fixture.ts'
import {
	ALL_GRANTS,
	BASE,
	cid,
	makeClient,
	OPERATOR_SECRET,
	PURCHASING,
	READ,
	setupTenantEnv,
	UPDATE,
} from './inventory-test-utils.ts'
import { operatorInventoryRoutes } from './operator-inventory.ts'

const ORG = 'org_inv_appr_a'
const LOC = 'loc_appr'
const LOC_TZ = 'loc_appr_tz'

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

async function mintApprovalToken(
	options: {
		subject?: string
		grants?: string[]
		canManageSettings?: boolean
		isOwner?: boolean
		locationIds?: string[] | null
	} = {},
): Promise<string> {
	const now = Math.floor(Date.now() / 1000)
	return new jose.SignJWT({
		role: 'operator',
		orgId: ORG,
		region: 'us',
		scope: 'write',
		grants: options.grants ?? ALL_GRANTS,
		locationIds: options.locationIds === undefined ? null : options.locationIds,
		features: {
			enabled: true,
			purchasing: true,
			recipes: false,
			prep: false,
			transfers: false,
		},
		impersonated: false,
		...(options.canManageSettings !== undefined
			? { canManageSettings: options.canManageSettings }
			: {}),
		...(options.isOwner !== undefined ? { isOwner: options.isOwner } : {}),
	})
		.setProtectedHeader({ alg: 'HS256', typ: INVENTORY_TOKEN_TYP })
		.setSubject(options.subject ?? 'user_owner')
		.setIssuer(brand.shortName)
		.setAudience(INVENTORY_TOKEN_AUDIENCE)
		.setIssuedAt(now)
		.setExpirationTime(now + 600)
		.sign(new TextEncoder().encode(OPERATOR_SECRET))
}

let env: ReturnType<typeof setupTenantEnv>
let ownerToken: string
let managerToken: string
let buyerToken: string
let buyerNoCostToken: string
let settingsNoCostToken: string
let world: ReturnType<typeof makeWorld>
let supplierId: string
let productId: string
let itemId: string

beforeAll(async () => {
	env = setupTenantEnv('inv-appr')
	orgs.set(ORG, {
		id: ORG,
		slug: ORG,
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
		name: ORG,
	})
	await provisionTenantDb(ORG)
	seedInventoryContextForTest(ORG, {
		enabled: true,
		purchasing: true,
		recipes: false,
		prep: false,
		transfers: false,
	})

	ownerToken = await mintApprovalToken({
		subject: 'user_owner',
		canManageSettings: true,
		isOwner: true,
	})
	managerToken = await mintApprovalToken({
		subject: 'user_manager',
		canManageSettings: true,
		isOwner: false,
	})
	buyerToken = await mintApprovalToken({
		subject: 'user_buyer',
		canManageSettings: false,
		isOwner: false,
	})
	buyerNoCostToken = await mintApprovalToken({
		subject: 'user_buyer_nocost',
		grants: [READ, UPDATE, PURCHASING],
		canManageSettings: false,
		isOwner: false,
	})
	settingsNoCostToken = await mintApprovalToken({
		subject: 'user_mgr_nocost',
		grants: [READ, UPDATE, PURCHASING],
		canManageSettings: true,
		isOwner: false,
	})

	world = makeWorld(call, ownerToken, LOC)
	const supplier = await world.supplier('Approval Supplier', {
		email: 'orders@appr.example',
		orderChannel: 'email',
	})
	supplierId = supplier.id
	const item = await world.item('Approval Flour')
	itemId = item.id
	const product = await world.product(supplierId, itemId, {
		packName: 'Sack',
		packBaseQuantity: 10_000_000,
		priceMinor: 10_000, // 100.00 per pack
	})
	productId = product.id
})

afterEach(() => {
	setTenantEmailDevCapture(null)
	vi.useRealTimers()
})

afterAll(async () => {
	await destroyTenantDb(ORG)
	env.cleanup()
})

describe('Order spending limits and approval (#500)', () => {
	it('enforces grants on spending limits and hides limit amounts without cost grant', async () => {
		// Non-settings user gets 403
		const noSettings = await call(
			'PUT',
			`${BASE}/settings/locations/${LOC}/limits`,
			{
				token: buyerToken,
				body: { expectedVersion: 0, orderLimitMinor: 15_000 },
			},
		)
		expect(noSettings.status).toBe(403)
		expect(noSettings.body.code).toBe('forbidden')

		// Settings + purchasing without cost grant gets 403
		const noCost = await call(
			'PUT',
			`${BASE}/settings/locations/${LOC}/limits`,
			{
				token: settingsNoCostToken,
				body: { expectedVersion: 0, orderLimitMinor: 15_000 },
			},
		)
		expect(noCost.status).toBe(403)
		expect(noCost.body.code).toBe('forbidden')

		// Missing purchasing grant gets 403
		const noPurchasing = await mintApprovalToken({
			subject: 'user_no_purch',
			grants: [READ, UPDATE, INVENTORY_PERMISSIONS.READ_INVENTORY_COST],
			canManageSettings: true,
		})
		const noPurchRes = await call(
			'PUT',
			`${BASE}/settings/locations/${LOC}/limits`,
			{
				token: noPurchasing,
				body: { expectedVersion: 0, orderLimitMinor: 15_000 },
			},
		)
		expect(noPurchRes.status).toBe(403)

		// Manager with purchasing + settings + cost can save limits
		const saved = await call(
			'PUT',
			`${BASE}/settings/locations/${LOC}/limits`,
			{
				token: managerToken,
				body: {
					expectedVersion: 0,
					orderLimitMinor: 15_000,
					monthlyLimitMinor: 35_000,
				},
			},
		)
		expect(saved.status).toBe(200)
		const locSettings = inventoryLocationSettingsSchema.parse(saved.body)
		expect(locSettings.orderLimitMinor).toBe(15_000)
		expect(locSettings.monthlyLimitMinor).toBe(35_000)
		expect(locSettings.version).toBe(1)

		// GET /settings shows limits to cost holder, strips them without cost grant
		const settingsWithCost = inventorySettingsSchema.parse(
			(await call('GET', `${BASE}/settings`, { token: managerToken })).body,
		)
		expect(
			settingsWithCost.locations?.find((l) => l.locationId === LOC),
		).toMatchObject({
			orderLimitMinor: 15_000,
			monthlyLimitMinor: 35_000,
		})

		const settingsNoCost = (
			await call('GET', `${BASE}/settings`, { token: buyerNoCostToken })
		).body
		const locNoCost = settingsNoCost.locations?.find(
			(l: { locationId: string }) => l.locationId === LOC,
		)
		expect(locNoCost).toBeDefined()
		expect('orderLimitMinor' in locNoCost).toBe(false)
		expect('monthlyLimitMinor' in locNoCost).toBe(false)
	})

	it('puts an over-limit order in waiting_for_approval without sending email, hides money without cost grant, blocks line edits, and delivers approval alert on tick', async () => {
		const captured: Array<{ to: string; messageKind?: string }> = []
		setTenantEmailDevCapture(async (msg) => {
			captured.push({ to: msg.to, messageKind: msg.meta.messageKind })
		})

		// 2 packs * 10,000 = 20,000 > orderLimitMinor (15,000)
		const created = orderDetailSchema.parse(
			(
				await call('POST', `${BASE}/orders`, {
					token: buyerNoCostToken,
					body: {
						clientId: cid('ord-over'),
						locationId: LOC,
						supplierId,
						lines: [{ itemId, supplierProductId: productId, packs: 2 }],
					},
				})
			).body,
		)
		expect(created.status).toBe('draft')
		expect('totalMinor' in created).toBe(false)

		const sendRes = await call('POST', `${BASE}/orders/${created.id}/send`, {
			token: buyerNoCostToken,
			body: { expectedVersion: created.version, channel: 'email' },
		})
		expect(sendRes.status).toBe(200)
		expect(captured).toHaveLength(0)

		const sendParsed = sendOrderResultSchema.parse(sendRes.body)
		expect(sendParsed.waitingForApproval).toBe(true)
		expect(sendParsed.emailSent).toBe(false)
		expect(sendParsed.order.status).toBe('waiting_for_approval')
		expect(sendParsed.order.approvalStatus).toBe('waiting_approval')
		expect(sendParsed.order.approvalBreachedOrderLimit).toBe(true)
		// Zero money fields leaked to requester without cost grant
		expect('orderLimitMinor' in sendRes.body).toBe(false)
		expect('monthlyLimitMinor' in sendRes.body).toBe(false)
		expect('monthlySpentMinor' in sendRes.body).toBe(false)
		expect('orderLimitMinor' in sendRes.body.order).toBe(false)
		expect('totalMinor' in sendRes.body.order).toBe(false)

		// SQL status stays 'draft'
		const db = await getTenantDb(ORG)
		const dbRow = await db
			.select()
			.from(invOrders)
			.where(eq(invOrders.id, created.id))
			.get()
		expect(dbRow?.status).toBe('draft')
		expect(dbRow?.approvalStatus).toBe('waiting_approval')
		expect(dbRow?.approvalAlertStatus).toBe('pending')

		// Line edits are blocked while waiting_for_approval
		const patchBlocked = await call('PATCH', `${BASE}/orders/${created.id}`, {
			token: buyerToken,
			body: {
				expectedVersion: sendParsed.order.version,
				lines: [{ itemId, supplierProductId: productId, packs: 1 }],
			},
		})
		expect(patchBlocked.status).toBe(409)
		expect(patchBlocked.body.code).toBe('order_not_editable')

		// Tick retries pending approval alert and marks it 'sent'
		const posted: Array<{ kind: string; orderApproval?: unknown }> = []
		const tick = await runInventoryTickForOrg(ORG, {
			post: async (event) => {
				posted.push({
					kind: event.kind,
					orderApproval: event.orderApproval,
				})
				return { status: 'delivered' }
			},
		})
		expect(tick.alertsSent).toBeGreaterThanOrEqual(1)
		expect(
			posted.some(
				(p) =>
					p.kind === 'inventory_order_approval' &&
					(p.orderApproval as { orderId: string }).orderId === created.id,
			),
		).toBe(true)
		const afterTick = await db
			.select()
			.from(invOrders)
			.where(eq(invOrders.id, created.id))
			.get()
		expect(afterTick?.approvalAlertStatus).toBe('sent')

		// Non-approver (canManageSettings: false) gets 403 on approve and reject
		const nonApproverApprove = await call(
			'POST',
			`${BASE}/orders/${created.id}/approve`,
			{
				token: buyerToken,
				body: { expectedVersion: sendParsed.order.version },
			},
		)
		expect(nonApproverApprove.status).toBe(403)
		expect(nonApproverApprove.body.code).toBe('forbidden')

		const nonApproverReject = await call(
			'POST',
			`${BASE}/orders/${created.id}/reject`,
			{
				token: buyerToken,
				body: {
					expectedVersion: sendParsed.order.version,
					reason: 'Not allowed',
				},
			},
		)
		expect(nonApproverReject.status).toBe(403)
		expect(nonApproverReject.body.code).toBe('forbidden')

		// Another approver (manager) approves and sends it via the requested email channel
		const approvedRes = await call(
			'POST',
			`${BASE}/orders/${created.id}/approve`,
			{
				token: managerToken,
				body: { expectedVersion: sendParsed.order.version },
			},
		)
		expect(approvedRes.status).toBe(200)
		const approved = sendOrderResultSchema.parse(approvedRes.body)
		expect(approved.emailSent).toBe(true)
		expect(approved.channel).toBe('email')
		expect(approved.order.status).toBe('sent')
		expect(approved.order.sentVia).toBe('email')
		expect(approved.order.approvalStatus).toBe('approved')
		expect(captured).toHaveLength(1)
		expect(captured[0]).toMatchObject({
			to: 'orders@appr.example',
			messageKind: 'inventory_order',
		})
	})

	it('enforces self-approval ban for non-owner, allows owner self-approval, and handles reject -> draft -> resend', async () => {
		// Non-owner manager creates an over-limit order
		const created = orderDetailSchema.parse(
			(
				await call('POST', `${BASE}/orders`, {
					token: managerToken,
					body: {
						clientId: cid('ord-self'),
						locationId: LOC,
						supplierId,
						lines: [{ itemId, supplierProductId: productId, packs: 2 }],
					},
				})
			).body,
		)
		const sent = sendOrderResultSchema.parse(
			(
				await call('POST', `${BASE}/orders/${created.id}/send`, {
					token: managerToken,
					body: { expectedVersion: created.version, channel: 'whatsapp' },
				})
			).body,
		)
		expect(sent.waitingForApproval).toBe(true)

		// Manager cannot approve their own order
		const selfApprove = await call(
			'POST',
			`${BASE}/orders/${created.id}/approve`,
			{
				token: managerToken,
				body: { expectedVersion: sent.order.version },
			},
		)
		expect(selfApprove.status).toBe(403)
		expect(selfApprove.body.code).toBe('self_approval_forbidden')

		// Reject without reason fails 400
		const blankReject = await call(
			'POST',
			`${BASE}/orders/${created.id}/reject`,
			{
				token: ownerToken,
				body: { expectedVersion: sent.order.version, reason: '   ' },
			},
		)
		expect(blankReject.status).toBe(400)

		// Reject with reason returns to editable draft
		const rejectedRes = await call(
			'POST',
			`${BASE}/orders/${created.id}/reject`,
			{
				token: ownerToken,
				body: {
					expectedVersion: sent.order.version,
					reason: 'Reduce to 1 pack',
				},
			},
		)
		expect(rejectedRes.status).toBe(200)
		const rejected = orderDetailSchema.parse(rejectedRes.body)
		expect(rejected.status).toBe('draft')
		expect(rejected.approvalStatus).toBe('rejected')
		expect(rejected.rejectionReason).toBe('Reduce to 1 pack')

		// Draft is editable again: reduce to 1 pack (10,000 <= 15,000)
		const patched = orderDetailSchema.parse(
			(
				await call('PATCH', `${BASE}/orders/${created.id}`, {
					token: managerToken,
					body: {
						expectedVersion: rejected.version,
						lines: [{ itemId, supplierProductId: productId, packs: 1 }],
					},
				})
			).body,
		)
		expect(patched.lines[0]?.packs).toBe(1)

		// Owner creates an over-limit order and CAN self-approve it
		const ownerOrder = orderDetailSchema.parse(
			(
				await call('POST', `${BASE}/orders`, {
					token: ownerToken,
					body: {
						clientId: cid('ord-owner'),
						locationId: LOC,
						supplierId,
						lines: [{ itemId, supplierProductId: productId, packs: 2 }],
					},
				})
			).body,
		)
		const ownerWaiting = sendOrderResultSchema.parse(
			(
				await call('POST', `${BASE}/orders/${ownerOrder.id}/send`, {
					token: ownerToken,
					body: { expectedVersion: ownerOrder.version, channel: 'copy' },
				})
			).body,
		)
		expect(ownerWaiting.waitingForApproval).toBe(true)

		const ownerApproved = sendOrderResultSchema.parse(
			(
				await call('POST', `${BASE}/orders/${ownerOrder.id}/approve`, {
					token: ownerToken,
					body: { expectedVersion: ownerWaiting.order.version },
				})
			).body,
		)
		expect(ownerApproved.order.status).toBe('sent')
		expect(ownerApproved.channel).toBe('copy')
		expect(ownerApproved.order.sentVia).toBe('copy')
	})

	it('checks monthly limit in location IANA timezone counting sent/partly_received/received orders and ignoring draft/cancelled/prior-month', async () => {
		const db = await getTenantDb(ORG)
		// Set location LOC_TZ to America/New_York (UTC-5 in Nov) and monthly limit 25,000 (no per-order limit)
		await db
			.insert(invLocationSettings)
			.values({
				locationId: LOC_TZ,
				timeZone: 'America/New_York',
				orderLimitMinor: null,
				monthlyLimitMinor: 25_000,
				version: 1,
				updatedAt: Date.now(),
			})
			.onConflictDoUpdate({
				target: invLocationSettings.locationId,
				set: {
					timeZone: 'America/New_York',
					orderLimitMinor: null,
					monthlyLimitMinor: 25_000,
				},
			})

		// At 2026-11-15T12:00:00Z (2026-11 in America/New_York):
		// 2026-11-01T02:00:00Z is 2026-10-31 22:00 EDT in New York -> PRIOR MONTH!
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-11-15T12:00:00Z'))

		// Order 1: sent on 2026-11-01T02:00:00Z (October in America/New_York) -> MUST NOT count
		const priorMonthOrd = orderDetailSchema.parse(
			(
				await call('POST', `${BASE}/orders`, {
					token: buyerToken,
					body: {
						clientId: cid('ord-prior'),
						locationId: LOC_TZ,
						supplierId,
						lines: [{ itemId, supplierProductId: productId, packs: 2 }], // 20,000
					},
				})
			).body,
		)
		await db
			.update(invOrders)
			.set({
				status: 'received',
				sentAt: Date.parse('2026-11-01T02:00:00Z'),
				closedAt: Date.parse('2026-11-01T03:00:00Z'),
			})
			.where(eq(invOrders.id, priorMonthOrd.id))

		// Order 2: cancelled in November -> MUST NOT count
		const cancelledOrd = orderDetailSchema.parse(
			(
				await call('POST', `${BASE}/orders`, {
					token: buyerToken,
					body: {
						clientId: cid('ord-canc'),
						locationId: LOC_TZ,
						supplierId,
						lines: [{ itemId, supplierProductId: productId, packs: 2 }], // 20,000
					},
				})
			).body,
		)
		await db
			.update(invOrders)
			.set({
				status: 'cancelled',
				sentAt: Date.parse('2026-11-10T12:00:00Z'),
				closedAt: Date.parse('2026-11-10T13:00:00Z'),
			})
			.where(eq(invOrders.id, cancelledOrd.id))

		// Order 3: 2 packs (20,000) sent in November -> monthly spent = 20,000 <= 25,000 -> sends immediately
		const novOrd1 = orderDetailSchema.parse(
			(
				await call('POST', `${BASE}/orders`, {
					token: buyerToken,
					body: {
						clientId: cid('ord-nov1'),
						locationId: LOC_TZ,
						supplierId,
						lines: [{ itemId, supplierProductId: productId, packs: 2 }],
					},
				})
			).body,
		)
		const novSent1 = sendOrderResultSchema.parse(
			(
				await call('POST', `${BASE}/orders/${novOrd1.id}/send`, {
					token: buyerToken,
					body: { expectedVersion: novOrd1.version, channel: 'copy' },
				})
			).body,
		)
		expect(novSent1.waitingForApproval).toBeUndefined()
		expect(novSent1.order.status).toBe('sent')

		// Order 4: 1 pack (10,000) -> 20,000 + 10,000 = 30,000 > 25,000 -> waits for approval!
		const novOrd2 = orderDetailSchema.parse(
			(
				await call('POST', `${BASE}/orders`, {
					token: buyerToken,
					body: {
						clientId: cid('ord-nov2'),
						locationId: LOC_TZ,
						supplierId,
						lines: [{ itemId, supplierProductId: productId, packs: 1 }],
					},
				})
			).body,
		)
		const novWaiting = sendOrderResultSchema.parse(
			(
				await call('POST', `${BASE}/orders/${novOrd2.id}/send`, {
					token: buyerToken,
					body: { expectedVersion: novOrd2.version, channel: 'copy' },
				})
			).body,
		)
		expect(novWaiting.waitingForApproval).toBe(true)
		expect(novWaiting.order.status).toBe('waiting_for_approval')
		expect(novWaiting.order.approvalBreachedOrderLimit).toBe(false)
		expect(novWaiting.order.approvalBreachedMonthlyLimit).toBe(true)
		expect(novWaiting.monthlySpentMinor).toBe(20_000)
		expect(novWaiting.monthlyLimitMinor).toBe(25_000)
	})
})

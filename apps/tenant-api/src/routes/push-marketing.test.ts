import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveLink } from '@repo/common/links'
import { buildRewardPush, payloadHoldsPersonalData } from '@repo/common/push'
import {
	customerPushDevices,
	customerSubscriptions,
	customers,
	destroyTenantDb,
	getTenantDb,
	journeyRuns,
	marketingCampaigns,
	marketingJourneys,
	marketingMessages,
	marketingSettings,
	provisionTenantDb,
	pushMessages,
} from '@repo/tenant-db'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearCustomerAppInfoCache } from '../lib/customer-app-info.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import {
	broadcastLease,
	dispatchBroadcast,
} from '../services/broadcast-dispatch.ts'
import { executeJourneyStep } from '../services/journey-service.ts'
import { pushBooking } from '../services/push-hooks.ts'
import { MockPushProvider, setPushProvider } from '../services/push-provider.ts'
import { sendPushToCustomer } from '../services/push-service.ts'
import { pushRoutes } from './push.ts'

const orgId = 'clw9x0a12000008l00test13'
const jwtSecret = 'test-jwt-secret-123456789'
const SITE = 'https://acme.menuza.test'

const info = vi.hoisted(() => ({
	value: {
		app: {
			id: 'app_1',
			displayName: 'Acme',
			iosBundleId: 'com.acme.app',
			androidPackage: 'com.acme.app',
			stores: {},
			inviteEmail: true,
		},
		push: {
			enabled: true,
			marketing: true,
			credentials: { ios: true, android: true },
		},
	} as unknown,
}))
vi.mock('../lib/customer-app-info.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getCustomerAppInfo: vi.fn(async () => info.value),
}))
vi.mock('../lib/reservations-context.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getReservationsContext: vi.fn(async () => ({
		organization: { siteOrigin: 'https://acme.menuza.test' },
	})),
}))
vi.mock('../lib/origin.ts', () => {
	const organization = {
		id: 'clw9x0a12000008l00test13',
		slug: 'push-test',
		customDomain: null,
		hasProvisionedDb: true,
		dataRegion: 'us',
	}
	return {
		findActiveOrganizationById: vi.fn().mockResolvedValue(organization),
		lookupActiveOrganization: vi
			.fn()
			.mockResolvedValue({ status: 'found', organization }),
	}
})

let app: Hono
let tempDir: string
let provider: MockPushProvider
let aliceId: string
let bobId: string
let alice: string
let bob: string

const ALICE = {
	name: 'Alice Wonderland',
	phone: '+15555550301',
	email: 'alice@example.com',
}
const tokenOf = (n: number) =>
	`ExponentPushToken[device${String(n).padStart(8, '0')}]`

async function jwt(customerId: string) {
	return new SignJWT({
		customerId,
		orgId,
		orgSlug: 'push-test',
		type: 'access',
	})
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api')
		.setIssuer('menuza')
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(jwtSecret))
}

function call(
	method: string,
	route: string,
	body?: unknown,
	bearer: string | null = alice,
) {
	return app.request(route, {
		method,
		headers: {
			...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
}

const register = (
	n: number,
	extra: Record<string, unknown> = {},
	bearer: string | null = alice,
) =>
	call(
		'POST',
		'/push/devices',
		{ token: tokenOf(n), platform: 'ios', locale: 'en', ...extra },
		bearer,
	)

beforeEach(async () => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-push-'))
	process.env.TENANT_DB_DIR = tempDir
	process.env.DATA_REGION = 'us'
	process.env.JWT_SECRET = jwtSecret
	process.env.AUTH_HMAC_SECRET = 'push-test-hmac-secret-very-long-1234567890'
	// varlock keeps removed keys in its config, so reset to explicit values.
	process.env.PUSH_ENABLED = 'true'
	process.env.PUSH_KSA_APPROVED = 'no'
	syncEnvFromProcess()
	clearCustomerAppInfoCache()
	info.value = {
		app: {
			id: 'app_1',
			displayName: 'Acme',
			iosBundleId: 'com.acme.app',
			androidPackage: 'com.acme.app',
			stores: {},
			inviteEmail: true,
		},
		push: {
			enabled: true,
			marketing: true,
			credentials: { ios: true, android: true },
		},
	}
	provider = new MockPushProvider()
	setPushProvider(provider)
	await provisionTenantDb(orgId)
	const db = await getTenantDb(orgId)
	const [a] = await db
		.insert(customers)
		.values({ ...ALICE, phoneVerified: true })
		.returning()
	const [b] = await db
		.insert(customers)
		.values({ name: 'Bob Builder', phone: '+15555550302', phoneVerified: true })
		.returning()
	aliceId = a!.id
	bobId = b!.id
	alice = await jwt(aliceId)
	bob = await jwt(bobId)
	app = new Hono()
	app.route('/push', pushRoutes)
})

afterEach(async () => {
	setPushProvider(null)
	await destroyTenantDb(orgId)
	fs.rmSync(tempDir, { recursive: true, force: true })
})

const optIn = async (
	db: Awaited<ReturnType<typeof getTenantDb>>,
	customerId: string,
) => {
	await db.insert(customerSubscriptions).values({
		customerId,
		topic: 'marketing',
		channel: 'push',
		source: 'app_prompt',
		subscribedAt: new Date(),
	})
}

async function device(n: number, bearer: string | null = alice) {
	const response = await call(
		'POST',
		'/push/devices',
		{ token: tokenOf(n), platform: 'ios', locale: 'en' },
		bearer,
	)
	expect(response.status).toBe(201)
}

const resolved = (url: string | null | undefined) =>
	resolveLink(url ?? '', { appHost: 'acme.menuza.test', platform: 'ios' })

describe('booking and reward pushes open the right screen (#105, #195)', () => {
	it('a booking push goes out once per event and opens the reservations screen', async () => {
		await device(1)
		const send = () =>
			pushBooking(orgId, {
				customerId: aliceId,
				kind: 'confirmation',
				ref: 'b1:confirmation:1',
			})
		await send()
		await send()
		expect(provider.sent).toHaveLength(1)
		const payload = provider.sent[0]!.payload
		expect(payload.data.kind).toBe('booking')
		expect(resolved(payload.data.url)).toMatchObject({
			kind: 'app',
			route: '/reservations',
		})
		// A later reminder is its own event.
		await pushBooking(orgId, {
			customerId: aliceId,
			kind: 'reminder',
			ref: 'b1:reminder:1',
		})
		expect(provider.sent).toHaveLength(2)
	})

	it('a reward push goes out once per event and opens the rewards screen', async () => {
		await device(1)
		const db = await getTenantDb(orgId)
		const send = () =>
			sendPushToCustomer(db, {
				orgId,
				customerId: aliceId,
				kind: 'reward',
				ref: 'purchase_1:reward_available',
				category: 'rewards',
				build: ({ locale, siteOrigin }) =>
					buildRewardPush({ kind: 'reward_available' }, { locale, siteOrigin }),
			})
		expect(await send()).toMatchObject({ sent: 1 })
		expect(await send()).toMatchObject({ sent: 0 })
		const payload = provider.sent[0]!.payload
		expect(payload.data.kind).toBe('reward')
		expect(resolved(payload.data.url)).toMatchObject({
			kind: 'app',
			route: '/rewards',
		})
	})

	it('a guest who turned the category off gets no booking or reward push', async () => {
		await device(1)
		await call('PUT', '/push/preferences', { bookings: false, rewards: false })
		await pushBooking(orgId, {
			customerId: aliceId,
			kind: 'confirmation',
			ref: 'b9:confirmation:1',
		})
		expect(provider.sent).toHaveLength(0)
	})
})

describe('a push broadcast (#105: operators send it, with metrics)', () => {
	async function pushCampaign(
		db: Awaited<ReturnType<typeof getTenantDb>>,
		extra: Record<string, unknown> = {},
	) {
		const id = randomUUID()
		const now = Date.now()
		await db.insert(marketingCampaigns).values({
			id,
			name: 'Summer menu',
			channel: 'push',
			subject: 'Fresh summer menu',
			content: 'Open the app to take a look.',
			pushLink: '/menu',
			status: 'Processing',
			segmentationRules: JSON.stringify({ audience: 'all' }),
			updatedAt: broadcastLease(now),
			...extra,
		})
		return { id, now }
	}

	it('goes only to guests who opted in to Offers and news and have a device, once each', async () => {
		const db = await getTenantDb(orgId)
		await device(1)
		await device(2, bob)
		await optIn(db, aliceId) // Alice opted in; Bob has a device but did not.
		const { id, now } = await pushCampaign(db)
		const outcome = await dispatchBroadcast(orgId, id, broadcastLease(now), {
			now: () => now,
		})
		expect(outcome).toBe('completed')
		expect(provider.sent).toHaveLength(1)
		expect(provider.sent[0]!.token).toBe(tokenOf(1))
		const payload = provider.sent[0]!.payload
		expect(payload).toMatchObject({
			title: 'Fresh summer menu',
			body: 'Open the app to take a look.',
			data: { kind: 'marketing' },
		})
		expect(resolved(payload.data.url)).toMatchObject({
			kind: 'app',
			route: '/menu',
		})
		const rows = await db
			.select()
			.from(marketingMessages)
			.where(eq(marketingMessages.campaignId, id))
		expect(
			rows.map((row) => [row.customerId, row.channel, row.status]),
		).toEqual([[aliceId, 'push', 'Sent']])
		// A second dispatch of the same campaign sends nothing more.
		await dispatchBroadcast(orgId, id, broadcastLease(now), { now: () => now })
		expect(provider.sent).toHaveLength(1)
	})

	it('counts opens: a tap on the notification marks the recipient opened', async () => {
		const db = await getTenantDb(orgId)
		await device(1)
		await optIn(db, aliceId)
		const { id, now } = await pushCampaign(db)
		await dispatchBroadcast(orgId, id, broadcastLease(now), { now: () => now })
		const messageId = provider.sent[0]!.payload.data.messageId!
		expect((await call('POST', '/push/opened', { messageId })).status).toBe(204)
		const [row] = await db
			.select()
			.from(marketingMessages)
			.where(eq(marketingMessages.campaignId, id))
		expect(row!.openedAt).not.toBeNull()
	})

	it('holds no personal data: no name, phone or email of the guest', async () => {
		const db = await getTenantDb(orgId)
		await device(1)
		await optIn(db, aliceId)
		const { id, now } = await pushCampaign(db)
		await dispatchBroadcast(orgId, id, broadcastLease(now), { now: () => now })
		const payload = provider.sent[0]!.payload
		expect(
			payloadHoldsPersonalData(payload, [
				'Alice Wonderland',
				'Alice',
				'+15555550301',
				'alice@example.com',
			]),
		).toEqual([])
	})

	it('fails the broadcast, sending nothing, while push is not on for the restaurant', async () => {
		const db = await getTenantDb(orgId)
		await device(1)
		await optIn(db, aliceId)
		info.value = {
			...(info.value as object),
			push: {
				enabled: true,
				marketing: false,
				credentials: { ios: true, android: true },
			},
		}
		const { id, now } = await pushCampaign(db)
		expect(
			await dispatchBroadcast(orgId, id, broadcastLease(now), {
				now: () => now,
			}),
		).toBe('failed')
		expect(provider.sent).toHaveLength(0)
	})

	it("a push counts against the guest's frequency cap like any marketing message", async () => {
		const db = await getTenantDb(orgId)
		await device(1)
		await optIn(db, aliceId)
		await db
			.insert(marketingSettings)
			.values({
				key: 'frequency_cap',
				value: JSON.stringify({ limit: 1, days: 7 }),
			})
		const first = await pushCampaign(db)
		await dispatchBroadcast(orgId, first.id, broadcastLease(first.now), {
			now: () => first.now,
		})
		expect(provider.sent).toHaveLength(1)
		const second = await pushCampaign(db, { name: 'Another' })
		await dispatchBroadcast(orgId, second.id, broadcastLease(second.now), {
			now: () => second.now,
		})
		// Alice is at the cap, so the second broadcast skips her.
		expect(provider.sent).toHaveLength(1)
	})
})

describe('a push step in an automation (#105)', () => {
	async function stepFor(
		config: Record<string, unknown>,
		nodeId = 'node-push',
	) {
		const db = await getTenantDb(orgId)
		const [journey] = await db
			.insert(marketingJourneys)
			.values({
				name: 'Win back',
				status: 'active',
				triggerType: 'phone_verified',
			})
			.returning()
		const [run] = await db
			.insert(journeyRuns)
			.values({
				journeyId: journey!.id,
				customerId: aliceId,
				status: 'running',
				contextData: '{}',
			})
			.returning()
		const execute = (id = nodeId) =>
			executeJourneyStep(orgId, {
				orgId,
				journeyId: journey!.id,
				runId: run!.id,
				customerId: aliceId,
				nodeId: id,
				nodeType: 'action_push',
				config,
			})
		return { db, execute }
	}

	const config = {
		title: 'We miss you',
		body: 'Open the app for something new.',
	}

	it('sends once per run and step to a guest who opted in, and records it for the cap', async () => {
		const { db, execute } = await stepFor(config)
		await device(1)
		await optIn(db, aliceId)
		const first = await execute()
		expect(first).toMatchObject({ success: true, status: 'delivered' })
		await execute()
		expect(provider.sent).toHaveLength(1)
		expect(provider.sent[0]!.payload).toMatchObject({
			title: 'We miss you',
			data: { kind: 'marketing' },
		})
		const rows = await db
			.select()
			.from(marketingMessages)
			.where(eq(marketingMessages.customerId, aliceId))
		expect(rows.map((row) => row.channel)).toEqual(['push'])
	})

	it('skips a guest who did not opt in, without an error', async () => {
		const { execute } = await stepFor(config)
		await device(1)
		const result = await execute()
		expect(result).toMatchObject({ success: true, status: 'skipped' })
		expect(provider.sent).toHaveLength(0)
	})

	it('refuses merge tags: a push step holds no personal data', async () => {
		const { db, execute } = await stepFor({
			title: 'Hi {{name}}',
			body: 'Come back',
		})
		await device(1)
		await optIn(db, aliceId)
		const result = await execute()
		expect(result.success).toBe(false)
		expect(provider.sent).toHaveLength(0)
	})

	it('is capped like email and text steps', async () => {
		const { db, execute } = await stepFor(config)
		await device(1)
		await optIn(db, aliceId)
		await db
			.insert(marketingSettings)
			.values({
				key: 'frequency_cap',
				value: JSON.stringify({ limit: 1, days: 7 }),
			})
		expect(await execute('one')).toMatchObject({ status: 'delivered' })
		expect(await execute('two')).toMatchObject({
			status: 'skipped',
			reason: 'frequency_capped',
		})
		expect(provider.sent).toHaveLength(1)
	})
})

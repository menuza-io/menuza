import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { brand } from '@repo/config/brand'
import { sendSms } from '@repo/sms'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	marketingCampaigns,
	marketingMessages,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { getBroadcastHourlyCap } from '../lib/rate-limit.ts'
import { sendTenantEmail } from '../lib/tenant-email.ts'
import { operatorRoutes } from '../routes/operator.ts'
import {
	BROADCAST_MAX_FAILURES,
	BROADCAST_STALE_MS,
	broadcastLease,
	dispatchBroadcast,
	nextBroadcastWakeAt,
	runBroadcastTick,
	startBroadcastTickForOrg,
} from './broadcast-dispatch.ts'
import {
	emailConsentHash,
	setCustomerSubscription,
} from './marketing-audience.ts'

vi.mock('@repo/email', () => ({
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEngagementLoggingConfigured: vi.fn().mockReturnValue(false),
}))
vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true }),
}))
vi.mock('../lib/rate-limit.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/rate-limit.ts')>()
	return {
		...actual,
		getBroadcastHourlyCap: vi.fn(actual.getBroadcastHourlyCap),
	}
})
vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const orgId = 'clw9x0a12000008l00bcast01'
const operatorSecret = 'test-operator-secret-123456789'

async function emailCustomers(db: TenantDatabase, n: number) {
	const rows = await db
		.insert(customers)
		.values(
			Array.from({ length: n }, (_, i) => ({
				name: `C${String(i).padStart(3, '0')}`,
				email: `c${String(i).padStart(3, '0')}@example.com`,
			})),
		)
		.returning()
	await db.insert(customerSubscriptions).values(
		rows.map((c) => ({
			customerId: c.id,
			topic: 'marketing' as const,
			channel: 'email' as const,
			source: 'signup' as const,
			subscribedAt: new Date(),
			confirmedEmailHash: emailConsentHash(c.email!),
		})),
	)
	return rows.sort((a, b) => a.id.localeCompare(b.id))
}

async function smsCustomers(db: TenantDatabase, n: number) {
	const rows = await db
		.insert(customers)
		.values(
			Array.from({ length: n }, (_, i) => ({
				name: `S${i}`,
				phone: `+1555000${String(i).padStart(4, '0')}`,
				phoneVerified: true,
			})),
		)
		.returning()
	await db.insert(customerSubscriptions).values(
		rows.map((c) => ({
			customerId: c.id,
			topic: 'marketing' as const,
			channel: 'sms' as const,
			source: 'signup' as const,
			subscribedAt: new Date(),
		})),
	)
	return rows
}

async function campaign(
	db: TenantDatabase,
	values: Partial<typeof marketingCampaigns.$inferInsert> = {},
) {
	const id = randomUUID()
	await db.insert(marketingCampaigns).values({
		id,
		name: 'Promo',
		channel: 'email',
		subject: 'Hi',
		content: 'Hello {{customer.name}}',
		status: 'Processing',
		segmentationRules: JSON.stringify({ audience: 'all' }),
		...values,
	})
	return id
}

async function getCampaign(db: TenantDatabase, id: string) {
	return db
		.select()
		.from(marketingCampaigns)
		.where(eq(marketingCampaigns.id, id))
		.get()
}

async function messagesOf(db: TenantDatabase, id: string) {
	return db
		.select()
		.from(marketingMessages)
		.where(eq(marketingMessages.campaignId, id))
		.all()
}

function emailedTo() {
	return vi.mocked(sendTenantEmail).mock.calls.map(([input]) => input.to)
}

describe('broadcast dispatch', () => {
	let tempDir: string
	const savedCap = process.env.GLOBAL_SMS_CAP

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-bcast-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		await provisionTenantDb(orgId)
		vi.mocked(sendTenantEmail).mockReset()
		vi.mocked(sendTenantEmail).mockResolvedValue({
			status: 'success',
		} as never)
		vi.mocked(sendSms).mockClear()
	})

	afterEach(async () => {
		if (savedCap === undefined) delete process.env.GLOBAL_SMS_CAP
		else process.env.GLOBAL_SMS_CAP = savedCap
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('resumes a stale Processing broadcast, sending only to customers without a message', async () => {
		const db = await getTenantDb(orgId)
		const [done, inFlight, todo] = await emailCustomers(db, 3)
		const now = Date.now()
		const id = await campaign(db, {
			updatedAt: new Date(now - BROADCAST_STALE_MS - 60_000),
		})
		await db.insert(marketingMessages).values([
			{
				id: randomUUID(),
				campaignId: id,
				customerId: done!.id,
				status: 'Sent',
			},
			// The dispatch died mid-send: this one may have gone out.
			{
				id: randomUUID(),
				campaignId: id,
				customerId: inFlight!.id,
				status: 'Processing',
			},
		])

		const result = await runBroadcastTick(orgId, db, now)

		expect(result.outcomes).toEqual(['completed'])
		expect(emailedTo()).toEqual([todo!.email])
		expect((await getCampaign(db, id))?.status).toBe('Completed')
		const byCustomer = Object.fromEntries(
			(await messagesOf(db, id)).map((m) => [m.customerId, m.status]),
		)
		expect(byCustomer).toEqual({
			[done!.id]: 'Sent',
			[inFlight!.id]: 'Unknown',
			[todo!.id]: 'Sent',
		})
	})

	it('two dispatches of one campaign running at once send once per customer', async () => {
		const db = await getTenantDb(orgId)
		const people = await emailCustomers(db, 30)
		const now = Date.now()
		const lease = broadcastLease(now)
		const id = await campaign(db, { updatedAt: lease })

		// Both hold the same lease (the heartbeat stays in one second), so the
		// lease alone does not keep them apart.
		const outcomes = await Promise.all([
			dispatchBroadcast(orgId, id, lease, { now: () => now }),
			dispatchBroadcast(orgId, id, lease, { now: () => now }),
		])

		expect(outcomes).toContain('completed')
		expect([...emailedTo()].sort()).toEqual(
			people.map((person) => person.email).sort(),
		)
		expect(await messagesOf(db, id)).toHaveLength(30)
	})

	it('does not resume a Processing broadcast whose dispatcher is alive', async () => {
		const db = await getTenantDb(orgId)
		await emailCustomers(db, 1)
		const now = Date.now()
		const id = await campaign(db, { updatedAt: new Date(now - 60_000) })

		const result = await runBroadcastTick(orgId, db, now)

		expect(result.claimed).toBe(0)
		expect(emailedTo()).toEqual([])
		expect((await getCampaign(db, id))?.status).toBe('Processing')
	})

	it('a dispatcher that lost its lease stops before sending', async () => {
		const db = await getTenantDb(orgId)
		await emailCustomers(db, 2)
		const now = Date.now()
		const id = await campaign(db, { updatedAt: broadcastLease(now) })

		// Someone else holds the campaign now (a different heartbeat value).
		const outcome = await dispatchBroadcast(
			orgId,
			id,
			broadcastLease(now - 3_600_000),
		)

		expect(outcome).toBe('lost_lease')
		expect(emailedTo()).toEqual([])
	})

	it('creates a future broadcast as Scheduled and the tick sends it once due', async () => {
		process.env.JWT_SECRET = operatorSecret
		const db = await getTenantDb(orgId)
		const [customer] = await emailCustomers(db, 1)
		const token = await new SignJWT({
			orgId,
			role: 'operator',
			canUpdate: true,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('1h')
			.sign(new TextEncoder().encode(operatorSecret))
		const app = new Hono()
		app.route('/operator', operatorRoutes)
		const scheduledAt = new Date(Date.now() + 3_600_000)

		const res = await app.request('/operator/marketing/campaigns', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				name: 'Later',
				channel: 'email',
				subject: 'Hi',
				content: 'Hello',
				audience: 'all',
				scheduledAt: scheduledAt.toISOString(),
			}),
		})
		expect(res.status).toBe(200)
		const { campaignId } = (await res.json()) as { campaignId: string }

		// Not yet due.
		await runBroadcastTick(orgId, db, Date.now())
		expect(emailedTo()).toEqual([])

		const result = await runBroadcastTick(
			orgId,
			db,
			scheduledAt.getTime() + 1000,
		)
		expect(result.outcomes).toEqual(['completed'])
		expect(emailedTo()).toEqual([customer!.email])
		expect((await getCampaign(db, campaignId))?.status).toBe('Completed')
	})

	it('never sends a Draft, even one with a past scheduled time', async () => {
		const db = await getTenantDb(orgId)
		await emailCustomers(db, 1)
		const now = Date.now()
		const id = await campaign(db, {
			status: 'Draft',
			scheduledAt: new Date(now - 60_000),
		})

		const result = await runBroadcastTick(orgId, db, now)

		expect(result.claimed).toBe(0)
		expect(emailedTo()).toEqual([])
		expect((await getCampaign(db, id))?.status).toBe('Draft')
		expect(await nextBroadcastWakeAt(db, now)).toBeNull()
	})

	it('leaves a broadcast Processing after an unexpected error, and resumes it', async () => {
		const db = await getTenantDb(orgId)
		const [customer] = await emailCustomers(db, 1)
		const now = Date.now()
		const id = await campaign(db, { updatedAt: broadcastLease(now) })
		vi.mocked(getBroadcastHourlyCap).mockImplementationOnce(() => {
			throw new Error('storage blip')
		})

		expect(await dispatchBroadcast(orgId, id, broadcastLease(now))).toBe(
			'retry',
		)
		expect((await getCampaign(db, id))?.status).toBe('Processing')
		expect(emailedTo()).toEqual([])

		const later = now + BROADCAST_STALE_MS + 1000
		const result = await runBroadcastTick(orgId, db, later)
		expect(result.outcomes).toEqual(['completed'])
		expect(emailedTo()).toEqual([customer!.email])
	})

	it('a dispatcher that lost its lease does not count a failure', async () => {
		const db = await getTenantDb(orgId)
		await emailCustomers(db, 1)
		const now = Date.now()
		// Another dispatcher holds the campaign now (a newer lease).
		const id = await campaign(db, {
			dispatchFailures: BROADCAST_MAX_FAILURES - 1,
			updatedAt: broadcastLease(now),
		})
		vi.mocked(getBroadcastHourlyCap).mockImplementationOnce(() => {
			throw new Error('storage blip')
		})

		expect(
			await dispatchBroadcast(orgId, id, broadcastLease(now - 60_000)),
		).toBe('lost_lease')
		const stored = await getCampaign(db, id)
		expect(stored?.status).toBe('Processing')
		expect(stored?.dispatchFailures).toBe(BROADCAST_MAX_FAILURES - 1)
	})

	it('fails a broadcast after repeated errors, and a sent batch resets the count', async () => {
		const db = await getTenantDb(orgId)
		await emailCustomers(db, 1)
		const now = Date.now()
		const id = await campaign(db, {
			dispatchFailures: BROADCAST_MAX_FAILURES - 1,
			updatedAt: broadcastLease(now),
		})
		vi.mocked(getBroadcastHourlyCap).mockImplementationOnce(() => {
			throw new Error('storage blip')
		})

		expect(await dispatchBroadcast(orgId, id, broadcastLease(now))).toBe(
			'failed',
		)
		expect((await getCampaign(db, id))?.status).toBe('Failed')

		const recovering = await campaign(db, {
			dispatchFailures: BROADCAST_MAX_FAILURES - 1,
			updatedAt: broadcastLease(now),
		})
		expect(
			await dispatchBroadcast(orgId, recovering, broadcastLease(now)),
		).toBe('completed')
		expect((await getCampaign(db, recovering))?.dispatchFailures).toBe(0)
	})

	it('the tick pass claims a due broadcast and sends it detached, without holding the tick', async () => {
		const db = await getTenantDb(orgId)
		const [customer] = await emailCustomers(db, 1)
		const now = Date.now()
		const id = await campaign(db, {
			status: 'Scheduled',
			scheduledAt: new Date(now - 60_000),
		})
		let releaseSend!: () => void
		vi.mocked(sendTenantEmail).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseSend = () => resolve({ status: 'success' } as never)
				}),
		)
		const detached: Promise<unknown>[] = []

		const result = await startBroadcastTickForOrg(orgId, {
			now,
			runDetached: (task) => detached.push(task),
		})

		// The pass returned while the send is still in flight.
		expect(result?.claimed).toBe(1)
		expect(detached).toHaveLength(1)
		expect((await getCampaign(db, id))?.status).toBe('Processing')
		await vi.waitFor(() => expect(emailedTo()).toEqual([customer!.email]))
		releaseSend()
		await Promise.all(detached)
		expect((await getCampaign(db, id))?.status).toBe('Completed')
		// A second pass right away finds nothing to claim.
		expect(
			(await startBroadcastTickForOrg(orgId, { now: now + 1000 }))?.claimed,
		).toBe(0)
	})

	it('reports when the tick next has broadcast work', async () => {
		const db = await getTenantDb(orgId)
		const now = Date.now()
		expect(await nextBroadcastWakeAt(db, now)).toBeNull()

		const at = new Date(Math.floor((now + 3_600_000) / 1000) * 1000)
		await campaign(db, { status: 'Scheduled', scheduledAt: at })
		expect(await nextBroadcastWakeAt(db, now)).toBe(at.getTime())

		// A send in progress is looked at again once its lease could go stale.
		const lease = broadcastLease(now)
		await campaign(db, { status: 'Processing', updatedAt: lease })
		expect(await nextBroadcastWakeAt(db, now)).toBe(
			lease.getTime() + BROADCAST_STALE_MS + 1000,
		)
	})

	it('counts every recipient against the durable hourly cap', async () => {
		process.env.GLOBAL_SMS_CAP = '3'
		const db = await getTenantDb(orgId)
		const people = await smsCustomers(db, 4)
		// One text already went out this hour (another campaign).
		const earlier = await campaign(db, { channel: 'sms', status: 'Completed' })
		await db.insert(marketingMessages).values({
			id: randomUUID(),
			campaignId: earlier,
			customerId: people[0]!.id,
			channel: 'sms',
			status: 'Sent',
			sentAt: new Date(),
		})
		const now = Date.now()
		const id = await campaign(db, {
			channel: 'sms',
			updatedAt: broadcastLease(now),
		})

		const outcome = await dispatchBroadcast(orgId, id, broadcastLease(now))

		expect(outcome).toBe('throttled')
		expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(2)
		expect(await messagesOf(db, id)).toHaveLength(2)
		// Left Processing: the tick resumes it once the window has room.
		expect((await getCampaign(db, id))?.status).toBe('Processing')
	})

	it('honours an unsubscribe made while the broadcast is being sent', async () => {
		const db = await getTenantDb(orgId)
		const people = await emailCustomers(db, 30)
		const last = people[29]!
		vi.mocked(sendTenantEmail).mockImplementation(async (input) => {
			if (input.to === people[0]!.email) {
				await setCustomerSubscription(db, {
					customerId: last.id,
					topic: 'marketing',
					channel: 'email',
					subscribed: false,
					source: 'customer',
				})
			}
			return { status: 'success' } as never
		})
		const now = Date.now()
		const id = await campaign(db, { updatedAt: broadcastLease(now) })

		await dispatchBroadcast(orgId, id, broadcastLease(now))

		expect(emailedTo()).toHaveLength(29)
		expect(emailedTo()).not.toContain(last.email)
		expect((await getCampaign(db, id))?.status).toBe('Completed')
	})

	it('does not overwrite an engagement status recorded during the send', async () => {
		const db = await getTenantDb(orgId)
		await emailCustomers(db, 1)
		vi.mocked(sendTenantEmail).mockImplementation(async (input) => {
			// Engagement sync lands before the batch records its outcome.
			await db
				.update(marketingMessages)
				.set({ status: 'Opened', openedAt: new Date() })
				.where(eq(marketingMessages.id, input.context!.messageId!))
			return { status: 'success' } as never
		})
		const now = Date.now()
		const id = await campaign(db, { updatedAt: broadcastLease(now) })

		await dispatchBroadcast(orgId, id, broadcastLease(now))

		const [message] = await messagesOf(db, id)
		expect(message?.status).toBe('Opened')
	})
})

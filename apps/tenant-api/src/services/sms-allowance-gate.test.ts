/**
 * #247 in the region: a text broadcast starts by spending one send of the
 * month's allowance; with none left it is put off to the reset day; a send that
 * will not go out gives it back; an automation text step counts once a month;
 * transactional texts, email and push never ask.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendSms } from '@repo/sms'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	journeyRuns,
	marketingCampaigns,
	marketingJourneys,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { bindAppService } from '../lib/app-service.ts'
import { clearOrgEmailSenderCacheForTest } from '../lib/org-email-sender.ts'
import { postSmsAllowance } from '../lib/sms-allowance-client.ts'
import {
	broadcastLease,
	claimBroadcast,
	dispatchBroadcast,
	skipLateBroadcast,
} from './broadcast-dispatch.ts'
import {
	executeJourneyStep,
	journeyStepAllowanceKey,
} from './journey-service.ts'

vi.mock('@repo/email', () => ({
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEngagementLoggingConfigured: vi.fn().mockReturnValue(false),
}))
vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true, mock: true }),
}))
vi.mock('../lib/marketing-notify.ts', () => ({
	postMarketingNotify: vi.fn().mockResolvedValue({ status: 'delivered' }),
}))
vi.mock('../lib/tenant-email.ts', () => ({
	sendTenantEmail: vi.fn().mockResolvedValue({ status: 'success' }),
}))

const orgId = 'clw9x0a12000008l00allow01'
const RESET = Date.UTC(2026, 11, 1)

type AllowanceCall = { orgId: string; campaignId: string; action: string }
let allowanceCalls: AllowanceCall[]
let allowanceAnswer: () => unknown

function stubApp() {
	allowanceCalls = []
	allowanceAnswer = () => ({ ok: true })
	vi.mocked(postSmsAllowance).mockImplementation(async (event) => {
		allowanceCalls.push(event)
		return allowanceAnswer() as never
	})
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ id: orgId, name: 'Casa Verde' })),
	)
}

async function smsGuest(db: TenantDatabase) {
	const [guest] = await db
		.insert(customers)
		.values({ name: 'Nora', phone: '+15550123456', phoneVerified: true })
		.returning()
	await db.insert(customerSubscriptions).values({
		customerId: guest!.id,
		topic: 'marketing',
		channel: 'sms',
		source: 'signup',
		subscribedAt: new Date(),
	})
	return guest!
}

async function smsCampaign(db: TenantDatabase, now: number, extra = {}) {
	const id = randomUUID()
	await db.insert(marketingCampaigns).values({
		id,
		name: 'Promo',
		channel: 'sms',
		content: 'Half price today',
		status: 'Processing',
		segmentationRules: JSON.stringify({ audience: 'all' }),
		updatedAt: broadcastLease(now),
		...extra,
	})
	return id
}

const campaignRow = async (db: TenantDatabase, id: string) =>
	db
		.select()
		.from(marketingCampaigns)
		.where(eq(marketingCampaigns.id, id))
		.get()

describe('text allowance in the region (#247)', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-allow-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.APP_URL = 'https://app.example.test'
		process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-command-token'
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		clearOrgEmailSenderCacheForTest()
		stubApp()
		vi.mocked(sendSms).mockClear()
		await provisionTenantDb(orgId)
	})

	afterEach(async () => {
		bindAppService(null)
		vi.unstubAllGlobals()
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('a text broadcast confirms a send of the month before its first text, once', async () => {
		const db = await getTenantDb(orgId)
		await smsGuest(db)
		const now = Date.UTC(2026, 10, 15, 16)
		const id = await smsCampaign(db, now)
		expect(
			await dispatchBroadcast(orgId, id, broadcastLease(now), {
				now: () => now,
			}),
		).toBe('completed')
		expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(1)
		expect(allowanceCalls).toEqual([{ orgId, campaignId: id, action: 'start' }])
	})

	it('with none left it sends nothing and is put off to the day the allowance returns', async () => {
		allowanceAnswer = () => ({
			ok: false,
			reason: 'exhausted',
			resetsAt: RESET,
		})
		const db = await getTenantDb(orgId)
		await smsGuest(db)
		const now = Date.UTC(2026, 10, 15, 16)
		const id = await smsCampaign(db, now)

		const outcome = await dispatchBroadcast(orgId, id, broadcastLease(now), {
			now: () => now,
		})

		expect(outcome).toBe('deferred')
		expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
		const held = await campaignRow(db, id)
		// A scheduled broadcast again, which the operator can still edit or cancel.
		expect(held?.status).toBe('Scheduled')
		expect(held?.scheduledAt?.getTime()).toBe(RESET)

		// Not started before the reset...
		expect(await claimBroadcast(db, id, RESET - 1000)).toBeNull()
		// ...and sent on the first day of the new month once the allowance is back.
		allowanceAnswer = () => ({ ok: true })
		const lease = await claimBroadcast(db, id, RESET + 60 * 60 * 1000)
		expect(lease).not.toBeNull()
		const morning = RESET + 60 * 60 * 1000
		expect(
			await dispatchBroadcast(orgId, id, lease!, { now: () => morning }),
		).toBe('completed')
		expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(1)
	})

	it('asks again shortly when the App cannot answer, and sends nothing meanwhile', async () => {
		allowanceAnswer = () => ({ ok: 'unavailable' })
		const db = await getTenantDb(orgId)
		await smsGuest(db)
		const now = Date.UTC(2026, 10, 15, 16)
		const id = await smsCampaign(db, now)
		expect(
			await dispatchBroadcast(orgId, id, broadcastLease(now), {
				now: () => now,
			}),
		).toBe('deferred')
		expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
		expect((await campaignRow(db, id))?.status).toBe('Processing')
	})

	it('gives the send back when the broadcast fails before anything went out', async () => {
		const db = await getTenantDb(orgId)
		// Nobody to send to: blocked at the start.
		const now = Date.UTC(2026, 10, 15, 16)
		const id = await smsCampaign(db, now)
		expect(
			await dispatchBroadcast(orgId, id, broadcastLease(now), {
				now: () => now,
			}),
		).toBe('failed')
		expect(allowanceCalls).toEqual([
			{ orgId, campaignId: id, action: 'release' },
		])
	})

	it('gives the send back when a scheduled broadcast was skipped as too late', async () => {
		const db = await getTenantDb(orgId)
		const now = Date.UTC(2026, 10, 15, 16)
		const id = await smsCampaign(db, now, {
			status: 'Scheduled',
			scheduledAt: new Date(now - 6 * 60 * 60 * 1000),
			lateAfterMinutes: 60,
		})
		expect(await skipLateBroadcast(db, id, now)).toBe(true)
		const { startBroadcastTickForOrg } = await import('./broadcast-dispatch.ts')
		// The tick tells the App the broadcast will never go out.
		const other = await smsCampaign(db, now, {
			status: 'Scheduled',
			scheduledAt: new Date(now - 6 * 60 * 60 * 1000),
			lateAfterMinutes: 60,
		})
		const tasks: Promise<unknown>[] = []
		await startBroadcastTickForOrg(orgId, {
			now,
			runDetached: (task) => tasks.push(task),
		})
		await Promise.all(tasks)
		expect(allowanceCalls).toContainEqual({
			orgId,
			campaignId: other,
			action: 'release',
		})
	})

	it('email and push broadcasts never ask for a send', async () => {
		const db = await getTenantDb(orgId)
		const now = Date.UTC(2026, 10, 15, 16)
		const id = randomUUID()
		await db.insert(marketingCampaigns).values({
			id,
			name: 'News',
			channel: 'email',
			subject: 'Hi',
			content: 'Hello',
			status: 'Processing',
			segmentationRules: JSON.stringify({ audience: 'all' }),
			updatedAt: broadcastLease(now),
		})
		await dispatchBroadcast(orgId, id, broadcastLease(now), { now: () => now })
		expect(allowanceCalls).toEqual([])
	})

	describe('automations', () => {
		async function smsStep(db: TenantDatabase) {
			const guest = await smsGuest(db)
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Welcome', status: 'active' })
				.returning()
			const [run] = await db
				.insert(journeyRuns)
				.values({ journeyId: journey!.id, customerId: guest.id })
				.returning()
			return {
				orgId,
				journeyId: journey!.id,
				runId: run!.id,
				customerId: guest.id,
				nodeId: 'sms-1',
				nodeType: 'action_sms',
				config: { messageText: 'Welcome!' },
			}
		}

		it('an automation text step counts one send a month, under an opaque key', async () => {
			const db = await getTenantDb(orgId)
			const step = await smsStep(db)
			expect((await executeJourneyStep(orgId, step)).status).toBe('delivered')
			expect(allowanceCalls).toHaveLength(1)
			const [call] = allowanceCalls
			expect(call!.action).toBe('start')
			expect(call!.campaignId).toBe(
				journeyStepAllowanceKey(step.journeyId, step.nodeId, Date.now()),
			)
			// Only a hash leaves the region: not the journey, the step or a guest.
			expect(call!.campaignId).toMatch(/^journey:[0-9a-f]{40}$/)
			expect(JSON.stringify(call)).not.toContain(step.journeyId)
			// The next month is another key; the same month is the same one.
			expect(journeyStepAllowanceKey('j', 'n', Date.UTC(2026, 10, 1))).toBe(
				journeyStepAllowanceKey('j', 'n', Date.UTC(2026, 10, 30)),
			)
			expect(journeyStepAllowanceKey('j', 'n', Date.UTC(2026, 10, 1))).not.toBe(
				journeyStepAllowanceKey('j', 'n', Date.UTC(2026, 11, 1)),
			)
		})

		it('with none left the step waits for the month to turn over; nothing is sent or recorded', async () => {
			allowanceAnswer = () => ({
				ok: false,
				reason: 'exhausted',
				resetsAt: RESET,
			})
			const db = await getTenantDb(orgId)
			const step = await smsStep(db)
			const result = await executeJourneyStep(orgId, step)
			expect(result).toMatchObject({
				success: true,
				status: 'deferred',
				notBefore: RESET,
				error: 'allowance_exhausted',
			})
			expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
		})

		it("an operator's own test run is not counted", async () => {
			const db = await getTenantDb(orgId)
			const step = await smsStep(db)
			await db
				.update(journeyRuns)
				.set({ contextData: JSON.stringify({ isTestRun: true }) })
				.where(eq(journeyRuns.id, step.runId))
			expect((await executeJourneyStep(orgId, step)).status).toBe('delivered')
			expect(allowanceCalls).toEqual([])
		})
	})

	it('transactional texts never go through the allowance', async () => {
		// The allowance is asked for only by marketing broadcasts and automation
		// steps. The transactional senders do not even know of it.
		const transactional = [
			'./order-message-send.ts',
			'../lib/reservations-sms.ts',
			'./pos-ready-text-service.ts',
			'../routes/auth.ts',
			'./loyalty-notices-service.ts',
			'./people-consent-service.ts',
		]
		for (const file of transactional) {
			const source = fs.readFileSync(
				path.join(import.meta.dirname, file),
				'utf8',
			)
			expect(source, file).not.toContain('sms-allowance')
			expect(source, file).not.toContain('postSmsAllowance')
		}
	})
})

/**
 * #75 marketing texts: the opt-out phrase on every text, the 9:00 to 20:00
 * window (deferred, never dropped), a broadcast that pauses and resumes, and an
 * automation step that waits for the window.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SMS_OPT_OUT_PHRASE } from '@repo/common/sms-compliance'
import { sendSms } from '@repo/sms'
import {
	customers,
	customerSubscriptions,
	destroyTenantDb,
	getTenantDb,
	journeyRuns,
	journeyStepExecutions,
	marketingCampaigns,
	marketingJourneys,
	marketingMessages,
	provisionTenantDb,
	type TenantDatabase,
} from '@repo/tenant-db'
import { bindAppService } from '../lib/app-service.ts'
import { clearOrgEmailSenderCacheForTest } from '../lib/org-email-sender.ts'
import {
	BROADCAST_BATCH_SIZE,
	BROADCAST_STALE_MS,
	broadcastLease,
	dispatchBroadcast,
	nextBroadcastWakeAt,
	runBroadcastTick,
} from './broadcast-dispatch.ts'
import { executeJourneyStep } from './journey-service.ts'
import { prepareMarketingSms } from './marketing-sms.ts'

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

const orgId = 'clw9x0a12000008l00smsqh01'
const NY = 'America/New_York'
// Wednesday 10 June 2026, in New York (EDT, UTC-4).
const at = (hour: number, minute = 0, day = 10) =>
	Date.UTC(2026, 5, day, hour + 4, minute)

function appKnowsTimeZone(zone: string | null) {
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: string | URL | Request) =>
			String(url).includes('/sms-allowance')
				? Response.json({ ok: true })
				: zone
					? Response.json({
							id: orgId,
							name: 'Casa Verde',
							timeZone: zone,
							locationTimeZones: { loc_la: 'America/Los_Angeles' },
						})
					: new Response('no', { status: 503 }),
		),
	)
}

async function smsGuests(db: TenantDatabase, n: number) {
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

async function smsCampaign(db: TenantDatabase, now: number) {
	const id = randomUUID()
	await db.insert(marketingCampaigns).values({
		id,
		name: 'Taco Tuesday',
		channel: 'sms',
		content: 'Tacos are half price today!',
		status: 'Processing',
		segmentationRules: JSON.stringify({ audience: 'all' }),
		updatedAt: broadcastLease(now),
	})
	return id
}

describe('marketing texts (#75)', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-smsqh-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.APP_URL = 'https://app.example.test'
		process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-command-token'
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		// These tests are about the window.
		process.env.MARKETING_SMS_QUIET_HOURS = 'on'
		clearOrgEmailSenderCacheForTest()
		appKnowsTimeZone(NY)
		vi.mocked(sendSms).mockClear()
		await provisionTenantDb(orgId)
	})

	afterEach(async () => {
		process.env.MARKETING_SMS_QUIET_HOURS = 'off'
		// Set rather than deleted: the env snapshot never forgets a removed key.
		process.env.MARKETING_SMS_ENABLED = 'true'
		bindAppService(null)
		vi.unstubAllGlobals()
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	describe('prepareMarketingSms', () => {
		it('ends the text with the opt-out phrase and counts it in the segments', async () => {
			const result = await prepareMarketingSms({
				orgId,
				text: 'a'.repeat(150),
				now: at(12),
			})
			expect(result.body.endsWith(SMS_OPT_OUT_PHRASE)).toBe(true)
			// 150 characters fit one segment alone, not with the phrase.
			expect(result.segments).toBe(2)
			expect(result.notBefore).toBe(at(12))
			expect(result.reason).toBeNull()
		})

		it('defers outside 9:00 to 20:00 to the next 9:00 in the location zone', async () => {
			const night = await prepareMarketingSms({
				orgId,
				text: 'hi',
				now: at(21),
			})
			expect(night.reason).toBe('quiet_hours')
			expect(night.notBefore).toBe(at(9, 0, 11))
			const early = await prepareMarketingSms({ orgId, text: 'hi', now: at(7) })
			expect(early.notBefore).toBe(at(9))
			expect(
				(await prepareMarketingSms({ orgId, text: 'hi', now: at(19, 59) }))
					.reason,
			).toBeNull()
			expect(
				(await prepareMarketingSms({ orgId, text: 'hi', now: at(20) })).reason,
			).toBe('quiet_hours')
		})

		it("uses the location's own zone when a location is named", async () => {
			// 12:30 in New York is 9:30 in Los Angeles: open in both. 21:30 in
			// New York is 18:30 in Los Angeles: closed there only for New York.
			const now = at(21, 30)
			expect(
				(await prepareMarketingSms({ orgId, text: 'hi', now })).reason,
			).toBe('quiet_hours')
			expect(
				(
					await prepareMarketingSms({
						orgId,
						locationId: 'loc_la',
						text: 'hi',
						now,
					})
				).reason,
			).toBeNull()
		})

		it('waits and retries when the time zone cannot be read', async () => {
			clearOrgEmailSenderCacheForTest()
			appKnowsTimeZone(null)
			const result = await prepareMarketingSms({
				orgId,
				text: 'hi',
				now: at(12),
			})
			expect(result.reason).toBe('time_zone_unknown')
			expect(result.notBefore).toBeGreaterThan(at(12))
		})
	})

	describe('broadcasts', () => {
		it('every text carries the opt-out phrase', async () => {
			const db = await getTenantDb(orgId)
			await smsGuests(db, 2)
			const now = at(12)
			const id = await smsCampaign(db, now)

			expect(
				await dispatchBroadcast(orgId, id, broadcastLease(now), {
					now: () => now,
				}),
			).toBe('completed')

			const sent = vi.mocked(sendSms).mock.calls.map(([input]) => input.message)
			expect(sent).toHaveLength(2)
			for (const message of sent) {
				expect(message).toBe(
					`Tacos are half price today!\n${SMS_OPT_OUT_PHRASE}`,
				)
			}
		})

		it('sends nothing at night, and goes out at the next window', async () => {
			const db = await getTenantDb(orgId)
			await smsGuests(db, 3)
			const night = at(21)
			const id = await smsCampaign(db, night)

			const outcome = await dispatchBroadcast(
				orgId,
				id,
				broadcastLease(night),
				{
					now: () => night,
				},
			)

			expect(outcome).toBe('deferred')
			expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
			const held = await db
				.select()
				.from(marketingCampaigns)
				.where(eq(marketingCampaigns.id, id))
				.get()
			// Deferred, not dropped, not failed, not skipped late.
			expect(held?.status).toBe('Processing')
			// The alarm is armed for the moment the window opens.
			const wake = await nextBroadcastWakeAt(db, night)
			expect(wake).toBeGreaterThanOrEqual(at(9, 0, 11))
			expect(wake).toBeLessThan(at(9, 5, 11))

			// A tick before the window does nothing.
			const early = await runBroadcastTick(orgId, db, at(8, 59, 11), {
				now: () => at(8, 59, 11),
			})
			expect(early.claimed).toBe(0)
			expect(vi.mocked(sendSms)).not.toHaveBeenCalled()

			// A tick after it sends everything.
			const morning = at(9, 2, 11)
			const result = await runBroadcastTick(orgId, db, morning, {
				now: () => morning,
			})
			expect(result.outcomes).toEqual(['completed'])
			expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(3)
		})

		it('pauses at 20:00 in the middle of a send and resumes at 9:00', async () => {
			const db = await getTenantDb(orgId)
			const people = await smsGuests(db, BROADCAST_BATCH_SIZE + 5)
			let now = at(19, 58)
			const id = await smsCampaign(db, now)
			// The first batch goes out; the clock then passes 20:00.
			vi.mocked(sendSms).mockImplementation(async () => {
				now = at(20, 1)
				return { success: true, mock: true } as never
			})

			const first = await dispatchBroadcast(orgId, id, broadcastLease(now), {
				now: () => now,
			})
			expect(first).toBe('deferred')
			expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(BROADCAST_BATCH_SIZE)

			vi.mocked(sendSms).mockResolvedValue({
				success: true,
				mock: true,
			} as never)
			const morning = at(9, 2, 11)
			const resumed = await runBroadcastTick(orgId, db, morning, {
				now: () => morning,
			})
			expect(resumed.outcomes).toEqual(['completed'])
			// Everyone exactly once.
			expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(people.length)
			const messages = await db
				.select()
				.from(marketingMessages)
				.where(eq(marketingMessages.campaignId, id))
				.all()
			expect(new Set(messages.map((m) => m.customerId)).size).toBe(
				people.length,
			)
			expect(BROADCAST_STALE_MS).toBeGreaterThan(0)
		})

		it('the window follows daylight saving time', async () => {
			// 2026-03-08 02:00 EST jumps to 03:00 EDT. A send held at 20:30 on the
			// 7th (EST, UTC-5) opens at 9:00 EDT (13:00Z) on the 8th.
			const result = await prepareMarketingSms({
				orgId,
				text: 'hi',
				now: Date.UTC(2026, 2, 8, 1, 30),
			})
			expect(result.reason).toBe('quiet_hours')
			expect(result.notBefore).toBe(Date.UTC(2026, 2, 8, 13, 0))
		})

		it('MARKETING_SMS_ENABLED=false fails a text broadcast when it starts, with nothing sent', async () => {
			process.env.MARKETING_SMS_ENABLED = 'false'
			const db = await getTenantDb(orgId)
			await smsGuests(db, 2)
			const now = at(12)
			const id = await smsCampaign(db, now)
			expect(
				await dispatchBroadcast(orgId, id, broadcastLease(now), {
					now: () => now,
				}),
			).toBe('failed')
			expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
		})
	})

	describe('automation steps', () => {
		async function smsStep(db: TenantDatabase) {
			const [customer] = await db
				.insert(customers)
				.values({ name: 'Nora', phone: '+15550123456', phoneVerified: true })
				.returning()
			await db.insert(customerSubscriptions).values({
				customerId: customer!.id,
				topic: 'marketing',
				channel: 'sms',
				source: 'signup',
				subscribedAt: new Date(),
			})
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Welcome', status: 'active' })
				.returning()
			const [run] = await db
				.insert(journeyRuns)
				.values({ journeyId: journey!.id, customerId: customer!.id })
				.returning()
			return {
				orgId,
				journeyId: journey!.id,
				runId: run!.id,
				customerId: customer!.id,
				nodeId: 'sms-1',
				nodeType: 'action_sms',
				config: { messageText: 'Welcome, {{firstName}}!' },
			}
		}

		it('moves forward: nothing is sent or recorded at night, and the step is asked again at the window', async () => {
			const db = await getTenantDb(orgId)
			const step = await smsStep(db)
			vi.useFakeTimers({ toFake: ['Date'] })
			try {
				vi.setSystemTime(at(22))
				const held = await executeJourneyStep(orgId, step)
				expect(held.status).toBe('deferred')
				expect(held.success).toBe(true)
				expect(held.notBefore).toBe(at(9, 0, 11))
				expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
				expect(
					await db.select().from(journeyStepExecutions).all(),
				).toHaveLength(0)

				vi.setSystemTime(at(9, 1, 11))
				const sent = await executeJourneyStep(orgId, step)
				expect(sent.status).toBe('delivered')
				expect(vi.mocked(sendSms)).toHaveBeenCalledTimes(1)
				expect(vi.mocked(sendSms).mock.calls[0]![0].message).toBe(
					`Welcome, Nora!\n${SMS_OPT_OUT_PHRASE}`,
				)
			} finally {
				vi.useRealTimers()
			}
		})

		it("an operator's own test run is not held back", async () => {
			const db = await getTenantDb(orgId)
			const step = await smsStep(db)
			await db
				.update(journeyRuns)
				.set({ contextData: JSON.stringify({ isTestRun: true }) })
				.where(eq(journeyRuns.id, step.runId))
			vi.useFakeTimers({ toFake: ['Date'] })
			try {
				vi.setSystemTime(at(22))
				const r = await executeJourneyStep(orgId, step)
				expect(r.status).toBe('delivered')
			} finally {
				vi.useRealTimers()
			}
		})

		it('MARKETING_SMS_ENABLED=false skips the step and the journey goes on', async () => {
			process.env.MARKETING_SMS_ENABLED = 'false'
			const db = await getTenantDb(orgId)
			const step = await smsStep(db)
			vi.useFakeTimers({ toFake: ['Date'] })
			try {
				vi.setSystemTime(at(12))
				const result = await executeJourneyStep(orgId, step)
				expect(result.status).toBe('skipped')
				expect(result.reason).toBe('marketing_sms_disabled')
				expect(vi.mocked(sendSms)).not.toHaveBeenCalled()
			} finally {
				vi.useRealTimers()
			}
		})
	})
})

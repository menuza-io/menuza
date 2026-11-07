import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	customers,
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	smsSendEvents,
} from '@repo/tenant-db'
import { sendSms } from '@repo/sms'
import { authRoutes } from './auth.ts'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import {
	NATIVE_SEND_LIMITS,
	reserveSmsSend,
} from '../services/sms-send-limits.ts'

const orgId = 'clw9x0a12000008l00test81'
const organization = {
	id: orgId,
	slug: 'native-limits',
	customDomain: null,
	hasProvisionedDb: true,
	dataRegion: 'us',
}

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({ success: true }),
}))
vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi.fn(),
	resolveOrganizationForBrowserAuth: vi.fn(),
	resolvePublishedOrganization: vi.fn(),
}))
vi.mock('../services/journey-service.ts', () => ({
	evaluateAndSpawnTriggers: vi.fn().mockResolvedValue(undefined),
}))

const origin = await import('../lib/origin.ts')

describe('send-code from the customer app (no Turnstile widget)', () => {
	let tempDir: string
	let app: Hono

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-native-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		vi.stubEnv('TURNSTILE_SECRET_KEY', 'dummy-turnstile-secret-value')
		syncEnvFromProcess()
		vi.mocked(origin.findActiveOrganizationById).mockResolvedValue(organization)
		vi.mocked(origin.resolveOrganizationForBrowserAuth).mockResolvedValue(
			organization,
		)
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/auth', authRoutes)
		vi.mocked(sendSms).mockClear()
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		syncEnvFromProcess()
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function sendCode(phone: string, headers: Record<string, string> = {}) {
		return app.request('/auth/send-code', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Origin: 'https://native-limits.example',
				...headers,
			},
			body: JSON.stringify({ phone }),
		})
	}

	it('still refuses a browser request without a Turnstile token', async () => {
		expect((await sendCode('+15551230001')).status).toBe(403)
		expect(sendSms).not.toHaveBeenCalled()
	})

	it('sends for the app header and records the send durably', async () => {
		const res = await sendCode('+15551230002', { 'X-Epic-Customer-App': '1' })
		expect(res.status).toBe(200)
		expect(sendSms).toHaveBeenCalledTimes(1)
		const db = await getTenantDb(orgId)
		const rows = await db.select().from(smsSendEvents)
		expect(rows).toHaveLength(1)
		expect(rows[0]!.kind).toBe('native')
		// Neither the phone nor the IP is stored in the clear.
		expect(JSON.stringify(rows)).not.toContain('5551230002')
	})

	it('refuses app-header sends once the organization hour is used up', async () => {
		const db = await getTenantDb(orgId)
		for (let i = 0; i < NATIVE_SEND_LIMITS.perOrganizationPerHour; i++) {
			await reserveSmsSend(db, {
				kind: 'native',
				phone: `+1555000${String(i).padStart(4, '0')}`,
				ip: `198.51.100.${i % 250}`,
			})
		}
		const res = await sendCode('+15551230003', { 'X-Epic-Customer-App': '1' })
		expect(res.status).toBe(429)
		expect(sendSms).not.toHaveBeenCalled()
	})

	it('still sends to a returning customer when header traffic filled the organization hour', async () => {
		const db = await getTenantDb(orgId)
		await db
			.insert(customers)
			.values({
				id: 'cust_returning',
				name: 'Returning',
				phone: '+15551230004',
				phoneVerified: true,
			})
			.run()
		for (let i = 0; i < NATIVE_SEND_LIMITS.perOrganizationPerHour; i++) {
			await reserveSmsSend(db, {
				kind: 'native',
				phone: `+1555000${String(i).padStart(4, '0')}`,
				ip: `198.51.100.${i % 250}`,
			})
		}
		const known = await sendCode('+15551230004', { 'X-Epic-Customer-App': '1' })
		expect(known.status).toBe(200)
		const unknown = await sendCode('+15551230005', {
			'X-Epic-Customer-App': '1',
		})
		expect(unknown.status).toBe(429)
		expect(sendSms).toHaveBeenCalledTimes(1)
	})
})

describe('native send limits', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-native-svc-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		await provisionTenantDb(orgId)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	const native = (phone: string, ip: string | null, now?: number) =>
		getTenantDb(orgId).then((db) =>
			reserveSmsSend(db, { kind: 'native', phone, ip, now }),
		)

	it('caps one phone per hour and says when the oldest send leaves the window', async () => {
		const now = Date.now()
		for (let i = 0; i < NATIVE_SEND_LIMITS.perPhonePerHour; i++) {
			expect(
				await native('+15550001111', `203.0.113.${i}`, now + i * 60_000),
			).toEqual({ ok: true })
		}
		const refused = await native(
			'+15550001111',
			'203.0.113.99',
			now + 10 * 60_000,
		)
		expect(refused.ok).toBe(false)
		// The first send was at `now`, so the wait is about 50 minutes, not an hour.
		expect(!refused.ok && refused.retryAfter).toBe(50 * 60)
		// A refused attempt is not counted, and another phone still passes.
		const db = await getTenantDb(orgId)
		expect(await db.select().from(smsSendEvents)).toHaveLength(3)
		expect(await native('+15550002222', '203.0.113.99', now)).toEqual({
			ok: true,
		})
		// After the hour the phone may send again.
		expect(
			await native('+15550001111', '203.0.113.99', now + 61 * 60_000),
		).toEqual({ ok: true })
	})

	it('caps one IP per hour, but an unknown IP does not share one bucket', async () => {
		for (let i = 0; i < NATIVE_SEND_LIMITS.perIpPerHour; i++) {
			expect(
				(await native(`+1555009${String(i).padStart(4, '0')}`, '192.0.2.7')).ok,
			).toBe(true)
		}
		expect((await native('+15550003333', '192.0.2.7')).ok).toBe(false)
		for (let i = 0; i < NATIVE_SEND_LIMITS.perIpPerHour + 2; i++) {
			expect(
				(await native(`+1555008${String(i).padStart(4, '0')}`, null)).ok,
			).toBe(true)
		}
	})

	it('counts an IPv6 client by its /64, so rotating the host part buys nothing', async () => {
		for (let i = 0; i < NATIVE_SEND_LIMITS.perIpPerHour; i++) {
			expect(
				(
					await native(
						`+1555007${String(i).padStart(4, '0')}`,
						`2001:db8:1:2::${(i + 1).toString(16)}`,
					)
				).ok,
			).toBe(true)
		}
		expect((await native('+15550005555', '2001:db8:1:2:ffff::1')).ok).toBe(
			false,
		)
		// Another /64 is another bucket.
		expect((await native('+15550005556', '2001:db8:1:3::1')).ok).toBe(true)
	})

	it('exempts a known customer from the organization ceiling, not from the phone one', async () => {
		const db = await getTenantDb(orgId)
		for (let i = 0; i < NATIVE_SEND_LIMITS.perOrganizationPerHour; i++) {
			await reserveSmsSend(db, {
				kind: 'native',
				phone: `+1555006${String(i).padStart(4, '0')}`,
				ip: `198.51.100.${i % 250}`,
			})
		}
		expect((await native('+15550007777', '203.0.113.50')).ok).toBe(false)
		const known = () =>
			reserveSmsSend(db, {
				kind: 'native',
				phone: '+15550008888',
				ip: '203.0.113.51',
				knownCustomer: true,
			})
		for (let i = 0; i < NATIVE_SEND_LIMITS.perPhonePerHour; i++) {
			expect((await known()).ok).toBe(true)
		}
		expect((await known()).ok).toBe(false)
	})

	it('holds the ceiling under a parallel burst', async () => {
		const results = await Promise.all(
			Array.from({ length: 8 }, (_, i) =>
				native('+15550006666', `198.51.100.${i}`),
			),
		)
		expect(results.filter((r) => r.ok)).toHaveLength(
			NATIVE_SEND_LIMITS.perPhonePerHour,
		)
	})

	it('does not count browser sends against the app limits', async () => {
		const db = await getTenantDb(orgId)
		for (let i = 0; i < 5; i++) {
			await reserveSmsSend(db, {
				kind: 'browser',
				phone: '+15550004444',
				ip: '192.0.2.8',
			})
		}
		expect(await native('+15550004444', '192.0.2.8')).toEqual({ ok: true })
	})
})

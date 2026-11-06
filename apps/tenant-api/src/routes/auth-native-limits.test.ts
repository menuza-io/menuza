import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
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
	nativeSendRetryAfter,
	recordSmsSend,
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
			await recordSmsSend(db, {
				kind: 'native',
				phone: `+1555000${String(i).padStart(4, '0')}`,
				ip: `198.51.100.${i % 250}`,
			})
		}
		const res = await sendCode('+15551230003', { 'X-Epic-Customer-App': '1' })
		expect(res.status).toBe(429)
		expect(sendSms).not.toHaveBeenCalled()
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

	it('caps one phone and one IP per hour, and forgets after the hour', async () => {
		const db = await getTenantDb(orgId)
		const now = Date.now()
		for (let i = 0; i < NATIVE_SEND_LIMITS.perPhonePerHour; i++) {
			await recordSmsSend(db, {
				kind: 'native',
				phone: '+15550001111',
				ip: `203.0.113.${i}`,
				now,
			})
		}
		expect(
			await nativeSendRetryAfter(db, {
				phone: '+15550001111',
				ip: '203.0.113.99',
				now,
			}),
		).not.toBeNull()
		expect(
			await nativeSendRetryAfter(db, {
				phone: '+15550002222',
				ip: '203.0.113.99',
				now,
			}),
		).toBeNull()
		expect(
			await nativeSendRetryAfter(db, {
				phone: '+15550001111',
				ip: '203.0.113.99',
				now: now + 61 * 60 * 1000,
			}),
		).toBeNull()

		for (let i = 0; i < NATIVE_SEND_LIMITS.perIpPerHour; i++) {
			await recordSmsSend(db, {
				kind: 'native',
				phone: `+1555009${String(i).padStart(4, '0')}`,
				ip: '192.0.2.7',
				now,
			})
		}
		expect(
			await nativeSendRetryAfter(db, {
				phone: '+15550003333',
				ip: '192.0.2.7',
				now,
			}),
		).not.toBeNull()
	})

	it('does not count browser sends against the app limits', async () => {
		const db = await getTenantDb(orgId)
		for (let i = 0; i < 5; i++) {
			await recordSmsSend(db, {
				kind: 'browser',
				phone: '+15550004444',
				ip: '192.0.2.8',
			})
		}
		expect(
			await nativeSendRetryAfter(db, {
				phone: '+15550004444',
				ip: '192.0.2.8',
			}),
		).toBeNull()
	})

	it('drops rows older than a day when writing', async () => {
		const db = await getTenantDb(orgId)
		const now = Date.now()
		await recordSmsSend(db, {
			kind: 'native',
			phone: '+15550005555',
			ip: 'x',
			now: now - 25 * 60 * 60 * 1000,
		})
		await recordSmsSend(db, {
			kind: 'native',
			phone: '+15550005555',
			ip: 'x',
			now,
		})
		expect(await db.select().from(smsSendEvents)).toHaveLength(1)
	})
})

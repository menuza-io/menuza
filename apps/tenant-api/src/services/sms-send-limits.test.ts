import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	smsSendEvents,
} from '@repo/tenant-db'
import { syncEnvFromProcess } from '../lib/secrets.ts'
import {
	eraseSmsSendEvents,
	pruneSmsSendEvents,
	reserveSmsSend,
} from './sms-send-limits.ts'

const orgId = 'clw9x0a12000008l00smsev01'
const HOUR_MS = 60 * 60 * 1000

describe('sms send event retention', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-smsev-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		syncEnvFromProcess()
		await provisionTenantDb(orgId)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	it('prunes events older than a day and keeps recent ones', async () => {
		const db = await getTenantDb(orgId)
		const now = Date.now()
		await reserveSmsSend(db, {
			kind: 'browser',
			phone: '+15550000001',
			ip: '203.0.113.1',
			now: now - 25 * HOUR_MS,
		})
		await reserveSmsSend(db, {
			kind: 'browser',
			phone: '+15550000002',
			ip: '203.0.113.2',
			now: now - HOUR_MS,
		})

		await pruneSmsSendEvents(db, now)

		expect(await db.select().from(smsSendEvents).all()).toHaveLength(1)
	})

	it('erases only the events of the given phone numbers', async () => {
		const db = await getTenantDb(orgId)
		for (const phone of ['+15550000001', '+15550000001', '+15550000002']) {
			await reserveSmsSend(db, { kind: 'browser', phone, ip: null })
		}

		await eraseSmsSendEvents(db, ['+15550000001'])

		expect(await db.select().from(smsSendEvents).all()).toHaveLength(1)
	})
})

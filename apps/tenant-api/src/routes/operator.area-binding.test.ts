import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formOperatorRoutes } from './forms.ts'
import { operatorRoutes } from './operator.ts'

const orgId = 'clw9x0a12000008l00test78'
const operatorSecret = 'test-operator-secret-123456789'

function mint(claims: Record<string, unknown>) {
	return new SignJWT({ orgId, role: 'operator', ...claims })
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(operatorSecret))
}

// The Marketing page mints a browser token after checking only
// read:campaign:any, which the default member and viewer roles hold. That token
// must not read customer PII or form submissions, which the App gates behind
// other permissions.
describe('browser operator tokens are bound to the area they were minted for', () => {
	let tempDir: string
	let app: Hono

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-area-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.JWT_SECRET = operatorSecret
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		await provisionTenantDb(orgId)
		app = new Hono()
		app.route('/operator/forms', formOperatorRoutes)
		app.route('/operator', operatorRoutes)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	const get = (route: string, token: string) =>
		app.request(`/operator${route}`, {
			headers: { Authorization: `Bearer ${token}` },
		})

	it('a marketing token reads marketing data but not customers or forms', async () => {
		const token = await mint({ area: 'marketing' })
		expect((await get('/marketing/campaigns', token)).status).toBe(200)
		expect((await get('/customers', token)).status).toBe(401)
		expect((await get('/forms', token)).status).toBe(401)
		expect((await get('/forms/f1/submissions', token)).status).toBe(401)
	})

	it('a customers token reads customers but not marketing or forms', async () => {
		const token = await mint({
			area: 'customers',
			canUpdate: true,
			canDelete: true,
		})
		expect((await get('/customers', token)).status).toBe(200)
		expect((await get('/marketing/campaigns', token)).status).toBe(401)
		const send = await app.request('/operator/marketing/campaigns', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: '{}',
		})
		expect(send.status).toBe(401)
		expect((await get('/forms', token)).status).toBe(401)
	})

	it('server-side tokens without an area keep working everywhere', async () => {
		const token = await mint({})
		expect((await get('/customers', token)).status).toBe(200)
		expect((await get('/marketing/campaigns', token)).status).toBe(200)
		expect((await get('/forms', token)).status).toBe(200)
	})
})

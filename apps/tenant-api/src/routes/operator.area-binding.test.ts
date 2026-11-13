import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import { destroyTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTenantApiApp } from '../app.ts'
import { formOperatorRoutes } from './forms.ts'
import { journeyOperatorRoutes } from './journeys.ts'
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
		app.route('/operator/journeys', journeyOperatorRoutes)
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
		expect((await get('/marketing/campaigns/c1/summary', token)).status).toBe(
			404,
		)
		expect((await get('/customers', token)).status).toBe(401)
		expect((await get('/forms', token)).status).toBe(401)
		expect((await get('/forms/f1/submissions', token)).status).toBe(401)
		expect((await get('/journeys', token)).status).toBe(401)
	})

	// The Automations Runs page reads a journey's runs and a run's timeline
	// from the browser. Those reads carry customer ids only. The definition and
	// every write stay on the server-side token.
	it('a marketing token reads journey runs but not definitions or writes', async () => {
		const token = await mint({
			area: 'marketing',
			canUpdate: true,
			canDelete: true,
		})
		expect((await get('/journeys/j1', token)).status).toBe(401)
		expect((await get('/journeys/j1/runs', token)).status).toBe(200)
		expect((await get('/journeys/runs/r1', token)).status).toBe(404)
		for (const [method, route] of [
			['POST', '/journeys'],
			['PATCH', '/journeys/j1'],
			['PUT', '/journeys/j1'],
			['POST', '/journeys/j1/publish'],
			['POST', '/journeys/j1/pause'],
			['POST', '/journeys/trigger-test'],
			['DELETE', '/journeys/j1'],
		] as const) {
			const res = await app.request(`/operator${route}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: method === 'DELETE' ? undefined : '{}',
			})
			expect(res.status, `${method} ${route}`).toBe(401)
		}
	})

	it('a customers token reads customers but not marketing or forms', async () => {
		const token = await mint({
			area: 'customers',
			canUpdate: true,
			canDelete: true,
		})
		expect((await get('/customers', token)).status).toBe(200)
		expect((await get('/marketing/campaigns', token)).status).toBe(401)
		expect((await get('/marketing/campaigns/c1/summary', token)).status).toBe(
			401,
		)
		expect((await get('/journeys/j1/runs', token)).status).toBe(401)
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
		// Its write claims must not reach journey writes either.
		for (const [method, route] of [
			['POST', '/journeys'],
			['POST', '/journeys/j1/publish'],
			['POST', '/journeys/trigger-test'],
			['DELETE', '/journeys/j1'],
		] as const) {
			const res = await app.request(`/operator${route}`, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: method === 'DELETE' ? undefined : '{}',
			})
			expect(res.status, `${method} ${route}`).toBe(401)
		}
	})

	it('server-side tokens without an area keep working everywhere', async () => {
		const token = await mint({})
		expect((await get('/customers', token)).status).toBe(200)
		expect((await get('/marketing/campaigns', token)).status).toBe(200)
		expect((await get('/forms', token)).status).toBe(200)
		expect((await get('/journeys', token)).status).toBe(200)
	})
})

// Walks every /operator/* route the real app mounts, so a route added later
// without naming its area (or with its own verifier) fails here.
describe('every /operator route refuses a token bound to another area', () => {
	let tempDir: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-area-walk-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.JWT_SECRET = operatorSecret
		process.env.TENANT_OPERATOR_TOKEN = operatorSecret
		await provisionTenantDb(orgId)
	})

	afterEach(async () => {
		await destroyTenantDb(orgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	function operatorRouteList(app: Hono) {
		const seen = new Set<string>()
		return app.routes
			.filter(
				(route) =>
					route.method !== 'ALL' && route.path.startsWith('/operator/'),
			)
			.map((route) => ({
				method: route.method,
				path: route.path.replace(/:[^/]+/g, 'x'),
			}))
			.filter(({ method, path }) => {
				const key = `${method} ${path}`
				if (seen.has(key)) return false
				seen.add(key)
				return true
			})
	}

	async function reachedRoutes(token: string) {
		const app = createTenantApiApp()
		const routes = operatorRouteList(app)
		// Guard against the walk silently covering nothing.
		expect(routes.length).toBeGreaterThan(50)
		const reached: string[] = []
		for (const { method, path } of routes) {
			const res = await app.request(path, {
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: method === 'GET' || method === 'DELETE' ? undefined : '{}',
			})
			if (res.status !== 401) reached.push(`${method} ${path}`)
		}
		return reached.sort()
	}

	it('a marketing token reaches only the marketing routes', async () => {
		const reached = await reachedRoutes(await mint({ area: 'marketing' }))
		expect(reached).toEqual([
			'GET /operator/journeys/runs/x',
			'GET /operator/journeys/x/runs',
			'GET /operator/marketing/campaigns',
			'GET /operator/marketing/campaigns/x',
			'GET /operator/marketing/campaigns/x/summary',
			'GET /operator/marketing/metrics',
			'POST /operator/marketing/campaigns',
		])
	})

	it('a customers token reaches only the customers routes', async () => {
		const reached = await reachedRoutes(
			await mint({ area: 'customers', canUpdate: true, canDelete: true }),
		)
		expect(reached).toEqual([
			'GET /operator/customers',
			'PATCH /operator/customers/x',
			'POST /operator/customers/x/erase',
		])
	})

	it('a token bound to an unknown area reaches nothing', async () => {
		expect(await reachedRoutes(await mint({ area: 'automations' }))).toEqual([])
	})
})

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { brand } from '@repo/config/brand'
import {
	destroyTenantDb,
	getTenantDb,
	provisionTenantDb,
	siteEventsDaily,
} from '@repo/tenant-db'
import { getTableColumns } from 'drizzle-orm'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { countSiteEvent, eventDay } from '../services/site-events.ts'
import { funnelOperatorRoutes } from './operator-funnel.ts'
import { publicFormRoutes } from './forms.ts'

const orgId = 'clw9x0a12000008l00test82'
const otherOrgId = 'clw9x0a12000008l00test83'
const secret = 'test-operator-secret-123456789'

vi.mock('../lib/origin.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../lib/origin.ts')>()
	return {
		...actual,
		resolveOrganizationForBrowserAuth: async (origin: string | undefined) =>
			origin === 'https://acme.menuza.test'
				? { id: 'clw9x0a12000008l00test82', slug: 'acme', dataRegion: 'us' }
				: null,
		findActiveOrganizationById: async (id: string) =>
			id.startsWith('clw9x0a12000008l00test')
				? { id, slug: 'acme', dataRegion: 'us' }
				: null,
	}
})

const mint = (claims: { org?: string; scope?: string } = {}) =>
	new SignJWT({
		orgId: claims.org ?? orgId,
		role: 'operator',
		scope: claims.scope ?? 'funnel',
	})
		.setSubject('user-1')
		.setProtectedHeader({ alg: 'HS256' })
		.setAudience('tenant-api-operator')
		.setIssuer(brand.shortName)
		.setExpirationTime('15m')
		.sign(new TextEncoder().encode(secret))

describe('site events and the funnel (#179)', () => {
	let tempDir: string
	let app: Hono

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-events-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'
		process.env.JWT_SECRET = secret
		process.env.TENANT_OPERATOR_TOKEN = secret
		delete process.env.SITE_EVENTS_ENABLED
		await provisionTenantDb(orgId)
		await provisionTenantDb(otherOrgId)
		app = new Hono()
		app.route('/forms', publicFormRoutes)
		app.route('/operator/funnel', funnelOperatorRoutes)
	})

	afterEach(async () => {
		delete process.env.SITE_EVENTS_ENABLED
		await destroyTenantDb(orgId).catch(() => {})
		await destroyTenantDb(otherOrgId).catch(() => {})
		fs.rmSync(tempDir, { recursive: true, force: true })
	})

	const beacon = (body: unknown, origin = 'https://acme.menuza.test') =>
		app.request('/forms/site-events', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: origin },
			body: JSON.stringify({ slug: 'acme', ...(body as object) }),
		})
	const rows = async () =>
		(await getTenantDb(orgId)).select().from(siteEventsDaily)
	const base = { event: 'visit', device: 'phone', entry: 'direct' }

	it('holds no visitor id, address or user agent anywhere', () => {
		expect(Object.keys(getTableColumns(siteEventsDaily)).sort()).toEqual([
			'count',
			'date',
			'device',
			'entry',
			'event',
			'locationId',
			'variant',
		])
	})

	it('adds one to the day, device and entry it names', async () => {
		for (let i = 0; i < 3; i++) expect((await beacon(base)).status).toBe(204)
		await beacon({ ...base, device: 'desktop' })
		await beacon({ ...base, event: 'order' })
		const all = await rows()
		const phoneVisits = all.find(
			(r) => r.event === 'visit' && r.device === 'phone',
		)
		expect(phoneVisits).toMatchObject({ count: 3, date: eventDay(Date.now()) })
		expect(all).toHaveLength(3)
	})

	it('counts the arm of a test separately', async () => {
		await beacon({ ...base, variant: 'exp1:a' })
		await beacon({ ...base, variant: 'exp1:b' })
		await beacon({ ...base, variant: 'exp1:b' })
		const all = await rows()
		expect(all.find((r) => r.variant === 'exp1:b')?.count).toBe(2)
		expect(all.find((r) => r.variant === 'exp1:a')?.count).toBe(1)
	})

	it('is silent for a bad beacon, a foreign origin or the kill switch', async () => {
		expect((await beacon({ ...base, event: 'purchase' })).status).toBe(204)
		expect((await beacon({ ...base, visitorId: 'x' })).status).toBe(204)
		expect((await beacon(base, 'https://evil.example')).status).toBe(204)
		process.env.SITE_EVENTS_ENABLED = 'false'
		expect((await beacon(base)).status).toBe(204)
		expect(await rows()).toHaveLength(0)
	})

	it('reads the funnel with step rates and the change against the previous period', async () => {
		const db = await getTenantDb(orgId)
		const day = (offset: number) =>
			eventDay(Date.UTC(2026, 10, 14) - offset * 86_400_000)
		const put = async (date: string, event: 'visit' | 'order', count: number) =>
			db.insert(siteEventsDaily).values({
				date,
				locationId: '',
				event,
				device: 'phone',
				entry: 'direct',
				variant: '',
				count,
			})
		await put(day(0), 'visit', 100)
		await put(day(0), 'order', 20)
		await put(day(7), 'visit', 100)
		await put(day(7), 'order', 10)
		const res = await app.request(
			`/operator/funnel?from=${day(6)}&to=${day(0)}`,
			{ headers: { Authorization: `Bearer ${await mint()}` } },
		)
		expect(res.status).toBe(200)
		expect(res.headers.get('cache-control')).toBe('private, no-store')
		const body = (await res.json()) as {
			steps: Array<{
				event: string
				count: number
				rateFromStart: number | null
				changePoints: number | null
			}>
		}
		const order = body.steps.find((s) => s.event === 'order')!
		expect(order).toMatchObject({
			count: 20,
			rateFromStart: 0.2,
			changePoints: 10,
		})
		expect(body.steps[0]).toMatchObject({ event: 'visit', count: 100 })
	})

	it('serves the funnel only to a funnel-scope token of this organization', async () => {
		const query = '?from=2026-11-01&to=2026-11-07'
		const get = (token: string | null) =>
			app.request(`/operator/funnel${query}`, {
				headers: token ? { Authorization: `Bearer ${token}` } : {},
			})
		expect((await get(null)).status).toBe(401)
		expect((await get(await mint({ scope: 'mailbox' }))).status).toBe(401)
		expect((await get(await mint({ scope: 'people' }))).status).toBe(401)
		// Another organization's token sees only its own (empty) counts.
		await countSiteEvent(orgId, {
			event: 'visit',
			device: 'phone',
			entry: 'direct',
		})
		const other = await get(await mint({ org: otherOrgId }))
		const body = (await other.json()) as { steps: Array<{ count: number }> }
		expect(body.steps.every((s) => s.count === 0)).toBe(true)
		expect(
			(
				await app.request('/operator/funnel?from=bad&to=x', {
					headers: { Authorization: `Bearer ${await mint()}` },
				})
			).status,
		).toBe(400)
	})
})

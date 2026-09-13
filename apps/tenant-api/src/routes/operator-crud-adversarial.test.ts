import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { eq } from 'drizzle-orm'
import {
	provisionTenantDb,
	destroyTenantDb,
	getTenantDb,
	customers,
	marketingJourneys,
	journeyRuns,
	journeyStepExecutions,
} from '@repo/tenant-db'
import { authRoutes } from './auth.ts'
import { journeyOperatorRoutes } from './journeys.ts'
import { hmacHash } from '../lib/secrets.ts'
import { brand } from '@repo/config/brand.ts'

const orgId1 = 'clw9x0a12000008l00test01'
const orgId2 = 'clw9x0a12000008l00test02'
const internalToken = 'test-internal-token-123456789'
const operatorToken = 'test-operator-token-123456789'
const jwtSecret = 'test-jwt-secret-123456789'
const hmacSecret = 'test-hmac-secret-123456789'

vi.mock('../lib/origin.ts', () => ({
	resolveOrganizationForBrowserAuth: vi
		.fn()
		.mockImplementation(async (_origin, body) => {
			const slug = body?.slug || 'test-org'
			const id = slug === 'org2' ? orgId2 : orgId1
			return {
				id,
				slug,
				customDomain: null,
				hasProvisionedDb: true,
				dataRegion: 'us',
			}
		}),
	findActiveOrganizationById: vi
		.fn()
		.mockImplementation(async (id: string) => ({
			id,
			slug: id === orgId2 ? 'org2' : 'test-org',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		})),
	resolvePublishedOrganization: vi
		.fn()
		.mockImplementation(async ({ slug }: { slug?: string }) => {
			const id = slug === 'org2' ? orgId2 : orgId1
			return {
				id,
				slug: slug || 'test-org',
				customDomain: null,
				hasProvisionedDb: true,
				dataRegion: 'us',
			}
		}),
}))

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockResolvedValue({
		success: true,
		sid: 'mock-sms-id',
		mock: true,
	}),
}))

vi.mock('@repo/email', () => ({
	sendOciEmail: vi.fn().mockResolvedValue({
		status: 'success',
		data: { messageId: 'mock-oci-email-id' },
	}),
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEmailConfigured: vi.fn().mockReturnValue(false),
}))

describe('Adversarial Stress Suite: Operator CRUD & Auth Lifecycle Triggers', () => {
	let tempDir: string
	let app: Hono

	async function mintOperatorJwt(
		tenantOrgId = orgId1,
		role = 'operator',
		secretKey = operatorToken,
		expiresIn = '1h',
	) {
		const secret = new TextEncoder().encode(secretKey)
		return new SignJWT({
			orgId: tenantOrgId,
			role,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime(expiresIn)
			.sign(secret)
	}

	async function mintCustomerJwt(
		customerId: string,
		tenantOrgId = orgId1,
		name = 'Test User',
	) {
		const secret = new TextEncoder().encode(jwtSecret)
		return new SignJWT({
			customerId,
			orgId: tenantOrgId,
			name,
			orgSlug: tenantOrgId === orgId2 ? 'org2' : 'test-org',
			type: 'access',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api')
			.setIssuer('menuza')
			.setExpirationTime('15m')
			.sign(secret)
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'tenant-api-adversarial-test-'),
		)
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.NODE_ENV = 'test'
		process.env.INTERNAL_COMMAND_TOKEN = internalToken
		process.env.TENANT_OPERATOR_TOKEN = operatorToken
		process.env.JWT_SECRET = jwtSecret
		process.env.AUTH_HMAC_SECRET = hmacSecret

		await provisionTenantDb(orgId1)
		await provisionTenantDb(orgId2)

		app = new Hono()
		app.route('/operator/journeys', journeyOperatorRoutes)
		app.route('/auth', authRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId1)
			await destroyTenantDb(orgId2)
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {}
		delete process.env.TENANT_DB_DIR
		vi.restoreAllMocks()
	})

	// =========================================================================
	// 1. ADVERSARIAL DAG TOPOLOGY STRESS TESTS
	// =========================================================================
	describe('1. Adversarial DAG Topology Stress Tests', () => {
		it('rejects journey creation with missing trigger node (only action/delay)', async () => {
			const token = await mintOperatorJwt()
			const res = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Missing Trigger Graph',
					nodes: [
						{
							id: 'a-1',
							type: 'action_email',
							data: { subject: 'Hi', bodyHtml: '<p>Hi</p>' },
						},
						{ id: 'd-1', type: 'delay', data: { duration: 1, unit: 'hours' } },
					],
					edges: [{ id: 'e1', source: 'a-1', target: 'd-1' }],
				}),
			})

			expect(res.status).toBe(400)
			const json = await res.json()
			expect(json.error).toBe('Invalid workflow DAG structure')
			expect(
				json.issues.some((i: string) =>
					i.includes('exactly one trigger node (found 0)'),
				),
			).toBe(true)
		})

		it('rejects journey creation with multiple trigger nodes', async () => {
			const token = await mintOperatorJwt()
			const res = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Multi Trigger Graph',
					nodes: [
						{
							id: 't-1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 't-2',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 'a-1',
							type: 'action_sms',
							data: { messageText: 'Hello' },
						},
					],
					edges: [
						{ id: 'e1', source: 't-1', target: 'a-1' },
						{ id: 'e2', source: 't-2', target: 'a-1' },
					],
				}),
			})

			expect(res.status).toBe(400)
			const json = await res.json()
			expect(json.error).toBe('Invalid workflow DAG structure')
			expect(
				json.issues.some((i: string) =>
					i.includes('can only have one trigger node (found 2'),
				),
			).toBe(true)
		})

		it('rejects trigger node with incoming edges (in-degree > 0)', async () => {
			const token = await mintOperatorJwt()
			const res = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Trigger With In-Degree',
					nodes: [
						{
							id: 't-1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 'd-1',
							type: 'delay',
							data: { duration: 1, unit: 'hours' },
						},
					],
					edges: [
						{ id: 'e1', source: 'd-1', target: 't-1' }, // Edge pointing TO trigger!
					],
				}),
			})

			expect(res.status).toBe(400)
			const json = await res.json()
			expect(
				json.issues.some((i: string) =>
					i.includes('cannot have incoming edges'),
				),
			).toBe(true)
		})

		it('rejects self-loops (source === target)', async () => {
			const token = await mintOperatorJwt()
			const res = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Self Loop Graph',
					nodes: [
						{
							id: 't-1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 'a-1',
							type: 'action_email',
							data: { subject: 'Hi', bodyHtml: '<p>Hi</p>' },
						},
					],
					edges: [
						{ id: 'e1', source: 't-1', target: 'a-1' },
						{ id: 'e2', source: 'a-1', target: 'a-1' }, // Self loop!
					],
				}),
			})

			expect(res.status).toBe(400)
			const json = await res.json()
			expect(
				json.issues.some((i: string) => i.includes('Self-loop detected')),
			).toBe(true)
		})

		it('rejects multi-node cyclic graph (4 nodes in a ring)', async () => {
			const token = await mintOperatorJwt()
			const res = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Complex Cyclic Graph',
					nodes: [
						{
							id: 't-1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 'd-1',
							type: 'delay',
							data: { duration: 1, unit: 'hours' },
						},
						{
							id: 'a-1',
							type: 'action_email',
							data: { subject: 'Email 1', bodyHtml: '<p>1</p>' },
						},
						{
							id: 'a-2',
							type: 'action_sms',
							data: { messageText: 'SMS 2' },
						},
					],
					edges: [
						{ id: 'e1', source: 't-1', target: 'd-1' },
						{ id: 'e2', source: 'd-1', target: 'a-1' },
						{ id: 'e3', source: 'a-1', target: 'a-2' },
						{ id: 'e4', source: 'a-2', target: 'd-1' }, // Cycle back to d-1!
					],
				}),
			})

			expect(res.status).toBe(400)
			const json = await res.json()
			expect(
				json.issues.some((i: string) => i.includes('Cycle detected')),
			).toBe(true)
		})

		it('rejects duplicate node IDs', async () => {
			const token = await mintOperatorJwt()
			const res = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Duplicate Node IDs',
					nodes: [
						{
							id: 'node-same',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 'node-same',
							type: 'action_sms',
							data: { messageText: 'SMS' },
						},
					],
					edges: [],
				}),
			})

			expect(res.status).toBe(400)
			const json = await res.json()
			expect(
				json.issues.some((i: string) =>
					i.includes('Duplicate node ID detected'),
				),
			).toBe(true)
		})

		it('rejects edge referencing non-existent target node', async () => {
			const token = await mintOperatorJwt()
			const res = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Broken Edge Graph',
					nodes: [
						{
							id: 't-1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
					],
					edges: [{ id: 'e1', source: 't-1', target: 'ghost-node-404' }],
				}),
			})

			expect(res.status).toBe(400)
			const json = await res.json()
			expect(
				json.issues.some((i: string) => i.includes('non-existent target node')),
			).toBe(true)
		})

		it('rejects invalid node data configurations (zero/negative delay, empty email, oversized SMS)', async () => {
			const token = await mintOperatorJwt()

			// Zero delay
			const res1 = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Zero Delay',
					nodes: [
						{
							id: 't-1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{ id: 'd-1', type: 'delay', data: { duration: 0, unit: 'hours' } },
					],
					edges: [{ id: 'e1', source: 't-1', target: 'd-1' }],
				}),
			})
			expect(res1.status).toBe(400)
			const json1 = await res1.json()
			expect(
				json1.issues.some((i: string) =>
					i.includes('Duration must be at least 1'),
				),
			).toBe(true)

			// Empty email subject & body
			const res2 = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Empty Email',
					nodes: [
						{
							id: 't-1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 'a-1',
							type: 'action_email',
							data: { subject: '', bodyHtml: '' },
						},
					],
					edges: [{ id: 'e1', source: 't-1', target: 'a-1' }],
				}),
			})
			expect(res2.status).toBe(400)
			const json2 = await res2.json()
			expect(
				json2.issues.some((i: string) => i.includes('Subject is required')),
			).toBe(true)

			// Oversized SMS (>1600 chars)
			const res3 = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Oversized SMS',
					nodes: [
						{
							id: 't-1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 's-1',
							type: 'action_sms',
							data: { messageText: 'x'.repeat(1601) },
						},
					],
					edges: [{ id: 'e1', source: 't-1', target: 's-1' }],
				}),
			})
			expect(res3.status).toBe(400)
			const json3 = await res3.json()
			expect(
				json3.issues.some((i: string) =>
					i.includes('cannot exceed 1600 characters'),
				),
			).toBe(true)
		})

		it('blocks updating an active journey with an invalid DAG graph', async () => {
			const token = await mintOperatorJwt()

			// 1. Create valid journey draft
			const createRes = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Active Flow',
					nodes: [
						{
							id: 't-1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{ id: 'a-1', type: 'action_sms', data: { messageText: 'Hello' } },
					],
					edges: [{ id: 'e1', source: 't-1', target: 'a-1' }],
				}),
			})
			const { journeyId } = await createRes.json()

			// 2. Publish to active
			const pubRes = await app.request(
				`/operator/journeys/${journeyId}/publish`,
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${token}` },
				},
			)
			expect(pubRes.status).toBe(200)

			// 3. Attempt to update active journey with cyclic edges
			const patchRes = await app.request(`/operator/journeys/${journeyId}`, {
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					edges: [
						{ id: 'e1', source: 't-1', target: 'a-1' },
						{ id: 'e2', source: 'a-1', target: 't-1' }, // Introduce cycle!
					],
				}),
			})

			expect(patchRes.status).toBe(400)
			const patchJson = await patchRes.json()
			expect(patchJson.error).toBe(
				'Cannot update active journey with invalid graph DAG',
			)
		})

		it('blocks publishing a draft with an invalid or empty graph', async () => {
			const db = await getTenantDb(orgId1)
			const token = await mintOperatorJwt()

			// Insert draft with empty nodes/edges
			const insert = await db
				.insert(marketingJourneys)
				.values({
					name: 'Empty Draft',
					status: 'draft',
					nodes: '[]',
					edges: '[]',
				})
				.returning()
			const journey = insert[0]!

			const pubRes = await app.request(
				`/operator/journeys/${journey.id}/publish`,
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${token}` },
				},
			)

			expect(pubRes.status).toBe(400)
			const pubJson = await pubRes.json()
			expect(pubJson.error).toBe(
				'Cannot publish journey with invalid graph DAG',
			)
			expect(
				pubJson.issues.some((i: string) =>
					i.includes('at least one trigger node'),
				),
			).toBe(true)
		})
	})

	// =========================================================================
	// 2. OPERATOR CRUD & LIFECYCLE STATE TRANSITIONS
	// =========================================================================
	describe('2. Operator CRUD & Lifecycle State Transitions', () => {
		it('handles full lifecycle: draft -> active -> paused -> active -> delete', async () => {
			const token = await mintOperatorJwt()
			const db = await getTenantDb(orgId1)

			// 1. Create
			const createRes = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Lifecycle Transition Journey',
					triggerType: 'phone_verified',
					nodes: [
						{
							id: 't-1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 's-1',
							type: 'action_sms',
							data: { messageText: 'Welcome!' },
						},
					],
					edges: [{ id: 'e1', source: 't-1', target: 's-1' }],
				}),
			})
			expect(createRes.status).toBe(201)
			const { journeyId } = await createRes.json()

			// Verify draft status in DB
			let j = await db
				.select()
				.from(marketingJourneys)
				.where(eq(marketingJourneys.id, journeyId))
				.get()
			expect(j?.status).toBe('draft')

			// 2. Publish -> active
			const pub1 = await app.request(
				`/operator/journeys/${journeyId}/publish`,
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${token}` },
				},
			)
			expect(pub1.status).toBe(200)
			j = await db
				.select()
				.from(marketingJourneys)
				.where(eq(marketingJourneys.id, journeyId))
				.get()
			expect(j?.status).toBe('active')
			expect(j?.publishedAt).toBeInstanceOf(Date)

			// 3. Pause -> paused
			const pause1 = await app.request(
				`/operator/journeys/${journeyId}/pause`,
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${token}` },
				},
			)
			expect(pause1.status).toBe(200)
			j = await db
				.select()
				.from(marketingJourneys)
				.where(eq(marketingJourneys.id, journeyId))
				.get()
			expect(j?.status).toBe('paused')

			// 4. Re-publish -> active
			const pub2 = await app.request(
				`/operator/journeys/${journeyId}/publish`,
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${token}` },
				},
			)
			expect(pub2.status).toBe(200)
			j = await db
				.select()
				.from(marketingJourneys)
				.where(eq(marketingJourneys.id, journeyId))
				.get()
			expect(j?.status).toBe('active')

			// 5. Delete
			const del = await app.request(`/operator/journeys/${journeyId}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` },
			})
			expect(del.status).toBe(200)
			j = await db
				.select()
				.from(marketingJourneys)
				.where(eq(marketingJourneys.id, journeyId))
				.get()
			expect(j).toBeUndefined()
		})

		it('deleting an active journey cascades deletion of runs and step executions', async () => {
			const db = await getTenantDb(orgId1)
			const token = await mintOperatorJwt()

			// Seed customer
			const cInsert = await db
				.insert(customers)
				.values({
					name: 'Cascade Target',
					phone: '+15559998888',
				})
				.returning()
			const customer = cInsert[0]!

			// Seed journey
			const jInsert = await db
				.insert(marketingJourneys)
				.values({
					name: 'Cascade Flow',
					status: 'active',
				})
				.returning()
			const journey = jInsert[0]!

			// Seed run & step execution
			const rInsert = await db
				.insert(journeyRuns)
				.values({
					journeyId: journey.id,
					customerId: customer.id,
					status: 'running',
				})
				.returning()
			const run = rInsert[0]!

			await db.insert(journeyStepExecutions).values({
				runId: run.id,
				journeyId: journey.id,
				customerId: customer.id,
				nodeId: 'node-1',
				nodeType: 'trigger',
				stepType: 'trigger',
				status: 'completed',
			})

			// Delete journey via Operator API
			const delRes = await app.request(`/operator/journeys/${journey.id}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` },
			})
			expect(delRes.status).toBe(200)

			// Verify journey is gone
			const checkJ = await db
				.select()
				.from(marketingJourneys)
				.where(eq(marketingJourneys.id, journey.id))
				.get()
			expect(checkJ).toBeUndefined()

			// Verify runs are cascade-deleted
			const checkRuns = await db
				.select()
				.from(journeyRuns)
				.where(eq(journeyRuns.journeyId, journey.id))
				.all()
			expect(checkRuns).toHaveLength(0)

			// Verify step executions are cascade-deleted
			const checkSteps = await db
				.select()
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.journeyId, journey.id))
				.all()
			expect(checkSteps).toHaveLength(0)
		})

		it('returns 404 for operations on non-existent journey IDs', async () => {
			const token = await mintOperatorJwt()
			const ghostId = '00000000-0000-0000-0000-000000000000'

			const getRes = await app.request(`/operator/journeys/${ghostId}`, {
				headers: { Authorization: `Bearer ${token}` },
			})
			expect(getRes.status).toBe(404)

			const patchRes = await app.request(`/operator/journeys/${ghostId}`, {
				method: 'PATCH',
				headers: {
					Authorization: `Bearer ${token}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({ name: 'New Name' }),
			})
			expect(patchRes.status).toBe(404)

			const pubRes = await app.request(
				`/operator/journeys/${ghostId}/publish`,
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${token}` },
				},
			)
			expect(pubRes.status).toBe(404)

			const pauseRes = await app.request(
				`/operator/journeys/${ghostId}/pause`,
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${token}` },
				},
			)
			expect(pauseRes.status).toBe(404)

			const delRes = await app.request(`/operator/journeys/${ghostId}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${token}` },
			})
			expect(delRes.status).toBe(404)
		})
	})

	// =========================================================================
	// 3. MULTI-TENANT ISOLATION & CROSS-TENANT PERMISSION STRESS
	// =========================================================================
	describe('3. Multi-Tenant Isolation & Cross-Tenant Security', () => {
		it('strictly isolates tenant databases preventing cross-org mutation or leaks', async () => {
			const tokenOrg1 = await mintOperatorJwt(orgId1)
			const tokenOrg2 = await mintOperatorJwt(orgId2)

			// 1. Create journey in Org 1
			const createRes = await app.request('/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${tokenOrg1}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Org 1 Secret Journey',
					nodes: [
						{
							id: 't-1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 's-1',
							type: 'action_sms',
							data: { messageText: 'Secret promo' },
						},
					],
					edges: [{ id: 'e1', source: 't-1', target: 's-1' }],
				}),
			})
			expect(createRes.status).toBe(201)
			const { journeyId: org1JourneyId } = await createRes.json()

			// 2. Org 2 operator attempts to GET Org 1 journey -> 404
			const getRes = await app.request(`/operator/journeys/${org1JourneyId}`, {
				headers: { Authorization: `Bearer ${tokenOrg2}` },
			})
			expect(getRes.status).toBe(404)

			// 3. Org 2 operator attempts to PATCH Org 1 journey -> 404
			const patchRes = await app.request(
				`/operator/journeys/${org1JourneyId}`,
				{
					method: 'PATCH',
					headers: {
						Authorization: `Bearer ${tokenOrg2}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ name: 'Hacked Journey' }),
				},
			)
			expect(patchRes.status).toBe(404)

			// 4. Org 2 operator attempts to DELETE Org 1 journey -> 404
			const delRes = await app.request(`/operator/journeys/${org1JourneyId}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${tokenOrg2}` },
			})
			expect(delRes.status).toBe(404)

			// 5. Verify Org 1 journey remains intact
			const verifyRes = await app.request(
				`/operator/journeys/${org1JourneyId}`,
				{
					headers: { Authorization: `Bearer ${tokenOrg1}` },
				},
			)
			expect(verifyRes.status).toBe(200)
			const verifyJson = await verifyRes.json()
			expect(verifyJson.journey.name).toBe('Org 1 Secret Journey')
		})

		it('rejects operator requests with invalid roles or forged tokens', async () => {
			// Token with non-operator role
			const customerToken = await mintOperatorJwt(orgId1, 'customer')
			const res1 = await app.request('/operator/journeys', {
				headers: { Authorization: `Bearer ${customerToken}` },
			})
			expect(res1.status).toBe(403)

			// Token with wrong secret
			const forgedToken = await mintOperatorJwt(
				orgId1,
				'operator',
				'wrong-secret-key-12345',
			)
			const res2 = await app.request('/operator/journeys', {
				headers: { Authorization: `Bearer ${forgedToken}` },
			})
			expect(res2.status).toBe(401)

			// Expired token
			const expiredToken = await mintOperatorJwt(
				orgId1,
				'operator',
				operatorToken,
				'0s',
			)
			const res3 = await app.request('/operator/journeys', {
				headers: { Authorization: `Bearer ${expiredToken}` },
			})
			expect(res3.status).toBe(401)
		})
	})

	// =========================================================================
	// 4. HIGH-THROUGHPUT AUTH LIFECYCLE TRIGGER EVALUATION STRESS
	// =========================================================================
	describe('4. High-Throughput Auth Lifecycle Trigger Evaluation Stress', () => {
		it('processes 30 concurrent OTP verifications resiliently even when worker endpoint fails', async () => {
			const db = await getTenantDb(orgId1)

			// Set worker URL to non-existent endpoint to simulate worker outage
			process.env.JOBS_CRON_WORKER_URL = 'http://127.0.0.1:59999'

			// Create active marketing journey for phone_verified
			await db.insert(marketingJourneys).values({
				name: 'Active Welcome Journey',
				status: 'active',
				triggerType: 'phone_verified',
			})
			await db.insert(marketingJourneys).values({
				name: 'Active Phone Verified Journey',
				status: 'active',
				triggerType: 'phone_verified',
			})

			const code = '654321'
			const hashedCode = hmacHash(code)
			const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

			// Seed 30 unverified customers
			const customerIds: string[] = []
			for (let i = 0; i < 30; i++) {
				const phone = `+1555100${String(i).padStart(4, '0')}`
				const inserted = await db
					.insert(customers)
					.values({
						name: `Stress User ${i}`,
						phone,
						phoneVerificationCode: hashedCode,
						phoneVerificationExpiresAt: expiresAt,
					})
					.returning()
				customerIds.push(inserted[0]!.id)
			}

			// Fire 30 concurrent /auth/verify requests
			const verifyPromises = customerIds.map(async (_cid, i) => {
				const phone = `+1555100${String(i).padStart(4, '0')}`
				return app.request('/auth/verify', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						slug: 'test-org',
						phone,
						code,
					}),
				})
			})

			const responses = await Promise.all(verifyPromises)

			// Verify EVERY request succeeded with 200 OK
			for (const res of responses) {
				expect(res.status).toBe(200)
				const json = await res.json()
				expect(json.success).toBe(true)
				expect(json.accessToken).toBeDefined()
				expect(json.refreshToken).toBeDefined()
			}

			// Wait briefly for background trigger async tasks
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Verify journey runs were safely written to SQLite despite worker outage
			const runs = await db.select().from(journeyRuns).all()
			expect(runs.length).toBeGreaterThanOrEqual(30)
		})

		it('processes 30 concurrent profile completions resiliently and triggers profile_completed', async () => {
			const db = await getTenantDb(orgId1)
			process.env.JOBS_CRON_WORKER_URL = 'http://127.0.0.1:59999'

			// Create active profile_completed journey
			await db.insert(marketingJourneys).values({
				name: 'Active Profile Completed Flow',
				status: 'active',
				triggerType: 'profile_completed',
			})

			// Seed 30 verified customers and generate access tokens
			const customerData: Array<{ id: string; token: string }> = []
			for (let i = 0; i < 30; i++) {
				const phone = `+1555200${String(i).padStart(4, '0')}`
				const inserted = await db
					.insert(customers)
					.values({
						name: `Incomplete User ${i}`,
						phone,
						phoneVerified: true,
					})
					.returning()
				const c = inserted[0]!
				const token = await mintCustomerJwt(c.id, orgId1, c.name)
				customerData.push({ id: c.id, token })
			}

			// Fire 30 concurrent /auth/profile requests
			const profilePromises = customerData.map(async ({ token }, i) => {
				return app.request('/auth/profile', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						name: `Completed User ${i}`,
						email: `completed_${i}@example.com`,
					}),
				})
			})

			const responses = await Promise.all(profilePromises)

			for (const res of responses) {
				expect(res.status).toBe(200)
				const json = await res.json()
				expect(json.success).toBe(true)
			}

			await new Promise((resolve) => setTimeout(resolve, 100))

			// Verify profile_completed runs recorded in SQLite
			const runs = await db
				.select()
				.from(journeyRuns)
				.where(eq(journeyRuns.triggerEvent, 'profile_completed'))
				.all()

			expect(runs).toHaveLength(30)
		})

		it('spawns multiple active journey runs when fan-out trigger matches multiple active journeys', async () => {
			const db = await getTenantDb(orgId1)

			// Create 5 distinct active journeys for phone_verified
			for (let i = 1; i <= 5; i++) {
				await db.insert(marketingJourneys).values({
					name: `Welcome Journey Tier ${i}`,
					status: 'active',
					triggerType: 'phone_verified',
				})
			}

			// Also create 1 paused journey (should NOT spawn)
			await db.insert(marketingJourneys).values({
				name: 'Paused Welcome Journey',
				status: 'paused',
				triggerType: 'phone_verified',
			})

			// Seed customer with valid OTP
			const code = '112233'
			const hashedCode = hmacHash(code)
			const expiresAt = new Date(Date.now() + 10 * 60 * 1000)

			const customerInsert = await db
				.insert(customers)
				.values({
					name: 'Fanout User',
					phone: '+15558887777',
					phoneVerificationCode: hashedCode,
					phoneVerificationExpiresAt: expiresAt,
				})
				.returning()
			const customer = customerInsert[0]!

			const res = await app.request('/auth/verify', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					slug: 'test-org',
					phone: '+15558887777',
					code: '112233',
				}),
			})

			expect(res.status).toBe(200)

			await vi.waitFor(
				async () => {
					const runs = await db
						.select()
						.from(journeyRuns)
						.where(eq(journeyRuns.customerId, customer.id))
						.all()

					// Should have spawned exactly 5 runs (one for each active journey)
					expect(runs).toHaveLength(5)
					for (const r of runs) {
						expect(r.triggerEvent).toBe('phone_verified')
						expect(r.status).toBe('running')
					}
				},
				{ timeout: 4000, interval: 50 },
			)
		})
	})
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import {
	provisionTenantDb,
	destroyTenantDb,
	getTenantDb,
	customers,
	marketingJourneys,
	journeyRuns,
} from '@repo/tenant-db'
import { journeySystemRoutes, journeyOperatorRoutes } from './journeys.ts'
import { brand } from '@repo/config/brand.ts'

vi.mock('../lib/origin.ts', () => ({
	findActiveOrganizationById: vi
		.fn()
		.mockImplementation(async (id: string) => ({
			id,
			slug: 'test-org',
			customDomain: null,
			hasProvisionedDb: true,
			dataRegion: 'us',
		})),
}))

// Mock external dispatch modules
vi.mock('@repo/email', () => ({
	sendOciEmail: vi.fn().mockImplementation(async ({ to }) => {
		if (to === 'bad@example.com') {
			return {
				status: 'error',
				error: { message: 'Mailbox not found', statusCode: 400 },
			}
		}
		return {
			status: 'success',
			data: {
				messageId: 'mock-oci-id-' + Math.random().toString(36).substring(7),
			},
		}
	}),
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEmailConfigured: vi.fn().mockReturnValue(false),
}))

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockImplementation(async ({ to }) => {
		if (to === '+10000000000') {
			throw new Error('Twilio error')
		}
		return {
			success: true,
			sid: 'mock-twilio-sid-' + Math.random().toString(36).substring(7),
			mock: true,
		}
	}),
}))

describe('Journey API Routes (System & Operator)', () => {
	let tempDir: string
	let app: Hono
	const orgId = 'clw9x0a12000008l00test02'
	const internalToken = 'test-internal-token-123456789'
	const operatorToken = 'test-operator-token-123456789'

	async function mintOperatorJwt(tenantOrgId = orgId, role = 'operator') {
		const secret = new TextEncoder().encode(operatorToken)
		return new SignJWT({
			orgId: tenantOrgId,
			role,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('1h')
			.sign(secret)
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-routes-test-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.INTERNAL_COMMAND_TOKEN = internalToken
		process.env.TENANT_OPERATOR_TOKEN = operatorToken
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'

		await provisionTenantDb(orgId)

		app = new Hono()
		app.route('/api/journeys', journeySystemRoutes)
		app.route('/operator/journeys', journeyOperatorRoutes)
	})

	afterEach(async () => {
		try {
			await destroyTenantDb(orgId)
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {}
		delete process.env.TENANT_DB_DIR
		vi.restoreAllMocks()
	})

	// =========================================================================
	// 1. SYSTEM API ENDPOINTS (/api/journeys/*)
	// =========================================================================
	describe('System API (/api/journeys/*)', () => {
		describe('Authentication', () => {
			it('rejects unauthenticated requests with 401', async () => {
				const res = await app.request('/api/journeys/execute-step', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({}),
				})
				expect(res.status).toBe(401)
			})

			it('rejects invalid bearer token with 401', async () => {
				const res = await app.request('/api/journeys/execute-step', {
					method: 'POST',
					headers: {
						Authorization: 'Bearer invalid-token-value',
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({}),
				})
				expect(res.status).toBe(401)
			})
		})

		describe('POST /api/journeys/execute-step', () => {
			it('executes email action step and returns ZERO PII', async () => {
				const db = await getTenantDb(orgId)

				const customerInsert = await db
					.insert(customers)
					.values({
						name: 'Leila Smith',
						email: 'leila@example.com',
						phone: '+15559876543',
						phoneVerified: true,
					})
					.returning()
				const customer = customerInsert[0]!

				const journeyInsert = await db
					.insert(marketingJourneys)
					.values({ name: 'System Journey' })
					.returning()
				const journey = journeyInsert[0]!

				const runInsert = await db
					.insert(journeyRuns)
					.values({ journeyId: journey.id, customerId: customer.id })
					.returning()
				const run = runInsert[0]!

				const res = await app.request('/api/journeys/execute-step', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${internalToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						orgId,
						journeyId: journey.id,
						runId: run.id,
						customerId: customer.id,
						nodeId: 'node-email-system',
						nodeType: 'action_email',
						config: {
							subject: 'Hello {{name}}',
							bodyHtml: '<p>Special gift for you!</p>',
						},
					}),
				})

				expect(res.status).toBe(200)
				const json = await res.json()
				expect(json.success).toBe(true)
				expect(json.status).toBe('delivered')
				expect(json.executionId).toBeDefined()
				expect(json.messageId).toBeDefined()

				// Verify Zero PII in response
				expect(json.customerName).toBeUndefined()
				expect(json.email).toBeUndefined()
				expect(json.phone).toBeUndefined()
			})

			it('executes SMS action step and returns zero-PII delivered status', async () => {
				const db = await getTenantDb(orgId)

				const customerInsert = await db
					.insert(customers)
					.values({
						name: 'Khalid',
						phone: '+966509998877',
						phoneVerified: true,
					})
					.returning()
				const customer = customerInsert[0]!

				const journeyInsert = await db
					.insert(marketingJourneys)
					.values({ name: 'System SMS Journey' })
					.returning()
				const journey = journeyInsert[0]!

				const runInsert = await db
					.insert(journeyRuns)
					.values({ journeyId: journey.id, customerId: customer.id })
					.returning()
				const run = runInsert[0]!

				const res = await app.request('/api/journeys/execute-step', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${internalToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						orgId,
						journeyId: journey.id,
						runId: run.id,
						customerId: customer.id,
						nodeId: 'node-sms-system',
						nodeType: 'action_sms',
						config: {
							messageText: 'Your verification code is 123456',
						},
					}),
				})

				expect(res.status).toBe(200)
				const json = await res.json()
				expect(json.success).toBe(true)
				expect(json.status).toBe('delivered')
				expect(json.messageId).toBeDefined()
			})

			it('returns 400 for invalid payload body', async () => {
				const res = await app.request('/api/journeys/execute-step', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${internalToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ orgId: 'invalid-missing-fields' }),
				})

				expect(res.status).toBe(400)
				const json = await res.json()
				expect(json.error).toContain('Invalid execute step payload')
			})

			it('returns 422 when customer lacks email for email action', async () => {
				const db = await getTenantDb(orgId)

				const customerInsert = await db
					.insert(customers)
					.values({ name: 'No Email', phone: '+15551234567' })
					.returning()
				const customer = customerInsert[0]!

				const journeyInsert = await db
					.insert(marketingJourneys)
					.values({ name: 'J' })
					.returning()
				const journey = journeyInsert[0]!

				const runInsert = await db
					.insert(journeyRuns)
					.values({ journeyId: journey.id, customerId: customer.id })
					.returning()
				const run = runInsert[0]!

				const res = await app.request('/api/journeys/execute-step', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${internalToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						orgId,
						journeyId: journey.id,
						runId: run.id,
						customerId: customer.id,
						nodeId: 'node-1',
						nodeType: 'action_email',
						config: { subject: 'Subject', content: 'Content' },
					}),
				})

				expect(res.status).toBe(422)
				const json = await res.json()
				expect(json.error).toContain('no email address')
			})
		})

		describe('POST /api/journeys/complete-run', () => {
			it('marks run as completed with 200 OK', async () => {
				const db = await getTenantDb(orgId)

				const customerInsert = await db
					.insert(customers)
					.values({ name: 'Run Target' })
					.returning()
				const customer = customerInsert[0]!

				const journeyInsert = await db
					.insert(marketingJourneys)
					.values({ name: 'Complete Flow' })
					.returning()
				const journey = journeyInsert[0]!

				const runInsert = await db
					.insert(journeyRuns)
					.values({ journeyId: journey.id, customerId: customer.id })
					.returning()
				const run = runInsert[0]!

				const res = await app.request('/api/journeys/complete-run', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${internalToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						orgId,
						runId: run.id,
						status: 'completed',
					}),
				})

				expect(res.status).toBe(200)
				const json = await res.json()
				expect(json.success).toBe(true)
				expect(json.status).toBe('completed')
			})

			it('returns 404 for non-existent run ID', async () => {
				const res = await app.request('/api/journeys/complete-run', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${internalToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						orgId,
						runId: '00000000-0000-0000-0000-000000000000',
						status: 'completed',
					}),
				})

				expect(res.status).toBe(404)
			})
		})

		describe('GET /api/journeys/definitions/:journeyId', () => {
			it('returns serialized zero-PII graph definition for Cloudflare worker', async () => {
				const db = await getTenantDb(orgId)

				const journeyInsert = await db
					.insert(marketingJourneys)
					.values({
						name: 'CF Worker Retrieval Flow',
						triggerType: 'phone_verified',
						nodes: JSON.stringify([
							{
								id: 't-1',
								type: 'trigger',
								data: { triggerType: 'phone_verified' },
							},
						]),
						edges: JSON.stringify([]),
					})
					.returning()
				const journey = journeyInsert[0]!

				const res = await app.request(
					`/api/journeys/definitions/${journey.id}?orgId=${orgId}`,
					{
						headers: { Authorization: `Bearer ${internalToken}` },
					},
				)

				expect(res.status).toBe(200)
				const json = await res.json()
				expect(json.success).toBe(true)
				expect(json.journey.name).toBe('CF Worker Retrieval Flow')
				expect(json.journey.nodes).toHaveLength(1)
			})

			it('returns 400 if orgId is missing from query string', async () => {
				const res = await app.request('/api/journeys/definitions/some-id', {
					headers: { Authorization: `Bearer ${internalToken}` },
				})
				expect(res.status).toBe(400)
			})
		})
	})

	// =========================================================================
	// 2. OPERATOR API ENDPOINTS (/operator/journeys/*)
	// =========================================================================
	describe('Operator API (/operator/journeys/*)', () => {
		describe('Authentication', () => {
			it('rejects unauthenticated requests with 401', async () => {
				const res = await app.request('/operator/journeys')
				expect(res.status).toBe(401)
			})

			it('rejects non-operator tokens with 403', async () => {
				const customerToken = await mintOperatorJwt(orgId, 'customer')
				const res = await app.request('/operator/journeys', {
					headers: { Authorization: `Bearer ${customerToken}` },
				})
				expect(res.status).toBe(403)
			})
		})

		describe('CRUD Endpoints', () => {
			const validGraph = {
				nodes: [
					{
						id: 't-1',
						type: 'trigger' as const,
						data: { triggerType: 'phone_verified' as const },
					},
					{
						id: 'a-1',
						type: 'action_email' as const,
						data: { subject: 'Welcome', bodyHtml: '<p>Hi</p>' },
					},
				],
				edges: [{ id: 'e-1', source: 't-1', target: 'a-1' }],
			}

			it('creates a new journey draft with 201 Created', async () => {
				const token = await mintOperatorJwt()
				const res = await app.request('/operator/journeys', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						name: 'Operator Created Journey',
						description: 'A test flow',
						triggerType: 'phone_verified',
						nodes: validGraph.nodes,
						edges: validGraph.edges,
					}),
				})

				expect(res.status).toBe(201)
				const json = await res.json()
				expect(json.success).toBe(true)
				expect(json.journeyId).toBeDefined()
				expect(json.journey.name).toBe('Operator Created Journey')
				expect(json.journey.status).toBe('draft')
			})

			it.each([
				'reservation_booked',
				'reservation_completed',
				'reservation_no_show',
				'reservation_cancelled',
			] as const)(
				'creates and updates a journey with the %s trigger',
				async (triggerType) => {
					const token = await mintOperatorJwt()
					const headers = {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					}
					const graph = {
						nodes: [
							{
								id: 't-1',
								type: 'trigger' as const,
								data: { triggerType },
							},
							validGraph.nodes[1]!,
						],
						edges: validGraph.edges,
					}
					const created = await app.request('/operator/journeys', {
						method: 'POST',
						headers,
						body: JSON.stringify({
							name: `Reservation ${triggerType}`,
							triggerType,
							...graph,
						}),
					})
					expect(created.status).toBe(201)
					const json = await created.json()
					expect(json.journey.triggerType).toBe(triggerType)

					const updated = await app.request(
						`/operator/journeys/${json.journeyId}`,
						{
							method: 'PUT',
							headers,
							body: JSON.stringify({ name: 'Renamed', triggerType, ...graph }),
						},
					)
					expect(updated.status).toBe(200)
					const fetched = await app.request(
						`/operator/journeys/${json.journeyId}`,
						{ headers: { Authorization: `Bearer ${token}` } },
					)
					expect((await fetched.json()).journey.triggerType).toBe(triggerType)
				},
			)

			it('rejects an unknown trigger type', async () => {
				const token = await mintOperatorJwt()
				const res = await app.request('/operator/journeys', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						name: 'Nope',
						triggerType: 'reservation_teleported',
						nodes: validGraph.nodes,
						edges: validGraph.edges,
					}),
				})
				expect(res.status).toBe(400)
			})

			it('rejects creation of journey with invalid DAG cycles with 400', async () => {
				const token = await mintOperatorJwt()
				const res = await app.request('/operator/journeys', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						name: 'Invalid Flow',
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
							{ id: 'e1', source: 't-1', target: 'd-1' },
							{ id: 'e2', source: 'd-1', target: 't-1' }, // Cycle to trigger!
						],
					}),
				})

				expect(res.status).toBe(400)
				const json = await res.json()
				expect(json.error).toContain('Invalid workflow DAG')
			})

			it('lists journeys with run stats', async () => {
				const db = await getTenantDb(orgId)
				await db.insert(marketingJourneys).values({
					name: 'Listed Journey 1',
					status: 'draft',
				})

				const token = await mintOperatorJwt()
				const res = await app.request('/operator/journeys', {
					headers: { Authorization: `Bearer ${token}` },
				})

				expect(res.status).toBe(200)
				const json = await res.json()
				expect(json.journeys).toHaveLength(1)
				expect(json.journeys[0].name).toBe('Listed Journey 1')
				expect(json.journeys[0].stats).toBeDefined()
			})

			it('gets, updates, publishes, pauses, and deletes journey', async () => {
				const token = await mintOperatorJwt()

				// 1. Create
				const createRes = await app.request('/operator/journeys', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						name: 'Lifecycle Journey',
						nodes: validGraph.nodes,
						edges: validGraph.edges,
					}),
				})
				const { journeyId } = await createRes.json()

				// 2. Get
				const getRes = await app.request(`/operator/journeys/${journeyId}`, {
					headers: { Authorization: `Bearer ${token}` },
				})
				expect(getRes.status).toBe(200)
				const getJson = await getRes.json()
				expect(getJson.journey.name).toBe('Lifecycle Journey')

				// 3. Patch / Update
				const patchRes = await app.request(`/operator/journeys/${journeyId}`, {
					method: 'PATCH',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({ name: 'Renamed Journey' }),
				})
				expect(patchRes.status).toBe(200)

				// 4. Publish
				const publishRes = await app.request(
					`/operator/journeys/${journeyId}/publish`,
					{
						method: 'POST',
						headers: { Authorization: `Bearer ${token}` },
					},
				)
				expect(publishRes.status).toBe(200)
				const publishJson = await publishRes.json()
				expect(publishJson.status).toBe('active')

				// 5. Pause
				const pauseRes = await app.request(
					`/operator/journeys/${journeyId}/pause`,
					{
						method: 'POST',
						headers: { Authorization: `Bearer ${token}` },
					},
				)
				expect(pauseRes.status).toBe(200)
				const pauseJson = await pauseRes.json()
				expect(pauseJson.status).toBe('paused')

				// 6. Delete
				const deleteRes = await app.request(`/operator/journeys/${journeyId}`, {
					method: 'DELETE',
					headers: { Authorization: `Bearer ${token}` },
				})
				expect(deleteRes.status).toBe(200)
			})

			it('lists runs and retrieves run timeline', async () => {
				const db = await getTenantDb(orgId)

				const customerInsert = await db
					.insert(customers)
					.values({ name: 'Run Observer', email: 'observer@example.com' })
					.returning()
				const customer = customerInsert[0]!

				const journeyInsert = await db
					.insert(marketingJourneys)
					.values({ name: 'Runs Inspector Journey' })
					.returning()
				const journey = journeyInsert[0]!

				const runInsert = await db
					.insert(journeyRuns)
					.values({
						journeyId: journey.id,
						customerId: customer.id,
						status: 'running',
					})
					.returning()
				const run = runInsert[0]!

				const token = await mintOperatorJwt()

				// 1. List runs
				const runsRes = await app.request(
					`/operator/journeys/${journey.id}/runs`,
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				)
				expect(runsRes.status).toBe(200)
				const runsJson = await runsRes.json()
				expect(runsJson.runs).toHaveLength(1)
				expect(runsJson.runs[0].customerName).toBe('Run Observer')

				// 2. Get timeline
				const timelineRes = await app.request(
					`/operator/journeys/runs/${run.id}`,
					{
						headers: { Authorization: `Bearer ${token}` },
					},
				)
				expect(timelineRes.status).toBe(200)
				const timelineJson = await timelineRes.json()
				expect(timelineJson.success).toBe(true)
				expect(timelineJson.run.id).toBe(run.id)
			})

			it('triggers test journey run for customer', async () => {
				const db = await getTenantDb(orgId)

				const customerInsert = await db
					.insert(customers)
					.values({ name: 'Test Target' })
					.returning()
				const customer = customerInsert[0]!

				const journeyInsert = await db
					.insert(marketingJourneys)
					.values({
						name: 'Test Trigger Target',
						nodes: JSON.stringify(validGraph.nodes),
						edges: JSON.stringify(validGraph.edges),
					})
					.returning()
				const journey = journeyInsert[0]!

				const token = await mintOperatorJwt()
				const res = await app.request('/operator/journeys/trigger-test', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${token}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						journeyId: journey.id,
						customerId: customer.id,
					}),
				})

				expect(res.status).toBe(200)
				const json = await res.json()
				expect(json.success).toBe(true)
				expect(json.runId).toBeDefined()
			})
		})
	})
})

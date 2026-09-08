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
	marketingMessages,
	validateWorkflowDAG,
} from '@repo/tenant-db'
import { journeySystemRoutes, journeyOperatorRoutes } from './journeys.ts'
import {
	interpolateMergeTags,
	executeJourneyStep,
	completeJourneyRun,
	getJourneyDefinition,
	evaluateAndSpawnTriggers,
} from '../services/journey-service.ts'
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
		if (to === 'throw-error@example.com') {
			throw new Error('Fatal SMTP connection timeout')
		}
		if (to === 'bad-domain@example.com') {
			return {
				status: 'error',
				error: { message: 'Domain verification failed', statusCode: 422 },
			}
		}
		return {
			status: 'success',
			data: {
				messageId: 'email-id-' + Math.random().toString(36).substring(7),
			},
		}
	}),
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEmailConfigured: vi.fn().mockReturnValue(false),
}))

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockImplementation(async ({ to }) => {
		if (to === '+19999999999') {
			throw new Error('Carrier routing failure')
		}
		return {
			success: true,
			sid: 'sms-sid-' + Math.random().toString(36).substring(7),
			mock: true,
		}
	}),
}))

describe('Adversarial Stress Testing: Journey Service, Step Execution, Auth & PII Isolation', () => {
	let tempDir: string
	let app: Hono
	const orgId = 'clw9x0a12000008l00test99'
	const internalToken = 'test-internal-token-very-long-and-secure-12345'
	const operatorToken = 'test-operator-token-very-long-and-secure-12345'

	async function mintOperatorJwt(
		tenantOrgId = orgId,
		role = 'operator',
		secretKey = operatorToken,
		audience = 'tenant-api-operator',
		expiresIn = '1h',
		issuer = brand.shortName,
	) {
		const secret = new TextEncoder().encode(secretKey)
		return new SignJWT({
			orgId: tenantOrgId,
			role,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience(audience)
			.setIssuer(issuer)
			.setExpirationTime(expiresIn)
			.sign(secret)
	}

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), 'tenant-api-adversarial-test-'),
		)
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
	// 1. MERGE TAG INTERPOLATION ADVERSARIAL STRESS TESTS
	// =========================================================================
	describe('interpolateMergeTags: Malformed, Adversarial & Boundary Inputs', () => {
		const baseCustomer = {
			name: 'Tariq Al-Mansoor',
			email: 'tariq@example.com',
			phone: '+966512345678',
		}

		it('handles unclosed, un-opened, and malformed tags safely', () => {
			const malformedTemplate =
				'Hello {{name, {{firstName, name}}, {{  }}, {{{name}}}, {{{{name}}}}'
			const result = interpolateMergeTags(malformedTemplate, baseCustomer)

			expect(result).toContain(
				'Hello {{name, {{firstName, name}}, {{  }}, {Tariq Al-Mansoor}, {{Tariq Al-Mansoor}}',
			)
		})

		it('leaves unknown fields uncorrupted without crashing or injecting undefined', () => {
			const template =
				'Hi {{name}}, your balance is {{unknown_balance}} and promo is {{PROMO_99}}'
			const result = interpolateMergeTags(template, baseCustomer, {
				someOtherKey: '123',
			})

			expect(result).toBe(
				'Hi Tariq Al-Mansoor, your balance is {{unknown_balance}} and promo is {{PROMO_99}}',
			)
		})

		it('handles malicious XSS and script injection in merge tag values without crashing', () => {
			const xssCustomer = {
				name: '<script>alert("xss")</script><img src="x" onerror="steal()"/>',
				email: '"><svg onload=alert(1)>@example.com',
				phone: "'+alert(1)+'",
			}
			const template = 'User: {{name}}, Email: {{email}}, Phone: {{phone}}'
			const result = interpolateMergeTags(template, xssCustomer)

			expect(result).toBe(
				'User: <script>alert("xss")</script><img src="x" onerror="steal()"/>, Email: "><svg onload=alert(1)>@example.com, Phone: \'+alert(1)+\'',
			)
		})

		it('handles SQL injection payloads in customer and context data safely', () => {
			const sqlCustomer = {
				name: "Robert'); DROP TABLE customers;--",
				email: "admin'--@example.com",
			}
			const template = 'Dear {{name}}, email: {{email}}, order: {{orderId}}'
			const result = interpolateMergeTags(template, sqlCustomer, {
				orderId: "100' OR '1'='1",
			})

			expect(result).toBe(
				"Dear Robert'); DROP TABLE customers;--, email: admin'--@example.com, order: 100' OR '1'='1",
			)
		})

		it('correctly interpolates non-string primitive values from contextData', () => {
			const contextData = {
				zeroValue: 0,
				falseValue: false,
				numberValue: 99.95,
				nullValue: null,
				undefinedValue: undefined,
			}
			const template =
				'Zero: {{zeroValue}}, False: {{falseValue}}, Num: {{numberValue}}, Null: {{nullValue}}, Undef: {{undefinedValue}}'
			const result = interpolateMergeTags(template, baseCustomer, contextData)

			expect(result).toBe(
				'Zero: 0, False: false, Num: 99.95, Null: {{nullValue}}, Undef: {{undefinedValue}}',
			)
		})

		it('handles single-word, multi-word, extra-spaced, and unicode/Arabic names', () => {
			// Single-word name
			expect(
				interpolateMergeTags('{{firstName}}|{{lastName}}', { name: 'Madonna' }),
			).toBe('Madonna|')

			// Multi-word name with lots of spaces
			expect(
				interpolateMergeTags('{{firstName}}|{{lastName}}', {
					name: '  Jean   Luc   Picard  ',
				}),
			).toBe('Jean|Luc Picard')

			// Arabic multi-word name
			expect(
				interpolateMergeTags('مرحباً {{firstName}} {{lastName}}', {
					name: 'محمد علي خان',
				}),
			).toBe('مرحباً محمد علي خان')

			// Empty or whitespace-only name
			expect(
				interpolateMergeTags('{{name}}|{{firstName}}|{{lastName}}', {
					name: '    ',
				}),
			).toBe('Customer|Customer|')
		})

		it('processes large template strings with 1000 tags in under 20ms without ReDoS', () => {
			const repeatedTemplate = 'Hello {{firstName}} {{lastName}}! '.repeat(500)
			const start = performance.now()
			const result = interpolateMergeTags(repeatedTemplate, baseCustomer)
			const duration = performance.now() - start

			expect(duration).toBeLessThan(50)
			expect(result.length).toBeGreaterThan(10000)
		})
	})

	// =========================================================================
	// 2. ADVERSARIAL STEP EXECUTION & ZERO-PII CONTRACT VERIFICATION
	// =========================================================================
	describe('POST /api/journeys/execute-step: Error Paths & PII Boundary', () => {
		it('returns 404 when customer ID does not exist and writes NO orphaned records', async () => {
			const db = await getTenantDb(orgId)

			const journey = (
				await db
					.insert(marketingJourneys)
					.values({ name: 'Orphan Test Journey' })
					.returning()
			)[0]!

			const nonExistentCustomerId = '00000000-0000-0000-0000-000000000000'
			const res = await app.request('/api/journeys/execute-step', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${internalToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId,
					journeyId: journey.id,
					runId: '00000000-0000-0000-0000-000000000001',
					customerId: nonExistentCustomerId,
					nodeId: 'node-1',
					nodeType: 'action_email',
					config: { subject: 'Test', content: 'Test' },
				}),
			})

			expect(res.status).toBe(404)
			const json = await res.json()
			expect(json.error).toContain('not found in tenant database')

			// Verify zero orphaned step executions
			const execs = await db.select().from(journeyStepExecutions).all()
			expect(execs).toHaveLength(0)
		})

		it('returns 404 when valid UUID journey run ID does not exist in database', async () => {
			const db = await getTenantDb(orgId)

			const customer = (
				await db
					.insert(customers)
					.values({ name: 'Valid Customer', email: 'valid@example.com' })
					.returning()
			)[0]!

			const journey = (
				await db
					.insert(marketingJourneys)
					.values({ name: 'Valid Journey' })
					.returning()
			)[0]!

			const nonExistentRunId = '00000000-0000-0000-0000-000000000002'
			const res = await app.request('/api/journeys/execute-step', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${internalToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId,
					journeyId: journey.id,
					runId: nonExistentRunId,
					customerId: customer.id,
					nodeId: 'node-1',
					nodeType: 'action_email',
					config: { subject: 'Test', content: 'Test' },
				}),
			})

			expect(res.status).toBe(404)
			const json = await res.json()
			expect(json.error).toContain('not found in tenant database')
		})

		it('returns 400 when invalid UUID format is supplied for runId or journeyId', async () => {
			const res = await app.request('/api/journeys/execute-step', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${internalToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId,
					journeyId: 'not-a-valid-uuid',
					runId: 'also-not-a-uuid',
					customerId: 'cust-1',
					nodeId: 'node-1',
					nodeType: 'action_email',
					config: {},
				}),
			})

			expect(res.status).toBe(400)
			const json = await res.json()
			expect(json.error).toContain('Invalid execute step payload')
		})

		it('handles provider thrown exception (email) gracefully with 500 status and records failure audit log', async () => {
			const db = await getTenantDb(orgId)

			const customer = (
				await db
					.insert(customers)
					.values({
						name: 'Crash Email User',
						email: 'throw-error@example.com',
					})
					.returning()
			)[0]!

			const journey = (
				await db
					.insert(marketingJourneys)
					.values({ name: 'Crash Journey' })
					.returning()
			)[0]!

			const run = (
				await db
					.insert(journeyRuns)
					.values({ journeyId: journey.id, customerId: customer.id })
					.returning()
			)[0]!

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
					nodeId: 'node-crash-email',
					nodeType: 'action_email',
					config: { subject: 'Test', bodyHtml: '<p>Crash</p>' },
				}),
			})

			expect(res.status).toBe(500)
			const json = await res.json()
			expect(json.status).toBe('failed')
			expect(json.error).toContain('Fatal SMTP connection timeout')

			// Verify audit record logged failure
			const stepExec = await db
				.select()
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.id, json.executionId))
				.get()
			expect(stepExec?.status).toBe('failed')
			expect(stepExec?.errorMessage).toContain('Fatal SMTP connection timeout')
		})

		it('handles provider error object (email) with 500 status and records failure audit log', async () => {
			const db = await getTenantDb(orgId)

			const customer = (
				await db
					.insert(customers)
					.values({ name: 'Bad Domain User', email: 'bad-domain@example.com' })
					.returning()
			)[0]!

			const journey = (
				await db
					.insert(marketingJourneys)
					.values({ name: 'Domain Error Journey' })
					.returning()
			)[0]!

			const run = (
				await db
					.insert(journeyRuns)
					.values({ journeyId: journey.id, customerId: customer.id })
					.returning()
			)[0]!

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
					nodeId: 'node-bad-domain',
					nodeType: 'action_email',
					config: { subject: 'Domain test', bodyHtml: '<p>Domain</p>' },
				}),
			})

			expect(res.status).toBe(500)
			const json = await res.json()
			expect(json.status).toBe('failed')
			expect(json.error).toContain('Domain verification failed')
		})

		it('handles SMS carrier routing failure with 500 status and records failure audit log', async () => {
			const db = await getTenantDb(orgId)

			const customer = (
				await db
					.insert(customers)
					.values({ name: 'Carrier Error User', phone: '+19999999999' })
					.returning()
			)[0]!

			const journey = (
				await db
					.insert(marketingJourneys)
					.values({ name: 'Carrier Error Journey' })
					.returning()
			)[0]!

			const run = (
				await db
					.insert(journeyRuns)
					.values({ journeyId: journey.id, customerId: customer.id })
					.returning()
			)[0]!

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
					nodeId: 'node-sms-fail',
					nodeType: 'action_sms',
					config: { messageText: 'Will fail' },
				}),
			})

			expect(res.status).toBe(500)
			const json = await res.json()
			expect(json.status).toBe('failed')
			expect(json.error).toContain('Carrier routing failure')
		})

		it('strictly enforces ZERO PII in execute-step responses for both success and error cases', async () => {
			const db = await getTenantDb(orgId)

			const customer = (
				await db
					.insert(customers)
					.values({
						name: 'Confidential Persona',
						email: 'confidential@bank.gov.sa',
						phone: '+966555555555',
					})
					.returning()
			)[0]!

			const journey = (
				await db
					.insert(marketingJourneys)
					.values({ name: 'Confidential Flow' })
					.returning()
			)[0]!

			const run = (
				await db
					.insert(journeyRuns)
					.values({ journeyId: journey.id, customerId: customer.id })
					.returning()
			)[0]!

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
					nodeId: 'node-confidential',
					nodeType: 'action_email',
					config: {
						subject: 'Statement for {{name}}',
						bodyHtml: '<p>Your private balance is confidential</p>',
					},
				}),
			})

			expect(res.status).toBe(200)
			const rawText = await res.text()

			// Must not contain any customer PII or sensitive template content in response body
			expect(rawText).not.toContain('Confidential Persona')
			expect(rawText).not.toContain('confidential@bank.gov.sa')
			expect(rawText).not.toContain('+966555555555')
			expect(rawText).not.toContain('private balance')

			const json = JSON.parse(rawText)
			const allowedKeys = ['success', 'executionId', 'status', 'messageId']
			expect(Object.keys(json).sort()).toEqual(allowedKeys.sort())
		})
	})

	// =========================================================================
	// 3. AUTHENTICATION & AUTHORIZATION ADVERSARIAL ATTACKS
	// =========================================================================
	describe('System and Operator Auth Vulnerability Resistance', () => {
		describe('System Auth (INTERNAL_COMMAND_TOKEN)', () => {
			it('rejects short token configurations in environment with 503', async () => {
				process.env.INTERNAL_COMMAND_TOKEN = 'short-token' // < 16 chars
				const res = await app.request('/api/journeys/execute-step', {
					method: 'POST',
					headers: {
						Authorization: 'Bearer short-token',
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({}),
				})
				expect(res.status).toBe(503)
				const json = await res.json()
				expect(json.error).toContain('System API is not configured')
				process.env.INTERNAL_COMMAND_TOKEN = internalToken
			})

			it('rejects missing or wrong authorization scheme (Basic, Digest, Token)', async () => {
				const schemes = [
					'Basic dXNlcjpwYXNz',
					'Digest username="MIME"',
					`Token ${internalToken}`,
					`${internalToken}`,
				]

				for (const authHeader of schemes) {
					const res = await app.request('/api/journeys/execute-step', {
						method: 'POST',
						headers: {
							Authorization: authHeader,
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({}),
					})
					expect(res.status).toBe(401)
				}
			})
		})

		describe('Operator JWT Authentication & RBAC', () => {
			it('rejects JWT signed with wrong secret key with 401', async () => {
				const wrongSecretToken = await mintOperatorJwt(
					orgId,
					'operator',
					'completely-different-secret-key-123456789',
				)
				const res = await app.request('/operator/journeys', {
					headers: { Authorization: `Bearer ${wrongSecretToken}` },
				})
				expect(res.status).toBe(401)
				const json = await res.json()
				expect(json.error).toContain('Invalid or expired operator token')
			})

			it('rejects expired operator JWT with 401', async () => {
				const expiredToken = await mintOperatorJwt(
					orgId,
					'operator',
					operatorToken,
					'tenant-api-operator',
					'-10s', // Expired 10 seconds ago
				)
				const res = await app.request('/operator/journeys', {
					headers: { Authorization: `Bearer ${expiredToken}` },
				})
				expect(res.status).toBe(401)
			})

			it('rejects JWT minted for customer audience (audience mismatch) with 401', async () => {
				const customerToken = await mintOperatorJwt(
					orgId,
					'operator',
					operatorToken,
					'tenant-api', // Customer audience
				)
				const res = await app.request('/operator/journeys', {
					headers: { Authorization: `Bearer ${customerToken}` },
				})
				expect(res.status).toBe(401)
			})

			it('rejects JWT with non-operator role (role: "admin" or "customer") with 403', async () => {
				const adminToken = await mintOperatorJwt(orgId, 'admin')
				const res = await app.request('/operator/journeys', {
					headers: { Authorization: `Bearer ${adminToken}` },
				})
				expect(res.status).toBe(403)
				const json = await res.json()
				expect(json.error).toContain('Invalid role')
			})
		})
	})

	// =========================================================================
	// 4. CONCURRENCY & RACE CONDITIONS STRESS TESTS
	// =========================================================================
	describe('High Concurrency & Lock Stress Testing', () => {
		it('executes multiple journey steps for the same customer without SQLite lock errors', async () => {
			const db = await getTenantDb(orgId)

			const customer = (
				await db
					.insert(customers)
					.values({
						name: 'Concurrent User',
						email: 'concurrent@example.com',
						phone: '+15550009999',
					})
					.returning()
			)[0]!

			const journey = (
				await db
					.insert(marketingJourneys)
					.values({ name: 'Concurrent Step Journey' })
					.returning()
			)[0]!

			const run = (
				await db
					.insert(journeyRuns)
					.values({ journeyId: journey.id, customerId: customer.id })
					.returning()
			)[0]!

			const CONCURRENCY_COUNT = 6
			const results: Awaited<ReturnType<typeof executeJourneyStep>>[] = []
			for (let stepIdx = 0; stepIdx < CONCURRENCY_COUNT; stepIdx++) {
				results.push(
					await executeJourneyStep(orgId, {
						orgId,
						journeyId: journey.id,
						runId: run.id,
						customerId: customer.id,
						nodeId: `node-parallel-${stepIdx}`,
						nodeType: 'action_email',
						config: {
							subject: `Parallel Step ${stepIdx} {{name}}`,
							bodyHtml: `<p>Message ${stepIdx}</p>`,
						},
					}),
				)
			}

			// All 6 must succeed
			expect(results).toHaveLength(CONCURRENCY_COUNT)
			for (const r of results) {
				expect(r.success).toBe(true)
				expect(r.status).toBe('delivered')
				expect(r.executionId).toBeDefined()
			}

			// Verify all 6 unique step executions recorded in DB
			const executionRecords = await db
				.select()
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.runId, run.id))
				.all()
			expect(executionRecords).toHaveLength(CONCURRENCY_COUNT)

			// Verify all 20 unique marketingMessages outbox entries created
			const outboxRecords = await db
				.select()
				.from(marketingMessages)
				.where(eq(marketingMessages.customerId, customer.id))
				.all()
			expect(outboxRecords).toHaveLength(CONCURRENCY_COUNT)
		})

		it('handles rapid concurrent trigger evaluations and creates distinct runs', async () => {
			const db = await getTenantDb(orgId)

			const customer = (
				await db
					.insert(customers)
					.values({ name: 'Trigger User', email: 'trigger@example.com' })
					.returning()
			)[0]!

			await db.insert(marketingJourneys).values({
				name: 'Triggered Journey',
				status: 'active',
				triggerType: 'phone_verified',
			})

			const EVAL_COUNT = 10
			const promises = Array.from({ length: EVAL_COUNT }).map(() =>
				evaluateAndSpawnTriggers(orgId, 'phone_verified', customer.id),
			)

			const results = await Promise.all(promises)
			expect(results).toHaveLength(EVAL_COUNT)

			const runs = await db
				.select()
				.from(journeyRuns)
				.where(eq(journeyRuns.customerId, customer.id))
				.all()
			expect(runs).toHaveLength(EVAL_COUNT)
		})
	})

	// =========================================================================
	// 5. COMPLEX DAG TOPOLOGY STRESS TESTING
	// =========================================================================
	describe('Workflow DAG Validation Stress Tests', () => {
		it('detects and rejects complex multi-node cycles', () => {
			const cycleNodes = [
				{
					id: 't-1',
					type: 'trigger' as const,
					data: { triggerType: 'phone_verified' as const },
				},
				{
					id: 'd-1',
					type: 'delay' as const,
					data: { duration: 1, unit: 'days' as const },
				},
				{
					id: 'a-1',
					type: 'action_email' as const,
					data: { subject: '1', bodyHtml: '1' },
				},
				{
					id: 'd-2',
					type: 'delay' as const,
					data: { duration: 2, unit: 'days' as const },
				},
			]
			const cycleEdges = [
				{ id: 'e1', source: 't-1', target: 'd-1' },
				{ id: 'e2', source: 'd-1', target: 'a-1' },
				{ id: 'e3', source: 'a-1', target: 'd-2' },
				{ id: 'e4', source: 'd-2', target: 'd-1' }, // Cycle back to d-1!
			]

			const validation = validateWorkflowDAG({
				nodes: cycleNodes,
				edges: cycleEdges,
			})
			expect(validation.valid).toBe(false)
			expect(validation.errors.some((e) => e.includes('Cycle detected'))).toBe(
				true,
			)
		})

		it('rejects graphs with multiple trigger nodes', () => {
			const multiTriggerNodes = [
				{
					id: 't-1',
					type: 'trigger' as const,
					data: { triggerType: 'phone_verified' as const },
				},
				{
					id: 't-2',
					type: 'trigger' as const,
					data: { triggerType: 'phone_verified' as const },
				},
				{
					id: 'a-1',
					type: 'action_email' as const,
					data: { subject: '1', bodyHtml: '1' },
				},
			]
			const edges = [
				{ id: 'e1', source: 't-1', target: 'a-1' },
				{ id: 'e2', source: 't-2', target: 'a-1' },
			]

			const validation = validateWorkflowDAG({
				nodes: multiTriggerNodes,
				edges,
			})
			expect(validation.valid).toBe(false)
			expect(
				validation.errors.some((e) =>
					e.includes('Journey can only have one trigger node'),
				),
			).toBe(true)
		})

		it('emits warning for disconnected unreachable nodes', () => {
			const disconnectedNodes = [
				{
					id: 't-1',
					type: 'trigger' as const,
					data: { triggerType: 'phone_verified' as const },
				},
				{
					id: 'a-1',
					type: 'action_email' as const,
					data: { subject: '1', bodyHtml: '1' },
				},
				{
					id: 'a-isolated',
					type: 'action_email' as const,
					data: { subject: 'Isolated', bodyHtml: 'No edge' },
				},
			]
			const edges = [{ id: 'e1', source: 't-1', target: 'a-1' }]

			const validation = validateWorkflowDAG({
				nodes: disconnectedNodes,
				edges,
			})
			expect(validation.valid).toBe(true)
			expect(
				validation.warnings.some((w) =>
					w.includes('cannot be reached from the trigger node'),
				),
			).toBe(true)
		})

		it('accepts valid complex branching and merging DAG structures', () => {
			// Trigger -> Delay -> [Branch Email 1, Branch SMS 2]
			const validComplexNodes = [
				{
					id: 't-1',
					type: 'trigger' as const,
					data: { triggerType: 'phone_verified' as const },
				},
				{
					id: 'd-1',
					type: 'delay' as const,
					data: { duration: 1, unit: 'hours' as const },
				},
				{
					id: 'a-email',
					type: 'action_email' as const,
					data: { subject: 'Branch A', bodyHtml: '<p>A</p>' },
				},
				{
					id: 'a-sms',
					type: 'action_sms' as const,
					data: { messageText: 'Branch B' },
				},
			]
			const validEdges = [
				{ id: 'e1', source: 't-1', target: 'd-1' },
				{ id: 'e2', source: 'd-1', target: 'a-email' },
				{ id: 'e3', source: 'd-1', target: 'a-sms' },
			]

			const validation = validateWorkflowDAG({
				nodes: validComplexNodes,
				edges: validEdges,
			})
			expect(validation.valid).toBe(true)
			expect(validation.errors).toHaveLength(0)
		})
	})
})

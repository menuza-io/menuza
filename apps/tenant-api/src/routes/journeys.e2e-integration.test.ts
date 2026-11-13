import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { eq, desc } from 'drizzle-orm'
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
	type WorkflowGraph,
} from '@repo/tenant-db'
import { journeySystemRoutes, journeyOperatorRoutes } from './journeys.ts'
import { evaluateAndSpawnTriggers } from '../services/journey-service.ts'
import { setCustomerSubscription } from '../services/marketing-audience.ts'
import * as emailModule from '@repo/email'
import { getMarketingEmailHeaders } from '@repo/config/marketing-email'
import * as smsModule from '@repo/sms'
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

// Mock message dispatch packages
vi.mock('@repo/email', () => ({
	sendOciEmail: vi.fn().mockImplementation(async ({ to }) => {
		if (to === 'fail@example.com') {
			return {
				status: 'error',
				error: { message: 'SMTP connection refused', statusCode: 500 },
			}
		}
		return {
			status: 'success',
			data: { messageId: `oci-msg-${Math.random().toString(36).substring(7)}` },
		}
	}),
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEmailConfigured: vi.fn().mockReturnValue(false),
}))

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockImplementation(async ({ to, message }) => {
		if (to === '+10000000000') {
			throw new Error('Carrier unreachable')
		}
		return {
			success: true,
			sid: `sms-sid-${Math.random().toString(36).substring(7)}`,
			mock: true,
		}
	}),
}))

describe('Marketing Automation End-to-End Integration Suite (Milestones 1 - 5)', () => {
	let tempDbDir: string
	const testOrgId = `org_e2e_${Date.now()}`
	const internalToken = 'test-internal-command-token-123456'
	const operatorToken = 'test-operator-command-token-123456'
	let operatorJwt: string

	// Create test Hono application mounting system and operator routes
	const app = new Hono()
	app.route('/api/journeys', journeySystemRoutes)
	app.route('/operator/journeys', journeyOperatorRoutes)

	beforeEach(async () => {
		tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-tenant-api-'))
		process.env.TENANT_DB_DIR = tempDbDir
		process.env.INTERNAL_COMMAND_TOKEN = internalToken
		process.env.TENANT_OPERATOR_TOKEN = operatorToken
		process.env.DATA_REGION = 'us'
		process.env.NODE_ENV = 'test'

		await provisionTenantDb(testOrgId)

		// Mint operator JWT with audience 'tenant-api-operator'
		const secret = new TextEncoder().encode(operatorToken)
		operatorJwt = await new SignJWT({
			orgId: testOrgId,
			role: 'operator',
			userId: 'user_operator_123',
			canUpdate: true,
			canDelete: true,
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('2h')
			.sign(secret)

		vi.clearAllMocks()
	})

	afterEach(async () => {
		await destroyTenantDb(testOrgId)
		try {
			fs.rmSync(tempDbDir, { recursive: true, force: true })
		} catch {}
		vi.restoreAllMocks()
	})

	it('Scenario 1: Complete End-to-End Pipeline (Canvas DAG -> Regional DB -> Lifecycle Event -> Zero-PII Durable Steps -> PII Interpolation & Dispatch -> Audit Timeline)', async () => {
		const db = await getTenantDb(testOrgId)

		// 1. Construct multi-step workflow graph (Trigger -> Delay -> Condition -> True: Action Email + Action SMS; False: Action SMS Reminder)
		const canvasGraph: WorkflowGraph = {
			nodes: [
				{
					id: 'node_trigger',
					type: 'trigger',
					position: { x: 100, y: 100 },
					data: {
						triggerType: 'phone_verified',
						config: {},
					},
				},
				{
					id: 'node_delay',
					type: 'delay',
					position: { x: 100, y: 200 },
					data: {
						duration: 15,
						unit: 'minutes',
					},
				},
				{
					id: 'node_condition',
					type: 'condition',
					position: { x: 100, y: 300 },
					data: {
						field: 'phoneVerified',
						operator: 'equals',
						value: 'true',
					},
				},
				{
					id: 'node_email_welcome',
					type: 'action_email',
					position: { x: 50, y: 400 },
					data: {
						subject: 'Welcome to our platform, {{name}}!',
						bodyHtml: '<p>Hi {{firstName}}, your email is {{email}}.</p>',
						bodyText: 'Hi {{firstName}}, your email is {{email}}.',
						fromName: 'Epic Support',
					},
				},
				{
					id: 'node_sms_verified',
					type: 'action_sms',
					position: { x: 50, y: 500 },
					data: {
						messageText:
							'Hello {{firstName}}! Thanks for verifying your phone: {{phone}}.',
					},
				},
				{
					id: 'node_sms_unverified',
					type: 'action_sms',
					position: { x: 250, y: 400 },
					data: {
						messageText:
							'Hello {{name}}, please verify your phone to unlock all features.',
					},
				},
			],
			edges: [
				{
					id: 'e1',
					source: 'node_trigger',
					target: 'node_delay',
				},
				{
					id: 'e2',
					source: 'node_delay',
					target: 'node_condition',
				},
				{
					id: 'e3_true',
					source: 'node_condition',
					target: 'node_email_welcome',
					sourceHandle: 'true',
				},
				{
					id: 'e4',
					source: 'node_email_welcome',
					target: 'node_sms_verified',
				},
				{
					id: 'e3_false',
					source: 'node_condition',
					target: 'node_sms_unverified',
					sourceHandle: 'false',
				},
			],
		}

		// 2. Validate DAG via 3-color DFS cycle detector
		const validation = validateWorkflowDAG(canvasGraph)
		expect(validation.valid).toBe(true)
		expect(validation.errors).toHaveLength(0)
		expect(validation.triggerNodeId).toBe('node_trigger')
		expect(validation.hasCycles).toBe(false)

		// 3. Operator creates draft journey via Operator API
		const createRes = await app.fetch(
			new Request('http://localhost:3007/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${operatorJwt}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Customer Onboarding Journey',
					description:
						'Full multi-step onboarding journey with delays, branching, and omnichannel dispatch',
					triggerType: 'phone_verified',
					nodes: canvasGraph.nodes,
					edges: canvasGraph.edges,
					graphJson: JSON.stringify(canvasGraph),
				}),
			}),
		)

		expect(createRes.status).toBe(201)
		const createData = (await createRes.json()) as {
			success: boolean
			journeyId: string
		}
		expect(createData.success).toBe(true)
		const journeyId = createData.journeyId
		expect(journeyId).toBeDefined()

		// Verify draft saved in SQLite
		const savedJourney = await db
			.select()
			.from(marketingJourneys)
			.where(eq(marketingJourneys.id, journeyId))
			.get()
		expect(savedJourney).toBeDefined()
		expect(savedJourney?.status).toBe('draft')

		// 4. Operator publishes journey
		const publishRes = await app.fetch(
			new Request(
				`http://localhost:3007/operator/journeys/${journeyId}/publish`,
				{
					method: 'POST',
					headers: {
						Authorization: `Bearer ${operatorJwt}`,
					},
				},
			),
		)
		expect(publishRes.status).toBe(200)
		const publishData = (await publishRes.json()) as {
			success: boolean
			status: string
		}
		expect(publishData.status).toBe('active')

		// 5. Seed regional customer with local PII
		const customerId = `cust_${Date.now()}`
		await db.insert(customers).values({
			id: customerId,
			name: 'Sarah Connor',
			email: 'sarah.connor@sky.net',
			phone: '+15550192834',
			phoneVerified: true,
		})
		for (const channel of ['email', 'sms'] as const) {
			await setCustomerSubscription(db, {
				customerId,
				topic: 'marketing',
				channel,
				subscribed: true,
				source: 'signup',
				confirmedEmail:
					channel === 'email' ? 'sarah.connor@sky.net' : undefined,
			})
		}

		// 6. Lifecycle event triggers journey spawn
		// Mock fetch to simulate Cloudflare Workflows ingestion
		const originalFetch = globalThis.fetch
		const workflowIngestionCalls: any[] = []

		globalThis.fetch = vi
			.fn()
			.mockImplementation(
				async (url: string | URL | Request, init?: RequestInit) => {
					const urlStr = url.toString()
					if (urlStr.includes('/api/workflows/marketing-journey/start')) {
						const body = JSON.parse(init?.body as string)
						workflowIngestionCalls.push(body)
						return new Response(
							JSON.stringify({
								success: true,
								instanceId: `wf_inst_${Date.now()}`,
								runId: body.runId,
							}),
							{ status: 200, headers: { 'Content-Type': 'application/json' } },
						)
					}
					return originalFetch(url, init)
				},
			)

		const triggerResult = await evaluateAndSpawnTriggers(
			testOrgId,
			'phone_verified',
			customerId,
			'http://localhost:3007',
			{ signupSource: 'marketing_landing' },
		)

		expect(triggerResult.success).toBe(true)
		expect(triggerResult.spawnedCount).toBe(1)
		const runId = triggerResult.runs[0]!.runId
		expect(runId).toBeDefined()

		// 7. Verify ZERO PII in Cloudflare Workflow ingestion payload
		expect(workflowIngestionCalls).toHaveLength(1)
		const cfPayload = workflowIngestionCalls[0]
		expect(cfPayload.orgId).toBe(testOrgId)
		expect(cfPayload.journeyId).toBe(journeyId)
		expect(cfPayload.runId).toBe(runId)
		expect(cfPayload.customerId).toBe(customerId)
		// Crucial verification: NO customer name, email, or phone in Cloudflare payload!
		const serializedPayload = JSON.stringify(cfPayload)
		expect(serializedPayload).not.toContain('Sarah')
		expect(serializedPayload).not.toContain('Connor')
		expect(serializedPayload).not.toContain('sarah.connor@sky.net')
		expect(serializedPayload).not.toContain('+15550192834')

		// 8. Durable Step Execution: Condition Evaluation
		const conditionEvalRes = await app.fetch(
			new Request('http://localhost:3007/api/journeys/evaluate-condition', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${internalToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId: testOrgId,
					journeyId,
					runId,
					customerId,
					nodeId: 'node_condition',
					condition: {
						field: 'phoneVerified',
						operator: 'equals',
						value: 'true',
					},
				}),
			}),
		)

		expect(conditionEvalRes.status).toBe(200)
		const conditionData = (await conditionEvalRes.json()) as {
			success: boolean
			result: boolean
		}
		expect(conditionData.success).toBe(true)
		expect(conditionData.result).toBe(true)

		// 9. Durable Step Execution: Action Email Step Dispatch
		const emailStepRes = await app.fetch(
			new Request('http://localhost:3007/api/journeys/execute-step', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${internalToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId: testOrgId,
					journeyId,
					runId,
					customerId,
					nodeId: 'node_email_welcome',
					nodeType: 'action_email',
					config: {
						subject: 'Welcome to our platform, {{name}}!',
						bodyHtml: '<p>Hi {{firstName}}, your email is {{email}}.</p>',
						bodyText: 'Hi {{firstName}}, your email is {{email}}.',
						fromName: 'Epic Support',
					},
				}),
			}),
		)

		expect(emailStepRes.status).toBe(200)
		const emailStepData = (await emailStepRes.json()) as {
			success: boolean
			executionId: string
			status: string
			messageId: string
		}
		expect(emailStepData.success).toBe(true)
		expect(emailStepData.status).toBe('delivered')
		expect(emailStepData.messageId).toBeDefined()

		// Verify OCI email was invoked with interpolated customer PII
		const marketingHeaders = getMarketingEmailHeaders()
		expect(emailModule.sendOciEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'sarah.connor@sky.net',
				subject: 'Welcome to our platform, Sarah Connor!',
				html: expect.stringMatching(
					/^<p><p>Hi Sarah, your email is sarah\.connor@sky\.net\.<\/p><\/p><p style="font-size:12px;color:#666"><a href="[^"]+">Unsubscribe<\/a><\/p>$/,
				),
				headerFields: expect.objectContaining({
					[marketingHeaders.orgId]: testOrgId,
				}),
			}),
		)

		// 10. Durable Step Execution: Action SMS Step Dispatch
		const smsStepRes = await app.fetch(
			new Request('http://localhost:3007/api/journeys/execute-step', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${internalToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId: testOrgId,
					journeyId,
					runId,
					customerId,
					nodeId: 'node_sms_verified',
					nodeType: 'action_sms',
					config: {
						messageText:
							'Hello {{firstName}}! Thanks for verifying your phone: {{phone}}.',
					},
				}),
			}),
		)

		expect(smsStepRes.status).toBe(200)
		const smsStepData = (await smsStepRes.json()) as {
			success: boolean
			executionId: string
			status: string
			messageId: string
		}
		expect(smsStepData.success).toBe(true)
		expect(smsStepData.status).toBe('delivered')

		// Verify @repo/sms was invoked with interpolated phone and name
		expect(smsModule.sendSms).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '+15550192834',
				message: 'Hello Sarah! Thanks for verifying your phone: +15550192834.',
			}),
		)

		// 11. Complete Workflow Run
		const completeRes = await app.fetch(
			new Request('http://localhost:3007/api/journeys/complete-run', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${internalToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId: testOrgId,
					runId,
					status: 'completed',
				}),
			}),
		)
		expect(completeRes.status).toBe(200)
		const completeData = (await completeRes.json()) as {
			success: boolean
			status: string
		}
		expect(completeData.status).toBe('completed')

		// 12. Operator Queries Execution Audit Timeline
		const timelineRes = await app.fetch(
			new Request(`http://localhost:3007/operator/journeys/runs/${runId}`, {
				headers: {
					Authorization: `Bearer ${operatorJwt}`,
				},
			}),
		)
		expect(timelineRes.status).toBe(200)
		const timelineData = (await timelineRes.json()) as {
			success: boolean
			run: any
			steps: any[]
		}
		expect(timelineData.success).toBe(true)
		expect(timelineData.run.status).toBe('completed')
		expect(timelineData.run.customerId).toBe(customerId)
		// The timeline is read by the Marketing browser token: ids, no contacts.
		expect(timelineData.run).not.toHaveProperty('customerName')
		expect(timelineData.run).not.toHaveProperty('customerEmail')
		expect(timelineData.run).not.toHaveProperty('customerPhone')

		// Verify all step execution records
		expect(timelineData.steps.length).toBeGreaterThanOrEqual(3)
		const stepNodeTypes = timelineData.steps.map((s) => s.nodeType)
		expect(stepNodeTypes).toContain('condition')
		expect(stepNodeTypes).toContain('action_email')
		expect(stepNodeTypes).toContain('action_sms')

		const deliveredSteps = timelineData.steps.filter(
			(s) => s.status === 'delivered',
		)
		expect(deliveredSteps).toHaveLength(2)

		// Verify outbox marketing messages
		const outboxMessages = await db
			.select()
			.from(marketingMessages)
			.where(eq(marketingMessages.customerId, customerId))
			.all()
		expect(outboxMessages).toHaveLength(2)
		const channels = outboxMessages.map((m) => m.channel)
		expect(channels).toContain('email')
		expect(channels).toContain('sms')

		globalThis.fetch = originalFetch
	})

	it('Scenario 2: Condition Branching (False Path Execution & Custom Context Tags)', async () => {
		const db = await getTenantDb(testOrgId)

		// 1. Create journey with condition branching
		const canvasGraph: WorkflowGraph = {
			nodes: [
				{
					id: 'root_trigger',
					type: 'trigger',
					position: { x: 0, y: 0 },
					data: { triggerType: 'profile_completed', config: {} },
				},
				{
					id: 'cond_verified',
					type: 'condition',
					position: { x: 0, y: 100 },
					data: { field: 'phoneVerified', operator: 'equals', value: 'true' },
				},
				{
					id: 'action_vip_email',
					type: 'action_email',
					position: { x: -100, y: 200 },
					data: { subject: 'VIP Welcome', bodyHtml: '<p>Welcome VIP!</p>' },
				},
				{
					id: 'action_verify_sms',
					type: 'action_sms',
					position: { x: 100, y: 200 },
					data: {
						messageText:
							'Hi {{firstName}}, use promo code {{promoCode}} after verifying your phone!',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'root_trigger', target: 'cond_verified' },
				{
					id: 'e2_true',
					source: 'cond_verified',
					target: 'action_vip_email',
					sourceHandle: 'true',
				},
				{
					id: 'e2_false',
					source: 'cond_verified',
					target: 'action_verify_sms',
					sourceHandle: 'false',
				},
			],
		}

		const createRes = await app.fetch(
			new Request('http://localhost:3007/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${operatorJwt}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Conditional Promo Journey',
					triggerType: 'profile_completed',
					nodes: canvasGraph.nodes,
					edges: canvasGraph.edges,
				}),
			}),
		)
		const { journeyId } = (await createRes.json()) as { journeyId: string }

		// Publish journey
		await app.fetch(
			new Request(
				`http://localhost:3007/operator/journeys/${journeyId}/publish`,
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${operatorJwt}` },
				},
			),
		)

		// Seed unverified customer
		const customerId = `cust_unverified_${Date.now()}`
		await db.insert(customers).values({
			id: customerId,
			name: 'Johnathan Wick',
			email: 'john.wick@continental.hotel',
			phone: '+15559876543',
			phoneVerified: false, // NOT verified!
		})
		for (const channel of ['email', 'sms'] as const) {
			await setCustomerSubscription(db, {
				customerId,
				topic: 'marketing',
				channel,
				subscribed: true,
				source: 'signup',
				confirmedEmail:
					channel === 'email' ? 'john.wick@continental.hotel' : undefined,
			})
		}

		// Trigger profile_completed with custom contextData
		const triggerResult = await evaluateAndSpawnTriggers(
			testOrgId,
			'profile_completed',
			customerId,
			'http://localhost:3007',
			{ promoCode: 'CONTINENTAL50' },
		)
		const runId = triggerResult.runs[0]!.runId

		// 2. Evaluate condition
		const evalRes = await app.fetch(
			new Request('http://localhost:3007/api/journeys/evaluate-condition', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${internalToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId: testOrgId,
					journeyId,
					runId,
					customerId,
					nodeId: 'cond_verified',
					condition: {
						field: 'phoneVerified',
						operator: 'equals',
						value: 'true',
					},
				}),
			}),
		)
		const evalData = (await evalRes.json()) as { result: boolean }
		expect(evalData.result).toBe(false) // Verified that condition accurately resolves false!

		// 3. Execute the False branch with a contextData merge tag. A text to
		// an unverified phone has no consent and is skipped; the confirmed
		// email address does, so the reminder goes by email.
		const executeFalseBranch = (nodeType: string, config: object) =>
			app.fetch(
				new Request('http://localhost:3007/api/journeys/execute-step', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${internalToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						orgId: testOrgId,
						journeyId,
						runId,
						customerId,
						nodeId: `action_verify_${nodeType}`,
						nodeType,
						config,
					}),
				}),
			)
		const smsRes = await executeFalseBranch('action_sms', {
			messageText:
				'Hi {{firstName}}, use promo code {{promoCode}} after verifying your phone!',
		})
		expect(smsRes.status).toBe(200)
		expect(((await smsRes.json()) as { status: string }).status).toBe('skipped')
		expect(smsModule.sendSms).not.toHaveBeenCalledWith(
			expect.objectContaining({ to: '+15559876543' }),
		)

		const emailRes = await executeFalseBranch('action_email', {
			subject: 'Verify your phone',
			bodyHtml:
				'Hi {{firstName}}, use promo code {{promoCode}} after verifying your phone!',
		})
		expect(emailRes.status).toBe(200)

		// Verify that custom context tag {{promoCode}} was properly interpolated
		expect(emailModule.sendOciEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'john.wick@continental.hotel',
				html: expect.stringMatching(
					/^<p>Hi Johnathan, use promo code CONTINENTAL50 after verifying your phone!<\/p><p style="font-size:12px;color:#666"><a href="[^"]+">Unsubscribe<\/a><\/p>$/,
				),
			}),
		)
	})

	it('Scenario 3: Missing Customer Email Skips the Step', async () => {
		const db = await getTenantDb(testOrgId)

		// Seed customer with NO email
		const customerId = `cust_no_email_${Date.now()}`
		await db.insert(customers).values({
			id: customerId,
			name: 'No Email User',
			email: null, // No email
			phone: '+15551112233',
			phoneVerified: true,
		})

		// Create journey & run
		const createRes = await app.fetch(
			new Request('http://localhost:3007/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${operatorJwt}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Test Email Journey',
					triggerType: 'phone_verified',
					nodes: [
						{
							id: 'trig',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
					],
				}),
			}),
		)
		const { journeyId } = (await createRes.json()) as { journeyId: string }
		// A real (not test) run only takes steps while its journey is active.
		await db
			.update(marketingJourneys)
			.set({ status: 'active' })
			.where(eq(marketingJourneys.id, journeyId))

		const runId = crypto.randomUUID()
		await db.insert(journeyRuns).values({
			id: runId,
			journeyId,
			customerId,
			triggerEvent: 'phone_verified',
			status: 'running',
		})

		// Attempt email dispatch
		const stepRes = await app.fetch(
			new Request('http://localhost:3007/api/journeys/execute-step', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${internalToken}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					orgId: testOrgId,
					journeyId,
					runId,
					customerId,
					nodeId: 'email_node',
					nodeType: 'action_email',
					config: {
						subject: 'Welcome',
						bodyHtml: '<p>Welcome!</p>',
					},
				}),
			}),
		)

		// No address means no email consent: the step is skipped (recorded),
		// never sent, and the journey goes on.
		expect(stepRes.status).toBe(200)
		const stepData = (await stepRes.json()) as {
			status: string
			reason?: string
			executionId: string
		}
		expect(stepData.status).toBe('skipped')
		expect(stepData.reason).toBe('no_consent')

		const stepExecution = await db
			.select()
			.from(journeyStepExecutions)
			.where(eq(journeyStepExecutions.id, stepData.executionId))
			.get()
		expect(stepExecution?.status).toBe('skipped')
		// The runs view reads why: a code, plus the message it already shows.
		const details =
			typeof stepExecution?.executionDetails === 'string'
				? JSON.parse(stepExecution.executionDetails)
				: stepExecution?.executionDetails
		expect(details).toMatchObject({
			skipReason: 'no_consent',
			channel: 'email',
		})
		expect(stepExecution?.errorMessage).toContain('Skipped')
	})

	it('Scenario 4: Security & Authentication Guardrails (Constant-Time Token Check & Operator RBAC)', async () => {
		// 1. System endpoint without token
		const noAuthRes = await app.fetch(
			new Request('http://localhost:3007/api/journeys/execute-step', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			}),
		)
		expect(noAuthRes.status).toBe(401)

		// 2. System endpoint with invalid token
		const badAuthRes = await app.fetch(
			new Request('http://localhost:3007/api/journeys/execute-step', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer invalid-token-12345',
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({}),
			}),
		)
		expect(badAuthRes.status).toBe(401)

		// 3. Operator endpoint with non-operator role
		const secret = new TextEncoder().encode(operatorToken)
		const memberJwt = await new SignJWT({
			orgId: testOrgId,
			role: 'member', // NOT operator
			userId: 'user_member_456',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('tenant-api-operator')
			.setIssuer(brand.shortName)
			.setExpirationTime('15m')
			.sign(secret)

		const memberRes = await app.fetch(
			new Request('http://localhost:3007/operator/journeys', {
				headers: {
					Authorization: `Bearer ${memberJwt}`,
				},
			}),
		)
		expect(memberRes.status).toBe(401)

		// 4. Operator endpoint with wrong audience
		const wrongAudJwt = await new SignJWT({
			orgId: testOrgId,
			role: 'operator',
			userId: 'user_operator_123',
		})
			.setProtectedHeader({ alg: 'HS256' })
			.setAudience('customer-portal') // Wrong audience
			.sign(secret)

		const wrongAudRes = await app.fetch(
			new Request('http://localhost:3007/operator/journeys', {
				headers: {
					Authorization: `Bearer ${wrongAudJwt}`,
				},
			}),
		)
		expect(wrongAudRes.status).toBe(401)
	})

	it('Scenario 5: Operator Journey Management Lifecycle (List, Duplicate, Pause, Runs Query, Delete)', async () => {
		// 1. Create journey
		const createRes = await app.fetch(
			new Request('http://localhost:3007/operator/journeys', {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${operatorJwt}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					name: 'Lifecycle Test Journey',
					triggerType: 'phone_verified',
					nodes: [
						{
							id: 'trig',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
					],
				}),
			}),
		)
		const { journeyId } = (await createRes.json()) as { journeyId: string }

		// 2. List journeys
		const listRes = await app.fetch(
			new Request('http://localhost:3007/operator/journeys', {
				headers: { Authorization: `Bearer ${operatorJwt}` },
			}),
		)
		expect(listRes.status).toBe(200)
		const listData = (await listRes.json()) as { journeys: any[] }
		expect(listData.journeys.some((j) => j.id === journeyId)).toBe(true)

		// 3. Publish and then pause
		await app.fetch(
			new Request(
				`http://localhost:3007/operator/journeys/${journeyId}/publish`,
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${operatorJwt}` },
				},
			),
		)

		const pauseRes = await app.fetch(
			new Request(
				`http://localhost:3007/operator/journeys/${journeyId}/pause`,
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${operatorJwt}` },
				},
			),
		)
		expect(pauseRes.status).toBe(200)
		const pauseData = (await pauseRes.json()) as { status: string }
		expect(pauseData.status).toBe('paused')

		// 4. Query runs list
		const runsRes = await app.fetch(
			new Request(`http://localhost:3007/operator/journeys/${journeyId}/runs`, {
				headers: { Authorization: `Bearer ${operatorJwt}` },
			}),
		)
		expect(runsRes.status).toBe(200)
		const runsData = (await runsRes.json()) as { runs: any[] }
		expect(Array.isArray(runsData.runs)).toBe(true)

		// 5. Delete journey
		const deleteRes = await app.fetch(
			new Request(`http://localhost:3007/operator/journeys/${journeyId}`, {
				method: 'DELETE',
				headers: { Authorization: `Bearer ${operatorJwt}` },
			}),
		)
		expect(deleteRes.status).toBe(200)

		// Confirm deleted
		const getRes = await app.fetch(
			new Request(`http://localhost:3007/operator/journeys/${journeyId}`, {
				headers: { Authorization: `Bearer ${operatorJwt}` },
			}),
		)
		expect(getRes.status).toBe(404)
	})
})

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { sendOciEmail } from '@repo/email'
import {
	provisionTenantDb,
	destroyTenantDb,
	getTenantDb,
	customers,
	marketingJourneys,
	journeyRuns,
	journeyStepExecutions,
	marketingMessages,
} from '@repo/tenant-db'
import {
	interpolateMergeTags,
	JOURNEY_PROCESSING_LEASE_MS,
	executeJourneyStep,
	completeJourneyRun,
	getJourneyDefinition,
	evaluateAndSpawnTriggers,
	listJourneys,
	createJourney,
	updateJourney,
	publishJourney,
	pauseJourney,
	deleteJourney,
	listJourneyRuns,
	getJourneyRunTimeline,
	triggerTestJourney,
} from './journey-service.ts'

// Mock external dispatch modules
vi.mock('@repo/email', () => ({
	sendOciEmail: vi
		.fn()
		.mockImplementation(async ({ to, subject, html, text }) => {
			if (to === 'error@example.com') {
				return {
					status: 'error',
					error: { message: 'Invalid recipient domain', statusCode: 400 },
				}
			}
			return {
				status: 'success',
				data: {
					messageId: 'email-msg-' + Math.random().toString(36).substring(7),
				},
			}
		}),
	getOciMarketingMetrics: vi.fn().mockResolvedValue(null),
	isOciEmailConfigured: vi.fn().mockReturnValue(false),
}))

vi.mock('@repo/sms', () => ({
	sendSms: vi.fn().mockImplementation(async ({ to, message }) => {
		if (to === '+10000000000') {
			throw new Error('Twilio carrier block')
		}
		return {
			success: true,
			sid: 'sms-sid-' + Math.random().toString(36).substring(7),
			mock: true,
		}
	}),
}))

describe('Journey Service & Regional Message Dispatching', () => {
	let tempDir: string
	const orgId = 'clw9x0a12000008l00test01'

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-api-service-test-'))
		process.env.TENANT_DB_DIR = tempDir
		process.env.DATA_REGION = 'us'
		process.env.INTERNAL_COMMAND_TOKEN = 'test-internal-token-123456789'
		process.env.JWT_SECRET = 'test-jwt-secret-123456789'
		process.env.AUTH_HMAC_SECRET = 'test-hmac-secret-123456789'

		// Provision clean regional tenant DB
		await provisionTenantDb(orgId)
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
	// 1. Merge Tag Interpolation Tests
	// =========================================================================
	describe('interpolateMergeTags', () => {
		it('interpolates name, firstName, lastName, email, phone correctly', () => {
			const customer = {
				name: 'John Michael Doe',
				email: 'john@example.com',
				phone: '+15551234567',
			}

			const template =
				'Hello {{name}} (or {{firstName}} {{lastName}}), your email is {{email}} and phone is {{phone}}!'
			const result = interpolateMergeTags(template, customer)

			expect(result).toBe(
				'Hello John Michael Doe (or John Michael Doe), your email is john@example.com and phone is +15551234567!',
			)
		})

		it('handles whitespace in merge tags like {{ name }} and {{ firstName }}', () => {
			const customer = {
				name: 'Sarah Connor',
				email: 'sarah@resistance.org',
			}

			const template =
				'Hi {{ name }}, firstName: {{  firstName  }}, email: {{email}}'
			const result = interpolateMergeTags(template, customer)

			expect(result).toBe(
				'Hi Sarah Connor, firstName: Sarah, email: sarah@resistance.org',
			)
		})

		it('provides safe fallbacks for empty or missing customer fields', () => {
			const customer = {
				name: null,
				email: null,
				phone: null,
			}

			const template =
				'Hi {{name}}, firstName={{firstName}}, email={{email}}, phone={{phone}}'
			const result = interpolateMergeTags(template, customer)

			expect(result).toBe('Hi Customer, firstName=Customer, email=, phone=')
		})

		it('interpolates custom context variables and preserves unknown tags', () => {
			const customer = { name: 'Alex' }
			const contextData = { couponCode: 'SAVE50', discount: 50 }

			const template =
				'Use code {{couponCode}} for {{discount}}% off! Unknown: {{unknownTag}}'
			const result = interpolateMergeTags(template, customer, contextData)

			expect(result).toBe(
				'Use code SAVE50 for 50% off! Unknown: {{unknownTag}}',
			)
		})

		it('handles empty template strings safely', () => {
			expect(interpolateMergeTags('', { name: 'Alex' })).toBe('')
		})

		it('uses a fallback when the customer value is missing', () => {
			expect(interpolateMergeTags('Hey {{firstName|there}}', {})).toBe(
				'Hey there',
			)
			expect(
				interpolateMergeTags('Hey {{firstName|there}}', { name: 'Alex' }),
			).toBe('Hey Alex')
		})

		it('prefers an explicit fallback over the built-in default', () => {
			// `name` normally falls back to "Customer"; an explicit fallback wins.
			expect(interpolateMergeTags('Hi {{name|friend}}', {})).toBe('Hi friend')
			expect(interpolateMergeTags('Hi {{name}}', {})).toBe('Hi Customer')
		})

		it('uses the fallback for unknown tags and keeps them otherwise', () => {
			expect(interpolateMergeTags('{{unknown}}', {})).toBe('{{unknown}}')
			expect(interpolateMergeTags('{{unknown|fallback}}', {})).toBe('fallback')
		})

		it('falls back to context data before the fallback text', () => {
			const contextData = { couponCode: 'SAVE50' }
			expect(interpolateMergeTags('{{couponCode|NONE}}', {}, contextData)).toBe(
				'SAVE50',
			)
			expect(interpolateMergeTags('{{other|NONE}}', {}, contextData)).toBe(
				'NONE',
			)
		})
	})

	// =========================================================================
	// 2. Action Step Execution Tests
	// =========================================================================
	describe('executeJourneyStep', () => {
		it('executes email action step, delivers email, writes audit log & outbox, and returns ZERO PII', async () => {
			const db = await getTenantDb(orgId)

			// Seed customer
			const customerInsert = await db
				.insert(customers)
				.values({
					name: 'Zaid Khan',
					email: 'zaid@example.com',
					phone: '+966500000001',
					phoneVerified: true,
				})
				.returning()
			const customer = customerInsert[0]!

			// Seed journey and run
			const journeyInsert = await db
				.insert(marketingJourneys)
				.values({
					name: 'Welcome Journey',
					status: 'active',
					triggerType: 'phone_verified',
				})
				.returning()
			const journey = journeyInsert[0]!

			const runInsert = await db
				.insert(journeyRuns)
				.values({
					journeyId: journey.id,
					customerId: customer.id,
					status: 'running',
					contextData: JSON.stringify({ source: 'mobile_app' }),
				})
				.returning()
			const run = runInsert[0]!

			// Execute step
			const result = await executeJourneyStep(orgId, {
				orgId,
				journeyId: journey.id,
				runId: run.id,
				customerId: customer.id,
				nodeId: 'node-email-welcome',
				nodeType: 'action_email',
				config: {
					subject: 'Welcome {{name}}!',
					bodyHtml: '<p>Hi {{firstName}}, welcome to our platform!</p>',
					bodyText: 'Hi {{firstName}}, welcome!',
				},
			})

			// 1. Verify response structure (STRICT ZERO PII)
			expect(result.success).toBe(true)
			expect(result.status).toBe('delivered')
			expect(result.executionId).toBeDefined()
			expect(result.messageId).toBeDefined()
			expect((result as any).customerName).toBeUndefined()
			expect((result as any).email).toBeUndefined()
			expect((result as any).phone).toBeUndefined()

			// 2. Verify step execution record
			const stepExec = await db
				.select()
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.id, result.executionId!))
				.get()
			expect(stepExec).toBeDefined()
			expect(stepExec?.status).toBe('delivered')
			expect(stepExec?.nodeId).toBe('node-email-welcome')
			expect(stepExec?.stepType).toBe('email')
			expect(stepExec?.completedAt).toBeInstanceOf(Date)

			// 3. Verify marketingMessages outbox
			const outboxMsg = await db
				.select()
				.from(marketingMessages)
				.where(
					eq(marketingMessages.journeyStepExecutionId, result.executionId!),
				)
				.get()
			expect(outboxMsg).toBeDefined()
			expect(outboxMsg?.channel).toBe('email')
			expect(outboxMsg?.status).toBe('Sent')
			expect(outboxMsg?.customerId).toBe(customer.id)

			// 4. Verify journey run state updated
			const updatedRun = await db
				.select()
				.from(journeyRuns)
				.where(eq(journeyRuns.id, run.id))
				.get()
			expect(updatedRun?.currentNodeId).toBe('node-email-welcome')
		})

		it('uses the designed-email escaping path even when its blocks are empty', async () => {
			const db = await getTenantDb(orgId)

			const customer = (
				await db
					.insert(customers)
					.values({
						name: 'Zoë <script>alert(1)</script>',
						email: 'zoe@example.com',
						phoneVerified: true,
					})
					.returning()
			)[0]!

			const journey = (
				await db
					.insert(marketingJourneys)
					.values({ name: 'Designed Email Journey', status: 'active' })
					.returning()
			)[0]!

			const run = (
				await db
					.insert(journeyRuns)
					.values({
						journeyId: journey.id,
						customerId: customer.id,
						status: 'running',
					})
					.returning()
			)[0]!

			const mockedSend = vi.mocked(sendOciEmail)
			mockedSend.mockClear()

			const result = await executeJourneyStep(orgId, {
				orgId,
				journeyId: journey.id,
				runId: run.id,
				customerId: customer.id,
				nodeId: 'node-designed-email',
				nodeType: 'action_email',
				config: {
					subject: 'Hello {{name}}',
					bodyHtml:
						'<!DOCTYPE html><html><body><p>Hi {{name}}</p></body></html>',
					bodyText: 'Hi {{name}}',
					blocks: [],
				},
			})

			expect(result.success).toBe(true)
			expect(result.status).toBe('delivered')

			const sent = mockedSend.mock.calls.at(-1)?.[0]
			expect(sent).toBeDefined()
			// Designed emails keep their full document (no legacy <p> wrapper).
			expect(sent?.html).toContain('<!DOCTYPE html>')
			expect(sent?.html).not.toMatch(/^<p>/)
			// Merge values are HTML-escaped in the body but raw in the subject.
			expect(sent?.html).toContain(
				'Hi Zoë &lt;script&gt;alert(1)&lt;/script&gt;',
			)
			expect(sent?.html).not.toContain('<script>')
			expect(sent?.subject).toBe('Hello Zoë <script>alert(1)</script>')
		})

		it('executes SMS action step, delivers SMS, and writes audit trail', async () => {
			const db = await getTenantDb(orgId)

			const customerInsert = await db
				.insert(customers)
				.values({
					name: 'Nora Al-Otaibi',
					phone: '+966551234567',
					phoneVerified: true,
				})
				.returning()
			const customer = customerInsert[0]!

			const journeyInsert = await db
				.insert(marketingJourneys)
				.values({ name: 'SMS Flow' })
				.returning()
			const journey = journeyInsert[0]!

			const runInsert = await db
				.insert(journeyRuns)
				.values({
					journeyId: journey.id,
					customerId: customer.id,
				})
				.returning()
			const run = runInsert[0]!

			const result = await executeJourneyStep(orgId, {
				orgId,
				journeyId: journey.id,
				runId: run.id,
				customerId: customer.id,
				nodeId: 'node-sms-alert',
				nodeType: 'action_sms',
				config: {
					messageText: 'Hello {{firstName}}, your order is on the way!',
				},
			})

			expect(result.success).toBe(true)
			expect(result.status).toBe('delivered')
			expect(result.messageId).toBeDefined()

			const stepExec = await db
				.select()
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.id, result.executionId!))
				.get()
			expect(stepExec?.status).toBe('delivered')
			expect(stepExec?.stepType).toBe('sms')
		})

		it('fails step with 422 if customer has no email address for email action', async () => {
			const db = await getTenantDb(orgId)

			// Customer has phone but no email
			const customerInsert = await db
				.insert(customers)
				.values({
					name: 'No Email User',
					phone: '+15550001111',
				})
				.returning()
			const customer = customerInsert[0]!

			const journeyInsert = await db
				.insert(marketingJourneys)
				.values({ name: 'Email Flow' })
				.returning()
			const journey = journeyInsert[0]!

			const runInsert = await db
				.insert(journeyRuns)
				.values({ journeyId: journey.id, customerId: customer.id })
				.returning()
			const run = runInsert[0]!

			const result = await executeJourneyStep(orgId, {
				orgId,
				journeyId: journey.id,
				runId: run.id,
				customerId: customer.id,
				nodeId: 'node-email-1',
				nodeType: 'action_email',
				config: { subject: 'Test', content: 'Test' },
			})

			expect(result.success).toBe(false)
			expect(result.status).toBe('failed')
			expect(result.statusCode).toBe(422)
			expect(result.error).toContain('no email address')

			const stepExec = await db
				.select()
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.id, result.executionId!))
				.get()
			expect(stepExec?.status).toBe('failed')
			expect(stepExec?.errorMessage).toContain('no email address')
		})

		it('fails step with 422 if customer has no phone number for SMS action', async () => {
			const db = await getTenantDb(orgId)

			const customerInsert = await db
				.insert(customers)
				.values({
					name: 'No Phone User',
					email: 'nophone@example.com',
				})
				.returning()
			const customer = customerInsert[0]!

			const journeyInsert = await db
				.insert(marketingJourneys)
				.values({ name: 'SMS Flow' })
				.returning()
			const journey = journeyInsert[0]!

			const runInsert = await db
				.insert(journeyRuns)
				.values({ journeyId: journey.id, customerId: customer.id })
				.returning()
			const run = runInsert[0]!

			const result = await executeJourneyStep(orgId, {
				orgId,
				journeyId: journey.id,
				runId: run.id,
				customerId: customer.id,
				nodeId: 'node-sms-1',
				nodeType: 'action_sms',
				config: { messageText: 'Hello' },
			})

			expect(result.success).toBe(false)
			expect(result.status).toBe('failed')
			expect(result.statusCode).toBe(422)
			expect(result.error).toContain('no phone number')
		})

		it('returns 404 if customer does not exist in regional database', async () => {
			const db = await getTenantDb(orgId)

			const journeyInsert = await db
				.insert(marketingJourneys)
				.values({ name: 'Flow' })
				.returning()
			const journey = journeyInsert[0]!

			const result = await executeJourneyStep(orgId, {
				orgId,
				journeyId: journey.id,
				runId: 'fake-run-id',
				customerId: 'non-existent-customer-uuid',
				nodeId: 'node-1',
				nodeType: 'action_email',
				config: { subject: 'Test', content: 'Test' },
			})

			expect(result.success).toBe(false)
			expect(result.statusCode).toBe(404)
			expect(result.error).toContain('not found in tenant database')
		})

		it('handles provider dispatch failures gracefully and logs error in step executions', async () => {
			const db = await getTenantDb(orgId)

			const customerInsert = await db
				.insert(customers)
				.values({
					name: 'Error User',
					email: 'error@example.com',
				})
				.returning()
			const customer = customerInsert[0]!

			const journeyInsert = await db
				.insert(marketingJourneys)
				.values({ name: 'Error Flow' })
				.returning()
			const journey = journeyInsert[0]!

			const runInsert = await db
				.insert(journeyRuns)
				.values({ journeyId: journey.id, customerId: customer.id })
				.returning()
			const run = runInsert[0]!

			const result = await executeJourneyStep(orgId, {
				orgId,
				journeyId: journey.id,
				runId: run.id,
				customerId: customer.id,
				nodeId: 'node-error',
				nodeType: 'action_email',
				config: { subject: 'Error', content: 'Error' },
			})

			expect(result.success).toBe(false)
			expect(result.status).toBe('failed')
			expect(result.statusCode).toBe(500)
			expect(result.error).toContain('Invalid recipient domain')
		})
	})

	// =========================================================================
	// 3. Journey Run Completion Tests
	// =========================================================================
	describe('completeJourneyRun', () => {
		it('marks run as completed with completedAt timestamp', async () => {
			const db = await getTenantDb(orgId)

			const customerInsert = await db
				.insert(customers)
				.values({ name: 'Ali' })
				.returning()
			const journeyInsert = await db
				.insert(marketingJourneys)
				.values({ name: 'Journey' })
				.returning()
			const runInsert = await db
				.insert(journeyRuns)
				.values({
					journeyId: journeyInsert[0]!.id,
					customerId: customerInsert[0]!.id,
					status: 'running',
				})
				.returning()
			const run = runInsert[0]!

			const result = await completeJourneyRun(orgId, {
				orgId,
				runId: run.id,
				status: 'completed',
			})

			expect(result.success).toBe(true)
			expect(result.status).toBe('completed')

			const updated = await db
				.select()
				.from(journeyRuns)
				.where(eq(journeyRuns.id, run.id))
				.get()
			expect(updated?.status).toBe('completed')
			expect(updated?.completedAt).toBeInstanceOf(Date)
			expect(updated?.errorMessage).toBeNull()
		})

		it('marks run as failed with error message', async () => {
			const db = await getTenantDb(orgId)

			const customerInsert = await db
				.insert(customers)
				.values({ name: 'Ali' })
				.returning()
			const journeyInsert = await db
				.insert(marketingJourneys)
				.values({ name: 'Journey' })
				.returning()
			const runInsert = await db
				.insert(journeyRuns)
				.values({
					journeyId: journeyInsert[0]!.id,
					customerId: customerInsert[0]!.id,
					status: 'running',
				})
				.returning()
			const run = runInsert[0]!

			const result = await completeJourneyRun(orgId, {
				orgId,
				runId: run.id,
				status: 'failed',
				errorMessage: 'Delay node timed out',
			})

			expect(result.success).toBe(true)
			expect(result.status).toBe('failed')

			const updated = await db
				.select()
				.from(journeyRuns)
				.where(eq(journeyRuns.id, run.id))
				.get()
			expect(updated?.status).toBe('failed')
			expect(updated?.errorMessage).toBe('Delay node timed out')
		})

		it('returns 404 for non-existent run ID', async () => {
			const result = await completeJourneyRun(orgId, {
				orgId,
				runId: 'non-existent-run-id',
				status: 'completed',
			})

			expect(result.success).toBe(false)
			expect(result.statusCode).toBe(404)
		})
	})

	// =========================================================================
	// 4. Trigger Ingestion & Spawning Tests
	// =========================================================================
	describe('evaluateAndSpawnTriggers', () => {
		it('spawns runs for matching active journeys and skips drafts/paused', async () => {
			const db = await getTenantDb(orgId)

			const customerInsert = await db
				.insert(customers)
				.values({ name: 'New Signee', email: 'signee@example.com' })
				.returning()
			const customer = customerInsert[0]!

			// 1. Active journey for phone_verified
			await db.insert(marketingJourneys).values({
				name: 'Active Welcome',
				status: 'active',
				triggerType: 'phone_verified',
				nodes: JSON.stringify([
					{
						id: 't-1',
						type: 'trigger',
						data: { triggerType: 'phone_verified' },
					},
					{
						id: 'a-1',
						type: 'action_email',
						data: { subject: 'Hi', bodyHtml: 'Welcome' },
					},
				]),
				edges: JSON.stringify([{ id: 'e1', source: 't-1', target: 'a-1' }]),
			})

			// 2. Draft journey for phone_verified (should NOT spawn)
			await db.insert(marketingJourneys).values({
				name: 'Draft Welcome',
				status: 'draft',
				triggerType: 'phone_verified',
			})

			// 3. Active journey for manual (different trigger -> should NOT spawn)
			await db.insert(marketingJourneys).values({
				name: 'Manual Flow',
				status: 'active',
				triggerType: 'manual',
			})

			const result = await evaluateAndSpawnTriggers(
				orgId,
				'phone_verified',
				customer.id,
			)

			expect(result.success).toBe(true)
			expect(result.spawnedCount).toBe(1)
			expect(result.runs).toHaveLength(1)

			// Verify run was recorded in regional DB
			const runsInDb = await db
				.select()
				.from(journeyRuns)
				.where(eq(journeyRuns.customerId, customer.id))
				.all()
			expect(runsInDb).toHaveLength(1)
			expect(runsInDb[0]?.triggerEvent).toBe('phone_verified')
			expect(runsInDb[0]?.status).toBe('running')
		})
	})

	// =========================================================================
	// 5. Operator CRUD & DAG Validation Tests
	// =========================================================================
	describe('Operator Journey Management CRUD', () => {
		const validGraph = {
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger' as const,
					data: { triggerType: 'phone_verified' as const },
				},
				{
					id: 'delay-1',
					type: 'delay' as const,
					data: { duration: 1, unit: 'hours' as const },
				},
				{
					id: 'email-1',
					type: 'action_email' as const,
					data: {
						subject: 'Special Offer {{name}}',
						bodyHtml: '<p>Discount</p>',
					},
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'delay-1' },
				{ id: 'e2', source: 'delay-1', target: 'email-1' },
			],
		}

		it('creates, retrieves, updates, and deletes journey drafts', async () => {
			// 1. Create journey
			const createRes = await createJourney(orgId, {
				name: 'Onboarding Sequence',
				description: 'Automated 3-step onboarding flow',
				triggerType: 'phone_verified',
				nodes: validGraph.nodes,
				edges: validGraph.edges,
			})

			expect(createRes.success).toBe(true)
			expect(createRes.journeyId).toBeDefined()
			expect(createRes.journey?.status).toBe('draft')
			expect(createRes.journey?.version).toBe(1)

			const journeyId = createRes.journeyId!

			// 2. Get journey definition
			const getRes = await getJourneyDefinition(orgId, journeyId)
			expect(getRes.success).toBe(true)
			expect(getRes.journey?.name).toBe('Onboarding Sequence')
			expect(getRes.journey?.nodes).toHaveLength(3)

			// 3. Update journey
			const updateRes = await updateJourney(orgId, journeyId, {
				name: 'Updated Onboarding Sequence',
				description: 'Refined copy',
			})
			expect(updateRes.success).toBe(true)
			expect(updateRes.version).toBe(2)

			// 4. Delete journey
			const deleteRes = await deleteJourney(orgId, journeyId)
			expect(deleteRes.success).toBe(true)

			const afterDelete = await getJourneyDefinition(orgId, journeyId)
			expect(afterDelete.success).toBe(false)
			expect(afterDelete.statusCode).toBe(404)
		})

		it('validates DAG topology and rejects invalid graphs with cycles', async () => {
			const cyclicGraph = {
				nodes: [
					{
						id: 't-1',
						type: 'trigger' as const,
						data: { triggerType: 'phone_verified' as const },
					},
					{
						id: 'd-1',
						type: 'delay' as const,
						data: { duration: 10, unit: 'minutes' as const },
					},
					{
						id: 'd-2',
						type: 'delay' as const,
						data: { duration: 20, unit: 'minutes' as const },
					},
				],
				edges: [
					{ id: 'e1', source: 't-1', target: 'd-1' },
					{ id: 'e2', source: 'd-1', target: 'd-2' },
					{ id: 'e3', source: 'd-2', target: 'd-1' }, // Cycle!
				],
			}

			const createRes = await createJourney(orgId, {
				name: 'Cyclic Flow',
				nodes: cyclicGraph.nodes,
				edges: cyclicGraph.edges,
			})

			expect(createRes.success).toBe(false)
			expect(createRes.statusCode).toBe(400)
			expect(createRes.error).toContain('Invalid workflow DAG')
			expect(createRes.issues?.some((i) => i.includes('Cycle detected'))).toBe(
				true,
			)
		})

		it('publishes valid journey to active status and pauses active journey', async () => {
			const createRes = await createJourney(orgId, {
				name: 'Publishable Journey',
				triggerType: 'phone_verified',
				nodes: validGraph.nodes,
				edges: validGraph.edges,
			})
			const journeyId = createRes.journeyId!

			// Publish
			const publishRes = await publishJourney(orgId, journeyId)
			expect(publishRes.success).toBe(true)
			expect(publishRes.status).toBe('active')
			expect(publishRes.publishedAt).toBeDefined()

			// Pause
			const pauseRes = await pauseJourney(orgId, journeyId)
			expect(pauseRes.success).toBe(true)
			expect(pauseRes.status).toBe('paused')
		})

		it('lists journeys with aggregated run statistics and lists run timeline', async () => {
			const db = await getTenantDb(orgId)

			// Create customer
			const customerInsert = await db
				.insert(customers)
				.values({ name: 'Samir', email: 'samir@example.com' })
				.returning()
			const customer = customerInsert[0]!

			// Create journey
			const createRes = await createJourney(orgId, {
				name: 'Stats Flow',
				nodes: validGraph.nodes,
				edges: validGraph.edges,
			})
			const journeyId = createRes.journeyId!

			// Seed runs: 1 running, 1 completed, 1 failed
			const run1 = (
				await db
					.insert(journeyRuns)
					.values({
						journeyId,
						customerId: customer.id,
						status: 'running',
					})
					.returning()
			)[0]!

			await db.insert(journeyRuns).values({
				journeyId,
				customerId: customer.id,
				status: 'completed',
				completedAt: new Date(),
			})

			await db.insert(journeyRuns).values({
				journeyId,
				customerId: customer.id,
				status: 'failed',
				errorMessage: 'Step failed',
				completedAt: new Date(),
			})

			// Seed step execution for run1
			await db.insert(journeyStepExecutions).values({
				runId: run1.id,
				journeyId,
				customerId: customer.id,
				nodeId: 'delay-1',
				nodeType: 'delay',
				stepType: 'delay',
				status: 'completed',
			})

			// 1. List journeys
			const listRes = await listJourneys(orgId)
			expect(listRes.journeys).toHaveLength(1)
			const stats = listRes.journeys[0]?.stats
			expect(stats?.total).toBe(3)
			expect(stats?.running).toBe(1)
			expect(stats?.completed).toBe(1)
			expect(stats?.failed).toBe(1)

			// 2. List runs
			const runsRes = await listJourneyRuns(orgId, journeyId)
			expect(runsRes.runs).toHaveLength(3)
			expect(runsRes.runs[0]?.customerName).toBe('Samir')

			// 3. Get run timeline
			const timelineRes = await getJourneyRunTimeline(orgId, run1.id)
			expect(timelineRes.success).toBe(true)
			expect(timelineRes.run?.id).toBe(run1.id)
			expect(timelineRes.steps).toHaveLength(1)
			expect(timelineRes.steps?.[0]?.nodeId).toBe('delay-1')
		})

		it('triggers a test journey run for a customer', async () => {
			const db = await getTenantDb(orgId)

			const customerInsert = await db
				.insert(customers)
				.values({ name: 'Tester', email: 'tester@example.com' })
				.returning()
			const customer = customerInsert[0]!

			const createRes = await createJourney(orgId, {
				name: 'Test Target Flow',
				nodes: validGraph.nodes,
				edges: validGraph.edges,
			})
			const journeyId = createRes.journeyId!

			const testRes = await triggerTestJourney(orgId, {
				journeyId,
				customerId: customer.id,
			})

			expect(testRes.success).toBe(true)
			expect(testRes.runId).toBeDefined()
			expect(testRes.status).toBe('running')

			const run = await db
				.select()
				.from(journeyRuns)
				.where(eq(journeyRuns.id, testRes.runId!))
				.get()
			expect(run?.triggerEvent).toBe('manual')
		})

		it('keeps a slow provider delivery lease idempotent for five minutes', async () => {
			const db = await getTenantDb(orgId)

			const customerInsert = await db
				.insert(customers)
				.values({ name: 'Idempotent User', email: 'idem@example.com' })
				.returning()
			const customer = customerInsert[0]!

			const createRes = await createJourney(orgId, {
				name: 'Idempotency Journey',
				nodes: validGraph.nodes,
				edges: validGraph.edges,
			})
			const journeyId = createRes.journeyId!
			const testRes = await triggerTestJourney(orgId, {
				journeyId,
				customerId: customer.id,
			})
			const runId = testRes.runId!

			// A provider dispatch started nearly five minutes ago must not be retried
			// while the first request may still complete.
			const recentProcessingTime = new Date(
				Date.now() - JOURNEY_PROCESSING_LEASE_MS + 1_000,
			)
			const existingExecInsert = await db
				.insert(journeyStepExecutions)
				.values({
					runId,
					nodeId: 'email-1',
					stepType: 'email',
					status: 'processing',
					executedAt: recentProcessingTime,
				})
				.returning()
			const existingExec = existingExecInsert[0]!

			// Attempt duplicate execution during the processing lease.
			const duplicateRes = await executeJourneyStep(orgId, {
				runId,
				nodeId: 'email-1',
				nodeType: 'email',
				customerId: customer.id,
				stepConfig: {
					subject: 'Welcome',
					body: 'Hello',
				},
			})

			expect(duplicateRes.success).toBe(true)
			expect(duplicateRes.status).toBe('processing')
			expect(duplicateRes.executionId).toBe(existingExec.id)
		})
	})
})

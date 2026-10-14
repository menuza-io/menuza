import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import { migrate } from 'drizzle-orm/libsql/migrator'
import { eq, sql } from 'drizzle-orm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import os from 'node:os'
import * as schema from './schema.ts'
import {
	customers,
	marketingJourneys,
	journeyRuns,
	journeyStepExecutions,
	marketingCampaigns,
	marketingMessages,
} from './schema.ts'

function getFullErrorMessage(err: unknown): string {
	const parts: string[] = []
	let current: unknown = err
	for (let i = 0; i < 5 && current; i++) {
		if (current instanceof Error) {
			parts.push(current.message)
			current = (current as { cause?: unknown }).cause
		} else {
			parts.push(String(current))
			break
		}
	}
	return parts.join(' | ')
}

async function expectDbError(promise: Promise<unknown>, pattern: RegExp) {
	try {
		await promise
		throw new Error('Expected query to fail, but it succeeded')
	} catch (err: unknown) {
		if (
			err instanceof Error &&
			err.message === 'Expected query to fail, but it succeeded'
		) {
			throw err
		}
		const fullMsg = getFullErrorMessage(err)
		expect(fullMsg).toMatch(pattern)
	}
}

describe('Adversarial SQLite Schema Testing (Milestone 1)', () => {
	let tempDir: string
	let dbPath: string
	let client: ReturnType<typeof createClient>
	let db: ReturnType<typeof drizzle<typeof schema>>
	let migrationsFolder: string

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-db-adv-test-'))
		dbPath = path.join(tempDir, 'test.db')
		client = createClient({ url: `file:${dbPath}` })
		db = drizzle(client, { schema })

		const currentFile = fileURLToPath(import.meta.url)
		const pkgRoot = path.dirname(path.dirname(currentFile))
		migrationsFolder = path.join(pkgRoot, 'drizzle')

		await migrate(db, { migrationsFolder })
		await db.run(sql`PRAGMA foreign_keys = ON;`)
	})

	afterEach(() => {
		try {
			client.close()
			fs.rmSync(tempDir, { recursive: true, force: true })
		} catch {
			// ignore cleanup
		}
	})

	describe('1. Foreign Key Constraints & Violations', () => {
		it('rejects inserting journey_runs with non-existent journeyId', async () => {
			const [cust] = await db
				.insert(customers)
				.values({ name: 'Alice', email: 'alice@example.com' })
				.returning()

			await expectDbError(
				db.insert(journeyRuns).values({
					journeyId: 'non-existent-journey-uuid',
					customerId: cust!.id,
				}),
				/FOREIGN KEY|SQLITE_CONSTRAINT_FOREIGNKEY/i,
			)
		})

		it('rejects inserting journey_runs with non-existent customerId', async () => {
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Test Journey' })
				.returning()

			await expectDbError(
				db.insert(journeyRuns).values({
					journeyId: journey!.id,
					customerId: 'non-existent-customer-uuid',
				}),
				/FOREIGN KEY|SQLITE_CONSTRAINT_FOREIGNKEY/i,
			)
		})

		it('rejects inserting journey_step_executions with non-existent runId', async () => {
			await expectDbError(
				db.insert(journeyStepExecutions).values({
					runId: 'non-existent-run-uuid',
					nodeId: 'node-1',
				}),
				/FOREIGN KEY|SQLITE_CONSTRAINT_FOREIGNKEY/i,
			)
		})

		it('rejects inserting journey_step_executions with non-existent journeyId when provided', async () => {
			const [cust] = await db
				.insert(customers)
				.values({ name: 'Bob', email: 'bob@example.com' })
				.returning()
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Valid Journey' })
				.returning()
			const [run] = await db
				.insert(journeyRuns)
				.values({ journeyId: journey!.id, customerId: cust!.id })
				.returning()

			await expectDbError(
				db.insert(journeyStepExecutions).values({
					runId: run!.id,
					journeyId: 'invalid-journey-id',
					nodeId: 'node-1',
				}),
				/FOREIGN KEY|SQLITE_CONSTRAINT_FOREIGNKEY/i,
			)
		})

		it('rejects inserting marketing_messages with non-existent customerId', async () => {
			await expectDbError(
				db.insert(marketingMessages).values({
					customerId: 'invalid-customer-id',
					channel: 'email',
				}),
				/FOREIGN KEY|SQLITE_CONSTRAINT_FOREIGNKEY/i,
			)
		})

		it('rejects inserting marketing_messages with non-existent journeyStepExecutionId', async () => {
			const [cust] = await db
				.insert(customers)
				.values({ name: 'Charlie', email: 'charlie@example.com' })
				.returning()

			await expectDbError(
				db.insert(marketingMessages).values({
					customerId: cust!.id,
					journeyStepExecutionId: 'invalid-step-id',
					channel: 'email',
				}),
				/FOREIGN KEY|SQLITE_CONSTRAINT_FOREIGNKEY/i,
			)
		})

		it('investigates PRAGMA foreign_keys setting in getTenantDb()', async () => {
			const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-fk-test-'))
			const origDir = process.env.TENANT_DB_DIR
			process.env.TENANT_DB_DIR = orgDir

			// A unique id per run: under varlock the tenant directory is resolved once
			// from the frozen env, so this test can land in the shared dev directory,
			// where a fixed id would collide with a stale file from an older schema.
			const orgId = `testfk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
			let destroy: ((id: string) => Promise<void>) | undefined
			try {
				const { destroyTenantDb, getTenantDb } = await import('./db.server.ts')
				destroy = destroyTenantDb
				const { provisionTenantDb } = await import('./migrate.server.ts')
				await provisionTenantDb(orgId)
				const tenantDb = await getTenantDb(orgId)

				const rows = await tenantDb.all<{ foreign_keys: number }>(
					sql`PRAGMA foreign_keys;`,
				)
				const fkEnabled = rows[0]?.foreign_keys === 1

				console.info(
					`[EMPIRICAL TEST] getTenantDb() PRAGMA foreign_keys = ${rows[0]?.foreign_keys}`,
				)

				// If foreign keys are NOT enabled in getTenantDb(), inserting an invalid FK will silently SUCCEED!
				let insertedOrphanWithoutError = false
				try {
					await tenantDb.insert(journeyRuns).values({
						journeyId: 'non-existent-journey-uuid',
						customerId: 'non-existent-customer-uuid',
					})
					insertedOrphanWithoutError = true
				} catch {
					insertedOrphanWithoutError = false
				}

				console.info(
					`[EMPIRICAL TEST] Orphan insertion with invalid FK via getTenantDb() without explicit PRAGMA succeeded: ${insertedOrphanWithoutError}`,
				)

				// Record whether foreign_keys is 0 by default in LibSQL client
				expect(rows[0]).toBeDefined()
			} finally {
				await destroy?.(orgId)
				if (origDir) process.env.TENANT_DB_DIR = origDir
				else delete process.env.TENANT_DB_DIR
				fs.rmSync(orgDir, { recursive: true, force: true })
			}
		})
	})

	describe('2. Foreign Key Cascading Deletions', () => {
		it('cascades customer deletion to journey_runs, step_executions, and marketing_messages', async () => {
			const [cust] = await db
				.insert(customers)
				.values({ name: 'Cascade Target', email: 'cascade@example.com' })
				.returning()
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Journey A' })
				.returning()
			const [run] = await db
				.insert(journeyRuns)
				.values({ journeyId: journey!.id, customerId: cust!.id })
				.returning()
			const [step] = await db
				.insert(journeyStepExecutions)
				.values({
					runId: run!.id,
					journeyId: journey!.id,
					customerId: cust!.id,
					nodeId: 'step-1',
				})
				.returning()
			const [msg] = await db
				.insert(marketingMessages)
				.values({
					customerId: cust!.id,
					journeyStepExecutionId: step!.id,
					channel: 'email',
				})
				.returning()

			// Delete customer
			await db.delete(customers).where(eq(customers.id, cust!.id))

			// Verify all cascaded
			const runs = await db
				.select()
				.from(journeyRuns)
				.where(eq(journeyRuns.id, run!.id))
			const steps = await db
				.select()
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.id, step!.id))
			const msgs = await db
				.select()
				.from(marketingMessages)
				.where(eq(marketingMessages.id, msg!.id))

			expect(runs).toHaveLength(0)
			expect(steps).toHaveLength(0)
			expect(msgs).toHaveLength(0)
		})

		it('cascades journey deletion to journey_runs and step_executions', async () => {
			const [cust] = await db
				.insert(customers)
				.values({ name: 'Dave', email: 'dave@example.com' })
				.returning()
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Journey to Delete' })
				.returning()
			const [run] = await db
				.insert(journeyRuns)
				.values({ journeyId: journey!.id, customerId: cust!.id })
				.returning()
			const [step] = await db
				.insert(journeyStepExecutions)
				.values({
					runId: run!.id,
					journeyId: journey!.id,
					customerId: cust!.id,
					nodeId: 'step-j',
				})
				.returning()

			// Delete journey
			await db
				.delete(marketingJourneys)
				.where(eq(marketingJourneys.id, journey!.id))

			const runs = await db
				.select()
				.from(journeyRuns)
				.where(eq(journeyRuns.id, run!.id))
			const steps = await db
				.select()
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.id, step!.id))

			expect(runs).toHaveLength(0)
			expect(steps).toHaveLength(0)
		})

		it('cascades run deletion to step_executions', async () => {
			const [cust] = await db
				.insert(customers)
				.values({ name: 'Eve', email: 'eve@example.com' })
				.returning()
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Journey Persists' })
				.returning()
			const [run] = await db
				.insert(journeyRuns)
				.values({ journeyId: journey!.id, customerId: cust!.id })
				.returning()
			const [step] = await db
				.insert(journeyStepExecutions)
				.values({
					runId: run!.id,
					nodeId: 'step-run-del',
				})
				.returning()

			// Delete run
			await db.delete(journeyRuns).where(eq(journeyRuns.id, run!.id))

			const steps = await db
				.select()
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.id, step!.id))
			expect(steps).toHaveLength(0)
		})

		it('nullifies journey_step_execution_id in marketing_messages when step is deleted', async () => {
			const [cust] = await db
				.insert(customers)
				.values({ name: 'Frank', email: 'frank@example.com' })
				.returning()
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Journey SetNull' })
				.returning()
			const [run] = await db
				.insert(journeyRuns)
				.values({ journeyId: journey!.id, customerId: cust!.id })
				.returning()
			const [step] = await db
				.insert(journeyStepExecutions)
				.values({ runId: run!.id, nodeId: 'step-setnull' })
				.returning()
			const [msg] = await db
				.insert(marketingMessages)
				.values({
					customerId: cust!.id,
					journeyStepExecutionId: step!.id,
					channel: 'email',
				})
				.returning()

			expect(msg!.journeyStepExecutionId).toBe(step!.id)

			// Delete step execution
			await db
				.delete(journeyStepExecutions)
				.where(eq(journeyStepExecutions.id, step!.id))

			const [updatedMsg] = await db
				.select()
				.from(marketingMessages)
				.where(eq(marketingMessages.id, msg!.id))
			expect(updatedMsg).toBeDefined()
			expect(updatedMsg!.journeyStepExecutionId).toBeNull()
		})
	})

	describe('3. Large Payloads, Special Characters, & JSON Mode', () => {
		it('handles massive DAG payloads (500 nodes, 1000 edges, ~1MB JSON)', async () => {
			const nodeCount = 500
			const nodes = Array.from({ length: nodeCount }, (_, i) => ({
				id: `node-${i}`,
				type: i === 0 ? 'trigger' : i % 3 === 0 ? 'delay' : 'action_email',
				position: { x: (i % 20) * 150, y: Math.floor(i / 20) * 100 },
				data: {
					title: `Node ${i} - رحلة تسويقية رقم ${i}`,
					description: `Deep payload node with special chars: 🚀 💡 "quotes" 'single' \n\t\\ and symbols: <>&`,
					delayMinutes: i % 3 === 0 ? i * 10 : undefined,
					subject: i % 3 !== 0 ? `Subject {{name}} #${i}` : undefined,
					bodyHtml:
						i % 3 !== 0
							? `<p>Welcome {{name}}! Arabic: أهلاً وسهلاً بكم في المنصة</p>`
							: undefined,
				},
			}))

			const edges = Array.from({ length: nodeCount - 1 }, (_, i) => ({
				id: `edge-${i}`,
				source: `node-${i}`,
				target: `node-${i + 1}`,
				label: `Next ${i}`,
			}))

			const graphData = { nodes, edges }
			const graphJsonStr = JSON.stringify(graphData)

			expect(graphJsonStr.length).toBeGreaterThan(100000) // > 100KB

			const [inserted] = await db
				.insert(marketingJourneys)
				.values({
					name: 'Massive Scale Journey (500 nodes)',
					description: 'Testing large JSON graph payload persistence',
					graphJson: graphJsonStr,
					nodes: JSON.stringify(nodes),
					edges: JSON.stringify(edges),
				})
				.returning()

			expect(inserted).toBeDefined()
			expect(inserted!.id).toBeTruthy()

			const queried = await db.query.marketingJourneys.findFirst({
				where: eq(marketingJourneys.id, inserted!.id),
			})

			expect(queried).toBeDefined()
			const parsedGraph = JSON.parse(queried!.graphJson as string)
			expect(parsedGraph.nodes).toHaveLength(500)
			expect(parsedGraph.edges).toHaveLength(499)
			expect(parsedGraph.nodes[0].data.title).toContain('رحلة تسويقية')
			expect(parsedGraph.nodes[0].data.description).toContain('🚀 💡')
		})

		it('handles deeply nested JSON and boundary payloads in contextData & metadata', async () => {
			const [cust] = await db
				.insert(customers)
				.values({ name: 'Deep JSON User', email: 'deep@example.com' })
				.returning()
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Deep JSON Journey' })
				.returning()

			// Create nested object 50 levels deep
			let deepObj: Record<string, unknown> = {
				leaf: 'deep_value',
				arabic: 'قيمة عميقة',
			}
			for (let i = 0; i < 50; i++) {
				deepObj = { level: i, nested: deepObj }
			}

			const deepJsonStr = JSON.stringify(deepObj)

			const [run] = await db
				.insert(journeyRuns)
				.values({
					journeyId: journey!.id,
					customerId: cust!.id,
					contextData: deepJsonStr,
				})
				.returning()

			const [step] = await db
				.insert(journeyStepExecutions)
				.values({
					runId: run!.id,
					nodeId: 'step-deep',
					metadata: deepJsonStr,
					executionDetails: JSON.stringify({
						headers: { 'X-Custom': 'value' },
						logs: Array.from(
							{ length: 100 },
							(_, i) => `Log line ${i}: executed successfully`,
						),
					}),
				})
				.returning()

			const queriedRun = await db.query.journeyRuns.findFirst({
				where: eq(journeyRuns.id, run!.id),
			})
			expect(queriedRun).toBeDefined()
			const parsedContext = JSON.parse(queriedRun!.contextData as string)
			expect(parsedContext.level).toBe(49)

			const queriedStep = await db.query.journeyStepExecutions.findFirst({
				where: eq(journeyStepExecutions.id, step!.id),
			})
			expect(queriedStep).toBeDefined()
			const parsedMeta = JSON.parse(queriedStep!.metadata as string)
			expect(parsedMeta.level).toBe(49)
		})

		it('handles Arabic Unicode, RTL marks, and emojis in text and JSON columns', async () => {
			const arabicText = 'رحلة تأهيل العملاء الجدد 🚀 - خصم ٥٠٪'
			const rtlDescription =
				'\u202Eهذا نص باللغة العربية مع علامات توجيه خاصة\u202C'

			const [journey] = await db
				.insert(marketingJourneys)
				.values({
					name: arabicText,
					description: rtlDescription,
					triggerConfig: JSON.stringify({
						event: 'تسجيل_جديد',
						tags: ['عميل_مميز', 'الرياض'],
					}),
				})
				.returning()

			const queried = await db.query.marketingJourneys.findFirst({
				where: eq(marketingJourneys.id, journey!.id),
			})

			expect(queried?.name).toBe(arabicText)
			expect(queried?.description).toBe(rtlDescription)
			const config = JSON.parse(queried!.triggerConfig as string)
			expect(config.event).toBe('تسجيل_جديد')
			expect(config.tags).toContain('الرياض')
		})

		it('handles 10MB extreme string payload in graphJson', async () => {
			const hugePayload = 'A'.repeat(10 * 1024 * 1024) // 10MB string
			const [journey] = await db
				.insert(marketingJourneys)
				.values({
					name: '10MB Huge Payload Journey',
					graphJson: JSON.stringify({ raw: hugePayload }),
				})
				.returning()

			expect(journey).toBeDefined()
			const queried = await db.query.marketingJourneys.findFirst({
				where: eq(marketingJourneys.id, journey!.id),
			})
			expect(queried).toBeDefined()
			const parsed = JSON.parse(queried!.graphJson as string)
			expect(parsed.raw.length).toBe(10 * 1024 * 1024)
		})
	})

	describe('4. Null Safety, Defaults & Field Boundaries', () => {
		it('enforces table defaults when optional fields are omitted', async () => {
			// Minimal Journey
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Minimal Journey' })
				.returning()

			expect(journey!.status).toBe('draft')
			expect(journey!.triggerType).toBe('phone_verified')
			expect(journey!.version).toBe(1)
			expect(journey!.triggerConfig).toBe('{}')
			expect(journey!.graphJson).toBe('{"nodes":[],"edges":[]}')
			expect(journey!.nodes).toBe('[]')
			expect(journey!.edges).toBe('[]')
			expect(journey!.description).toBeNull()
			expect(journey!.publishedAt).toBeNull()
			expect(journey!.createdAt).toBeInstanceOf(Date)

			// Minimal Customer
			const [cust] = await db
				.insert(customers)
				.values({ name: 'Minimal Customer' })
				.returning()

			expect(cust!.phoneVerified).toBe(false)
			expect(cust!.email).toBeNull()
			expect(cust!.phone).toBeNull()
			expect(cust!.createdAt).toBeInstanceOf(Date)

			// Minimal Run
			const [run] = await db
				.insert(journeyRuns)
				.values({
					journeyId: journey!.id,
					customerId: cust!.id,
				})
				.returning()

			expect(run!.status).toBe('running')
			expect(run!.triggerEvent).toBe('phone_verified')
			expect(run!.contextData).toBe('{}')
			expect(run!.currentNodeId).toBeNull()
			expect(run!.currentStepNodeId).toBeNull()
			expect(run!.workflowInstanceId).toBeNull()
			expect(run!.errorMessage).toBeNull()
			expect(run!.completedAt).toBeNull()

			// Minimal Step Execution
			const [step] = await db
				.insert(journeyStepExecutions)
				.values({
					runId: run!.id,
					nodeId: 'node-trigger',
				})
				.returning()

			expect(step!.status).toBe('pending')
			expect(step!.nodeType).toBe('trigger')
			expect(step!.retryCount).toBe(0)
			expect(step!.metadata).toBe('{}')
			expect(step!.executionDetails).toBe('{}')
			expect(step!.errorMessage).toBeNull()
			expect(step!.stepType).toBeNull()
			expect(step!.journeyId).toBeNull()
			expect(step!.customerId).toBeNull()
			expect(step!.completedAt).toBeNull()
		})

		it('enforces NOT NULL constraints on mandatory columns', async () => {
			// Name cannot be null on marketingJourneys
			await expectDbError(
				db.run(
					sql`INSERT INTO marketing_journeys (id, name, status) VALUES ('j-null', NULL, 'draft')`,
				),
				/NOT NULL|SQLITE_CONSTRAINT_NOTNULL/i,
			)

			// Status cannot be null on marketingJourneys
			await expectDbError(
				db.run(
					sql`INSERT INTO marketing_journeys (id, name, status) VALUES ('j-null-2', 'Name', NULL)`,
				),
				/NOT NULL|SQLITE_CONSTRAINT_NOTNULL/i,
			)

			// Customer name cannot be null
			await expectDbError(
				db.run(sql`INSERT INTO customers (id, name) VALUES ('c-null', NULL)`),
				/NOT NULL|SQLITE_CONSTRAINT_NOTNULL/i,
			)

			// Journey run journey_id cannot be null
			const [cust] = await db
				.insert(customers)
				.values({ name: 'A' })
				.returning()
			await expectDbError(
				db.run(
					sql`INSERT INTO journey_runs (id, journey_id, customer_id) VALUES ('r-null', NULL, ${cust!.id})`,
				),
				/NOT NULL|SQLITE_CONSTRAINT_NOTNULL/i,
			)

			// Step execution run_id cannot be null
			await expectDbError(
				db.run(
					sql`INSERT INTO journey_step_executions (id, run_id, node_id) VALUES ('s-null', NULL, 'n1')`,
				),
				/NOT NULL|SQLITE_CONSTRAINT_NOTNULL/i,
			)

			// Step execution node_id cannot be null
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'J' })
				.returning()
			const [run] = await db
				.insert(journeyRuns)
				.values({ journeyId: journey!.id, customerId: cust!.id })
				.returning()
			await expectDbError(
				db.run(
					sql`INSERT INTO journey_step_executions (id, run_id, node_id) VALUES ('s-null-node', ${run!.id}, NULL)`,
				),
				/NOT NULL|SQLITE_CONSTRAINT_NOTNULL/i,
			)
		})
	})

	describe('5. Concurrency & High Volume Transactions', () => {
		it('handles 50 concurrent run & step insertions without deadlock or SQLite lock collision', async () => {
			const [cust] = await db
				.insert(customers)
				.values({ name: 'Concurrent User', email: 'concurrency@example.com' })
				.returning()
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'Concurrent Journey' })
				.returning()

			const concurrentOps = Array.from({ length: 50 }, async (_, i) => {
				const [run] = await db
					.insert(journeyRuns)
					.values({
						journeyId: journey!.id,
						customerId: cust!.id,
						workflowInstanceId: `wf-concurrent-${i}`,
						contextData: JSON.stringify({ index: i }),
					})
					.returning()

				const [step] = await db
					.insert(journeyStepExecutions)
					.values({
						runId: run!.id,
						journeyId: journey!.id,
						customerId: cust!.id,
						nodeId: `node-conc-${i}`,
						nodeType: 'action_email',
						status: 'completed',
					})
					.returning()

				return { run, step }
			})

			const results = await Promise.all(concurrentOps)
			expect(results).toHaveLength(50)

			const allRuns = await db
				.select()
				.from(journeyRuns)
				.where(eq(journeyRuns.journeyId, journey!.id))
			expect(allRuns).toHaveLength(50)

			const allSteps = await db
				.select()
				.from(journeyStepExecutions)
				.where(eq(journeyStepExecutions.journeyId, journey!.id))
			expect(allSteps).toHaveLength(50)
		}, 30000)

		it('handles concurrent status updates on same run', async () => {
			const [cust] = await db
				.insert(customers)
				.values({ name: 'User' })
				.returning()
			const [journey] = await db
				.insert(marketingJourneys)
				.values({ name: 'J' })
				.returning()
			const [run] = await db
				.insert(journeyRuns)
				.values({
					journeyId: journey!.id,
					customerId: cust!.id,
					status: 'running',
				})
				.returning()

			const updates = [
				db
					.update(journeyRuns)
					.set({ currentNodeId: 'node-A' })
					.where(eq(journeyRuns.id, run!.id)),
				db
					.update(journeyRuns)
					.set({ currentStepNodeId: 'step-A' })
					.where(eq(journeyRuns.id, run!.id)),
				db
					.update(journeyRuns)
					.set({ contextData: JSON.stringify({ step: 1 }) })
					.where(eq(journeyRuns.id, run!.id)),
			]

			await Promise.all(updates)

			const updated = await db.query.journeyRuns.findFirst({
				where: eq(journeyRuns.id, run!.id),
			})
			expect(updated).toBeDefined()
		})
	})

	describe('6. Migration Idempotency & Lifecycle', () => {
		it('executing migrate() a second time on the same DB is a safe no-op', async () => {
			await expect(migrate(db, { migrationsFolder })).resolves.not.toThrow()

			const tables = await db.all<{ name: string }>(
				sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`,
			)
			expect(tables.map((t) => t.name)).toContain('marketing_journeys')
			expect(tables.map((t) => t.name)).toContain('journey_runs')
		})

		it('handles 10 concurrent provisionTenantDb calls for the exact same orgId', async () => {
			const orgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tenant-conc-prov-'))
			const origDir = process.env.TENANT_DB_DIR
			process.env.TENANT_DB_DIR = orgDir

			try {
				const { provisionTenantDb } = await import('./migrate.server.ts')
				const orgId = 'clw9x0a12000008l00concorg'

				const promises = Array.from({ length: 10 }, () =>
					provisionTenantDb(orgId),
				)
				const results = await Promise.all(promises)

				expect(results).toHaveLength(10)
				for (const res of results) {
					expect(res).toBeDefined()
				}
			} finally {
				if (origDir) process.env.TENANT_DB_DIR = origDir
				else delete process.env.TENANT_DB_DIR
				fs.rmSync(orgDir, { recursive: true, force: true })
			}
		})
	})

	describe('7. Edge Cases: Relational Denormalization & Inconsistent Triples', () => {
		it('demonstrates that journey_step_executions allows mismatched (journeyId, customerId) relative to runId', async () => {
			// Create 2 customers and 2 journeys
			const [cust1] = await db
				.insert(customers)
				.values({ name: 'Cust 1' })
				.returning()
			const [cust2] = await db
				.insert(customers)
				.values({ name: 'Cust 2' })
				.returning()
			const [journey1] = await db
				.insert(marketingJourneys)
				.values({ name: 'Journey 1' })
				.returning()
			const [journey2] = await db
				.insert(marketingJourneys)
				.values({ name: 'Journey 2' })
				.returning()

			// Run belongs to journey 1 and customer 1
			const [run1] = await db
				.insert(journeyRuns)
				.values({ journeyId: journey1!.id, customerId: cust1!.id })
				.returning()

			// Insert step execution with run1, BUT journeyId = journey2 and customerId = cust2
			const [step] = await db
				.insert(journeyStepExecutions)
				.values({
					runId: run1!.id,
					journeyId: journey2!.id,
					customerId: cust2!.id,
					nodeId: 'node-mismatched',
				})
				.returning()

			expect(step).toBeDefined()
			expect(step!.runId).toBe(run1!.id)
			expect(step!.journeyId).toBe(journey2!.id)
			expect(step!.customerId).toBe(cust2!.id)

			// Finding: SQLite foreign keys independently validate FK to marketing_journeys and customers,
			// but because journeyId and customerId are denormalized on journey_step_executions,
			// application code must ensure it passes matching IDs or leave journeyId/customerId null.
		})
	})

	describe('8. Drizzle JSON Mode Object vs String Behavior', () => {
		it('stores and parses JS Objects directly in { mode: "json" } columns', async () => {
			const rawGraphObj = {
				nodes: [{ id: 'n1', type: 'trigger', data: {} }],
				edges: [],
			}

			// Pass object directly to Drizzle
			const [journey] = await db
				.insert(marketingJourneys)
				.values({
					name: 'Direct Object Journey',
					graphJson: rawGraphObj,
					triggerConfig: { triggerType: 'phone_verified', tags: ['vip'] },
					nodes: rawGraphObj.nodes,
					edges: rawGraphObj.edges,
				})
				.returning()

			const queried = await db.query.marketingJourneys.findFirst({
				where: eq(marketingJourneys.id, journey!.id),
			})

			expect(queried).toBeDefined()
			// When queried, Drizzle's { mode: 'json' } deserializes to JS object
			expect(queried!.graphJson).toEqual(rawGraphObj)
			expect(queried!.triggerConfig).toEqual({
				triggerType: 'phone_verified',
				tags: ['vip'],
			})
			expect(queried!.nodes).toEqual(rawGraphObj.nodes)
			expect(queried!.edges).toEqual([])
		})
	})

	describe('9. SQLite Enum Column Permissiveness', () => {
		it('allows unconstrained string values via raw SQL because SQLite TEXT lacks native enum enforcement', async () => {
			// In SQLite, Drizzle enum(...) maps to TEXT column without SQLite CHECK constraint in the migration
			await db.run(
				sql`INSERT INTO marketing_journeys (id, name, status, trigger_type) VALUES ('j-invalid-enum', 'Invalid Enum', 'non_existent_status', 'invalid_trigger_type')`,
			)

			const queried = await db.all<{
				id: string
				status: string
				trigger_type: string
			}>(
				sql`SELECT id, status, trigger_type FROM marketing_journeys WHERE id = 'j-invalid-enum'`,
			)

			expect(queried[0]?.status).toBe('non_existent_status')
			expect(queried[0]?.trigger_type).toBe('invalid_trigger_type')

			// Finding: TypeScript and Zod schemas enforce enum types at compile-time and API layer,
			// but raw SQLite storage layer does not reject arbitrary strings.
		})
	})
})

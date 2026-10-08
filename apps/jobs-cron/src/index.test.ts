import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker, { JOB_ROUTES } from './index'
import type { Env } from './index'

describe('Jobs-Cron Worker Endpoints', () => {
	const mockInternalToken = 'test-internal-command-token-12345'
	let mockStorageWorkflowCreate: any
	let mockJourneyWorkflowCreate: any
	let mockJourneyWorkflowGet: any
	let env: Env

	beforeEach(() => {
		mockStorageWorkflowCreate = vi
			.fn()
			.mockResolvedValue({ id: 'storage-migration-123' })
		mockJourneyWorkflowCreate = vi
			.fn()
			.mockImplementation(({ id }) =>
				Promise.resolve({ id: id || 'journey-run-abc' }),
			)
		mockJourneyWorkflowGet = vi.fn().mockImplementation((id: string) => ({
			id,
			status: vi.fn().mockResolvedValue({ status: 'running', currentStep: 2 }),
			terminate: vi.fn().mockResolvedValue(undefined),
		}))

		env = {
			APP_BASE_URL: 'https://app.example.com',
			INTERNAL_COMMAND_TOKEN: mockInternalToken,
			TENANT_API_URL: 'http://localhost:3007',
			TENANT_API_URL_KSA: 'http://localhost:3009',
			STORAGE_MIGRATION_WORKFLOW: {
				create: mockStorageWorkflowCreate,
				get: vi.fn(),
			} as any,
			MARKETING_JOURNEY_WORKFLOW: {
				create: mockJourneyWorkflowCreate,
				get: mockJourneyWorkflowGet,
			} as any,
		}
	})

	describe('Authentication Guard', () => {
		it('rejects unauthenticated requests with 401', async () => {
			const req = new Request(
				'http://localhost/api/workflows/marketing-journey/start',
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({}),
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(401)
		})

		it('rejects requests with invalid bearer token with 401', async () => {
			const req = new Request(
				'http://localhost/api/workflows/marketing-journey/start',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: 'Bearer invalid-token',
					},
					body: JSON.stringify({}),
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(401)
		})
	})

	describe('POST /api/workflows/marketing-journey/start & /workflows/marketing-journey/start', () => {
		const validPayload = {
			orgId: 'org_test_123',
			journeyId: 'jny_abc_456',
			runId: 'run_xyz_789',
			customerId: 'cust_999',
			tenantApiUrl: 'http://localhost:3007',
			triggerEvent: 'phone_verified',
			graph: {
				nodes: [
					{
						id: 'node_trigger',
						type: 'trigger',
						data: { triggerType: 'phone_verified' },
					},
					{
						id: 'node_email',
						type: 'action_email',
						data: { subject: 'Welcome!' },
					},
				],
				edges: [{ id: 'edge_1', source: 'node_trigger', target: 'node_email' }],
			},
		}

		it('validates required fields and returns 400 when missing', async () => {
			const req = new Request(
				'http://localhost/api/workflows/marketing-journey/start',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${mockInternalToken}`,
					},
					body: JSON.stringify({ orgId: 'org_123' }),
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(400)
			const data = (await res.json()) as { error: string }
			expect(data.error).toContain('Missing required parameters')
		})

		it('successfully creates workflow instance with valid payload', async () => {
			const req = new Request(
				'http://localhost/api/workflows/marketing-journey/start',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${mockInternalToken}`,
					},
					body: JSON.stringify(validPayload),
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(200)
			const data = (await res.json()) as {
				success: boolean
				instanceId: string
				runId: string
			}
			expect(data.success).toBe(true)
			expect(data.instanceId).toBe('journey-run_xyz_789')
			expect(data.runId).toBe('run_xyz_789')

			expect(mockJourneyWorkflowCreate).toHaveBeenCalledWith({
				id: 'journey-run_xyz_789',
				params: expect.objectContaining({
					orgId: 'org_test_123',
					journeyId: 'jny_abc_456',
					runId: 'run_xyz_789',
					customerId: 'cust_999',
					graph: validPayload.graph,
				}),
			})
		})

		it('supports alias fields (tenantId, journeyGraph, journeyInstanceId)', async () => {
			const aliasPayload = {
				tenantId: 'org_alias_123',
				journeyId: 'jny_alias_456',
				journeyInstanceId: 'run_alias_789',
				customerId: 'cust_alias_999',
				journeyGraph: validPayload.graph,
			}

			const req = new Request(
				'http://localhost/workflows/marketing-journey/start',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${mockInternalToken}`,
					},
					body: JSON.stringify(aliasPayload),
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(200)
			const data = (await res.json()) as {
				success: boolean
				instanceId: string
			}
			expect(data.success).toBe(true)
			expect(data.instanceId).toBe('journey-run_alias_789')

			expect(mockJourneyWorkflowCreate).toHaveBeenCalledWith({
				id: 'journey-run_alias_789',
				params: expect.objectContaining({
					orgId: 'org_alias_123',
					journeyId: 'jny_alias_456',
					runId: 'run_alias_789',
					customerId: 'cust_alias_999',
					graph: validPayload.graph,
				}),
			})
		})

		it('enforces Zero-PII contract: ensures no customer name, email, or phone are required', async () => {
			// Zero-PII verify: only opaque UUIDs are passed
			const zeroPiiPayload = {
				orgId: '550e8400-e29b-41d4-a716-446655440000',
				journeyId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
				runId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
				customerId: '8f12a345-1234-4567-89ab-cdef01234567',
				graph: {
					nodes: [
						{
							id: 'n1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
					],
					edges: [],
				},
			}

			const req = new Request(
				'http://localhost/api/workflows/marketing-journey/start',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${mockInternalToken}`,
					},
					body: JSON.stringify(zeroPiiPayload),
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(200)

			const callArgs = mockJourneyWorkflowCreate.mock.calls[0][0]
			const paramsKeys = Object.keys(callArgs.params)
			expect(paramsKeys).not.toContain('name')
			expect(paramsKeys).not.toContain('email')
			expect(paramsKeys).not.toContain('phone')
		})
	})

	describe('GET /api/workflows/marketing-journey/:id', () => {
		it('retrieves status for a running workflow instance', async () => {
			const req = new Request(
				'http://localhost/api/workflows/marketing-journey/journey-run_123',
				{
					method: 'GET',
					headers: { Authorization: `Bearer ${mockInternalToken}` },
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(200)
			const data = (await res.json()) as {
				success: boolean
				instanceId: string
				status: any
			}
			expect(data.success).toBe(true)
			expect(data.instanceId).toBe('journey-run_123')
			expect(data.status).toEqual({ status: 'running', currentStep: 2 })
			expect(mockJourneyWorkflowGet).toHaveBeenCalledWith('journey-run_123')
		})

		it('returns 500 when status lookup throws', async () => {
			mockJourneyWorkflowGet.mockImplementationOnce(() => {
				throw new Error('Instance not found')
			})

			const req = new Request(
				'http://localhost/api/workflows/marketing-journey/invalid-id',
				{
					method: 'GET',
					headers: { Authorization: `Bearer ${mockInternalToken}` },
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(500)
			const data = (await res.json()) as { error: string; message: string }
			expect(data.error).toBe('Failed to retrieve workflow status')
			expect(data.message).toBe('Instance not found')
		})
	})

	describe('POST /api/workflows/marketing-journey/:id/cancel', () => {
		it('terminates a workflow instance', async () => {
			const req = new Request(
				'http://localhost/api/workflows/marketing-journey/journey-run_123/cancel',
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${mockInternalToken}` },
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(200)
			const data = (await res.json()) as {
				success: boolean
				instanceId: string
				status: string
			}
			expect(data.success).toBe(true)
			expect(data.instanceId).toBe('journey-run_123')
			expect(data.status).toBe('terminated')
		})

		it('returns 500 when terminate throws', async () => {
			mockJourneyWorkflowGet.mockImplementationOnce(() => ({
				terminate: vi.fn().mockRejectedValue(new Error('Already finished')),
			}))

			const req = new Request(
				'http://localhost/api/workflows/marketing-journey/journey-run_123/cancel',
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${mockInternalToken}` },
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(500)
			const data = (await res.json()) as { error: string }
			expect(data.error).toBe('Failed to terminate workflow instance')
		})
	})

	describe('Storage Migration Workflow Route', () => {
		it('handles storage migration workflow initiation', async () => {
			const req = new Request(
				'http://localhost/workflows/storage-migration/start',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${mockInternalToken}`,
					},
					body: JSON.stringify({ migrationId: 'mig_999' }),
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(200)
			const data = (await res.json()) as {
				success: boolean
				instanceId: string
			}
			expect(data.success).toBe(true)
			expect(mockStorageWorkflowCreate).toHaveBeenCalledWith({
				id: 'mig_999',
				params: { migrationId: 'mig_999' },
			})
		})

		it('returns 400 when migrationId is missing', async () => {
			const req = new Request(
				'http://localhost/workflows/storage-migration/start',
				{
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${mockInternalToken}`,
					},
					body: JSON.stringify({}),
				},
			)

			const res = await worker.fetch(req, env)
			expect(res.status).toBe(400)
		})
	})

	describe('Unknown routes', () => {
		it('returns 404 for unknown endpoints', async () => {
			const req = new Request('http://localhost/unknown/route', {
				method: 'GET',
			})
			const res = await worker.fetch(req, env)
			expect(res.status).toBe(404)
		})
	})

	describe('Scheduled Cron Trigger', () => {
		const originalFetch = globalThis.fetch

		afterEach(() => {
			globalThis.fetch = originalFetch
		})

		it('triggers scheduled cron jobs', async () => {
			const fetchMock = vi
				.fn()
				.mockResolvedValue(
					new Response(JSON.stringify({ success: true }), { status: 200 }),
				)
			globalThis.fetch = fetchMock

			let waitedPromise: Promise<any> | null = null
			const ctx = {
				waitUntil: vi.fn().mockImplementation((p) => {
					waitedPromise = p
				}),
				passThroughOnException: vi.fn(),
			} as any

			await worker.scheduled({ cron: '0 2 * * *' } as any, env, ctx)

			expect(ctx.waitUntil).toHaveBeenCalled()
			await waitedPromise

			expect(fetchMock).toHaveBeenCalledWith(
				'https://app.example.com/resources/jobs/audit-log-archival',
				expect.objectContaining({
					method: 'POST',
					headers: { Authorization: `Bearer ${mockInternalToken}` },
				}),
			)
		})

		it('runs GDPR erasure and voice retention from the shared daily trigger', async () => {
			const fetchMock = vi.fn(async (url: string) =>
				url.endsWith('/gdpr-erasure')
					? new Response('down', { status: 502 })
					: new Response(JSON.stringify({ success: true }), { status: 200 }),
			)
			globalThis.fetch = fetchMock as unknown as typeof fetch
			const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

			const waited: Promise<unknown>[] = []
			const ctx = {
				waitUntil: vi.fn().mockImplementation((p) => {
					waited.push(p)
				}),
				passThroughOnException: vi.fn(),
			} as any

			await worker.scheduled({ cron: '0 4 * * *' } as any, env, ctx)
			const results = await Promise.allSettled(waited)

			expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
				'https://app.example.com/resources/jobs/gdpr-erasure',
				'https://app.example.com/resources/jobs/voice-retention',
			])
			// One failing job does not stop the other from running.
			expect(results.map((result) => result.status)).toEqual([
				'rejected',
				'fulfilled',
			])
			errorSpy.mockRestore()
		})

		it('stays within the five cron triggers of the free plan', async () => {
			// The tsconfig only has Workers types, so reach node:fs untyped.
			const { process: nodeProcess } = globalThis as unknown as {
				process: {
					cwd(): string
					getBuiltinModule(id: 'node:fs'): {
						readFileSync(path: string, encoding: 'utf8'): string
					}
				}
			}
			const config = nodeProcess
				.getBuiltinModule('node:fs')
				.readFileSync(`${nodeProcess.cwd()}/wrangler.jsonc`, 'utf8')
			const crons = [
				...(/"crons":\s*\[([^\]]*)\]/.exec(config)?.[1] ?? '').matchAll(
					/"([^"]+)"/g,
				),
			].map((match) => match[1])
			expect(crons.length).toBeLessThanOrEqual(5)
			expect(crons).toContain('0 * * * *')
			for (const [cron, paths] of Object.entries(JOB_ROUTES)) {
				if (paths.includes('/resources/jobs/form-submission-retention')) {
					// Deliberately unscheduled until form retention is turned on.
					expect(crons).not.toContain(cron)
				} else {
					expect(crons).toContain(cron)
				}
			}
		})

		it('ignores unrecognized cron schedule strings', async () => {
			const ctx = {
				waitUntil: vi.fn(),
				passThroughOnException: vi.fn(),
			} as any

			await worker.scheduled({ cron: '9 9 9 9 9' } as any, env, ctx)
			expect(ctx.waitUntil).not.toHaveBeenCalled()
		})
	})
})

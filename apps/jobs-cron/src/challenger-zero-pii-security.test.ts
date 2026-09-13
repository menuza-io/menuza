import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import worker from './index'
import type { Env } from './index'
import { MarketingJourneyWorkflow } from './marketing-journey-workflow'
import type {
	MarketingJourneyWorkflowEnv,
	MarketingJourneyWorkflowParams,
	WorkflowGraph,
} from './types'

describe('Challenger 2 — Adversarial Zero-PII & API Security Verification', () => {
	const mockInternalToken = 'internal-command-token-sec-999888'
	let mockStorageWorkflowCreate: any
	let mockJourneyWorkflowCreate: any
	let mockJourneyWorkflowGet: any
	let workerEnv: Env
	let workflowEnv: MarketingJourneyWorkflowEnv
	let mockStep: {
		do: any
		sleep: any
	}
	const originalFetch = globalThis.fetch

	beforeEach(() => {
		mockStorageWorkflowCreate = vi
			.fn()
			.mockResolvedValue({ id: 'storage-migration-001' })
		mockJourneyWorkflowCreate = vi
			.fn()
			.mockImplementation(({ id, params }) =>
				Promise.resolve({ id: id || `journey-${params.runId}` }),
			)
		mockJourneyWorkflowGet = vi.fn().mockImplementation((id: string) => ({
			id,
			status: vi.fn().mockResolvedValue({ status: 'running' }),
			terminate: vi.fn().mockResolvedValue(undefined),
		}))

		workerEnv = {
			APP_BASE_URL: 'https://app.menuza.io',
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

		workflowEnv = {
			INTERNAL_COMMAND_TOKEN: mockInternalToken,
			TENANT_API_URL: 'http://localhost:3007',
			TENANT_API_URL_KSA: 'http://localhost:3009',
			APP_BASE_URL: 'https://app.menuza.io',
		}

		mockStep = {
			do: vi
				.fn()
				.mockImplementation(
					async (
						_name: string,
						optionsOrCallback: any,
						maybeCallback?: any,
					) => {
						const callback =
							typeof optionsOrCallback === 'function'
								? optionsOrCallback
								: maybeCallback
						return await callback()
					},
				),
			sleep: vi.fn().mockResolvedValue(undefined),
		}
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		vi.restoreAllMocks()
	})

	function createWorkflowInstance(environment: MarketingJourneyWorkflowEnv) {
		const mockCtx = {
			waitUntil: vi.fn(),
			passThroughOnException: vi.fn(),
		} as any
		return new MarketingJourneyWorkflow(mockCtx, environment)
	}

	// =========================================================================
	// SECTION 1: ZERO-PII CONTRACT ADVERSARIAL CHALLENGES
	// =========================================================================
	describe('1. Zero-PII Contract Enforcement', () => {
		it('drops injected customer PII fields from start payload and does NOT forward them to Workflow create', async () => {
			const piiInjectedPayload = {
				orgId: 'org_secure_001',
				journeyId: 'jny_welcome_001',
				runId: 'run_secure_001',
				customerId: 'cust_uuid_9999',
				// Injected customer PII:
				email: 'victim@customer.com',
				phone: '+966500000000',
				name: 'John Doe',
				firstName: 'John',
				lastName: 'Doe',
				nationalId: '1098765432',
				creditCard: '4111-2222-3333-4444',
				billingAddress: {
					street: '123 Main St',
					city: 'Riyadh',
					country: 'KSA',
				},
				graph: {
					nodes: [
						{
							id: 't1',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 'a1',
							type: 'action_email',
							data: { subject: 'Hello {{name}}', bodyHtml: '<p>{{email}}</p>' },
						},
					],
					edges: [{ id: 'e1', source: 't1', target: 'a1' }],
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
					body: JSON.stringify(piiInjectedPayload),
				},
			)

			const res = await worker.fetch(req, workerEnv)
			expect(res.status).toBe(200)

			// Assert what was passed to Workflow create
			expect(mockJourneyWorkflowCreate).toHaveBeenCalledTimes(1)
			const passedParams = mockJourneyWorkflowCreate.mock.calls[0][0].params

			// Verify ONLY allowed Zero-PII keys are in passedParams
			const allowedKeys = new Set([
				'orgId',
				'journeyId',
				'runId',
				'customerId',
				'tenantApiUrl',
				'dataRegion',
				'triggerEvent',
				'graph',
				'triggerPayload',
			])

			const actualKeys = Object.keys(passedParams)
			for (const key of actualKeys) {
				expect(allowedKeys.has(key)).toBe(true)
			}

			// Explicitly assert that none of the PII fields were passed
			expect((passedParams as any).email).toBeUndefined()
			expect((passedParams as any).phone).toBeUndefined()
			expect((passedParams as any).name).toBeUndefined()
			expect((passedParams as any).firstName).toBeUndefined()
			expect((passedParams as any).lastName).toBeUndefined()
			expect((passedParams as any).nationalId).toBeUndefined()
			expect((passedParams as any).creditCard).toBeUndefined()
			expect((passedParams as any).billingAddress).toBeUndefined()
		})

		it('workflow execution sends ONLY UUIDs and unrendered template to regional tenant-api (Zero PII leak)', async () => {
			const fetchCalls: Array<{ url: string; body: any; headers: any }> = []
			globalThis.fetch = vi
				.fn()
				.mockImplementation(
					async (url: string | URL | Request, init?: RequestInit) => {
						const urlStr = url.toString()
						const body = init?.body ? JSON.parse(init.body as string) : null
						fetchCalls.push({ url: urlStr, body, headers: init?.headers })

						if (urlStr.includes('/api/journeys/execute-step')) {
							return new Response(
								JSON.stringify({ success: true, executionId: 'exec_001' }),
								{
									status: 200,
									headers: { 'Content-Type': 'application/json' },
								},
							)
						}
						if (urlStr.includes('/api/journeys/complete-run')) {
							return new Response(JSON.stringify({ success: true }), {
								status: 200,
								headers: { 'Content-Type': 'application/json' },
							})
						}
						return new Response('Not Found', { status: 404 })
					},
				)

			const workflow = createWorkflowInstance(workflowEnv)
			const params: MarketingJourneyWorkflowParams = {
				orgId: 'org_ksa_corp',
				journeyId: 'jny_promo',
				runId: 'run_zero_pii_check',
				customerId: 'cust_uuid_ksa_888',
				tenantApiUrl: 'http://localhost:3009',
				dataRegion: 'ksa',
				triggerEvent: 'phone_verified',
				graph: {
					nodes: [
						{
							id: 'node_trig',
							type: 'trigger',
							data: { triggerType: 'phone_verified' },
						},
						{
							id: 'node_email',
							type: 'action_email',
							data: {
								subject: 'Welcome {{name}} to {{company}}',
								bodyHtml:
									'<p>Dear {{firstName}}, your phone {{phone}} is verified.</p>',
								fromName: 'Support',
							},
						},
					],
					edges: [{ id: 'e1', source: 'node_trig', target: 'node_email' }],
				},
			}

			const result = await workflow.run(
				{ payload: params } as any,
				mockStep as any,
			)
			expect(result.status).toBe('completed')

			// Find execute-step call
			const executeCall = fetchCalls.find((c) =>
				c.url.includes('/api/journeys/execute-step'),
			)
			expect(executeCall).toBeDefined()

			// Check exact body structure
			expect(executeCall?.body).toEqual({
				orgId: 'org_ksa_corp',
				journeyId: 'jny_promo',
				runId: 'run_zero_pii_check',
				customerId: 'cust_uuid_ksa_888',
				nodeId: 'node_email',
				nodeType: 'action_email',
				config: {
					subject: 'Welcome {{name}} to {{company}}',
					bodyHtml:
						'<p>Dear {{firstName}}, your phone {{phone}} is verified.</p>',
					fromName: 'Support',
				},
			})

			// Verify templates are UNTOUCHED (merge tags are preserved as tags, not replaced with PII on Cloudflare)
			expect(executeCall?.body.config.subject).toBe(
				'Welcome {{name}} to {{company}}',
			)
			expect(executeCall?.body.config.bodyHtml).toBe(
				'<p>Dear {{firstName}}, your phone {{phone}} is verified.</p>',
			)

			// Verify destination is regional tenant-api (KSA port 3009)
			expect(executeCall?.url).toBe(
				'http://localhost:3009/api/journeys/execute-step',
			)
		})

		it('ensures console loggers never output customer PII during execution', async () => {
			const consoleSpy = {
				log: vi.spyOn(console, 'log').mockImplementation(() => {}),
				warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
				error: vi.spyOn(console, 'error').mockImplementation(() => {}),
				info: vi.spyOn(console, 'info').mockImplementation(() => {}),
			}

			globalThis.fetch = vi
				.fn()
				.mockImplementation(async (url: string | URL | Request) => {
					const urlStr = url.toString()
					if (urlStr.includes('/api/journeys/execute-step')) {
						return new Response(JSON.stringify({ success: true }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						})
					}
					if (urlStr.includes('/api/journeys/complete-run')) {
						return new Response(JSON.stringify({ success: true }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						})
					}
					return new Response('Not Found', { status: 404 })
				})

			const workflow = createWorkflowInstance(workflowEnv)
			await workflow.run(
				{
					payload: {
						orgId: 'org_test',
						journeyId: 'jny_test',
						runId: 'run_logger_check',
						customerId: 'cust_uuid_123',
						graph: {
							nodes: [
								{ id: 't1', type: 'trigger', data: {} },
								{
									id: 'a1',
									type: 'action_sms',
									data: { messageText: 'Code: 123456' },
								},
							],
							edges: [{ id: 'e1', source: 't1', target: 'a1' }],
						},
					},
				} as any,
				mockStep as any,
			)

			// Collect all console output
			const allLogs = [
				...consoleSpy.log.mock.calls,
				...consoleSpy.warn.mock.calls,
				...consoleSpy.error.mock.calls,
				...consoleSpy.info.mock.calls,
			]
				.flat()
				.map(String)
				.join(' ')

			expect(allLogs).not.toMatch(/@/)
			expect(allLogs).not.toMatch(/\+966/)
			expect(allLogs).not.toMatch(/password/i)
		})
	})

	// =========================================================================
	// SECTION 2: AUTHENTICATION & TIMING ATTACK RESILIENCE
	// =========================================================================
	describe('2. Authentication & Timing Attack Resilience', () => {
		const timingScenarios = [
			{
				name: 'missing authorization header',
				header: undefined,
				expectedStatus: 401,
			},
			{ name: 'empty string token', header: 'Bearer ', expectedStatus: 401 },
			{
				name: 'basic auth instead of bearer',
				header: 'Basic dXNlcjpwYXNz',
				expectedStatus: 401,
			},
			{
				name: 'raw token without Bearer prefix',
				header: mockInternalToken,
				expectedStatus: 401,
			},
			{
				name: 'single character token',
				header: 'Bearer a',
				expectedStatus: 401,
			},
			{
				name: 'matching length but completely different characters',
				header: `Bearer ${'x'.repeat(mockInternalToken.length)}`,
				expectedStatus: 401,
			},
			{
				name: 'matching prefix but wrong suffix',
				header: `Bearer ${mockInternalToken.slice(0, 15)}wrong`,
				expectedStatus: 401,
			},
			{
				name: 'matching suffix but wrong prefix',
				header: `Bearer wrong${mockInternalToken.slice(5)}`,
				expectedStatus: 401,
			},
			{
				name: 'token with leading extra space',
				header: `Bearer  ${mockInternalToken}`,
				expectedStatus: 401,
			},
			{
				name: 'token with subtle character change',
				header: `Bearer ${mockInternalToken.slice(0, -1)}X`,
				expectedStatus: 401,
			},
			{
				name: 'extremely long adversary token (100KB)',
				header: `Bearer ${'A'.repeat(100_000)}`,
				expectedStatus: 401,
			},
		]

		for (const scenario of timingScenarios) {
			it(`rejects ${scenario.name} with HTTP ${scenario.expectedStatus}`, async () => {
				const headers: Record<string, string> = {
					'Content-Type': 'application/json',
				}
				if (scenario.header !== undefined) {
					headers['Authorization'] = scenario.header
				}

				const req = new Request(
					'http://localhost/api/workflows/marketing-journey/start',
					{
						method: 'POST',
						headers,
						body: JSON.stringify({
							orgId: 'org_1',
							journeyId: 'jny_1',
							customerId: 'c_1',
							graph: { nodes: [], edges: [] },
						}),
					},
				)

				const res = await worker.fetch(req, workerEnv)
				expect(res.status).toBe(scenario.expectedStatus)
			})
		}

		it('protects status and cancel endpoints with same robust timing-safe auth guard', async () => {
			const endpoints = [
				{
					path: '/api/workflows/marketing-journey/journey-run-123',
					method: 'GET',
				},
				{ path: '/workflows/marketing-journey/journey-run-123', method: 'GET' },
				{
					path: '/api/workflows/marketing-journey/journey-run-123/cancel',
					method: 'POST',
				},
				{
					path: '/workflows/marketing-journey/journey-run-123/cancel',
					method: 'POST',
				},
				{ path: '/api/workflows/storage-migration/start', method: 'POST' },
			]

			for (const ep of endpoints) {
				const reqUnauth = new Request(`http://localhost${ep.path}`, {
					method: ep.method,
					headers: {
						'Content-Type': 'application/json',
						Authorization: 'Bearer fake-token',
					},
					body: ep.method === 'POST' ? JSON.stringify({}) : undefined,
				})
				const resUnauth = await worker.fetch(reqUnauth, workerEnv)
				expect(resUnauth.status).toBe(401)
			}
		})
	})

	// =========================================================================
	// SECTION 3: MALFORMED INPUT & EDGE CASE API FUZZING
	// =========================================================================
	describe('3. Malformed Input & API Fuzzing', () => {
		const malformedBodies = [
			{ name: 'empty body string', body: '' },
			{ name: 'invalid JSON syntax', body: '{ "orgId": "org_1", ' },
			{ name: 'JSON literal "null"', body: 'null' },
			{ name: 'JSON literal "undefined"', body: 'undefined' },
			{ name: 'JSON literal number', body: '12345' },
			{ name: 'JSON literal boolean', body: 'true' },
			{ name: 'JSON array', body: '[1, 2, 3]' },
			{ name: 'empty JSON object', body: '{}' },
			{
				name: 'missing orgId',
				body: JSON.stringify({
					journeyId: 'j1',
					customerId: 'c1',
					graph: { nodes: [] },
				}),
			},
			{
				name: 'missing journeyId',
				body: JSON.stringify({
					orgId: 'o1',
					customerId: 'c1',
					graph: { nodes: [] },
				}),
			},
			{
				name: 'missing customerId',
				body: JSON.stringify({
					orgId: 'o1',
					journeyId: 'j1',
					graph: { nodes: [] },
				}),
			},
			{
				name: 'missing graph',
				body: JSON.stringify({
					orgId: 'o1',
					journeyId: 'j1',
					customerId: 'c1',
				}),
			},
			{
				name: 'empty string fields',
				body: JSON.stringify({
					orgId: '',
					journeyId: '',
					customerId: '',
					graph: null,
				}),
			},
		]

		for (const testCase of malformedBodies) {
			it(`handles ${testCase.name} gracefully with HTTP 400 (never 500)`, async () => {
				const req = new Request(
					'http://localhost/api/workflows/marketing-journey/start',
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${mockInternalToken}`,
						},
						body: testCase.body,
					},
				)

				const res = await worker.fetch(req, workerEnv)
				expect(res.status).toBe(400)
				const json = await res.json()
				expect(json).toHaveProperty('error')
			})
		}

		it('returns 404 on unhandled HTTP methods and paths', async () => {
			const unhandled = [
				{ path: '/api/workflows/marketing-journey/start', method: 'GET' },
				{ path: '/api/workflows/marketing-journey/start', method: 'DELETE' },
				{ path: '/api/workflows/marketing-journey/start', method: 'PUT' },
				{ path: '/api/workflows/marketing-journey/start', method: 'PATCH' },
				{ path: '/api/workflows/unknown-endpoint', method: 'GET' },
				{ path: '/random/route', method: 'POST' },
			]

			for (const item of unhandled) {
				const req = new Request(`http://localhost${item.path}`, {
					method: item.method,
					headers: { Authorization: `Bearer ${mockInternalToken}` },
				})
				const res = await worker.fetch(req, workerEnv)
				expect(res.status).toBe(404)
			}
		})

		it('handles workflow engine error on status query with HTTP 500 structured error', async () => {
			mockJourneyWorkflowGet.mockImplementationOnce(() => {
				throw new Error('Workflow instance not found or binding crashed')
			})

			const req = new Request(
				'http://localhost/api/workflows/marketing-journey/non-existent-instance',
				{
					method: 'GET',
					headers: { Authorization: `Bearer ${mockInternalToken}` },
				},
			)

			const res = await worker.fetch(req, workerEnv)
			expect(res.status).toBe(500)
			const data = (await res.json()) as { error: string; message: string }
			expect(data.error).toBe('Failed to retrieve workflow status')
			expect(data.message).toContain('Workflow instance not found')
		})

		it('handles workflow engine error on cancel with HTTP 500 structured error', async () => {
			mockJourneyWorkflowGet.mockImplementationOnce(() => {
				throw new Error('Cannot terminate completed workflow')
			})

			const req = new Request(
				'http://localhost/api/workflows/marketing-journey/completed-instance/cancel',
				{
					method: 'POST',
					headers: { Authorization: `Bearer ${mockInternalToken}` },
				},
			)

			const res = await worker.fetch(req, workerEnv)
			expect(res.status).toBe(500)
			const data = (await res.json()) as { error: string; message: string }
			expect(data.error).toBe('Failed to terminate workflow instance')
			expect(data.message).toContain('Cannot terminate')
		})
	})

	// =========================================================================
	// SECTION 4: DATA RESIDENCY & REGIONAL ROUTING ADVERSARIAL VERIFICATION
	// =========================================================================
	describe('4. Regional Data Residency & Routing', () => {
		it('routes to KSA tenant-api default when dataRegion is KSA and tenantApiUrl is omitted', async () => {
			const fetchMock = vi
				.fn()
				.mockImplementation(async (url: string | URL | Request) => {
					const urlStr = url.toString()
					if (
						urlStr.includes('/api/journeys/execute-step') ||
						urlStr.includes('/api/journeys/complete-run')
					) {
						return new Response(JSON.stringify({ success: true }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						})
					}
					return new Response('Not Found', { status: 404 })
				})
			globalThis.fetch = fetchMock

			const workflow = createWorkflowInstance(workflowEnv)
			const result = await workflow.run(
				{
					payload: {
						orgId: 'org_riyadh',
						journeyId: 'jny_riyadh',
						runId: 'run_ksa_001',
						customerId: 'cust_ksa_001',
						dataRegion: 'ksa',
						graph: {
							nodes: [
								{ id: 't1', type: 'trigger', data: {} },
								{
									id: 'act1',
									type: 'action_sms',
									data: { messageText: 'KSA SMS' },
								},
							],
							edges: [{ id: 'e1', source: 't1', target: 'act1' }],
						},
					},
				} as any,
				mockStep as any,
			)

			expect(result.status).toBe('completed')
			const stepCall = fetchMock.mock.calls.find((c) =>
				c[0].toString().includes('/api/journeys/execute-step'),
			)
			expect(stepCall![0].toString()).toBe(
				'http://localhost:3009/api/journeys/execute-step',
			)
		})

		it('routes to US tenant-api default when dataRegion is US or omitted', async () => {
			const fetchMock = vi
				.fn()
				.mockImplementation(async (url: string | URL | Request) => {
					const urlStr = url.toString()
					if (
						urlStr.includes('/api/journeys/execute-step') ||
						urlStr.includes('/api/journeys/complete-run')
					) {
						return new Response(JSON.stringify({ success: true }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						})
					}
					return new Response('Not Found', { status: 404 })
				})
			globalThis.fetch = fetchMock

			const workflow = createWorkflowInstance(workflowEnv)
			const result = await workflow.run(
				{
					payload: {
						orgId: 'org_ashburn',
						journeyId: 'jny_ashburn',
						runId: 'run_us_001',
						customerId: 'cust_us_001',
						dataRegion: 'us',
						graph: {
							nodes: [
								{ id: 't1', type: 'trigger', data: {} },
								{
									id: 'act1',
									type: 'action_email',
									data: { subject: 'US Email' },
								},
							],
							edges: [{ id: 'e1', source: 't1', target: 'act1' }],
						},
					},
				} as any,
				mockStep as any,
			)

			expect(result.status).toBe('completed')
			const stepCall = fetchMock.mock.calls.find((c) =>
				c[0].toString().includes('/api/journeys/execute-step'),
			)
			expect(stepCall![0].toString()).toBe(
				'http://localhost:3007/api/journeys/execute-step',
			)
		})
	})
})

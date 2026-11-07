import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
	ACTION_STEP_RETRIES,
	MarketingJourneyWorkflow,
} from './marketing-journey-workflow'
import type {
	MarketingJourneyWorkflowEnv,
	MarketingJourneyWorkflowParams,
} from './types'

describe('MarketingJourneyWorkflow', () => {
	let env: MarketingJourneyWorkflowEnv
	let mockStep: {
		do: any
		sleep: any
	}
	const originalFetch = globalThis.fetch

	beforeEach(() => {
		env = {
			INTERNAL_COMMAND_TOKEN: 'internal-command-token-secret-123',
			TENANT_API_URL: 'http://localhost:3007',
			TENANT_API_URL_KSA: 'http://localhost:3009',
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

	it('executes a linear flow (Trigger -> Action Email -> Complete) with Zero-PII contract', async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(
				async (url: string | URL | Request, init?: RequestInit) => {
					const urlStr = url.toString()
					if (urlStr.includes('/api/journeys/execute-step')) {
						return new Response(
							JSON.stringify({
								success: true,
								executionId: 'exec_email_001',
								status: 'delivered',
								messageId: 'msg_email_001',
							}),
							{ status: 200, headers: { 'Content-Type': 'application/json' } },
						)
					}
					if (urlStr.includes('/api/journeys/complete-run')) {
						return new Response(
							JSON.stringify({
								success: true,
								runId: 'run_123',
								status: 'completed',
							}),
							{ status: 200, headers: { 'Content-Type': 'application/json' } },
						)
					}
					return new Response('Not Found', { status: 404 })
				},
			)
		globalThis.fetch = fetchMock

		const workflow = createWorkflowInstance(env)
		const params: MarketingJourneyWorkflowParams = {
			orgId: 'org_550e8400-e29b-41d4-a716-446655440000',
			journeyId: 'jny_7c9e6679-7425-40de-944b-e07fc1f90ae7',
			runId: 'run_9f8e7d6c-5b4a-3210-fedc-ba9876543210',
			customerId: 'cust_6ba7b810-9dad-11d1-80b4-00c04fd430c8',
			tenantApiUrl: 'http://localhost:3007',
			triggerEvent: 'phone_verified',
			graph: {
				nodes: [
					{
						id: 'node_trig_1',
						type: 'trigger',
						data: { triggerType: 'phone_verified' },
					},
					{
						id: 'node_email_1',
						type: 'action_email',
						data: {
							subject: 'Welcome {{name}}!',
							bodyHtml: '<p>Hello {{firstName}}, welcome to our platform.</p>',
						},
					},
				],
				edges: [
					{
						id: 'edge_1',
						source: 'node_trig_1',
						target: 'node_email_1',
					},
				],
			},
		}

		const event = { payload: params } as any
		const result = await workflow.run(event, mockStep as any)

		expect(result).toEqual({ status: 'completed', executedSteps: 2 })

		// 1. Verify Trigger step executed
		expect(mockStep.do).toHaveBeenCalledWith(
			'step-node_trig_1-trigger',
			expect.any(Function),
		)

		// 2. Verify Action Email step executed with retry options
		expect(mockStep.do).toHaveBeenCalledWith(
			'action-node_email_1',
			{
				retries: ACTION_STEP_RETRIES,
				timeout: '2 minutes',
			},
			expect.any(Function),
		)

		// 3. Verify Zero-PII contract in execute-step HTTP payload
		const executeStepCall = fetchMock.mock.calls.find((call) =>
			call[0].toString().includes('/api/journeys/execute-step'),
		)
		expect(executeStepCall).toBeDefined()
		const executeHeaders = executeStepCall![1]?.headers as Record<
			string,
			string
		>
		expect(executeHeaders.Authorization).toBe(
			`Bearer ${env.INTERNAL_COMMAND_TOKEN}`,
		)

		const executeBody = JSON.parse(executeStepCall![1]?.body as string)
		expect(executeBody).toEqual({
			orgId: 'org_550e8400-e29b-41d4-a716-446655440000',
			journeyId: 'jny_7c9e6679-7425-40de-944b-e07fc1f90ae7',
			runId: 'run_9f8e7d6c-5b4a-3210-fedc-ba9876543210',
			customerId: 'cust_6ba7b810-9dad-11d1-80b4-00c04fd430c8',
			nodeId: 'node_email_1',
			nodeType: 'action_email',
			config: {
				subject: 'Welcome {{name}}!',
				bodyHtml: '<p>Hello {{firstName}}, welcome to our platform.</p>',
			},
		})

		// Strictly assert NO customer PII in body keys
		const bodyKeys = Object.keys(executeBody)
		expect(bodyKeys).not.toContain('name')
		expect(bodyKeys).not.toContain('email')
		expect(bodyKeys).not.toContain('phone')
		expect(bodyKeys).not.toContain('address')

		// 4. Verify Complete Run step executed
		expect(mockStep.do).toHaveBeenCalledWith(
			'complete-run_9f8e7d6c-5b4a-3210-fedc-ba9876543210',
			expect.any(Function),
		)
	})

	it('executes durable delays via step.sleep() with formatted duration strings', async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = url.toString()
				if (urlStr.includes('/api/journeys/execute-step')) {
					return new Response(
						JSON.stringify({
							success: true,
							executionId: 'exec_sms_001',
							status: 'delivered',
						}),
						{ status: 200, headers: { 'Content-Type': 'application/json' } },
					)
				}
				if (urlStr.includes('/api/journeys/complete-run')) {
					return new Response(JSON.stringify({ success: true }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					})
				}
				return new Response('Not Found', { status: 404 })
			})
		globalThis.fetch = fetchMock

		const workflow = createWorkflowInstance(env)
		const params: MarketingJourneyWorkflowParams = {
			orgId: 'org_test',
			journeyId: 'jny_test',
			runId: 'run_test_delay',
			customerId: 'cust_test',
			graph: {
				nodes: [
					{
						id: 'node_trigger',
						type: 'trigger',
						data: { triggerType: 'phone_verified' },
					},
					{
						id: 'node_delay_1',
						type: 'delay',
						data: { duration: 3, unit: 'days' },
					},
					{
						id: 'node_sms_1',
						type: 'action_sms',
						data: { messageText: 'Your offer expires soon!' },
					},
				],
				edges: [
					{ id: 'e1', source: 'node_trigger', target: 'node_delay_1' },
					{ id: 'e2', source: 'node_delay_1', target: 'node_sms_1' },
				],
			},
		}

		const result = await workflow.run(
			{ payload: params } as any,
			mockStep as any,
		)

		expect(result).toEqual({ status: 'completed', executedSteps: 3 })

		// Verify step.sleep was invoked with duration string
		expect(mockStep.sleep).toHaveBeenCalledWith('delay-node_delay_1', '3 days')

		// Verify action_sms step was invoked
		expect(mockStep.do).toHaveBeenCalledWith(
			'action-node_sms_1',
			expect.any(Object),
			expect.any(Function),
		)
	})

	it('supports alternative delay data properties (delayValue, delayUnit)', async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		)
		globalThis.fetch = fetchMock

		const workflow = createWorkflowInstance(env)
		const params: MarketingJourneyWorkflowParams = {
			orgId: 'org_test',
			journeyId: 'jny_test',
			runId: 'run_test_alt_delay',
			customerId: 'cust_test',
			graph: {
				nodes: [
					{ id: 'n1', type: 'trigger', data: {} },
					{
						id: 'n2',
						type: 'delay',
						data: { delayValue: 45, delayUnit: 'minutes' },
					},
				],
				edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
			},
		}

		await workflow.run({ payload: params } as any, mockStep as any)
		expect(mockStep.sleep).toHaveBeenCalledWith('delay-n2', '45 minutes')
	})

	it('handles condition evaluation and follows matching true/false branch edges', async () => {
		let conditionReturnValue = true

		const fetchMock = vi
			.fn()
			.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = url.toString()
				if (urlStr.includes('/api/journeys/evaluate-condition')) {
					return new Response(
						JSON.stringify({ result: conditionReturnValue }),
						{ status: 200, headers: { 'Content-Type': 'application/json' } },
					)
				}
				return new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			})
		globalThis.fetch = fetchMock

		const workflow = createWorkflowInstance(env)
		const graph = {
			nodes: [
				{ id: 'node_trigger', type: 'trigger', data: {} },
				{
					id: 'node_cond',
					type: 'condition',
					data: { field: 'phoneVerified', operator: 'equals', value: 'true' },
				},
				{
					id: 'node_action_true',
					type: 'action_sms',
					data: { messageText: 'Verified SMS' },
				},
				{
					id: 'node_action_false',
					type: 'action_email',
					data: { subject: 'Please verify email' },
				},
			],
			edges: [
				{ id: 'e1', source: 'node_trigger', target: 'node_cond' },
				{
					id: 'e2',
					source: 'node_cond',
					target: 'node_action_true',
					sourceHandle: 'true',
				},
				{
					id: 'e3',
					source: 'node_cond',
					target: 'node_action_false',
					sourceHandle: 'false',
				},
			],
		}

		// 1. Test True Branch
		conditionReturnValue = true
		mockStep.do.mockClear()
		const resultTrue = await workflow.run(
			{
				payload: {
					orgId: 'org_1',
					journeyId: 'jny_1',
					runId: 'run_branch_true',
					customerId: 'cust_1',
					graph,
				},
			} as any,
			mockStep as any,
		)
		expect(resultTrue.status).toBe('completed')
		expect(mockStep.do).toHaveBeenCalledWith(
			'action-node_action_true',
			expect.any(Object),
			expect.any(Function),
		)
		expect(mockStep.do).not.toHaveBeenCalledWith(
			'action-node_action_false',
			expect.any(Object),
			expect.any(Function),
		)

		// 2. Test False Branch
		conditionReturnValue = false
		mockStep.do.mockClear()
		const resultFalse = await workflow.run(
			{
				payload: {
					orgId: 'org_1',
					journeyId: 'jny_1',
					runId: 'run_branch_false',
					customerId: 'cust_1',
					graph,
				},
			} as any,
			mockStep as any,
		)
		expect(resultFalse.status).toBe('completed')
		expect(mockStep.do).toHaveBeenCalledWith(
			'action-node_action_false',
			expect.any(Object),
			expect.any(Function),
		)
		expect(mockStep.do).not.toHaveBeenCalledWith(
			'action-node_action_true',
			expect.any(Object),
			expect.any(Function),
		)
	})

	it('routes to regional tenant-api URL based on dataRegion (KSA vs US)', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		})
		globalThis.fetch = fetchMock

		const workflow = createWorkflowInstance(env)

		// Test KSA region routing
		await workflow.run(
			{
				payload: {
					orgId: 'org_ksa_1',
					journeyId: 'jny_1',
					runId: 'run_ksa',
					customerId: 'cust_1',
					dataRegion: 'ksa',
					graph: {
						nodes: [
							{ id: 'n_trig', type: 'trigger', data: {} },
							{
								id: 'n_sms',
								type: 'action_sms',
								data: { messageText: 'KSA OTP' },
							},
						],
						edges: [{ id: 'e1', source: 'n_trig', target: 'n_sms' }],
					},
				},
			} as any,
			mockStep as any,
		)

		const ksaExecuteCall = fetchMock.mock.calls.find((c) =>
			c[0].toString().includes('/api/journeys/execute-step'),
		)
		expect(ksaExecuteCall![0].toString()).toBe(
			'http://localhost:3009/api/journeys/execute-step',
		)
	})

	it('handles execute-step failures by notifying complete-run with failed status and rethrowing', async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = url.toString()
				if (urlStr.includes('/api/journeys/execute-step')) {
					return new Response('Database timeout', { status: 500 })
				}
				return new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			})
		globalThis.fetch = fetchMock

		const workflow = createWorkflowInstance(env)
		const params: MarketingJourneyWorkflowParams = {
			orgId: 'org_err',
			journeyId: 'jny_err',
			runId: 'run_err_1',
			customerId: 'cust_err',
			graph: {
				nodes: [
					{ id: 'n1', type: 'trigger', data: {} },
					{ id: 'n2', type: 'action_email', data: { subject: 'Test' } },
				],
				edges: [{ id: 'e1', source: 'n1', target: 'n2' }],
			},
		}

		await expect(
			workflow.run({ payload: params } as any, mockStep as any),
		).rejects.toThrow('Action step execution (n2) failed with HTTP 500')

		// Verify fail notification step was recorded
		expect(mockStep.do).toHaveBeenCalledWith(
			'fail-run_err_1',
			expect.any(Function),
		)
	})

	function jsonResponse(body: unknown, status = 200) {
		return new Response(JSON.stringify(body), {
			status,
			headers: { 'Content-Type': 'application/json' },
		})
	}

	function completeRunStatuses(fetchMock: ReturnType<typeof vi.fn>) {
		return fetchMock.mock.calls
			.filter(([url]) => String(url).includes('/api/journeys/complete-run'))
			.map(([, init]) => JSON.parse(String((init as RequestInit).body)).status)
	}

	const pausedGraph = {
		nodes: [
			{ id: 'p1', type: 'trigger', data: {} },
			{ id: 'p2', type: 'action_email', data: { subject: 'First' } },
			{ id: 'p3', type: 'action_sms', data: { messageText: 'Second' } },
		],
		edges: [
			{ id: 'e1', source: 'p1', target: 'p2' },
			{ id: 'e2', source: 'p2', target: 'p3' },
		],
	}

	it('stops the run when tenant-api says the journey was paused', async () => {
		const fetchMock = vi.fn().mockImplementation(async (url: string) => {
			if (String(url).includes('/api/journeys/execute-step')) {
				return jsonResponse({ success: true, status: 'halted' })
			}
			return jsonResponse({ success: true })
		})
		globalThis.fetch = fetchMock

		const result = await createWorkflowInstance(env).run(
			{
				payload: {
					orgId: 'org_p',
					journeyId: 'jny_p',
					runId: 'run_paused',
					customerId: 'cust_p',
					graph: pausedGraph,
				},
			} as any,
			mockStep as any,
		)

		expect(result.status).toBe('cancelled')
		const executeCalls = fetchMock.mock.calls.filter(([url]) =>
			String(url).includes('/api/journeys/execute-step'),
		)
		expect(executeCalls).toHaveLength(1)
		expect(completeRunStatuses(fetchMock)).not.toContain('completed')
	})

	const conditionGraph = {
		nodes: [
			{ id: 'c1', type: 'trigger', data: {} },
			{
				id: 'c2',
				type: 'condition',
				data: { field: 'phoneVerified', operator: 'equals', value: 'true' },
			},
			{ id: 'c3', type: 'action_sms', data: { messageText: 'Yes' } },
			{ id: 'c4', type: 'action_email', data: { subject: 'No' } },
		],
		edges: [
			{ id: 'e1', source: 'c1', target: 'c2' },
			{ id: 'e2', source: 'c2', target: 'c3', sourceHandle: 'true' },
			{ id: 'e3', source: 'c2', target: 'c4', sourceHandle: 'false' },
		],
	}

	it('retries a condition step on a 5xx and never routes on an unanswered condition', async () => {
		const fetchMock = vi.fn().mockImplementation(async (url: string) => {
			if (String(url).includes('/api/journeys/evaluate-condition')) {
				return new Response('Service Unavailable', { status: 503 })
			}
			return jsonResponse({ success: true, status: 'delivered' })
		})
		globalThis.fetch = fetchMock

		// The step throws, so Workflows retries it; after the last retry the
		// run fails instead of taking the "false" branch.
		await expect(
			createWorkflowInstance(env).run(
				{
					payload: {
						orgId: 'org_c',
						journeyId: 'jny_c',
						runId: 'run_cond_503',
						customerId: 'cust_c',
						graph: conditionGraph,
					},
				} as any,
				mockStep as any,
			),
		).rejects.toThrow('HTTP 503')

		const executeCalls = fetchMock.mock.calls.filter(([url]) =>
			String(url).includes('/api/journeys/execute-step'),
		)
		expect(executeCalls).toHaveLength(0)
		expect(completeRunStatuses(fetchMock)).toEqual(['failed'])
	})

	it('stops the run when a condition step finds the journey paused', async () => {
		const fetchMock = vi.fn().mockImplementation(async (url: string) => {
			if (String(url).includes('/api/journeys/evaluate-condition')) {
				return jsonResponse({ success: true, halted: true, result: false })
			}
			return jsonResponse({ success: true, status: 'delivered' })
		})
		globalThis.fetch = fetchMock

		const result = await createWorkflowInstance(env).run(
			{
				payload: {
					orgId: 'org_c',
					journeyId: 'jny_c',
					runId: 'run_cond_paused',
					customerId: 'cust_c',
					graph: conditionGraph,
				},
			} as any,
			mockStep as any,
		)

		expect(result.status).toBe('cancelled')
		const executeCalls = fetchMock.mock.calls.filter(([url]) =>
			String(url).includes('/api/journeys/execute-step'),
		)
		expect(executeCalls).toHaveLength(0)
	})

	it('handles empty or missing graph gracefully', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		})
		globalThis.fetch = fetchMock

		const workflow = createWorkflowInstance(env)
		const result = await workflow.run(
			{
				payload: {
					orgId: 'org_empty',
					journeyId: 'jny_empty',
					runId: 'run_empty',
					customerId: 'cust_empty',
					graph: { nodes: [], edges: [] },
				},
			} as any,
			mockStep as any,
		)

		expect(result).toEqual({ status: 'completed', executedSteps: 0 })
		expect(mockStep.do).toHaveBeenCalledWith(
			'complete-run_empty',
			expect.any(Function),
		)
	})

	it('detects cycles in graph safely and prevents infinite loops', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		})
		globalThis.fetch = fetchMock

		const workflow = createWorkflowInstance(env)
		// Cyclic graph: Trigger -> Delay A -> Delay B -> Delay A
		const result = await workflow.run(
			{
				payload: {
					orgId: 'org_cycle',
					journeyId: 'jny_cycle',
					runId: 'run_cycle',
					customerId: 'cust_cycle',
					graph: {
						nodes: [
							{ id: 'trig', type: 'trigger', data: {} },
							{
								id: 'delay_a',
								type: 'delay',
								data: { duration: 1, unit: 'minutes' },
							},
							{
								id: 'delay_b',
								type: 'delay',
								data: { duration: 1, unit: 'minutes' },
							},
						],
						edges: [
							{ id: 'e1', source: 'trig', target: 'delay_a' },
							{ id: 'e2', source: 'delay_a', target: 'delay_b' },
							{ id: 'e3', source: 'delay_b', target: 'delay_a' },
						],
					},
				},
			} as any,
			mockStep as any,
		)

		expect(result.status).toBe('completed')
		expect(result.executedSteps).toBe(3)
	})

	it('executes a complex multi-step journey (Trigger -> Delay -> Email -> Delay -> SMS -> Complete)', async () => {
		const executedNodes: string[] = []
		const fetchMock = vi
			.fn()
			.mockImplementation(
				async (url: string | URL | Request, init?: RequestInit) => {
					const urlStr = url.toString()
					if (urlStr.includes('/api/journeys/execute-step')) {
						const body = JSON.parse(init?.body as string)
						executedNodes.push(body.nodeId)
						return new Response(
							JSON.stringify({
								success: true,
								executionId: `exec_${body.nodeId}`,
								status: 'delivered',
							}),
							{ status: 200, headers: { 'Content-Type': 'application/json' } },
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
		globalThis.fetch = fetchMock

		const workflow = createWorkflowInstance(env)
		const params: MarketingJourneyWorkflowParams = {
			orgId: 'org_multi',
			journeyId: 'jny_multi',
			runId: 'run_multi_123',
			customerId: 'cust_multi_456',
			tenantApiUrl: 'http://localhost:3007',
			graph: {
				nodes: [
					{
						id: 'node_trig',
						type: 'trigger',
						data: { triggerType: 'phone_verified' },
					},
					{
						id: 'node_del_1',
						type: 'delay',
						data: { duration: 2, unit: 'hours' },
					},
					{
						id: 'node_email_1',
						type: 'action_email',
						data: { subject: 'Welcome!', bodyHtml: '<p>Hi</p>' },
					},
					{
						id: 'node_del_2',
						type: 'delay',
						data: { duration: 1, unit: 'weeks' },
					},
					{
						id: 'node_sms_1',
						type: 'action_sms',
						data: { messageText: 'Follow-up SMS' },
					},
				],
				edges: [
					{ id: 'e1', source: 'node_trig', target: 'node_del_1' },
					{ id: 'e2', source: 'node_del_1', target: 'node_email_1' },
					{ id: 'e3', source: 'node_email_1', target: 'node_del_2' },
					{ id: 'e4', source: 'node_del_2', target: 'node_sms_1' },
				],
			},
		}

		const result = await workflow.run(
			{ payload: params } as any,
			mockStep as any,
		)

		expect(result).toEqual({ status: 'completed', executedSteps: 5 })
		expect(mockStep.sleep).toHaveBeenCalledWith('delay-node_del_1', '2 hours')
		expect(mockStep.sleep).toHaveBeenCalledWith('delay-node_del_2', '1 weeks')
		expect(executedNodes).toEqual(['node_email_1', 'node_sms_1'])
	})

	it('parses graph provided as a JSON string and starts from in-degree 0 node if no trigger node exists', async () => {
		const fetchMock = vi.fn().mockImplementation(async () => {
			return new Response(JSON.stringify({ success: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			})
		})
		globalThis.fetch = fetchMock

		const workflow = createWorkflowInstance(env)
		const stringGraph = JSON.stringify({
			nodes: [
				{
					id: 'node_start',
					type: 'action',
					data: { channel: 'sms', messageText: 'Direct SMS' },
				},
				{
					id: 'node_next',
					type: 'action',
					data: {
						channel: 'email',
						subject: 'Direct Email',
						bodyHtml: '<p>Direct</p>',
					},
				},
			],
			edges: [{ id: 'e1', source: 'node_start', target: 'node_next' }],
		})

		const result = await workflow.run(
			{
				payload: {
					orgId: 'org_str',
					journeyId: 'jny_str',
					runId: 'run_str',
					customerId: 'cust_str',
					graph: stringGraph as any,
				},
			} as any,
			mockStep as any,
		)

		expect(result).toEqual({ status: 'completed', executedSteps: 2 })
	})

	it('handles non-200 complete-run responses without failing the workflow return value', async () => {
		const fetchMock = vi
			.fn()
			.mockImplementation(async (url: string | URL | Request) => {
				const urlStr = url.toString()
				if (urlStr.includes('/api/journeys/complete-run')) {
					return new Response('Complete run endpoint temporary error', {
						status: 502,
					})
				}
				return new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			})
		globalThis.fetch = fetchMock

		const workflow = createWorkflowInstance(env)
		const result = await workflow.run(
			{
				payload: {
					orgId: 'org_ok',
					journeyId: 'jny_ok',
					runId: 'run_ok',
					customerId: 'cust_ok',
					graph: {
						nodes: [{ id: 'n1', type: 'trigger', data: {} }],
						edges: [],
					},
				},
			} as any,
			mockStep as any,
		)

		expect(result).toEqual({ status: 'completed', executedSteps: 1 })
	})

	it('keeps retrying an action step for longer than tenant-api holds its processing lease', () => {
		// tenant-api: JOURNEY_PROCESSING_LEASE_MS. While it holds, execute-step
		// answers 409; only after it expires can a crashed attempt be reclaimed.
		const leaseMs = 5 * 60 * 1000
		const [amount, unit] = ACTION_STEP_RETRIES.delay.split(' ')
		const firstDelayMs =
			Number(amount) * (unit!.startsWith('minute') ? 60_000 : 1000)
		let spanMs = 0
		for (let attempt = 0; attempt < ACTION_STEP_RETRIES.limit; attempt++) {
			spanMs +=
				ACTION_STEP_RETRIES.backoff === 'exponential'
					? firstDelayMs * 2 ** attempt
					: firstDelayMs
		}
		expect(spanMs).toBeGreaterThan(leaseMs)
	})
})

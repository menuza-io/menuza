import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { MarketingJourneyWorkflow } from './marketing-journey-workflow'
import type {
	MarketingJourneyWorkflowEnv,
	MarketingJourneyWorkflowParams,
	WorkflowGraph,
} from './types'

describe('MarketingJourneyWorkflow — Adversarial Stress & Resilience Suite', () => {
	let env: MarketingJourneyWorkflowEnv
	let mockStep: {
		do: any
		sleep: any
	}
	const originalFetch = globalThis.fetch

	beforeEach(() => {
		env = {
			INTERNAL_COMMAND_TOKEN: 'test-internal-token-secret-xyz',
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

	// =========================================================================
	// 1. Complex Graphs & Multi-Branch Conditions
	// =========================================================================
	describe('1. Complex Graphs & Multi-Branch Conditions', () => {
		it('evaluates nested multi-tier condition decision trees accurately', async () => {
			const executedActions: string[] = []

			const fetchMock = vi
				.fn()
				.mockImplementation(
					async (url: string | URL | Request, init?: RequestInit) => {
						const urlStr = url.toString()
						if (urlStr.includes('/api/journeys/evaluate-condition')) {
							const body = JSON.parse(init?.body as string)
							if (body.nodeId === 'cond_vip') {
								return new Response(JSON.stringify({ result: true }), {
									status: 200,
									headers: { 'Content-Type': 'application/json' },
								})
							}
							if (body.nodeId === 'cond_phone') {
								return new Response(JSON.stringify({ result: false }), {
									status: 200,
									headers: { 'Content-Type': 'application/json' },
								})
							}
						}
						if (urlStr.includes('/api/journeys/execute-step')) {
							const body = JSON.parse(init?.body as string)
							executedActions.push(body.nodeId)
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
					},
				)
			globalThis.fetch = fetchMock

			const graph: WorkflowGraph = {
				nodes: [
					{ id: 'trig', type: 'trigger', data: {} },
					{
						id: 'cond_vip',
						type: 'condition',
						data: { field: 'isVip', operator: 'equals', value: 'true' },
					},
					{
						id: 'cond_phone',
						type: 'condition',
						data: { field: 'hasPhone', operator: 'equals', value: 'true' },
					},
					{
						id: 'act_vip_sms',
						type: 'action_sms',
						data: { messageText: 'VIP SMS' },
					},
					{
						id: 'act_vip_email',
						type: 'action_email',
						data: { subject: 'VIP Email' },
					},
					{
						id: 'act_std_email',
						type: 'action_email',
						data: { subject: 'Standard Email' },
					},
				],
				edges: [
					{ id: 'e1', source: 'trig', target: 'cond_vip' },
					{
						id: 'e2',
						source: 'cond_vip',
						target: 'cond_phone',
						sourceHandle: 'true',
					},
					{
						id: 'e3',
						source: 'cond_vip',
						target: 'act_std_email',
						sourceHandle: 'false',
					},
					{
						id: 'e4',
						source: 'cond_phone',
						target: 'act_vip_sms',
						sourceHandle: 'true',
					},
					{
						id: 'e5',
						source: 'cond_phone',
						target: 'act_vip_email',
						sourceHandle: 'false',
					},
				],
			}

			const workflow = createWorkflowInstance(env)
			const result = await workflow.run(
				{
					payload: {
						orgId: 'org_tree',
						journeyId: 'jny_tree',
						runId: 'run_tree',
						customerId: 'cust_tree',
						graph,
					},
				} as any,
				mockStep as any,
			)

			expect(result.status).toBe('completed')
			expect(executedActions).toEqual(['act_vip_email'])
			expect(executedActions).not.toContain('act_vip_sms')
			expect(executedActions).not.toContain('act_std_email')
		})

		it('supports diverse handle casing and aliases (yes/no, 1/0, success/failure, uppercase)', async () => {
			const handleTests = [
				{ handle: 'YES', expectedResult: true, target: 'act_yes' },
				{ handle: 'no', expectedResult: false, target: 'act_no' },
				{ handle: '1', expectedResult: true, target: 'act_yes' },
				{ handle: '0', expectedResult: false, target: 'act_no' },
				{ handle: 'SUCCESS', expectedResult: true, target: 'act_yes' },
				{ handle: 'failure', expectedResult: false, target: 'act_no' },
			]

			for (const testCase of handleTests) {
				const executedActions: string[] = []
				const fetchMock = vi
					.fn()
					.mockImplementation(
						async (url: string | URL | Request, init?: RequestInit) => {
							const urlStr = url.toString()
							if (urlStr.includes('/api/journeys/evaluate-condition')) {
								return new Response(
									JSON.stringify({ result: testCase.expectedResult }),
									{
										status: 200,
										headers: { 'Content-Type': 'application/json' },
									},
								)
							}
							if (urlStr.includes('/api/journeys/execute-step')) {
								const body = JSON.parse(init?.body as string)
								executedActions.push(body.nodeId)
								return new Response(JSON.stringify({ success: true }), {
									status: 200,
									headers: { 'Content-Type': 'application/json' },
								})
							}
							return new Response(JSON.stringify({ success: true }), {
								status: 200,
								headers: { 'Content-Type': 'application/json' },
							})
						},
					)
				globalThis.fetch = fetchMock

				const graph: WorkflowGraph = {
					nodes: [
						{ id: 'trig', type: 'trigger', data: {} },
						{
							id: 'cond',
							type: 'condition',
							data: { field: 'f', operator: 'equals', value: 'v' },
						},
						{ id: 'act_yes', type: 'action_email', data: { subject: 'Yes' } },
						{ id: 'act_no', type: 'action_sms', data: { messageText: 'No' } },
					],
					edges: [
						{ id: 'e1', source: 'trig', target: 'cond' },
						{
							id: 'e2',
							source: 'cond',
							target: 'act_yes',
							sourceHandle: testCase.expectedResult ? testCase.handle : 'true',
						},
						{
							id: 'e3',
							source: 'cond',
							target: 'act_no',
							sourceHandle: !testCase.expectedResult
								? testCase.handle
								: 'false',
						},
					],
				}

				const workflow = createWorkflowInstance(env)
				const result = await workflow.run(
					{
						payload: {
							orgId: 'org_alias',
							journeyId: 'jny_alias',
							runId: `run_${testCase.handle}`,
							customerId: 'cust_alias',
							graph,
						},
					} as any,
					mockStep as any,
				)

				expect(result.status).toBe('completed')
				expect(executedActions).toContain(testCase.target)
			}
		})

		it('fails the run instead of routing when condition evaluation keeps failing', async () => {
			const fetchMock = vi
				.fn()
				.mockImplementation(async (url: string | URL | Request) => {
					const urlStr = url.toString()
					if (urlStr.includes('/api/journeys/evaluate-condition')) {
						return new Response('Internal error', { status: 500 })
					}
					return new Response(JSON.stringify({ success: true }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					})
				})
			globalThis.fetch = fetchMock

			const graph: WorkflowGraph = {
				nodes: [
					{ id: 'trig', type: 'trigger', data: {} },
					{ id: 'cond', type: 'condition', data: {} },
					{
						id: 'act_true',
						type: 'action_email',
						data: { subject: 'True Action' },
					},
					{
						id: 'act_false',
						type: 'action_sms',
						data: { messageText: 'False Action' },
					},
				],
				edges: [
					{ id: 'e1', source: 'trig', target: 'cond' },
					{
						id: 'e2',
						source: 'cond',
						target: 'act_true',
						sourceHandle: 'true',
					},
					{
						id: 'e3',
						source: 'cond',
						target: 'act_false',
						sourceHandle: 'false',
					},
				],
			}

			// A 500 throws inside the step so Workflows retries it. Once the
			// retries run out the run fails: neither branch was evaluated, so
			// neither may run.
			const workflow = createWorkflowInstance(env)
			await expect(
				workflow.run(
					{
						payload: {
							orgId: 'org_fallback',
							journeyId: 'jny_fallback',
							runId: 'run_fallback',
							customerId: 'cust_fallback',
							graph,
						},
					} as any,
					mockStep as any,
				),
			).rejects.toThrow('HTTP 500')

			expect(mockStep.do).not.toHaveBeenCalledWith(
				'action-act_false',
				expect.any(Object),
				expect.any(Function),
			)
			expect(mockStep.do).not.toHaveBeenCalledWith(
				'action-act_true',
				expect.any(Object),
				expect.any(Function),
			)
		})
	})

	// =========================================================================
	// 2. Deep DAGs and Step Limits
	// =========================================================================
	describe('2. Deep DAGs and Step Limits', () => {
		it('executes a deep DAG with 50 sequential nodes without stack overflow or memory leaks', async () => {
			const nodeCount = 50
			const nodes = [{ id: 'node_0', type: 'trigger', data: {} }]
			const edges = []

			for (let i = 1; i < nodeCount; i++) {
				const isDelay = i % 2 === 1
				nodes.push({
					id: `node_${i}`,
					type: isDelay ? 'delay' : 'action_email',
					data: isDelay
						? { duration: 5, unit: 'minutes' }
						: { subject: `Step ${i}` },
				})
				edges.push({
					id: `edge_${i}`,
					source: `node_${i - 1}`,
					target: `node_${i}`,
				})
			}

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
						orgId: 'org_deep',
						journeyId: 'jny_deep',
						runId: 'run_deep_50',
						customerId: 'cust_deep',
						graph: { nodes, edges },
					},
				} as any,
				mockStep as any,
			)

			expect(result.status).toBe('completed')
			expect(result.executedSteps).toBe(50)
		})

		it('safely bounds execution at maxSteps (500) if graph exceeds maximum limit', async () => {
			// Generate a chain of 600 nodes
			const nodeCount = 600
			const nodes = [{ id: 'node_0', type: 'trigger', data: {} }]
			const edges = []

			for (let i = 1; i < nodeCount; i++) {
				nodes.push({
					id: `node_${i}`,
					type: 'delay',
					data: { duration: 1, unit: 'minutes' },
				})
				edges.push({
					id: `edge_${i}`,
					source: `node_${i - 1}`,
					target: `node_${i}`,
				})
			}

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
						orgId: 'org_max',
						journeyId: 'jny_max',
						runId: 'run_max_600',
						customerId: 'cust_max',
						graph: { nodes, edges },
					},
				} as any,
				mockStep as any,
			)

			// Should safely cap at 500 steps and complete
			expect(result.status).toBe('completed')
			expect(result.executedSteps).toBe(500)
		})
	})

	// =========================================================================
	// 3. Disconnected Nodes and Orphan Elements
	// =========================================================================
	describe('3. Disconnected Nodes & Complex Topologies', () => {
		it('safely traverses only connected components and ignores orphan/floating nodes', async () => {
			const executedNodes: string[] = []
			const fetchMock = vi
				.fn()
				.mockImplementation(
					async (url: string | URL | Request, init?: RequestInit) => {
						const urlStr = url.toString()
						if (urlStr.includes('/api/journeys/execute-step')) {
							const body = JSON.parse(init?.body as string)
							executedNodes.push(body.nodeId)
						}
						return new Response(JSON.stringify({ success: true }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						})
					},
				)
			globalThis.fetch = fetchMock

			const graph: WorkflowGraph = {
				nodes: [
					{ id: 'trig', type: 'trigger', data: {} },
					{
						id: 'connected_email',
						type: 'action_email',
						data: { subject: 'Active' },
					},
					// Orphan nodes disconnected from trigger
					{
						id: 'orphan_1',
						type: 'action_sms',
						data: { messageText: 'Orphan 1' },
					},
					{
						id: 'orphan_2',
						type: 'delay',
						data: { duration: 10, unit: 'days' },
					},
					{
						id: 'orphan_3',
						type: 'action_email',
						data: { subject: 'Orphan 3' },
					},
				],
				edges: [
					{ id: 'e1', source: 'trig', target: 'connected_email' },
					{ id: 'orphan_edge', source: 'orphan_1', target: 'orphan_2' },
				],
			}

			const workflow = createWorkflowInstance(env)
			const result = await workflow.run(
				{
					payload: {
						orgId: 'org_orphan',
						journeyId: 'jny_orphan',
						runId: 'run_orphan',
						customerId: 'cust_orphan',
						graph,
					},
				} as any,
				mockStep as any,
			)

			expect(result.status).toBe('completed')
			expect(result.executedSteps).toBe(2)
			expect(executedNodes).toEqual(['connected_email'])
			expect(executedNodes).not.toContain('orphan_1')
			expect(executedNodes).not.toContain('orphan_3')
		})

		it('picks the in-degree 0 node when trigger node is missing', async () => {
			const executedNodes: string[] = []
			const fetchMock = vi
				.fn()
				.mockImplementation(
					async (url: string | URL | Request, init?: RequestInit) => {
						const urlStr = url.toString()
						if (urlStr.includes('/api/journeys/execute-step')) {
							const body = JSON.parse(init?.body as string)
							executedNodes.push(body.nodeId)
						}
						return new Response(JSON.stringify({ success: true }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						})
					},
				)
			globalThis.fetch = fetchMock

			const graph: WorkflowGraph = {
				nodes: [
					{
						id: 'step_first',
						type: 'action_email',
						data: { subject: 'First' },
					},
					{
						id: 'step_second',
						type: 'action_sms',
						data: { messageText: 'Second' },
					},
				],
				edges: [{ id: 'e1', source: 'step_first', target: 'step_second' }],
			}

			const workflow = createWorkflowInstance(env)
			const result = await workflow.run(
				{
					payload: {
						orgId: 'org_no_trig',
						journeyId: 'jny_no_trig',
						runId: 'run_no_trig',
						customerId: 'cust_no_trig',
						graph,
					},
				} as any,
				mockStep as any,
			)

			expect(result.status).toBe('completed')
			expect(result.executedSteps).toBe(2)
			expect(executedNodes).toEqual(['step_first', 'step_second'])
		})
	})

	// =========================================================================
	// 4. Cycles and Infinite Loop Resilience
	// =========================================================================
	describe('4. Cycles and Infinite Loop Resilience', () => {
		it('terminates immediately on single node self-loop (Node -> Node)', async () => {
			const fetchMock = vi.fn().mockImplementation(async () => {
				return new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			})
			globalThis.fetch = fetchMock

			const graph: WorkflowGraph = {
				nodes: [{ id: 'self_loop_node', type: 'trigger', data: {} }],
				edges: [
					{ id: 'e_self', source: 'self_loop_node', target: 'self_loop_node' },
				],
			}

			const workflow = createWorkflowInstance(env)
			const result = await workflow.run(
				{
					payload: {
						orgId: 'org_self',
						journeyId: 'jny_self',
						runId: 'run_self',
						customerId: 'cust_self',
						graph,
					},
				} as any,
				mockStep as any,
			)

			expect(result.status).toBe('completed')
			expect(result.executedSteps).toBe(1)
		})

		it('terminates cleanly on long cyclic graph (A -> B -> C -> D -> B)', async () => {
			const fetchMock = vi.fn().mockImplementation(async () => {
				return new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			})
			globalThis.fetch = fetchMock

			const graph: WorkflowGraph = {
				nodes: [
					{ id: 'node_A', type: 'trigger', data: {} },
					{
						id: 'node_B',
						type: 'delay',
						data: { duration: 1, unit: 'minutes' },
					},
					{ id: 'node_C', type: 'action_email', data: { subject: 'C' } },
					{ id: 'node_D', type: 'delay', data: { duration: 2, unit: 'hours' } },
				],
				edges: [
					{ id: 'e1', source: 'node_A', target: 'node_B' },
					{ id: 'e2', source: 'node_B', target: 'node_C' },
					{ id: 'e3', source: 'node_C', target: 'node_D' },
					{ id: 'e4', source: 'node_D', target: 'node_B' }, // Cycle back to B
				],
			}

			const workflow = createWorkflowInstance(env)
			const result = await workflow.run(
				{
					payload: {
						orgId: 'org_long_cycle',
						journeyId: 'jny_long_cycle',
						runId: 'run_long_cycle',
						customerId: 'cust_long_cycle',
						graph,
					},
				} as any,
				mockStep as any,
			)

			expect(result.status).toBe('completed')
			expect(result.executedSteps).toBe(4) // A, B, C, D executed once each
		})
	})

	// =========================================================================
	// 5. Delay Units Formatting & Edge Cases
	// =========================================================================
	describe('5. Delay Units & Sleep Durations', () => {
		it.each([
			{ duration: 15, unit: 'minutes', expected: '15 minutes' },
			{ duration: 24, unit: 'hours', expected: '24 hours' },
			{ duration: 7, unit: 'days', expected: '7 days' },
			{ duration: 4, unit: 'weeks', expected: '4 weeks' },
			{ duration: 0, unit: 'minutes', expected: '0 minutes' },
		])(
			'formats duration correctly for $duration $unit',
			async ({ duration, unit, expected }) => {
				const fetchMock = vi.fn().mockImplementation(async () => {
					return new Response(JSON.stringify({ success: true }), {
						status: 200,
						headers: { 'Content-Type': 'application/json' },
					})
				})
				globalThis.fetch = fetchMock

				const graph: WorkflowGraph = {
					nodes: [
						{ id: 'trig', type: 'trigger', data: {} },
						{
							id: 'delay_test',
							type: 'delay',
							data: { duration, unit } as any,
						},
					],
					edges: [{ id: 'e1', source: 'trig', target: 'delay_test' }],
				}

				const workflow = createWorkflowInstance(env)
				await workflow.run(
					{
						payload: {
							orgId: 'org_del',
							journeyId: 'jny_del',
							runId: `run_del_${unit}`,
							customerId: 'cust_del',
							graph,
						},
					} as any,
					mockStep as any,
				)

				expect(mockStep.sleep).toHaveBeenCalledWith(
					'delay-delay_test',
					expected,
				)
			},
		)

		it('defaults to 1 minutes when delay data is empty or missing properties', async () => {
			const fetchMock = vi.fn().mockImplementation(async () => {
				return new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			})
			globalThis.fetch = fetchMock

			const graph: WorkflowGraph = {
				nodes: [
					{ id: 'trig', type: 'trigger', data: {} },
					{ id: 'empty_delay', type: 'delay', data: {} },
				],
				edges: [{ id: 'e1', source: 'trig', target: 'empty_delay' }],
			}

			const workflow = createWorkflowInstance(env)
			await workflow.run(
				{
					payload: {
						orgId: 'org_del_empty',
						journeyId: 'jny_del_empty',
						runId: 'run_del_empty',
						customerId: 'cust_del_empty',
						graph,
					},
				} as any,
				mockStep as any,
			)

			expect(mockStep.sleep).toHaveBeenCalledWith(
				'delay-empty_delay',
				'1 minutes',
			)
		})
	})

	// =========================================================================
	// 6. Malformed & Non-Standard Graph Inputs
	// =========================================================================
	describe('6. Malformed & Robustness Scenarios', () => {
		it.each([
			{ name: 'null graph', graph: null },
			{ name: 'undefined graph', graph: undefined },
			{ name: 'empty string graph', graph: '' },
			{ name: 'invalid JSON string', graph: '{ broken json:' },
			{ name: 'empty object graph', graph: {} as any },
			{
				name: 'graph with null nodes array',
				graph: { nodes: null, edges: null } as any,
			},
			{
				name: 'graph with string nodes property',
				graph: { nodes: 'invalid', edges: 123 } as any,
			},
		])(
			'handles $name without crashing or throwing unhandled errors',
			async ({ graph }) => {
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
							orgId: 'org_malformed',
							journeyId: 'jny_malformed',
							runId: 'run_malformed',
							customerId: 'cust_malformed',
							graph: graph as any,
						},
					} as any,
					mockStep as any,
				)

				expect(result.status).toBe('completed')
				expect(result.executedSteps).toBe(0)
			},
		)

		it('handles unknown or future node types without throwing', async () => {
			const fetchMock = vi.fn().mockImplementation(async () => {
				return new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			})
			globalThis.fetch = fetchMock

			const graph: WorkflowGraph = {
				nodes: [
					{ id: 'trig', type: 'trigger', data: {} },
					{
						id: 'custom_ai_node',
						type: 'future_ai_action',
						data: { model: 'gpt-5' },
					},
					{
						id: 'final_email',
						type: 'action_email',
						data: { subject: 'Done' },
					},
				],
				edges: [
					{ id: 'e1', source: 'trig', target: 'custom_ai_node' },
					{ id: 'e2', source: 'custom_ai_node', target: 'final_email' },
				],
			}

			const workflow = createWorkflowInstance(env)
			const result = await workflow.run(
				{
					payload: {
						orgId: 'org_unknown_type',
						journeyId: 'jny_unknown_type',
						runId: 'run_unknown_type',
						customerId: 'cust_unknown_type',
						graph,
					},
				} as any,
				mockStep as any,
			)

			expect(result.status).toBe('completed')
			expect(result.executedSteps).toBe(3)
		})

		it('handles dangling edges pointing to non-existent target nodes safely', async () => {
			const fetchMock = vi.fn().mockImplementation(async () => {
				return new Response(JSON.stringify({ success: true }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				})
			})
			globalThis.fetch = fetchMock

			const graph: WorkflowGraph = {
				nodes: [{ id: 'trig', type: 'trigger', data: {} }],
				edges: [
					{ id: 'e_dangling', source: 'trig', target: 'non_existent_node_id' },
				],
			}

			const workflow = createWorkflowInstance(env)
			const result = await workflow.run(
				{
					payload: {
						orgId: 'org_dangling',
						journeyId: 'jny_dangling',
						runId: 'run_dangling',
						customerId: 'cust_dangling',
						graph,
					},
				} as any,
				mockStep as any,
			)

			expect(result.status).toBe('completed')
			expect(result.executedSteps).toBe(1)
		})
	})

	// =========================================================================
	// 7. Security and Zero-PII Invariance
	// =========================================================================
	describe('7. Security & Zero-PII Invariance', () => {
		it('strictly guarantees no customer PII is sent to external or tenant-api endpoints', async () => {
			const capturedPayloads: any[] = []
			const fetchMock = vi
				.fn()
				.mockImplementation(
					async (url: string | URL | Request, init?: RequestInit) => {
						const urlStr = url.toString()
						if (init?.body) {
							capturedPayloads.push({
								url: urlStr,
								body: JSON.parse(init.body as string),
							})
						}
						return new Response(JSON.stringify({ success: true }), {
							status: 200,
							headers: { 'Content-Type': 'application/json' },
						})
					},
				)
			globalThis.fetch = fetchMock

			const graph: WorkflowGraph = {
				nodes: [
					{ id: 'trig', type: 'trigger', data: { triggerType: 'signup' } },
					{
						id: 'act_em',
						type: 'action_email',
						data: { subject: 'Hi {{name}}', bodyHtml: '<p>Body</p>' },
					},
					{
						id: 'act_sms',
						type: 'action_sms',
						data: { messageText: 'SMS {{phone}}' },
					},
				],
				edges: [
					{ id: 'e1', source: 'trig', target: 'act_em' },
					{ id: 'e2', source: 'act_em', target: 'act_sms' },
				],
			}

			const workflow = createWorkflowInstance(env)
			await workflow.run(
				{
					payload: {
						orgId: '550e8400-e29b-41d4-a716-446655440000',
						journeyId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
						runId: '9f8e7d6c-5b4a-3210-fedc-ba9876543210',
						customerId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
						graph,
					},
				} as any,
				mockStep as any,
			)

			// Inspect all outgoing payloads
			expect(capturedPayloads.length).toBeGreaterThan(0)
			for (const req of capturedPayloads) {
				const keys = Object.keys(req.body)
				// Ensure no PII field leaked
				expect(keys).not.toContain('email')
				expect(keys).not.toContain('phone')
				expect(keys).not.toContain('firstName')
				expect(keys).not.toContain('lastName')
				expect(keys).not.toContain('name')
				expect(keys).not.toContain('ssn')
				expect(keys).not.toContain('address')
			}
		})
	})
})

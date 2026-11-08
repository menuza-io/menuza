import { describe, it, expect } from 'vitest'
import {
	workflowGraphSchema,
	relaxedWorkflowGraphSchema,
	triggerNodeDataSchema,
	delayNodeDataSchema,
	actionEmailNodeDataSchema,
	actionSmsNodeDataSchema,
	conditionNodeDataSchema,
	createJourneySchema,
	updateJourneySchema,
	executeStepPayloadSchema,
	completeRunPayloadSchema,
	validateWorkflowDAG,
	calculateDelayMs,
	getDownstreamNodes,
	serializeWorkflowGraph,
	parseWorkflowGraph,
	interpolateMergeTagsHtml,
	type WorkflowGraph,
} from './journey.ts'

describe('Journey Zod Schemas', () => {
	it('validates trigger node data schema', () => {
		const valid = triggerNodeDataSchema.parse({
			triggerType: 'phone_verified',
			config: { tag: 'vip' },
		})
		expect(valid.triggerType).toBe('phone_verified')
		expect(valid.config).toEqual({ tag: 'vip' })

		// Default fallback
		const def = triggerNodeDataSchema.parse({})
		expect(def.triggerType).toBe('phone_verified')
	})

	it('validates delay node data schema', () => {
		const valid = delayNodeDataSchema.parse({
			duration: 2,
			unit: 'days',
		})
		expect(valid.duration).toBe(2)
		expect(valid.unit).toBe('days')

		// Rejects non-positive duration
		expect(() =>
			delayNodeDataSchema.parse({ duration: 0, unit: 'hours' }),
		).toThrow()
		expect(() =>
			delayNodeDataSchema.parse({ duration: -5, unit: 'hours' }),
		).toThrow()
	})

	it('validates email action node data schema', () => {
		const valid = actionEmailNodeDataSchema.parse({
			subject: 'Welcome {{name}}',
			bodyHtml: '<h1>Welcome!</h1>',
			bodyText: 'Welcome!',
			fromName: 'Store Team',
			template: 'onboarding',
		})
		expect(valid.subject).toBe('Welcome {{name}}')

		// Rejects missing required subject or bodyHtml
		expect(() =>
			actionEmailNodeDataSchema.parse({
				subject: '',
				bodyHtml: '<p>Hi</p>',
			}),
		).toThrow()
		expect(() =>
			actionEmailNodeDataSchema.parse({
				subject: 'Hello',
				bodyHtml: '',
			}),
		).toThrow()
	})

	it('validates SMS action node data schema', () => {
		const valid = actionSmsNodeDataSchema.parse({
			messageText: 'Your verification code is 123456',
		})
		expect(valid.messageText).toBe('Your verification code is 123456')

		// Rejects empty message
		expect(() => actionSmsNodeDataSchema.parse({ messageText: '' })).toThrow()
		// Rejects over-length message (> 1600 chars)
		expect(() =>
			actionSmsNodeDataSchema.parse({ messageText: 'a'.repeat(1601) }),
		).toThrow()
	})

	it('validates condition node data schema', () => {
		const valid = conditionNodeDataSchema.parse({
			field: 'email_verified',
			operator: 'equals',
			value: 'true',
		})
		expect(valid.field).toBe('email_verified')
		expect(valid.operator).toBe('equals')
	})

	it('validates full workflowGraphSchema on a standard linear workflow', () => {
		const graph: WorkflowGraph = {
			nodes: [
				{
					id: 'node-trigger-1',
					type: 'trigger',
					position: { x: 100, y: 100 },
					data: {
						triggerType: 'phone_verified',
						config: {},
					},
				},
				{
					id: 'node-delay-1',
					type: 'delay',
					position: { x: 100, y: 250 },
					data: {
						duration: 1,
						unit: 'hours',
					},
				},
				{
					id: 'node-email-1',
					type: 'action_email',
					position: { x: 100, y: 400 },
					data: {
						subject: 'Welcome to our platform',
						bodyHtml: '<p>Welcome!</p>',
					},
				},
			],
			edges: [
				{
					id: 'edge-1',
					source: 'node-trigger-1',
					target: 'node-delay-1',
				},
				{
					id: 'edge-2',
					source: 'node-delay-1',
					target: 'node-email-1',
				},
			],
			viewport: { x: 0, y: 0, zoom: 1 },
		}

		const parsed = workflowGraphSchema.parse(graph)
		expect(parsed.nodes).toHaveLength(3)
		expect(parsed.edges).toHaveLength(2)
	})

	it('validates API schemas (createJourney, updateJourney, executeStepPayload, completeRunPayload)', () => {
		const createInput = createJourneySchema.parse({
			name: 'New Customer Welcome Sequence',
			description: 'Onboards new signups',
			triggerType: 'phone_verified',
		})
		expect(createInput.name).toBe('New Customer Welcome Sequence')
		expect(createInput.triggerType).toBe('phone_verified')

		const updateInput = updateJourneySchema.parse({
			status: 'active',
			name: 'Updated Name',
		})
		expect(updateInput.status).toBe('active')

		const execStep = executeStepPayloadSchema.parse({
			orgId: 'org_1234567890abcdef',
			journeyId: '550e8400-e29b-41d4-a716-446655440000',
			runId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
			customerId: 'cust_001',
			nodeId: 'node-email-1',
			nodeType: 'action_email',
			config: {
				subject: 'Welcome',
				bodyHtml: '<p>Hi</p>',
			},
		})
		expect(execStep.nodeType).toBe('action_email')

		const completeRun = completeRunPayloadSchema.parse({
			orgId: 'org_1234567890abcdef',
			runId: '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
			status: 'completed',
		})
		expect(completeRun.status).toBe('completed')
	})
})

describe('DAG Validation Algorithm (validateWorkflowDAG)', () => {
	it('passes for a valid linear graph (Trigger -> Delay -> ActionEmail)', () => {
		const graph: WorkflowGraph = {
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					data: { triggerType: 'phone_verified', config: {} },
				},
				{
					id: 'delay-1',
					type: 'delay',
					data: { duration: 1, unit: 'days' },
				},
				{
					id: 'email-1',
					type: 'action_email',
					data: { subject: 'Hi', bodyHtml: '<p>Hello</p>' },
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'delay-1' },
				{ id: 'e2', source: 'delay-1', target: 'email-1' },
			],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(true)
		expect(result.errors).toHaveLength(0)
		expect(result.hasCycles).toBe(false)
		expect(result.triggerNodeId).toBe('trigger-1')
		expect(result.terminalNodeIds).toEqual(['email-1'])
		expect(result.nodeCount).toBe(3)
		expect(result.edgeCount).toBe(2)
	})

	it('passes for a branching condition graph (Trigger -> Condition -> Yes/No branches)', () => {
		const graph: WorkflowGraph = {
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					data: { triggerType: 'phone_verified', config: {} },
				},
				{
					id: 'cond-1',
					type: 'condition',
					data: { field: 'has_email', operator: 'equals', value: 'true' },
				},
				{
					id: 'email-1',
					type: 'action_email',
					data: { subject: 'Special Offer', bodyHtml: '<p>Code: 50OFF</p>' },
				},
				{
					id: 'sms-1',
					type: 'action_sms',
					data: { messageText: 'Your code is 50OFF' },
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'cond-1' },
				{
					id: 'e2',
					source: 'cond-1',
					target: 'email-1',
					sourceHandle: 'true',
				},
				{
					id: 'e3',
					source: 'cond-1',
					target: 'sms-1',
					sourceHandle: 'false',
				},
			],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(true)
		expect(result.errors).toHaveLength(0)
		expect(result.hasCycles).toBe(false)
		expect(result.terminalNodeIds).toContain('email-1')
		expect(result.terminalNodeIds).toContain('sms-1')
	})

	it('detects self-loop cycle (Node A -> Node A)', () => {
		const graph = {
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					data: { triggerType: 'phone_verified' },
				},
				{
					id: 'delay-1',
					type: 'delay',
					data: { duration: 1, unit: 'hours' },
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'delay-1' },
				{ id: 'e-loop', source: 'delay-1', target: 'delay-1' },
			],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(false)
		expect(result.errors.some((e) => e.includes('Self-loop'))).toBe(true)
	})

	it('detects simple cycle (A -> B -> A)', () => {
		const graph = {
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					data: { triggerType: 'phone_verified' },
				},
				{
					id: 'delay-1',
					type: 'delay',
					data: { duration: 1, unit: 'hours' },
				},
				{
					id: 'email-1',
					type: 'action_email',
					data: { subject: 'Loop', bodyHtml: '<p>L</p>' },
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'delay-1' },
				{ id: 'e2', source: 'delay-1', target: 'email-1' },
				{ id: 'e3', source: 'email-1', target: 'delay-1' }, // Cycle back!
			],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(false)
		expect(result.hasCycles).toBe(true)
		expect(result.errors.some((e) => e.includes('Cycle detected'))).toBe(true)
	})

	it('detects multi-node cycle (A -> B -> C -> D -> B)', () => {
		const graph = {
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					data: { triggerType: 'phone_verified' },
				},
				{
					id: 'node-b',
					type: 'delay',
					data: { duration: 1, unit: 'hours' },
				},
				{
					id: 'node-c',
					type: 'delay',
					data: { duration: 2, unit: 'hours' },
				},
				{
					id: 'node-d',
					type: 'action_sms',
					data: { messageText: 'Ping' },
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'node-b' },
				{ id: 'e2', source: 'node-b', target: 'node-c' },
				{ id: 'e3', source: 'node-c', target: 'node-d' },
				{ id: 'e4', source: 'node-d', target: 'node-b' }, // Cycle!
			],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(false)
		expect(result.hasCycles).toBe(true)
	})

	it('fails if no trigger node exists', () => {
		const graph = {
			nodes: [
				{
					id: 'delay-1',
					type: 'delay',
					data: { duration: 1, unit: 'hours' },
				},
			],
			edges: [],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(false)
		expect(result.errors.some((e) => e.includes('trigger node'))).toBe(true)
	})

	it('fails if multiple trigger nodes exist', () => {
		const graph = {
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					data: { triggerType: 'phone_verified' },
				},
				{
					id: 'trigger-2',
					type: 'trigger',
					data: { triggerType: 'phone_verified' },
				},
			],
			edges: [],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(false)
		expect(
			result.errors.some((e) => e.includes('can only have one trigger node')),
		).toBe(true)
	})

	it('fails if trigger node has incoming edge (in-degree > 0)', () => {
		const graph = {
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					data: { triggerType: 'phone_verified' },
				},
				{
					id: 'delay-1',
					type: 'delay',
					data: { duration: 1, unit: 'hours' },
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'delay-1' },
				{ id: 'e2', source: 'delay-1', target: 'trigger-1' }, // Incoming to trigger!
			],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(false)
		expect(
			result.errors.some((e) =>
				e.includes('Trigger node "trigger-1" cannot have incoming edges'),
			),
		).toBe(true)
	})

	it('detects duplicate node IDs', () => {
		const graph = {
			nodes: [
				{
					id: 'dup-id',
					type: 'trigger',
					data: { triggerType: 'phone_verified' },
				},
				{
					id: 'dup-id',
					type: 'delay',
					data: { duration: 1, unit: 'hours' },
				},
			],
			edges: [],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(false)
		expect(result.errors.some((e) => e.includes('Duplicate node ID'))).toBe(
			true,
		)
	})

	it('detects edge referencing non-existent nodes', () => {
		const graph = {
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					data: { triggerType: 'phone_verified' },
				},
			],
			edges: [{ id: 'e1', source: 'ghost-source', target: 'ghost-target' }],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(false)
		expect(
			result.errors.some((e) => e.includes('non-existent source node')),
		).toBe(true)
		expect(
			result.errors.some((e) => e.includes('non-existent target node')),
		).toBe(true)
	})

	it('warns about disconnected nodes unreachable from trigger', () => {
		const graph = {
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					data: { triggerType: 'phone_verified' },
				},
				{
					id: 'email-1',
					type: 'action_email',
					data: { subject: 'Hi', bodyHtml: '<p>Hi</p>' },
				},
				{
					id: 'orphan-delay',
					type: 'delay',
					data: { duration: 5, unit: 'minutes' },
				},
			],
			edges: [{ id: 'e1', source: 'trigger-1', target: 'email-1' }],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(true) // Warnings don't invalidate graph
		expect(
			result.warnings.some(
				(w) =>
					w.includes('orphan-delay') &&
					w.includes('cannot be reached from the trigger node'),
			),
		).toBe(true)
	})

	it('validates node-level content errors (e.g. invalid delay, missing email subject)', () => {
		const graph = {
			nodes: [
				{
					id: 'trigger-1',
					type: 'trigger',
					data: { triggerType: 'phone_verified' },
				},
				{
					id: 'bad-delay',
					type: 'delay',
					data: { duration: -1, unit: 'hours' },
				},
				{
					id: 'bad-email',
					type: 'action_email',
					data: { subject: '', bodyHtml: '' },
				},
			],
			edges: [
				{ id: 'e1', source: 'trigger-1', target: 'bad-delay' },
				{ id: 'e2', source: 'bad-delay', target: 'bad-email' },
			],
		}

		const result = validateWorkflowDAG(graph)
		expect(result.valid).toBe(false)
		expect(result.errors.some((e) => e.includes('bad-delay'))).toBe(true)
		expect(result.errors.some((e) => e.includes('bad-email'))).toBe(true)
	})
})

describe('Journey Helper Utilities', () => {
	it('calculates delay in milliseconds accurately across units', () => {
		expect(calculateDelayMs(5, 'minutes')).toBe(5 * 60 * 1000)
		expect(calculateDelayMs(2, 'hours')).toBe(2 * 60 * 60 * 1000)
		expect(calculateDelayMs(3, 'days')).toBe(3 * 24 * 60 * 60 * 1000)
		expect(calculateDelayMs(1, 'weeks')).toBe(7 * 24 * 60 * 60 * 1000)
	})

	it('finds downstream nodes filtered by handle', () => {
		const graph: WorkflowGraph = {
			nodes: [],
			edges: [
				{
					id: 'e1',
					source: 'cond-1',
					target: 'email-true',
					sourceHandle: 'true',
				},
				{
					id: 'e2',
					source: 'cond-1',
					target: 'sms-false',
					sourceHandle: 'false',
				},
				{ id: 'e3', source: 'other-1', target: 'email-true' },
				{ id: 'e4', source: 'cond-1', target: 'default-target' },
			],
		}

		expect(getDownstreamNodes(graph, 'cond-1')).toEqual([
			'email-true',
			'sms-false',
			'default-target',
		])
		expect(getDownstreamNodes(graph, 'cond-1', 'true')).toEqual(['email-true'])
		expect(getDownstreamNodes(graph, 'cond-1', 'false')).toEqual(['sms-false'])
		expect(getDownstreamNodes(graph, 'cond-1', null)).toEqual([
			'default-target',
		])
		expect(getDownstreamNodes(graph, 'cond-1', undefined)).toEqual([
			'email-true',
			'sms-false',
			'default-target',
		])
		expect(getDownstreamNodes(graph, 'cond-1', 'nonexistent')).toEqual([])
	})

	it('serializes and parses graph JSON roundtrip', () => {
		const graph: WorkflowGraph = {
			nodes: [
				{
					id: 't-1',
					type: 'trigger',
					position: { x: 50, y: 50 },
					data: { triggerType: 'manual', config: {} },
				},
				{
					id: 'e-1',
					type: 'action_email',
					position: { x: 50, y: 200 },
					data: { subject: 'Test', bodyHtml: '<p>Roundtrip</p>' },
				},
			],
			edges: [{ id: 'e1', source: 't-1', target: 'e-1' }],
			viewport: { x: 10, y: 20, zoom: 1.5 },
		}

		const json = serializeWorkflowGraph(graph)
		expect(typeof json).toBe('string')

		const parsed = parseWorkflowGraph(json)
		expect(parsed.nodes).toHaveLength(2)
		expect(parsed.edges).toHaveLength(1)
		expect(parsed.viewport).toEqual({ x: 10, y: 20, zoom: 1.5 })
	})
})

describe('interpolateMergeTagsHtml', () => {
	it('escapes the fallback of a designed email once', () => {
		// What React renders for `Hey {{firstName|friend's & co}}` at design time.
		const designed = '<p>Hey {{firstName|friend&#x27;s &amp; co}}</p>'
		const html = interpolateMergeTagsHtml(designed, { name: null })
		expect(html).toBe('<p>Hey friend&#39;s &amp; co</p>')
		expect(html).not.toContain('&amp;amp;')
		expect(html).not.toContain('&amp;#x27;')
	})

	it('treats escaped and raw fallbacks alike for every kind of tag', () => {
		for (const fallback of ['a &lt;b&gt; &amp; c', 'a <b> & c']) {
			expect(
				interpolateMergeTagsHtml(`{{lastName|${fallback}}}`, { name: 'Alex' }),
			).toBe('a &lt;b&gt; &amp; c')
			expect(
				interpolateMergeTagsHtml(
					`{{orderNumber|${fallback}}}`,
					{},
					{ orderNumber: '' },
				),
			).toBe('a &lt;b&gt; &amp; c')
			expect(interpolateMergeTagsHtml(`{{orderNumber|${fallback}}}`, {})).toBe(
				'a &lt;b&gt; &amp; c',
			)
		}
	})

	it('still escapes customer and context values as they are', () => {
		expect(
			interpolateMergeTagsHtml('<p>{{name|friend}}</p>', {
				name: 'AT&amp;T <b>',
			}),
		).toBe('<p>AT&amp;amp;T &lt;b&gt;</p>')
		expect(
			interpolateMergeTagsHtml(
				'{{orderNumber|n/a}}',
				{},
				{
					orderNumber: '<i>7</i>',
				},
			),
		).toBe('&lt;i&gt;7&lt;/i&gt;')
		expect(interpolateMergeTagsHtml('<p>{{unknown}}</p>', {})).toBe(
			'<p>{{unknown}}</p>',
		)
	})
})

describe('interpolateMergeTagsHtml in URL attributes', () => {
	it('refuses unsafe schemes from customer and context values', () => {
		for (const value of [
			'javascript:alert(1)',
			'JAVASCRIPT:alert(1)',
			' \tjava\nscript:alert(1)',
			'data:text/html,<b>',
			'vbscript:x',
		]) {
			expect(
				interpolateMergeTagsHtml('<a href="{{name}}">x</a>', { name: value }),
			).toBe('<a href="">x</a>')
			expect(
				interpolateMergeTagsHtml('<img src="{{link}}">', {}, { link: value }),
			).toBe('<img src="">')
		}
	})

	it('keeps safe URLs and leaves other attributes and text alone', () => {
		expect(
			interpolateMergeTagsHtml(
				'<a href="{{link}}" title="{{link}}">{{link}}</a>',
				{},
				{ link: 'https://x.test/?a=1&b=2' },
			),
		).toBe(
			'<a href="https://x.test/?a=1&amp;b=2" title="https://x.test/?a=1&amp;b=2">https://x.test/?a=1&amp;b=2</a>',
		)
		expect(
			interpolateMergeTagsHtml('<a href="mailto:{{email}}">x</a>', {
				email: 'a@example.com',
			}),
		).toBe('<a href="mailto:a@example.com">x</a>')
		expect(
			interpolateMergeTagsHtml(
				'<p title="{{link}}">{{link}}</p>',
				{},
				{ link: 'javascript:alert(1)' },
			),
		).toBe('<p title="javascript:alert(1)">javascript:alert(1)</p>')
	})
})

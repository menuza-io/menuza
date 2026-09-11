import { emailBlocksSchema } from '@repo/common/email-blocks'
import {
	isMergeTagName,
	replaceMergeTokens,
	resolveWithFallback,
} from '@repo/common/merge-tags'
import { z } from 'zod'

// ==========================================
// 1. ENUMS & LITERALS
// ==========================================

export const JOURNEY_STATUSES = [
	'draft',
	'active',
	'paused',
	'archived',
] as const
export type JourneyStatus = (typeof JOURNEY_STATUSES)[number]
export const journeyStatusSchema = z.enum(JOURNEY_STATUSES)

export const JOURNEY_TRIGGER_TYPES = [
	'phone_verified',
	'profile_completed',
	'custom_event',
	'manual',
] as const
export type JourneyTriggerType = (typeof JOURNEY_TRIGGER_TYPES)[number]
export const journeyTriggerTypeSchema = z.enum(JOURNEY_TRIGGER_TYPES)

export const JOURNEY_RUN_STATUSES = [
	'running',
	'completed',
	'failed',
	'cancelled',
] as const
export type JourneyRunStatus = (typeof JOURNEY_RUN_STATUSES)[number]
export const journeyRunStatusSchema = z.enum(JOURNEY_RUN_STATUSES)

export const STEP_EXECUTION_STATUSES = [
	'pending',
	'processing',
	'completed',
	'delivered',
	'failed',
	'skipped',
] as const
export type StepExecutionStatus = (typeof STEP_EXECUTION_STATUSES)[number]
export const stepExecutionStatusSchema = z.enum(STEP_EXECUTION_STATUSES)

export const NODE_TYPES = [
	'trigger',
	'delay',
	'action_email',
	'action_sms',
	'condition',
] as const
export type NodeType = (typeof NODE_TYPES)[number]
export const nodeTypeSchema = z.enum(NODE_TYPES)

export const DELAY_UNITS = ['minutes', 'hours', 'days', 'weeks'] as const
export type DelayUnit = (typeof DELAY_UNITS)[number]
export const delayUnitSchema = z.enum(DELAY_UNITS)

export const CONDITION_OPERATORS = [
	'equals',
	'not_equals',
	'contains',
	'greater_than',
	'less_than',
] as const
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number]
export const conditionOperatorSchema = z.enum(CONDITION_OPERATORS)

// ==========================================
// 2. NODE DATA SCHEMAS
// ==========================================

export const triggerNodeDataSchema = z.object({
	triggerType: journeyTriggerTypeSchema.default('phone_verified'),
	config: z.record(z.unknown()).optional().default({}),
})
export type TriggerNodeData = z.infer<typeof triggerNodeDataSchema>

export const delayNodeDataSchema = z.object({
	duration: z.number().int().min(1, 'Duration must be at least 1'),
	unit: delayUnitSchema.default('hours'),
})
export type DelayNodeData = z.infer<typeof delayNodeDataSchema>

export const actionEmailNodeDataSchema = z
	.object({
		subject: z.string().min(1, 'Subject is required'),
		/**
		 * Pre-rendered HTML body. When `blocks` is set this holds the full
		 * document produced by the email designer at save time.
		 */
		bodyHtml: z.string().optional(),
		bodyText: z.string().optional(),
		fromName: z.string().optional(),
		template: z.string().optional(),
		/** Distinguishes designed documents from legacy HTML content. */
		emailFormat: z.enum(['designed', 'html']).optional(),
		/** Email designer blocks — the source of truth for editing. */
		blocks: emailBlocksSchema.optional(),
	})
	.superRefine((data, context) => {
		const isDesigned =
			data.emailFormat === 'designed' || Array.isArray(data.blocks)
		const hasBlocks =
			isDesigned && Array.isArray(data.blocks) && data.blocks.length > 0
		const hasHtml = Boolean(data.bodyHtml && data.bodyHtml.trim().length > 0)
		if (!hasBlocks && !hasHtml) {
			context.addIssue({
				code: 'custom',
				message: 'Add an email design or an HTML body',
				path: ['bodyHtml'],
			})
		}
	})
export type ActionEmailNodeData = z.infer<typeof actionEmailNodeDataSchema>

export const actionSmsNodeDataSchema = z.object({
	messageText: z
		.string()
		.min(1, 'Message text is required')
		.max(1600, 'SMS message cannot exceed 1600 characters'),
})
export type ActionSmsNodeData = z.infer<typeof actionSmsNodeDataSchema>

export const conditionNodeDataSchema = z.object({
	field: z.string().min(1, 'Condition field is required'),
	operator: conditionOperatorSchema.default('equals'),
	value: z.string().default(''),
})
export type ConditionNodeData = z.infer<typeof conditionNodeDataSchema>

export type NodeData =
	| TriggerNodeData
	| DelayNodeData
	| ActionEmailNodeData
	| ActionSmsNodeData
	| ConditionNodeData

// ==========================================
// 3. NODE & EDGE SCHEMAS
// ==========================================

export const nodePositionSchema = z.object({
	x: z.number(),
	y: z.number(),
})
export type NodePosition = z.infer<typeof nodePositionSchema>

export const triggerNodeSchema = z.object({
	id: z.string().min(1),
	type: z.literal('trigger'),
	position: nodePositionSchema.optional(),
	data: triggerNodeDataSchema,
})
export type TriggerNode = z.infer<typeof triggerNodeSchema>

export const delayNodeSchema = z.object({
	id: z.string().min(1),
	type: z.literal('delay'),
	position: nodePositionSchema.optional(),
	data: delayNodeDataSchema,
})
export type DelayNode = z.infer<typeof delayNodeSchema>

export const actionEmailNodeSchema = z.object({
	id: z.string().min(1),
	type: z.literal('action_email'),
	position: nodePositionSchema.optional(),
	data: actionEmailNodeDataSchema,
})
export type ActionEmailNode = z.infer<typeof actionEmailNodeSchema>

export const actionSmsNodeSchema = z.object({
	id: z.string().min(1),
	type: z.literal('action_sms'),
	position: nodePositionSchema.optional(),
	data: actionSmsNodeDataSchema,
})
export type ActionSmsNode = z.infer<typeof actionSmsNodeSchema>

export const conditionNodeSchema = z.object({
	id: z.string().min(1),
	type: z.literal('condition'),
	position: nodePositionSchema.optional(),
	data: conditionNodeDataSchema,
})
export type ConditionNode = z.infer<typeof conditionNodeSchema>

export const nodeSchema = z.discriminatedUnion('type', [
	triggerNodeSchema,
	delayNodeSchema,
	actionEmailNodeSchema,
	actionSmsNodeSchema,
	conditionNodeSchema,
])
export type WorkflowNode = z.infer<typeof nodeSchema>

export const genericNodeSchema = z.object({
	id: z.string().min(1),
	type: nodeTypeSchema,
	position: nodePositionSchema.optional(),
	data: z.record(z.unknown()),
})
export type GenericNode = z.infer<typeof genericNodeSchema>

export const edgeSchema = z.object({
	id: z.string().min(1),
	source: z.string().min(1),
	target: z.string().min(1),
	sourceHandle: z.string().nullish(),
	targetHandle: z.string().nullish(),
})
export type WorkflowEdge = z.infer<typeof edgeSchema>

export const viewportSchema = z.object({
	x: z.number(),
	y: z.number(),
	zoom: z.number(),
})
export type WorkflowViewport = z.infer<typeof viewportSchema>

export const workflowGraphSchema = z.object({
	nodes: z.array(nodeSchema),
	edges: z.array(edgeSchema),
	viewport: viewportSchema.optional(),
})
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>

export const relaxedWorkflowGraphSchema = z.object({
	nodes: z.array(genericNodeSchema),
	edges: z.array(edgeSchema),
	viewport: viewportSchema.optional(),
})
export type RelaxedWorkflowGraph = z.infer<typeof relaxedWorkflowGraphSchema>

// ==========================================
// 4. API & MUTATION SCHEMAS
// ==========================================

export const createJourneySchema = z.object({
	name: z.string().min(1, 'Journey name is required').max(200),
	description: z.string().max(1000).optional(),
	triggerType: journeyTriggerTypeSchema.optional().default('phone_verified'),
	triggerConfig: z.record(z.unknown()).optional().default({}),
	nodes: z.array(z.record(z.unknown())).optional().default([]),
	edges: z.array(z.record(z.unknown())).optional().default([]),
	graphJson: z.string().optional(),
})
export type CreateJourneyInput = z.infer<typeof createJourneySchema>

export const updateJourneySchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(1000).nullish(),
	status: journeyStatusSchema.optional(),
	triggerType: journeyTriggerTypeSchema.optional(),
	triggerConfig: z.record(z.unknown()).optional(),
	nodes: z.array(z.record(z.unknown())).optional(),
	edges: z.array(z.record(z.unknown())).optional(),
	graphJson: z.string().optional(),
})
export type UpdateJourneyInput = z.infer<typeof updateJourneySchema>

export const executeStepPayloadSchema = z.object({
	orgId: z.string().min(1),
	journeyId: z.string().uuid(),
	runId: z.string().uuid(),
	customerId: z.string().min(1),
	nodeId: z.string().min(1),
	nodeType: z.enum(['action_email', 'action_sms', 'email', 'sms']),
	config: z.record(z.unknown()),
})
export type ExecuteStepPayload = z.infer<typeof executeStepPayloadSchema>

export const completeRunPayloadSchema = z.object({
	orgId: z.string().min(1),
	runId: z.string().uuid(),
	status: z.enum(['completed', 'failed', 'cancelled']),
	errorMessage: z.string().nullish(),
})
export type CompleteRunPayload = z.infer<typeof completeRunPayloadSchema>

export const evaluateConditionPayloadSchema = z.object({
	orgId: z.string().min(1),
	journeyId: z.string().uuid(),
	runId: z.string().uuid(),
	customerId: z.string().min(1),
	nodeId: z.string().min(1),
	condition: conditionNodeDataSchema,
})
export type EvaluateConditionPayload = z.infer<
	typeof evaluateConditionPayloadSchema
>

// ==========================================
// 5. DAG VALIDATION & HELPER UTILITIES
// ==========================================

export interface DAGValidationResult {
	valid: boolean
	errors: string[]
	warnings: string[]
	nodeCount: number
	edgeCount: number
	triggerNodeId?: string
	terminalNodeIds: string[]
	hasCycles: boolean
}

/**
 * Validates a workflow graph structure, ensuring:
 * 1. Conforms to graph schema.
 * 2. Exactly one trigger node (with in-degree 0).
 * 3. All node IDs are unique.
 * 4. All edges connect existing source and target nodes.
 * 5. No self-loops (source !== target).
 * 6. No cycles (verified via 3-color DFS traversal).
 * 7. Connectivity & reachability from trigger node.
 * 8. Validation of node-specific data configurations.
 */
export function validateWorkflowDAG(graph: unknown): DAGValidationResult {
	const errors: string[] = []
	const warnings: string[] = []

	if (!graph || typeof graph !== 'object') {
		return {
			valid: false,
			errors: ['Invalid graph: must be an object'],
			warnings: [],
			nodeCount: 0,
			edgeCount: 0,
			terminalNodeIds: [],
			hasCycles: false,
		}
	}

	const parsed = relaxedWorkflowGraphSchema.safeParse(graph)
	if (!parsed.success) {
		const formattedErrors = parsed.error.issues.map(
			(issue) => `${issue.path.join('.')}: ${issue.message}`,
		)
		return {
			valid: false,
			errors: formattedErrors,
			warnings: [],
			nodeCount: 0,
			edgeCount: 0,
			terminalNodeIds: [],
			hasCycles: false,
		}
	}

	const { nodes, edges } = parsed.data
	const nodeCount = nodes.length
	const edgeCount = edges.length

	// 1. Check node count
	if (nodeCount === 0) {
		return {
			valid: false,
			errors: ['Journey graph must contain at least one trigger node'],
			warnings: [],
			nodeCount: 0,
			edgeCount: 0,
			terminalNodeIds: [],
			hasCycles: false,
		}
	}

	// 2. Check unique node IDs
	const nodeIds = new Set<string>()
	const nodeMap = new Map<string, GenericNode>()
	for (const node of nodes) {
		if (nodeIds.has(node.id)) {
			errors.push(`Duplicate node ID detected: "${node.id}"`)
		}
		nodeIds.add(node.id)
		nodeMap.set(node.id, node)
	}

	// 3. Trigger node count and identification
	const triggerNodes = nodes.filter((n) => n.type === 'trigger')
	let triggerNodeId: string | undefined

	if (triggerNodes.length === 0) {
		errors.push('Journey must have exactly one trigger node (found 0)')
	} else if (triggerNodes.length > 1) {
		errors.push(
			`Journey can only have one trigger node (found ${triggerNodes.length}: ${triggerNodes.map((n) => n.id).join(', ')})`,
		)
	} else {
		triggerNodeId = triggerNodes[0]!.id
	}

	// 4. Build adjacency lists and verify edge endpoints
	const adj = new Map<string, string[]>()
	const inDegree = new Map<string, number>()
	const outDegree = new Map<string, number>()

	for (const nodeId of nodeIds) {
		adj.set(nodeId, [])
		inDegree.set(nodeId, 0)
		outDegree.set(nodeId, 0)
	}

	for (const edge of edges) {
		let edgeValid = true
		if (!nodeMap.has(edge.source)) {
			errors.push(
				`Edge "${edge.id}" references non-existent source node: "${edge.source}"`,
			)
			edgeValid = false
		}
		if (!nodeMap.has(edge.target)) {
			errors.push(
				`Edge "${edge.id}" references non-existent target node: "${edge.target}"`,
			)
			edgeValid = false
		}
		if (!edgeValid) {
			continue
		}
		if (edge.source === edge.target) {
			errors.push(
				`Self-loop detected on node "${edge.source}" via edge "${edge.id}"`,
			)
			continue
		}

		adj.get(edge.source)!.push(edge.target)
		inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1)
		outDegree.set(edge.source, (outDegree.get(edge.source) || 0) + 1)
	}

	// 5. Trigger node in-degree check
	if (triggerNodeId && (inDegree.get(triggerNodeId) || 0) > 0) {
		errors.push(
			`Trigger node "${triggerNodeId}" cannot have incoming edges (in-degree is ${inDegree.get(triggerNodeId)})`,
		)
	}

	// 6. Cycle detection via 3-color DFS (0 = White, 1 = Gray, 2 = Black)
	const color = new Map<string, number>()
	for (const nodeId of nodeIds) {
		color.set(nodeId, 0)
	}

	let hasCycles = false
	const cyclePath: string[] = []

	function dfsCycleCheck(nodeId: string, path: string[]): boolean {
		color.set(nodeId, 1) // Gray: visiting
		path.push(nodeId)

		const neighbors = adj.get(nodeId) || []
		for (const neighbor of neighbors) {
			const neighborColor = color.get(neighbor) || 0
			if (neighborColor === 1) {
				// Cycle found!
				hasCycles = true
				const cycleStartIdx = path.indexOf(neighbor)
				const detectedCycle = [...path.slice(cycleStartIdx), neighbor].join(
					' -> ',
				)
				cyclePath.push(detectedCycle)
				return true
			}
			if (neighborColor === 0) {
				if (dfsCycleCheck(neighbor, path)) {
					return true
				}
			}
		}

		path.pop()
		color.set(nodeId, 2) // Black: fully visited
		return false
	}

	// Run DFS from trigger first, then any unvisited nodes
	if (triggerNodeId && color.get(triggerNodeId) === 0) {
		dfsCycleCheck(triggerNodeId, [])
	}
	for (const nodeId of nodeIds) {
		if (color.get(nodeId) === 0) {
			dfsCycleCheck(nodeId, [])
		}
	}

	if (hasCycles) {
		errors.push(`Cycle detected in workflow graph: ${cyclePath.join('; ')}`)
	}

	// 7. Reachability check from trigger node
	const reachable = new Set<string>()
	if (triggerNodeId) {
		const queue = [triggerNodeId]
		reachable.add(triggerNodeId)

		while (queue.length > 0) {
			const current = queue.shift()!
			const neighbors = adj.get(current) || []
			for (const next of neighbors) {
				if (!reachable.has(next)) {
					reachable.add(next)
					queue.push(next)
				}
			}
		}

		for (const nodeId of nodeIds) {
			if (!reachable.has(nodeId)) {
				warnings.push(
					`Node "${nodeId}" is disconnected and cannot be reached from the trigger node`,
				)
			}
		}
	}

	// 8. Find terminal nodes (out-degree 0)
	const terminalNodeIds: string[] = []
	for (const nodeId of nodeIds) {
		if ((outDegree.get(nodeId) || 0) === 0) {
			terminalNodeIds.push(nodeId)
		}
	}

	// 9. Node data content validation
	for (const node of nodes) {
		switch (node.type) {
			case 'delay': {
				const res = delayNodeDataSchema.safeParse(node.data)
				if (!res.success) {
					errors.push(
						`Delay node "${node.id}" has invalid configuration: ${res.error.issues.map((i) => i.message).join(', ')}`,
					)
				}
				break
			}
			case 'action_email': {
				const res = actionEmailNodeDataSchema.safeParse(node.data)
				if (!res.success) {
					errors.push(
						`Email action node "${node.id}" has invalid configuration: ${res.error.issues.map((i) => i.message).join(', ')}`,
					)
				}
				break
			}
			case 'action_sms': {
				const res = actionSmsNodeDataSchema.safeParse(node.data)
				if (!res.success) {
					errors.push(
						`SMS action node "${node.id}" has invalid configuration: ${res.error.issues.map((i) => i.message).join(', ')}`,
					)
				}
				break
			}
			case 'condition': {
				const res = conditionNodeDataSchema.safeParse(node.data)
				if (!res.success) {
					errors.push(
						`Condition node "${node.id}" has invalid configuration: ${res.error.issues.map((i) => i.message).join(', ')}`,
					)
				}
				// Condition nodes should branch to 2 paths
				const out = outDegree.get(node.id) || 0
				if (out > 2) {
					warnings.push(
						`Condition node "${node.id}" has more than 2 outgoing connections (${out})`,
					)
				}
				break
			}
			case 'trigger': {
				const res = triggerNodeDataSchema.safeParse(node.data)
				if (!res.success) {
					errors.push(
						`Trigger node "${node.id}" has invalid configuration: ${res.error.issues.map((i) => i.message).join(', ')}`,
					)
				}
				break
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
		nodeCount,
		edgeCount,
		triggerNodeId,
		terminalNodeIds,
		hasCycles,
	}
}

/**
 * Serializes a WorkflowGraph object into a compact JSON string.
 */
export function serializeWorkflowGraph(graph: WorkflowGraph): string {
	return JSON.stringify(graph)
}

/**
 * Parses and validates a JSON string into a WorkflowGraph object.
 */
export function parseWorkflowGraph(jsonString: string): WorkflowGraph {
	const parsed = JSON.parse(jsonString)
	return workflowGraphSchema.parse(parsed)
}

/**
 * Calculates milliseconds for a given delay duration and unit.
 */
export function calculateDelayMs(duration: number, unit: DelayUnit): number {
	const minuteMs = 60 * 1000
	const hourMs = 60 * minuteMs
	const dayMs = 24 * hourMs
	const weekMs = 7 * dayMs

	switch (unit) {
		case 'minutes':
			return duration * minuteMs
		case 'hours':
			return duration * hourMs
		case 'days':
			return duration * dayMs
		case 'weeks':
			return duration * weekMs
		default:
			return duration * minuteMs
	}
}

/**
 * Retrieves the immediate downstream target node IDs for a given node in a graph,
 * optionally filtered by sourceHandle.
 */
export function getDownstreamNodes(
	graph: { edges: WorkflowEdge[] },
	nodeId: string,
	handle?: string | null,
): string[] {
	return graph.edges
		.filter((edge) => {
			if (edge.source !== nodeId) return false
			if (handle === undefined) return true
			if (handle === null) return edge.sourceHandle == null
			return edge.sourceHandle === handle
		})
		.map((edge) => edge.target)
}

/**
 * Interpolates customer PII and trigger context merge tags in template strings.
 * Supported merge tags:
 * - {{name}} -> customer.name or 'Customer'
 * - {{firstName}} -> first word of customer.name or 'Customer'
 * - {{lastName}} -> remaining words of customer.name or ''
 * - {{email}} -> customer.email or ''
 * - {{phone}} -> customer.phone or ''
 * - {{customKey}} -> contextData[customKey] or original tag
 *
 * Any tag accepts a fallback: `{{firstName|there}}` resolves to 'there' when the
 * customer has no first name. A fallback takes precedence over the built-in
 * default above, and an unknown tag with a fallback resolves to that fallback.
 */
export function interpolateMergeTags(
	template: string,
	customer: {
		name?: string | null
		email?: string | null
		phone?: string | null
	},
	contextData: Record<string, unknown> = {},
): string {
	return replaceMergeTokens(template, (key, fallback, raw) => {
		switch (key) {
			case 'name':
				return resolveWithFallback(customer.name, fallback, 'Customer')
			case 'firstName': {
				const trimmed = customer.name?.trim()
				const first = trimmed ? trimmed.split(/\s+/)[0] : ''
				return resolveWithFallback(first, fallback, 'Customer')
			}
			case 'lastName': {
				const trimmed = customer.name?.trim()
				if (!trimmed) return resolveWithFallback('', fallback)
				const parts = trimmed.split(/\s+/)
				const rest = parts.length > 1 ? parts.slice(1).join(' ') : ''
				return resolveWithFallback(rest, fallback)
			}
			case 'email':
				return resolveWithFallback(customer.email, fallback)
			case 'phone':
				return resolveWithFallback(customer.phone, fallback)
			default:
				if (contextData[key] !== undefined && contextData[key] !== null) {
					return resolveWithFallback(String(contextData[key]), fallback)
				}
				// Unknown tag: use the fallback when given, else keep it verbatim.
				return fallback.trim() || raw
		}
	})
}

const HTML_ESCAPES: Record<string, string> = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
}

export function escapeHtmlValue(value: string): string {
	return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char)
}

/**
 * Same as `interpolateMergeTags`, but escapes every substituted value so
 * customer PII cannot inject markup into a pre-rendered HTML email body.
 * Use the plain variant for the text part of the message.
 */
export function interpolateMergeTagsHtml(
	template: string,
	customer: {
		name?: string | null
		email?: string | null
		phone?: string | null
	},
	contextData: Record<string, unknown> = {},
): string {
	return replaceMergeTokens(template, (key, fallback, raw) => {
		// Literal text is written by the editor and stays as-is; only the
		// substituted values (and fallbacks) are escaped.
		if (!isMergeTagName(key)) {
			if (contextData[key] !== undefined && contextData[key] !== null) {
				return escapeHtmlValue(
					resolveWithFallback(String(contextData[key]), fallback),
				)
			}
			return fallback.trim() ? escapeHtmlValue(fallback) : raw
		}
		return escapeHtmlValue(interpolateMergeTags(raw, customer, contextData))
	})
}

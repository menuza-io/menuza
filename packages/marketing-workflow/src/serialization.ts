import {
	type ActionEmailNodeData,
	type WorkflowGraph,
	type WorkflowNode,
	type WorkflowEdge,
	workflowGraphSchema,
} from '@repo/tenant-db/types/journey'
import { emailBlockSchema } from '@repo/common/email-blocks'
import { type Node, type Edge, type Viewport } from '@xyflow/react'

/**
 * Converts React Flow state (nodes, edges, viewport) into the canonical WorkflowGraph object.
 */
export function reactFlowToWorkflowGraph(
	nodes: Node[],
	edges: Edge[],
	viewport?: Viewport,
): WorkflowGraph {
	const sanitizedNodes: WorkflowNode[] = nodes.map((node) => {
		const baseNode = {
			id: node.id,
			type: node.type as WorkflowNode['type'],
			position: {
				x: Math.round(node.position.x),
				y: Math.round(node.position.y),
			},
			data: { ...node.data },
		}

		// Ensure defaults for specific node types
		switch (node.type) {
			case 'trigger':
				return {
					...baseNode,
					type: 'trigger' as const,
					data: {
						triggerType: (node.data?.triggerType as any) || 'phone_verified',
						config: (node.data?.config as Record<string, unknown>) || {},
					},
				}
			case 'delay':
				return {
					...baseNode,
					type: 'delay' as const,
					data: {
						duration: Number(node.data?.duration) || 1,
						unit: (node.data?.unit as any) || 'hours',
					},
				}
			case 'action_email':
				return {
					...baseNode,
					type: 'action_email' as const,
					data: {
						subject: String(node.data?.subject || ''),
						bodyHtml: String(node.data?.bodyHtml || ''),
						bodyText: node.data?.bodyText
							? String(node.data.bodyText)
							: undefined,
						fromName: node.data?.fromName
							? String(node.data.fromName)
							: undefined,
						emailFormat: Array.isArray(node.data?.blocks)
							? 'designed'
							: undefined,
						template: node.data?.template
							? String(node.data.template)
							: undefined,
						blocks: Array.isArray(node.data?.blocks)
							? node.data.blocks.flatMap((block) => {
									const parsed = emailBlockSchema.safeParse(block)
									return parsed.success ? [parsed.data] : []
								})
							: undefined,
					},
				}
			case 'action_sms':
				return {
					...baseNode,
					type: 'action_sms' as const,
					data: {
						messageText: String(node.data?.messageText || ''),
					},
				}
			case 'condition':
				return {
					...baseNode,
					type: 'condition' as const,
					data: {
						field: String(node.data?.field || 'tags'),
						operator: (node.data?.operator as any) || 'equals',
						value: String(node.data?.value ?? ''),
					},
				}
			default:
				return baseNode as unknown as WorkflowNode
		}
	})

	const sanitizedEdges: WorkflowEdge[] = edges.map((edge) => ({
		id: edge.id,
		source: edge.source,
		target: edge.target,
		sourceHandle: edge.sourceHandle || null,
		targetHandle: edge.targetHandle || null,
	}))

	const graph: WorkflowGraph = {
		nodes: sanitizedNodes,
		edges: sanitizedEdges,
		viewport: viewport
			? {
					x: Math.round(viewport.x),
					y: Math.round(viewport.y),
					zoom: Number(viewport.zoom.toFixed(2)),
				}
			: undefined,
	}

	return graph
}

/**
 * Deserializes a WorkflowGraph object or JSON string into React Flow nodes and edges.
 */
export function workflowGraphToReactFlow(rawGraph: unknown): {
	nodes: Node[]
	edges: Edge[]
	viewport?: Viewport
} {
	let graph: WorkflowGraph

	if (typeof rawGraph === 'string') {
		try {
			const parsed = JSON.parse(rawGraph)
			graph = workflowGraphSchema.parse(parsed)
		} catch {
			graph = createDefaultTenantJourneyGraph()
		}
	} else if (rawGraph && typeof rawGraph === 'object') {
		const parsed = workflowGraphSchema.safeParse(rawGraph)
		if (parsed.success) {
			graph = parsed.data
		} else {
			graph = createDefaultTenantJourneyGraph()
		}
	} else {
		graph = createDefaultJourneyGraph()
	}

	const nodes: Node[] = graph.nodes.map((node) => ({
		id: node.id,
		type: node.type,
		position: node.position || { x: 250, y: 100 },
		data: { ...node.data },
	}))

	const edges: Edge[] = graph.edges.map((edge) => {
		// Fallback for older saved graphs where handles might be null
		let sourceHandle = edge.sourceHandle
		if (!sourceHandle) {
			const sourceNode = graph.nodes.find((n) => n.id === edge.source)
			if (sourceNode?.type === 'condition') {
				sourceHandle = 'true'
			} else {
				sourceHandle = 'output'
			}
		}

		let targetHandle = edge.targetHandle
		if (!targetHandle) {
			targetHandle = 'input'
		}

		return {
			id: edge.id,
			source: edge.source,
			target: edge.target,
			sourceHandle,
			targetHandle,
			type: 'workflow',
		}
	})

	return {
		nodes,
		edges,
		viewport: graph.viewport,
	}
}

/** @deprecated Use createDefaultTenantJourneyGraph */
export const createDefaultJourneyGraph = createDefaultTenantJourneyGraph

/**
 * Creates a clean default workflow template (Trigger -> Delay -> Email Action).
 */
export function createDefaultTenantJourneyGraph(): WorkflowGraph {
	return {
		nodes: [
			{
				id: 'node_trigger_1',
				type: 'trigger',
				position: { x: 250, y: 50 },
				data: {
					triggerType: 'phone_verified',
					config: {},
				},
			},
			{
				id: 'node_delay_1',
				type: 'delay',
				position: { x: 250, y: 220 },
				data: {
					duration: 1,
					unit: 'hours',
				},
			},
			{
				id: 'node_email_1',
				type: 'action_email',
				position: { x: 250, y: 390 },
				data: {
					subject: 'Welcome to our platform, {{name}}!',
					bodyHtml:
						'<p>Hi {{name}},</p><p>Welcome aboard! We are thrilled to have you with us.</p>',
					bodyText:
						'Hi {{name}}, Welcome aboard! We are thrilled to have you with us.',
					fromName: 'Marketing Team',
				},
			},
		],
		edges: [
			{
				id: 'edge_1',
				source: 'node_trigger_1',
				target: 'node_delay_1',
				sourceHandle: 'output',
				targetHandle: 'input',
			},
			{
				id: 'edge_2',
				source: 'node_delay_1',
				target: 'node_email_1',
				sourceHandle: 'output',
				targetHandle: 'input',
			},
		],
		viewport: { x: 0, y: 0, zoom: 1 },
	}
}

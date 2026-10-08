import {
	type FlowEdge,
	type FlowGraph,
	type FlowNodeData,
	type FlowNodeType,
	type FlowValidationIssue,
	type MenuOption,
	menuKeyHandle,
} from '@repo/phone-agent'
import { type Edge, type Node } from '@xyflow/react'
import { createContext, useContext } from 'react'

export type FlowEditorNode = Node<FlowNodeData, FlowNodeType>
export type FlowEditorEdge = Edge<Record<string, never>, 'flow'>

export function randomId(prefix: string) {
	return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function graphToReactFlow(graph: FlowGraph): {
	nodes: FlowEditorNode[]
	edges: FlowEditorEdge[]
} {
	return {
		nodes: graph.nodes.map((node) => ({
			id: node.id,
			type: node.type,
			position: node.position,
			data: node.data,
			deletable: node.type !== 'start',
		})),
		edges: graph.edges.map((edge) => ({
			id: edge.id,
			source: edge.source,
			target: edge.target,
			sourceHandle: edge.sourceHandle ?? null,
			type: 'flow',
			data: {},
		})),
	}
}

function cleanText(value: string | undefined) {
	const trimmed = value?.trim()
	return trimmed ? trimmed : undefined
}

function cleanNodeData(
	data: FlowNodeData,
	fallbackLabel: string,
): FlowNodeData {
	const message = cleanText(data.message)
	const phone = cleanText(data.phone)?.replace(/[\s()-]/g, '')
	return {
		label: cleanText(data.label) ?? fallbackLabel,
		...(message ? { message } : {}),
		...(data.options
			? {
					options: data.options.map((option) => {
						const keywords = (option.keywords ?? [])
							.map((keyword) => keyword.trim())
							.filter(Boolean)
						return {
							key: option.key,
							label: option.label.trim(),
							...(keywords.length ? { keywords } : {}),
						}
					}),
				}
			: {}),
		...(data.repeat !== undefined ? { repeat: data.repeat } : {}),
		...(phone ? { phone } : {}),
	}
}

/**
 * Serializes editor state to the stored graph shape. Empty optional strings
 * are dropped so that the result is stable for dirty checks and matches what
 * the server schema produces.
 */
export function reactFlowToGraph(
	nodes: FlowEditorNode[],
	edges: FlowEditorEdge[],
	fallbackLabel: (type: FlowNodeType) => string,
): FlowGraph {
	return {
		nodes: nodes.map((node) => {
			const type = node.type ?? 'play_message'
			return {
				id: node.id,
				type,
				position: {
					x: Math.round(node.position.x),
					y: Math.round(node.position.y),
				},
				data: cleanNodeData(node.data, fallbackLabel(type)),
			}
		}),
		edges: edges.map((edge): FlowEdge => ({
			id: edge.id,
			source: edge.source,
			target: edge.target,
			sourceHandle: edge.sourceHandle ?? null,
		})),
	}
}

export function hasDuplicateMenuKeys(options: MenuOption[]) {
	return new Set(options.map((option) => option.key)).size !== options.length
}

/**
 * Keeps a keypad menu's connections attached to their options when the
 * option list changes: a re-keyed option (1 → 3) moves its edge from `key_1`
 * to `key_3`, and a removed option drops its edge. The inspector edits one
 * option at a time and never allows duplicate keys, so a list of the same
 * length is a positional edit and a shorter list is a removal.
 */
export function remapMenuOptionEdges<TEdge extends Edge>(
	edges: TEdge[],
	nodeId: string,
	previous: MenuOption[],
	next: MenuOption[],
): TEdge[] {
	const handleMap = new Map<string, string | null>()
	if (previous.length === next.length) {
		previous.forEach((option, index) => {
			handleMap.set(menuKeyHandle(option.key), menuKeyHandle(next[index]!.key))
		})
	} else {
		const nextKeys = new Set(next.map((option) => option.key))
		for (const option of previous) {
			const handle = menuKeyHandle(option.key)
			handleMap.set(handle, nextKeys.has(option.key) ? handle : null)
		}
	}

	let changed = false
	const result: TEdge[] = []
	for (const edge of edges) {
		const handle = edge.sourceHandle ?? null
		if (edge.source !== nodeId || handle === null || !handleMap.has(handle)) {
			result.push(edge)
			continue
		}
		const nextHandle = handleMap.get(handle) ?? null
		if (nextHandle === handle) {
			result.push(edge)
		} else {
			changed = true
			if (nextHandle !== null)
				result.push({ ...edge, sourceHandle: nextHandle })
		}
	}
	return changed ? result : edges
}

export type FlowEditorContextValue = {
	readOnly: boolean
	issuesByNode: Map<string, FlowValidationIssue[]>
	issuesByEdge: Map<string, FlowValidationIssue[]>
	deleteEdge: (edgeId: string) => void
}

export const FlowEditorContext = createContext<FlowEditorContextValue | null>(
	null,
)

export function useFlowEditorContext() {
	const value = useContext(FlowEditorContext)
	if (!value) {
		throw new Error('useFlowEditorContext must be used inside the flow editor')
	}
	return value
}

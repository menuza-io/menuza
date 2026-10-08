import { z } from 'zod'
import { isUsOrCanadaNumber } from './nanp.ts'

/**
 * A call flow is a phone menu (IVR). Steps play prompts, wait for a keypad
 * press or a spoken choice, text a website link, transfer, take voicemail, or
 * hand the call to the AI assistant. Only the AI assistant step uses the
 * language model; it then handles the rest of the call on its own.
 */
export const FLOW_NODE_TYPES = [
	'start',
	'play_message',
	'keypad_menu',
	'hours_check',
	'ai_agent',
	'text_link',
	'transfer',
	'voicemail',
	'hang_up',
] as const
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number]

export const MENU_KEYS = [
	'1',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
	'0',
	'*',
	'#',
] as const
export type MenuKey = (typeof MENU_KEYS)[number]

/** Times a keypad menu prompt plays again when the caller presses nothing. */
export const MAX_MENU_REPEATS = 3

export function menuKeyHandle(key: MenuKey) {
	if (key === '*') return 'key_star'
	if (key === '#') return 'key_hash'
	return `key_${key}`
}

const HANDLE_PATTERN =
	/^(?:open|closed|no_answer|no_input|key_(?:[0-9]|star|hash))$/

const E164 = /^\+[1-9]\d{7,14}$/

export function isE164(value: string | undefined | null): value is string {
	return Boolean(value && E164.test(value))
}

export const MenuOptionSchema = z.object({
	key: z.enum(MENU_KEYS),
	label: z.string().trim().min(1).max(80),
	/** Extra words a caller might say to pick this option. */
	keywords: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
})
export type MenuOption = z.infer<typeof MenuOptionSchema>

export const FlowNodeDataSchema = z.object({
	label: z.string().trim().min(1).max(80),
	/** What the step says: a prompt, announcement, or goodbye. */
	message: z.string().trim().max(600).optional(),
	options: z.array(MenuOptionSchema).max(MENU_KEYS.length).optional(),
	repeat: z.number().int().min(0).max(MAX_MENU_REPEATS).optional(),
	/** Transfer destination. Checked by validation so typing never breaks saves. */
	phone: z.string().trim().max(20).optional(),
})
export type FlowNodeData = z.infer<typeof FlowNodeDataSchema>

export const FlowNodeSchema = z.object({
	id: z.string().trim().min(1).max(80),
	type: z.enum(FLOW_NODE_TYPES),
	position: z.object({ x: z.number(), y: z.number() }),
	data: FlowNodeDataSchema,
})
export type FlowNode = z.infer<typeof FlowNodeSchema>

export const FlowEdgeSchema = z.object({
	id: z.string().trim().min(1).max(160),
	source: z.string().trim().min(1),
	target: z.string().trim().min(1),
	/** Which output of the source step; null for steps with a single output. */
	sourceHandle: z.string().regex(HANDLE_PATTERN).nullable().optional(),
})
export type FlowEdge = z.infer<typeof FlowEdgeSchema>

export const FlowGraphSchema = z.object({
	nodes: z.array(FlowNodeSchema).max(60),
	edges: z.array(FlowEdgeSchema).max(200),
})
export type FlowGraph = z.infer<typeof FlowGraphSchema>

export type FlowOutput = {
	handle: string | null
	required: boolean
	/** Set for keypad options. */
	option?: MenuOption
}

/** The outputs a step offers, as the editor lists them. */
export function flowOutputs(
	node: Pick<FlowNode, 'type' | 'data'>,
): FlowOutput[] {
	switch (node.type) {
		case 'start':
		case 'play_message':
		case 'text_link':
			return [{ handle: null, required: true }]
		case 'voicemail':
			return [{ handle: null, required: false }]
		case 'keypad_menu':
			return [
				...(node.data.options ?? []).map((option) => ({
					handle: menuKeyHandle(option.key),
					required: true,
					option,
				})),
				{ handle: 'no_input', required: false },
			]
		case 'hours_check':
			return [
				{ handle: 'open', required: true },
				{ handle: 'closed', required: true },
			]
		case 'transfer':
			return [{ handle: 'no_answer', required: true }]
		case 'ai_agent':
		case 'hang_up':
			return []
	}
}

/** Steps that finish without waiting for the caller. */
const INSTANT_TYPES = new Set<FlowNodeType>([
	'start',
	'play_message',
	'hours_check',
	'text_link',
])

export type FlowValidationIssue = {
	code:
		| 'missing_start'
		| 'multiple_start'
		| 'duplicate_node'
		| 'dangling_edge'
		| 'unreachable'
		| 'missing_output'
		| 'duplicate_output'
		| 'unknown_output'
		| 'unexpected_output'
		| 'missing_message'
		| 'menu_options'
		| 'menu_duplicate_key'
		| 'invalid_phone'
		| 'unsupported_phone'
		| 'instant_loop'
		| 'transfer_loop'
	message: string
	nodeId?: string
	edgeId?: string
}

export function outgoingEdges(graph: FlowGraph, nodeId: string) {
	return graph.edges.filter((edge) => edge.source === nodeId)
}

function describeKey(key: MenuKey) {
	if (key === '*') return 'star'
	if (key === '#') return 'pound'
	return key
}

function missingOutputMessage(node: FlowNode, output: FlowOutput) {
	const name = node.data.label
	if (node.type === 'start') return 'Connect Start to the first step.'
	if (output.option) {
		return `Connect option ${describeKey(output.option.key)} ("${output.option.label}") in "${name}" to a step.`
	}
	if (node.type === 'hours_check') {
		return `"${name}" needs both an Open and a Closed path.`
	}
	if (node.type === 'transfer') {
		return `"${name}" needs a path for when nobody answers.`
	}
	return `Connect "${name}" to the next step.`
}

function unexpectedOutputMessage(node: FlowNode) {
	return node.type === 'ai_agent'
		? `The AI assistant handles the rest of the call, so "${node.data.label}" can't lead anywhere.`
		: `"${node.data.label}" ends the call, so it can't lead anywhere.`
}

/** Finds cycles made only of steps that never wait for the caller. */
function findInstantLoops(graph: FlowGraph, byId: Map<string, FlowNode>) {
	const instant = (id: string) => {
		const node = byId.get(id)
		return node ? INSTANT_TYPES.has(node.type) : false
	}
	const state = new Map<string, 'visiting' | 'done'>()
	const looped = new Set<string>()
	const visit = (id: string, stack: string[]) => {
		state.set(id, 'visiting')
		stack.push(id)
		for (const edge of outgoingEdges(graph, id)) {
			if (!instant(edge.target)) continue
			const seen = state.get(edge.target)
			if (seen === 'visiting') {
				for (const member of stack.slice(stack.indexOf(edge.target))) {
					looped.add(member)
				}
			} else if (!seen) {
				visit(edge.target, stack)
			}
		}
		stack.pop()
		state.set(id, 'done')
	}
	for (const node of graph.nodes) {
		if (INSTANT_TYPES.has(node.type) && !state.has(node.id)) visit(node.id, [])
	}
	return looped
}

export function validateFlowGraph(graph: FlowGraph): FlowValidationIssue[] {
	const issues: FlowValidationIssue[] = []
	const ids = new Set<string>()
	for (const node of graph.nodes) {
		if (ids.has(node.id)) {
			issues.push({
				code: 'duplicate_node',
				message: `Two steps share the id "${node.id}".`,
				nodeId: node.id,
			})
		}
		ids.add(node.id)
	}

	for (const edge of graph.edges) {
		if (!ids.has(edge.source) || !ids.has(edge.target)) {
			issues.push({
				code: 'dangling_edge',
				message: 'A connection points to a step that no longer exists.',
				edgeId: edge.id,
			})
		}
	}

	const starts = graph.nodes.filter((node) => node.type === 'start')
	if (starts.length === 0) {
		issues.push({ code: 'missing_start', message: 'Add a Start step.' })
	} else if (starts.length > 1) {
		issues.push({
			code: 'multiple_start',
			message: 'A flow can only have one Start step.',
		})
	}

	const byId = new Map(graph.nodes.map((node) => [node.id, node]))
	for (const node of graph.nodes) {
		const name = node.data.label
		const out = outgoingEdges(graph, node.id)
		const outputs = flowOutputs(node)

		if (outputs.length === 0) {
			if (out.length > 0) {
				issues.push({
					code: 'unexpected_output',
					message: unexpectedOutputMessage(node),
					nodeId: node.id,
				})
			}
		} else {
			const known = new Set(outputs.map((output) => output.handle))
			const used = new Set<string | null>()
			for (const edge of out) {
				const handle = edge.sourceHandle ?? null
				if (!known.has(handle)) {
					issues.push({
						code: 'unknown_output',
						message: `A connection from "${name}" no longer matches one of its options. Delete it or reconnect it.`,
						nodeId: node.id,
						edgeId: edge.id,
					})
				} else if (used.has(handle)) {
					issues.push({
						code: 'duplicate_output',
						message: `Each choice in "${name}" can only lead to one step.`,
						nodeId: node.id,
						edgeId: edge.id,
					})
				}
				used.add(handle)
			}
			for (const output of outputs) {
				if (output.required && !used.has(output.handle)) {
					issues.push({
						code: 'missing_output',
						message: missingOutputMessage(node, output),
						nodeId: node.id,
					})
				}
			}
		}

		switch (node.type) {
			case 'play_message':
				if (!node.data.message?.trim()) {
					issues.push({
						code: 'missing_message',
						message: `Write what "${name}" should say.`,
						nodeId: node.id,
					})
				}
				break
			case 'keypad_menu': {
				if (!node.data.message?.trim()) {
					issues.push({
						code: 'missing_message',
						message: `Write the prompt callers hear in "${name}".`,
						nodeId: node.id,
					})
				}
				const options = node.data.options ?? []
				if (options.length === 0) {
					issues.push({
						code: 'menu_options',
						message: `Add at least one option to "${name}".`,
						nodeId: node.id,
					})
				}
				const keys = options.map((option) => option.key)
				if (new Set(keys).size !== keys.length) {
					issues.push({
						code: 'menu_duplicate_key',
						message: `Two options in "${name}" use the same key.`,
						nodeId: node.id,
					})
				}
				break
			}
			case 'transfer':
				if (node.data.phone && !isE164(node.data.phone)) {
					issues.push({
						code: 'invalid_phone',
						message: `Enter the number for "${name}" in international format, for example +15551234567.`,
						nodeId: node.id,
					})
				} else if (node.data.phone && !isUsOrCanadaNumber(node.data.phone)) {
					issues.push({
						code: 'unsupported_phone',
						message: `Use a US or Canada phone number for "${name}".`,
						nodeId: node.id,
					})
				}
				break
			default:
				break
		}
	}

	for (const nodeId of findInstantLoops(graph, byId)) {
		issues.push({
			code: 'instant_loop',
			message: `"${byId.get(nodeId)?.data.label ?? nodeId}" is in a loop that never waits for the caller. Add a keypad menu to the loop or break it.`,
			nodeId,
		})
	}

	const start = starts[0]
	if (start) {
		const reachable = new Set<string>([start.id])
		const queue = [start.id]
		while (queue.length) {
			const current = queue.shift()!
			for (const edge of outgoingEdges(graph, current)) {
				if (!reachable.has(edge.target)) {
					reachable.add(edge.target)
					queue.push(edge.target)
				}
			}
		}
		for (const node of graph.nodes) {
			if (!reachable.has(node.id)) {
				issues.push({
					code: 'unreachable',
					message: `"${node.data.label}" can't be reached from Start.`,
					nodeId: node.id,
				})
			}
		}
	}

	return issues
}

export function parseFlowGraph(value: unknown): FlowGraph {
	const raw = typeof value === 'string' ? (JSON.parse(value) as unknown) : value
	return FlowGraphSchema.parse(raw)
}

export function flowNode(
	id: string,
	type: FlowNodeType,
	x: number,
	y: number,
	data: FlowNodeData,
): FlowNode {
	return { id, type, position: { x, y }, data }
}

export function flowEdge(
	source: string,
	target: string,
	sourceHandle?: string,
): FlowEdge {
	return {
		id: `edge_${source}_${target}${sourceHandle ? `_${sourceHandle}` : ''}`,
		source,
		target,
		sourceHandle: sourceHandle ?? null,
	}
}

/**
 * The phone menu an organization starts with when its vertical has none of
 * its own. `{business}` in a message is replaced with the business name when
 * the call plays it.
 */
export function createDefaultFlowGraph(): FlowGraph {
	return {
		nodes: [
			flowNode('start', 'start', 0, 340, { label: 'Call comes in' }),
			flowNode('hours', 'hours_check', 380, 300, { label: 'Open right now?' }),
			flowNode('main_menu', 'keypad_menu', 760, 40, {
				label: 'Main menu',
				message:
					'Thanks for calling {business}. To get help from our AI assistant, press 1. To get a text with a link to our website, press 2. To speak with our team, press 3.',
				repeat: 2,
				options: [
					{
						key: '1',
						label: 'Get help from the AI assistant',
						keywords: ['assistant', 'question', 'help', 'information'],
					},
					{
						key: '2',
						label: 'Text me the website link',
						keywords: ['text', 'link', 'website', 'online'],
					},
					{
						key: '3',
						label: 'Speak with our team',
						keywords: ['person', 'staff', 'manager', 'someone', 'human'],
					},
				],
			}),
			flowNode('closed_menu', 'keypad_menu', 760, 560, {
				label: 'Closed menu',
				message:
					"Thanks for calling {business}. We're closed right now. To get a text with a link to our website, press 1. To leave a message, press 2.",
				repeat: 2,
				options: [
					{
						key: '1',
						label: 'Text me the website link',
						keywords: ['text', 'link', 'website', 'online'],
					},
					{
						key: '2',
						label: 'Leave a message',
						keywords: ['message', 'voicemail', 'callback'],
					},
				],
			}),
			flowNode('ai', 'ai_agent', 1160, 0, { label: 'AI assistant' }),
			flowNode('text_link', 'text_link', 1160, 440, {
				label: 'Text the website link',
				message: 'We just sent you a text with a link to our website.',
			}),
			flowNode('staff', 'transfer', 1160, 200, {
				label: 'Transfer to the team',
				message: 'Please hold while we connect you.',
			}),
			flowNode('voicemail', 'voicemail', 1560, 680, {
				label: 'Take a message',
				message:
					'Please leave your name, number, and message after this, then press pound or hang up.',
			}),
			flowNode('goodbye', 'hang_up', 1960, 560, {
				label: 'Goodbye',
				message: 'Thanks for calling {business}. Goodbye!',
			}),
		],
		edges: [
			flowEdge('start', 'hours'),
			flowEdge('hours', 'main_menu', 'open'),
			flowEdge('hours', 'closed_menu', 'closed'),
			flowEdge('main_menu', 'ai', 'key_1'),
			flowEdge('main_menu', 'text_link', 'key_2'),
			flowEdge('main_menu', 'staff', 'key_3'),
			flowEdge('main_menu', 'staff', 'no_input'),
			flowEdge('closed_menu', 'text_link', 'key_1'),
			flowEdge('closed_menu', 'voicemail', 'key_2'),
			flowEdge('closed_menu', 'voicemail', 'no_input'),
			flowEdge('text_link', 'goodbye'),
			flowEdge('staff', 'voicemail', 'no_answer'),
			flowEdge('voicemail', 'goodbye'),
		],
	}
}

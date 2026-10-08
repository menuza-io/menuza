import { describe, expect, it } from 'vitest'
import {
	createDefaultFlowGraph,
	type FlowGraph,
	type FlowNode,
	flowOutputs,
	parseFlowGraph,
	validateFlowGraph,
} from './flow.ts'
import {
	fillMessage,
	findStartNode,
	matchMenuChoice,
	nextNode,
	parseMenuKey,
} from './runtime.ts'

function step(
	id: string,
	type: FlowNode['type'],
	data: Partial<FlowNode['data']> = {},
): FlowNode {
	return {
		id,
		type,
		position: { x: 0, y: 0 },
		data: { label: id, ...data },
	}
}

describe('validateFlowGraph', () => {
	it('accepts the default menu', () => {
		const graph = createDefaultFlowGraph()
		expect(validateFlowGraph(graph)).toEqual([])
		expect(parseFlowGraph(JSON.stringify(graph))).toEqual(graph)
	})

	it('reports missing, unknown, and unexpected outputs', () => {
		const graph: FlowGraph = {
			nodes: [
				step('start', 'start'),
				step('menu', 'keypad_menu', {
					message: 'Press 1 or 2',
					options: [
						{ key: '1', label: 'Assistant' },
						{ key: '2', label: 'Staff' },
					],
				}),
				step('ai', 'ai_agent'),
				step('hours', 'hours_check'),
				step('bye', 'hang_up'),
				step('orphan', 'play_message'),
			],
			edges: [
				{ id: 'e1', source: 'start', target: 'menu' },
				{ id: 'e2', source: 'menu', target: 'ai', sourceHandle: 'key_1' },
				{ id: 'e3', source: 'menu', target: 'bye', sourceHandle: 'key_5' },
				{ id: 'e4', source: 'menu', target: 'hours', sourceHandle: 'no_input' },
				{ id: 'e5', source: 'ai', target: 'bye' },
				{ id: 'e6', source: 'hours', target: 'bye', sourceHandle: 'open' },
				{
					id: 'e7',
					source: 'hours',
					target: 'missing',
					sourceHandle: 'closed',
				},
			],
		}
		const codes = validateFlowGraph(graph).map((issue) => issue.code)
		expect(codes).toEqual(
			expect.arrayContaining([
				'missing_output',
				'unknown_output',
				'unexpected_output',
				'dangling_edge',
				'missing_message',
				'unreachable',
			]),
		)
		const option2 = validateFlowGraph(graph).find((issue) =>
			issue.message.includes('option 2'),
		)
		expect(option2?.nodeId).toBe('menu')
	})

	it('flags duplicate keys, bad numbers, and loops that never wait', () => {
		const graph: FlowGraph = {
			nodes: [
				step('start', 'start'),
				step('a', 'play_message', { message: 'Hi' }),
				step('b', 'play_message', { message: 'Again' }),
				step('menu', 'keypad_menu', {
					message: 'Press 1',
					options: [
						{ key: '1', label: 'One' },
						{ key: '1', label: 'Also one' },
					],
				}),
				step('staff', 'transfer', { phone: '555-1234' }),
			],
			edges: [
				{ id: 'e1', source: 'start', target: 'a' },
				{ id: 'e2', source: 'a', target: 'b' },
				{ id: 'e3', source: 'b', target: 'a' },
			],
		}
		const codes = validateFlowGraph(graph).map((issue) => issue.code)
		expect(codes).toEqual(
			expect.arrayContaining([
				'instant_loop',
				'menu_duplicate_key',
				'invalid_phone',
			]),
		)
	})

	it('refuses transfers to numbers outside the US and Canada', () => {
		const transferTo = (phone: string): FlowGraph => ({
			nodes: [
				step('start', 'start'),
				step('staff', 'transfer', { phone }),
				step('bye', 'hang_up'),
			],
			edges: [
				{ id: 'e1', source: 'start', target: 'staff' },
				{
					id: 'e2',
					source: 'staff',
					target: 'bye',
					sourceHandle: 'no_answer',
				},
			],
		})
		const codes = (phone: string) =>
			validateFlowGraph(transferTo(phone)).map((issue) => issue.code)
		expect(codes('+442071234567')).toEqual(['unsupported_phone'])
		expect(codes('+18765550123')).toEqual(['unsupported_phone'])
		expect(codes('+12025550123')).toEqual([])
		expect(codes('+14165550123')).toEqual([])
	})

	it('allows menus to loop back to themselves through other steps', () => {
		const graph: FlowGraph = {
			nodes: [
				step('start', 'start'),
				step('menu', 'keypad_menu', {
					message: 'Press 1 to hear our hours',
					options: [{ key: '1', label: 'Hours' }],
				}),
				step('hours', 'play_message', { message: 'We open at 11.' }),
			],
			edges: [
				{ id: 'e1', source: 'start', target: 'menu' },
				{ id: 'e2', source: 'menu', target: 'hours', sourceHandle: 'key_1' },
				{ id: 'e3', source: 'hours', target: 'menu' },
			],
		}
		expect(validateFlowGraph(graph)).toEqual([])
	})
})

describe('flowOutputs', () => {
	it('gives keypad menus one output per option plus no input', () => {
		const outputs = flowOutputs(
			step('menu', 'keypad_menu', {
				options: [
					{ key: '1', label: 'Assistant' },
					{ key: '#', label: 'Repeat' },
				],
			}),
		)
		expect(outputs.map((output) => output.handle)).toEqual([
			'key_1',
			'key_hash',
			'no_input',
		])
	})
})

describe('runtime helpers', () => {
	const graph = createDefaultFlowGraph()

	it('follows outputs to the next step', () => {
		expect(findStartNode(graph).id).toBe('start')
		expect(nextNode(graph, 'hours', 'open')?.id).toBe('main_menu')
		expect(nextNode(graph, 'hours', 'closed')?.id).toBe('closed_menu')
		expect(nextNode(graph, 'main_menu', 'key_2')?.id).toBe('text_link')
		expect(nextNode(graph, 'main_menu', 'key_9')).toBeNull()
	})

	it('parses keypad digits', () => {
		expect(parseMenuKey('5')).toBe('5')
		expect(parseMenuKey('#')).toBe('#')
		expect(parseMenuKey('A')).toBeNull()
	})

	it('fills message placeholders and leaves unknown ones', () => {
		expect(
			fillMessage('Thanks for calling {Business} in {branch}. {other}', {
				business: 'Acme',
				branch: 'Downtown',
			}),
		).toBe('Thanks for calling Acme in Downtown. {other}')
	})

	it('uses only neutral wording in the default flow', () => {
		const text = JSON.stringify(graph)
		expect(text).toContain('{business}')
		expect(text).not.toMatch(/\border|restaurant|\{location\}/i)
		expect(graph.nodes.some((node) => node.type === 'text_link')).toBe(true)
	})
})

describe('matchMenuChoice', () => {
	const options = createDefaultFlowGraph().nodes.find(
		(node) => node.id === 'main_menu',
	)!.data.options!

	it('matches spoken numbers', () => {
		expect(matchMenuChoice(options, 'two')).toBe('2')
		expect(matchMenuChoice(options, 'Press 3 please')).toBe('3')
		expect(matchMenuChoice(options, 'option one')).toBe('1')
	})

	it('matches words from the label and keywords before numbers', () => {
		expect(matchMenuChoice(options, 'I have a question')).toBe('1')
		expect(matchMenuChoice(options, 'I need help with two things')).toBe('1')
		expect(matchMenuChoice(options, 'Can you text me the link?')).toBe('2')
		expect(matchMenuChoice(options, 'Let me talk to a manager')).toBe('3')
	})

	it('returns null when unsure', () => {
		expect(matchMenuChoice(options, 'hmm')).toBeNull()
		expect(matchMenuChoice(options, 'one or two')).toBeNull()
		expect(matchMenuChoice(options, '')).toBeNull()
	})

	it('matches Arabic-Indic digits and Arabic number words', () => {
		expect(matchMenuChoice(options, '٢')).toBe('2')
		expect(matchMenuChoice(options, 'رقم ۳ لو سمحت')).toBe('3')
		expect(matchMenuChoice(options, 'واحد')).toBe('1')
		expect(matchMenuChoice(options, 'إثنين')).toBe('2')
		expect(matchMenuChoice(options, 'اثنان')).toBe('2')
		expect(matchMenuChoice(options, 'ثلاثة')).toBe('3')
		expect(matchMenuChoice(options, 'ثلاثـــة')).toBe('3')
		expect(matchMenuChoice(options, 'ثَلَاثَة')).toBe('3')
		expect(matchMenuChoice(options, 'الخيار الأول')).toBe('1')
		expect(matchMenuChoice(options, 'واحد أو اثنين')).toBeNull()
	})

	it('matches Spanish number words', () => {
		expect(matchMenuChoice(options, 'el número tres, por favor')).toBe('3')
		expect(matchMenuChoice(options, 'opción dos')).toBe('2')
	})

	it('matches Arabic labels and keywords despite spelling variants', () => {
		const arabic = [
			{ key: '1' as const, label: 'الطلب', keywords: ['أطلب'] },
			{ key: '2' as const, label: 'التحدث مع موظف' },
			{ key: '9' as const, label: 'ساعات العمل' },
		]
		expect(matchMenuChoice(arabic, 'ابي اطلب')).toBe('1')
		expect(matchMenuChoice(arabic, 'طلب')).toBe('1')
		expect(matchMenuChoice(arabic, 'أريد التحدث مع موظّف')).toBe('2')
		expect(matchMenuChoice(arabic, 'ساعات')).toBe('9')
		expect(matchMenuChoice(arabic, 'تسعة')).toBe('9')
	})
})

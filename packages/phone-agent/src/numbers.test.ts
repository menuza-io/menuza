import { describe, expect, it } from 'vitest'
import { createDefaultFlowGraph, type FlowGraph } from './flow.ts'
import {
	agentLineNumbers,
	describeLineTransferLoop,
	findFlowTransferLoops,
	findLineTransferLoop,
	findSettingsTransferLoop,
	pickSafeTransferTarget,
	toE164,
} from './numbers.ts'

const lines = [
	{ e164: '+15550000001', forwardedFrom: '+15550000002' },
	{ e164: '+15550000003', forwardedFrom: null },
]

describe('findSettingsTransferLoop', () => {
	it('finds a staff phone that reaches the agent', () => {
		expect(
			findSettingsTransferLoop(
				{ escalationPhone: '+15550000002', contacts: [] },
				lines,
			),
		).toEqual({ kind: 'escalation', phone: '+15550000002' })
	})

	it('finds a transfer contact that reaches the agent', () => {
		expect(
			findSettingsTransferLoop(
				{
					escalationPhone: '+15559999999',
					contacts: [{ id: 'chef', name: 'Chef', phone: '+15550000003' }],
				},
				lines,
			),
		).toEqual({ kind: 'contact', phone: '+15550000003', name: 'Chef' })
	})

	it('allows numbers staff answer directly', () => {
		expect(
			findSettingsTransferLoop(
				{
					escalationPhone: '+15559999999',
					contacts: [{ id: 'chef', name: 'Chef', phone: '+15558888888' }],
				},
				lines,
			),
		).toBeNull()
	})
})

describe('findFlowTransferLoops', () => {
	function withTransferPhone(phone: string | undefined): FlowGraph {
		const graph = createDefaultFlowGraph()
		return {
			...graph,
			nodes: graph.nodes.map((node) =>
				node.type === 'transfer'
					? { ...node, data: { ...node.data, phone } }
					: node,
			),
		}
	}

	it('flags a transfer step that dials an agent line', () => {
		const issues = findFlowTransferLoops(
			withTransferPhone('+15550000001'),
			lines,
		)
		expect(issues).toHaveLength(1)
		expect(issues[0]).toMatchObject({ code: 'transfer_loop', nodeId: 'staff' })
	})

	it('ignores transfer steps without their own number', () => {
		expect(findFlowTransferLoops(withTransferPhone(undefined), lines)).toEqual(
			[],
		)
		expect(
			findFlowTransferLoops(withTransferPhone('+15557777777'), lines),
		).toEqual([])
	})
})

describe('toE164', () => {
	it('reads common North American formats', () => {
		expect(toE164('(555) 123-4567')).toBe('+15551234567')
		expect(toE164('555.123.4567')).toBe('+15551234567')
		expect(toE164('1 555 123 4567')).toBe('+15551234567')
		expect(toE164('+1 (555) 123-4567')).toBe('+15551234567')
		expect(toE164('+966 50 123 4567')).toBe('+966501234567')
	})

	it('rejects values that are not phone numbers', () => {
		expect(toE164(null)).toBeNull()
		expect(toE164('')).toBeNull()
		expect(toE164('123-4567')).toBeNull()
		expect(toE164('555-123-4567 ext 2')).toBeNull()
		expect(toE164('+0123')).toBeNull()
	})
})

describe('agentLineNumbers', () => {
	it('lists agent numbers and forwarded lines once each', () => {
		expect(
			agentLineNumbers([
				...lines,
				{ e164: '+15550000004', forwardedFrom: '(555) 000-0002' },
			]),
		).toEqual(['+15550000001', '+15550000002', '+15550000003', '+15550000004'])
	})
})

describe('pickSafeTransferTarget', () => {
	const agentLines = agentLineNumbers(lines)

	it('skips candidates that reach the agent', () => {
		expect(
			pickSafeTransferTarget(['555-000-0002', '+15559999999'], agentLines),
		).toBe('+15559999999')
	})

	it('skips empty and unreadable candidates', () => {
		expect(
			pickSafeTransferTarget([null, 'front desk', '+15558888888'], agentLines),
		).toBe('+15558888888')
	})

	it('returns null when every candidate loops back', () => {
		expect(
			pickSafeTransferTarget(['+15550000001', '+15550000002'], agentLines),
		).toBeNull()
		expect(pickSafeTransferTarget([], agentLines)).toBeNull()
	})
})

describe('findLineTransferLoop', () => {
	const settings = { escalationPhone: '+15559999999', contacts: [] }

	function withTransferPhone(phone: string): FlowGraph {
		const graph = createDefaultFlowGraph()
		return {
			...graph,
			nodes: graph.nodes.map((node) =>
				node.type === 'transfer'
					? { ...node, data: { ...node.data, phone } }
					: node,
			),
		}
	}

	it('flags a published transfer step that dials the new line', () => {
		const loop = findLineTransferLoop(
			{ settings, graph: withTransferPhone('+15551112222') },
			[{ e164: '+15550000009', forwardedFrom: '+15551112222' }],
		)
		expect(loop).toMatchObject({ kind: 'flow', nodeId: 'staff' })
		expect(describeLineTransferLoop(loop!)).toContain('published phone menu')
	})

	it('flags the staff phone before the flow', () => {
		expect(
			findLineTransferLoop(
				{ settings, graph: withTransferPhone('+15551112222') },
				[{ e164: '+15550000009', forwardedFrom: '+15559999999' }],
			),
		).toEqual({ kind: 'escalation', phone: '+15559999999' })
	})

	it('allows a line no transfer dials', () => {
		expect(
			findLineTransferLoop(
				{ settings, graph: withTransferPhone('+15553334444') },
				[{ e164: '+15550000009', forwardedFrom: '+15551112222' }],
			),
		).toBeNull()
		expect(
			findLineTransferLoop({ settings, graph: null }, [
				{ e164: '+15550000009', forwardedFrom: '+15551112222' },
			]),
		).toBeNull()
	})
})

import { describe, expect, it } from 'vitest'
import {
	hasDuplicateMenuKeys,
	remapMenuOptionEdges,
	type FlowEditorEdge,
} from './flow-model.ts'

function edge(
	id: string,
	source: string,
	sourceHandle: string | null,
): FlowEditorEdge {
	return { id, source, target: 'next', sourceHandle, type: 'flow', data: {} }
}

const edges = [
	edge('e1', 'menu', 'key_1'),
	edge('e2', 'menu', 'key_2'),
	edge('e3', 'menu', 'no_input'),
	edge('e4', 'other', 'key_1'),
]

describe('remapMenuOptionEdges', () => {
	it('moves the edge when an option is re-keyed', () => {
		const result = remapMenuOptionEdges(
			edges,
			'menu',
			[
				{ key: '1', label: 'Sales' },
				{ key: '2', label: 'Staff' },
			],
			[
				{ key: '3', label: 'Sales' },
				{ key: '2', label: 'Staff' },
			],
		)
		expect(result.map((e) => [e.id, e.sourceHandle])).toEqual([
			['e1', 'key_3'],
			['e2', 'key_2'],
			['e3', 'no_input'],
			['e4', 'key_1'],
		])
	})

	it('maps the special keys to their handles', () => {
		const result = remapMenuOptionEdges(
			[edge('e1', 'menu', 'key_1')],
			'menu',
			[{ key: '1', label: 'Sales' }],
			[{ key: '#', label: 'Sales' }],
		)
		expect(result[0]?.sourceHandle).toBe('key_hash')
	})

	it("drops a removed option's edge and keeps the others", () => {
		const result = remapMenuOptionEdges(
			edges,
			'menu',
			[
				{ key: '1', label: 'Sales' },
				{ key: '2', label: 'Staff' },
			],
			[{ key: '2', label: 'Staff' }],
		)
		expect(result.map((e) => e.id)).toEqual(['e2', 'e3', 'e4'])
	})

	it('returns the same array when nothing changes', () => {
		const options = [{ key: '1' as const, label: 'Sales' }]
		expect(remapMenuOptionEdges(edges, 'menu', options, options)).toBe(edges)
		expect(
			remapMenuOptionEdges(edges, 'menu', options, [
				...options,
				{ key: '4', label: 'Hours' },
			]),
		).toBe(edges)
	})
})

describe('hasDuplicateMenuKeys', () => {
	it('detects repeated keys', () => {
		expect(
			hasDuplicateMenuKeys([
				{ key: '1', label: 'A' },
				{ key: '1', label: 'B' },
			]),
		).toBe(true)
		expect(
			hasDuplicateMenuKeys([
				{ key: '1', label: 'A' },
				{ key: '2', label: 'B' },
			]),
		).toBe(false)
	})
})

import { type Edge, type Node } from '@xyflow/react'
import { describe, expect, it } from 'vitest'
import { validateFlowCanvas } from './validation.ts'

describe('validateFlowCanvas', () => {
	it('rejects an empty canvas', () => {
		const validation = validateFlowCanvas([], [])
		expect(validation.valid).toBe(false)
		expect(validation.errors.some((error) => error.includes('Trigger'))).toBe(
			true,
		)
	})

	it('detects cyclic dependencies', () => {
		const nodes: Node[] = [
			{
				id: 't1',
				type: 'trigger',
				position: { x: 0, y: 0 },
				data: { triggerType: 'phone_verified' },
			},
			{
				id: 'd1',
				type: 'delay',
				position: { x: 0, y: 100 },
				data: { duration: 5, unit: 'minutes' },
			},
			{
				id: 'e1',
				type: 'action_email',
				position: { x: 0, y: 200 },
				data: { subject: 'Hi', bodyHtml: '<p>Hey</p>' },
			},
			{
				id: 's1',
				type: 'action_sms',
				position: { x: 0, y: 300 },
				data: { messageText: 'SMS' },
			},
		]
		const edges: Edge[] = [
			{ id: 'edge1', source: 't1', target: 'd1' },
			{ id: 'edge2', source: 'd1', target: 'e1' },
			{ id: 'edge3', source: 'e1', target: 's1' },
			{ id: 'edge4', source: 's1', target: 'd1' },
		]

		const validation = validateFlowCanvas(nodes, edges)
		expect(validation.valid).toBe(false)
		expect(validation.hasCycles).toBe(true)
		expect(
			validation.errors.some((error) => error.toLowerCase().includes('cycle')),
		).toBe(true)
	})

	it('detects missing trigger node', () => {
		const nodes: Node[] = [
			{
				id: 'd1',
				type: 'delay',
				position: { x: 0, y: 100 },
				data: { duration: 5, unit: 'minutes' },
			},
			{
				id: 'e1',
				type: 'action_email',
				position: { x: 0, y: 200 },
				data: { subject: 'Hi', bodyHtml: '<p>Hey</p>' },
			},
		]
		const edges: Edge[] = [{ id: 'edge1', source: 'd1', target: 'e1' }]

		const validation = validateFlowCanvas(nodes, edges)
		expect(validation.valid).toBe(false)
		expect(
			validation.errors.some((error) =>
				error.toLowerCase().includes('trigger'),
			),
		).toBe(true)
	})

	it('detects multiple trigger nodes', () => {
		const nodes: Node[] = [
			{
				id: 't1',
				type: 'trigger',
				position: { x: 0, y: 0 },
				data: { triggerType: 'phone_verified' },
			},
			{
				id: 't2',
				type: 'trigger',
				position: { x: 200, y: 0 },
				data: { triggerType: 'profile_completed' },
			},
			{
				id: 'e1',
				type: 'action_email',
				position: { x: 100, y: 200 },
				data: { subject: 'Hi', bodyHtml: '<p>Hey</p>' },
			},
		]
		const edges: Edge[] = [
			{ id: 'edge1', source: 't1', target: 'e1' },
			{ id: 'edge2', source: 't2', target: 'e1' },
		]

		const validation = validateFlowCanvas(nodes, edges)
		expect(validation.valid).toBe(false)
		expect(
			validation.errors.some((error) =>
				error.toLowerCase().includes('trigger'),
			),
		).toBe(true)
	})

	it('flags node-specific validation errors', () => {
		const nodes: Node[] = [
			{
				id: 't1',
				type: 'trigger',
				position: { x: 0, y: 0 },
				data: { triggerType: '' },
			},
			{
				id: 'd1',
				type: 'delay',
				position: { x: 0, y: 100 },
				data: { duration: 0, unit: '' },
			},
			{
				id: 'e1',
				type: 'action_email',
				position: { x: 0, y: 200 },
				data: { subject: '', bodyHtml: '' },
			},
			{
				id: 's1',
				type: 'action_sms',
				position: { x: 0, y: 300 },
				data: { messageText: 'a'.repeat(1601) },
			},
			{
				id: 'c1',
				type: 'condition',
				position: { x: 0, y: 400 },
				data: { field: '', operator: '' },
			},
		]

		const validation = validateFlowCanvas(nodes, [])
		expect(validation.valid).toBe(false)
		expect(validation.nodeErrors.t1).toBeDefined()
		expect(validation.nodeErrors.d1).toBeDefined()
		expect(validation.nodeErrors.e1).toBeDefined()
		expect(validation.nodeErrors.s1).toBeDefined()
		expect(validation.nodeErrors.c1).toBeDefined()
	})

	it('pairs the {{couponCode}} tag with a coupon on the step', () => {
		const step = (id: string, data: Record<string, unknown>): Node => ({
			id,
			type: 'action_sms',
			position: { x: 0, y: 0 },
			data,
		})
		const offer = {
			mode: 'unique',
			discountId: 'd1',
			prefix: '',
			validDays: 30,
		}
		const { nodeErrors } = validateFlowCanvas(
			[
				step('tagOnly', { messageText: 'Code {{couponCode}}' }),
				step('offerOnly', { messageText: 'Hello', discountOffer: offer }),
				step('both', {
					messageText: 'Code {{couponCode}}',
					discountOffer: offer,
				}),
			],
			[],
		)
		expect(nodeErrors.tagOnly?.[0]).toMatch(/Choose a coupon/)
		expect(nodeErrors.offerOnly?.[0]).toMatch(/Add the Coupon code tag/)
		expect(nodeErrors.both).toBeUndefined()
	})

	it('accepts a valid linear workflow', () => {
		const nodes: Node[] = [
			{
				id: 't1',
				type: 'trigger',
				position: { x: 0, y: 0 },
				data: { triggerType: 'phone_verified' },
			},
			{
				id: 'd1',
				type: 'delay',
				position: { x: 0, y: 100 },
				data: { duration: 1, unit: 'hours' },
			},
			{
				id: 'e1',
				type: 'action_email',
				position: { x: 0, y: 200 },
				data: { subject: 'Welcome', bodyHtml: '<p>Hi</p>' },
			},
		]
		const edges: Edge[] = [
			{ id: 'edge1', source: 't1', target: 'd1' },
			{ id: 'edge2', source: 'd1', target: 'e1' },
		]

		const validation = validateFlowCanvas(nodes, edges)
		expect(validation.valid).toBe(true)
		expect(validation.errors).toHaveLength(0)
	})
})

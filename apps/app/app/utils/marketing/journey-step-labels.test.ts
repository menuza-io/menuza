import { describe, expect, it } from 'vitest'
import { journeyStepLabels } from './journey-step-labels.ts'

describe('journeyStepLabels (#115)', () => {
	it('names steps by what they send', () => {
		const labels = journeyStepLabels(
			JSON.stringify({
				nodes: [
					{ id: 't', type: 'trigger', data: {} },
					{ id: 'e1', type: 'action_email', data: { subject: 'Welcome in' } },
					{
						id: 's1',
						type: 'action_sms',
						data: { messageText: 'x'.repeat(100) },
					},
					{ id: 'p1', type: 'action_push', data: { title: 'Hot now' } },
				],
			}),
		)
		expect(labels.map((l) => [l.nodeId, l.type, l.summary.length])).toEqual([
			['t', 'trigger', 0],
			['e1', 'action_email', 'Welcome in'.length],
			['s1', 'action_sms', 48],
			['p1', 'action_push', 'Hot now'.length],
		])
		expect(labels[2]!.summary.endsWith('…')).toBe(true)
	})

	it('gives no labels for a graph it cannot read', () => {
		expect(journeyStepLabels(undefined)).toEqual([])
		expect(journeyStepLabels('not json')).toEqual([])
		expect(journeyStepLabels('{"nodes":5}')).toEqual([])
	})
})

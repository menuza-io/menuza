import { describe, expect, it } from 'vitest'
import { evaluatePacing } from './pacing.ts'

const T = Date.parse('2030-01-01T19:00:00Z')
const MIN = 60_000

const base = {
	serviceId: 's',
	slotMin: 19 * 60,
	durationMin: 90,
	partySize: 4,
	channel: 'host' as const,
	rules: [{ serviceId: 's', concurrentCoversCap: 8 }],
}

describe('evaluatePacing concurrency units', () => {
	it('flags overlapping covers over the concurrent cap using epoch instants', () => {
		const res = evaluatePacing({
			...base,
			startAt: T + 30 * MIN,
			endAt: T + 120 * MIN,
			existing: [
				{
					id: 'a',
					serviceId: 's',
					partySize: 6,
					localStartMin: 19 * 60,
					startAt: T,
					endAt: T + 90 * MIN,
				},
			],
		})
		expect(res.warnings).toContain('concurrent_covers_exceeded')
	})

	it('throws when minutes are passed where epoch ms is expected', () => {
		expect(() =>
			evaluatePacing({
				...base,
				startAt: base.slotMin * MIN,
				existing: [],
			}),
		).toThrow(/epoch-ms/)
	})
})

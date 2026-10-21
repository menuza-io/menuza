import { describe, expect, it } from 'vitest'
import { resolveServices } from './services.ts'

describe('services barrel export', () => {
	it('re-exports resolveServices and resolves weekly and special-day services', () => {
		const out = resolveServices(
			'2026-06-10',
			[
				{
					id: 'srv_dinner',
					name: 'Dinner',
					slug: 'dinner',
					color: '#3B82F6',
					daysOfWeek: [3],
					startMin: 1080,
					endMin: 1380,
					lastSeatingMin: 1320,
					onlineBookable: true,
					sortOrder: 0,
					active: true,
				},
			],
			[],
		)
		expect(out.closed).toBe(false)
		expect(out.services).toHaveLength(1)
		expect(out.services[0]?.id).toBe('srv_dinner')
	})
})

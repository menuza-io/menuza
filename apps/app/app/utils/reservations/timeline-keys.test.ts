import { describe, expect, it } from 'vitest'
import { barKeyAction } from './timeline-keys.ts'

const base = { grabbed: false, canManage: true, onBar: true }

describe('timeline bar keyboard', () => {
	it('Enter opens the booking, Space or M picks it up', () => {
		expect(barKeyAction({ ...base, key: 'Enter' })).toBe('open')
		expect(barKeyAction({ ...base, key: ' ' })).toBe('grab')
		expect(barKeyAction({ ...base, key: 'm' })).toBe('grab')
		expect(barKeyAction({ ...base, key: 'M' })).toBe('grab')
	})

	it('a viewer who cannot manage can still open the booking from the keyboard', () => {
		const viewer = { ...base, canManage: false }
		expect(barKeyAction({ ...viewer, key: 'Enter' })).toBe('open')
		expect(barKeyAction({ ...viewer, key: ' ' })).toBe('open')
		expect(barKeyAction({ ...viewer, key: 'm' })).toBe('ignore')
	})

	it('while picked up, Enter or Space drops, Escape cancels, arrows move', () => {
		const held = { ...base, grabbed: true }
		expect(barKeyAction({ ...held, key: 'Enter' })).toBe('drop')
		expect(barKeyAction({ ...held, key: ' ' })).toBe('drop')
		expect(barKeyAction({ ...held, key: 'Escape' })).toBe('cancel')
		expect(barKeyAction({ ...held, key: 'ArrowLeft' })).toBe('move')
		expect(barKeyAction({ ...held, key: 'a' })).toBe('ignore')
	})

	it('ignores a key that came from a control inside the bar', () => {
		for (const key of ['Enter', ' ', 'm', 'Escape', 'ArrowDown']) {
			expect(barKeyAction({ ...base, key, onBar: false })).toBe('ignore')
			expect(barKeyAction({ ...base, key, onBar: false, grabbed: true })).toBe(
				'ignore',
			)
		}
	})
})

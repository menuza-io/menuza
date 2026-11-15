import { describe, expect, it, vi } from 'vitest'
import {
	UPSELL_EVENT,
	createShownCounter,
	readUpsellCounts,
	recordUpsell,
} from './upsell-stats.ts'

function memory() {
	const map = new Map<string, string>()
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => {
			map.set(key, value)
		},
		map,
	}
}

describe('upsell counts', () => {
	it('counts shown and added per dish id, per restaurant', () => {
		const storage = memory()
		recordUpsell('org', 'cola', 'shown', storage, null)
		recordUpsell('org', 'cola', 'shown', storage, null)
		recordUpsell('org', 'cola', 'added', storage, null)
		recordUpsell('org', 'fries', 'shown', storage, null)
		recordUpsell('other', 'cola', 'added', storage, null)
		expect(readUpsellCounts('org', storage)).toEqual({
			cola: { shown: 2, added: 1 },
			fries: { shown: 1, added: 0 },
		})
		expect(readUpsellCounts('other', storage)).toEqual({
			cola: { shown: 0, added: 1 },
		})
	})

	it('stores only dish ids and counts, nothing that names a person', () => {
		const storage = memory()
		recordUpsell('org', 'cola', 'added', storage, null)
		const [stored] = [...storage.map.values()]
		expect(JSON.parse(stored!)).toEqual({ cola: { shown: 0, added: 1 } })
	})

	it('announces each count as an event with the dish id and the action', () => {
		const target = { dispatchEvent: vi.fn(() => true) }
		recordUpsell('org', 'cola', 'added', memory(), target)
		const event = (
			target.dispatchEvent.mock.calls[0] as unknown as [CustomEvent]
		)[0]
		expect(event.type).toBe(UPSELL_EVENT)
		expect(event.detail).toEqual({ itemId: 'cola', action: 'added' })
	})

	it('survives a missing, broken or full store', () => {
		expect(readUpsellCounts('org', null)).toEqual({})
		expect(
			readUpsellCounts('org', { getItem: () => '{not json', setItem: () => {} }),
		).toEqual({})
		const full = {
			getItem: () => null,
			setItem: () => {
				throw new Error('quota')
			},
		}
		const target = { dispatchEvent: vi.fn(() => true) }
		expect(() =>
			recordUpsell('org', 'cola', 'shown', full, target),
		).not.toThrow()
		expect(target.dispatchEvent).toHaveBeenCalled()
	})

	it('ignores nonsense counts when reading', () => {
		const storage = memory()
		storage.setItem(
			'menuza_upsell_org',
			JSON.stringify({
				cola: { shown: -3, added: 'x' },
				fries: { shown: 2.9, added: 1 },
			}),
		)
		expect(readUpsellCounts('org', storage)).toEqual({
			cola: { shown: 0, added: 0 },
			fries: { shown: 2, added: 1 },
		})
	})
})

describe('createShownCounter', () => {
	it('counts a dish as shown once however often the row repaints', () => {
		const record = vi.fn()
		const shown = createShownCounter(record)
		shown(['a', 'b'])
		shown(['a', 'b', 'c'])
		shown(['c'])
		expect(record.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c'])
	})
})

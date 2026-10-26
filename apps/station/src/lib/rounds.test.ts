import { describe, expect, it } from 'vitest'
import { sendLines } from './orders.ts'
import { type CartLine } from './pricing.ts'
import { roundsOf, unsentCount } from './rounds.ts'

const line = (id: string, sentAt?: number, quantity = 1): CartLine => ({
	id,
	itemId: `item-${id}`,
	name: id,
	variantId: null,
	variantLabel: null,
	quantity,
	baseCents: 500,
	instructions: '',
	options: [],
	sentAt,
})

describe('kitchen rounds on a tab', () => {
	it('groups lines by the save that sent them, oldest first, unsent last', () => {
		const rounds = roundsOf([
			line('b', 2_000),
			line('new', undefined, 2),
			line('a', 1_000),
			line('c', 2_000),
		])
		expect(rounds.map((r) => [r.sentAt, r.lines.map((l) => l.id)])).toEqual([
			[1_000, ['a']],
			[2_000, ['b', 'c']],
			[null, ['new']],
		])
		expect(unsentCount(rounds.flatMap((r) => r.lines))).toBe(2)
	})

	it('has no rounds for an empty order, and one unsent round for a new one', () => {
		expect(roundsOf([])).toEqual([])
		expect(roundsOf([line('a')])).toEqual([
			{ sentAt: null, lines: [line('a')] },
		])
	})

	it('stamps only what was not sent yet when a tab is saved', () => {
		const lines = sendLines([line('old', 1_000), line('new')], 5_000)
		expect(lines.map((l) => l.sentAt)).toEqual([1_000, 5_000])
	})
})

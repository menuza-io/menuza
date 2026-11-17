import { describe, expect, it } from 'vitest'
import {
	serializePublicMenuItem,
	serializePublicModifierGroup,
	serializePublicOption,
} from './public-serializers.server.ts'

/**
 * The cap of a dish or option (#409) is what the kitchen prepares: it reaches
 * the region through the order context only. The public menu Sites publishes
 * must never carry it, not even for a dish that has one.
 */

const CAP = JSON.stringify({
	limit: 20,
	showRemaining: true,
	byLocation: { a: 7 },
})
const NOW = new Date('2026-03-10T12:00:00Z')

const itemRow = {
	id: 'item_1',
	displayName: 'Special',
	internalName: null,
	description: null,
	price: 10,
	variations: JSON.stringify({ groups: [], variants: [] }),
	imageKey: null,
	imageKeys: '[]',
	allergens: '[]',
	availabilityStatus: 'available',
	unavailableUntil: null,
	dailySaleLimit: CAP,
	position: 0,
} as never

const optionRow = {
	id: 'opt_1',
	displayName: 'Dessert',
	internalName: null,
	description: null,
	imageKey: null,
	price: 2,
	allergens: '[]',
	nestedModifierGroupIds: '[]',
	availabilityStatus: 'available',
	unavailableUntil: null,
	dailySaleLimit: CAP,
	position: 0,
} as never

describe('the public menu never carries a daily limit', () => {
	it('leaves it out of a dish', () => {
		const item = serializePublicMenuItem(itemRow, [], new Map(), NOW)
		const json = JSON.stringify(item)
		expect(json).not.toContain('dailySaleLimit')
		expect(json).not.toContain('showRemaining')
		expect(json).not.toContain('"limit"')
		expect(item).not.toHaveProperty('dailySaleLimit')
	})

	it('leaves it out of an option and of a group with that option', () => {
		const option = serializePublicOption(optionRow, new Map(), NOW)
		expect(option).not.toHaveProperty('dailySaleLimit')
		const group = serializePublicModifierGroup(
			{
				id: 'grp_1',
				name: 'Side',
				internalName: null,
				selectionType: 'single',
				minSelections: 0,
				maxSelections: 1,
				availabilityStatus: 'available',
				unavailableUntil: null,
				position: 0,
			} as never,
			[option],
			NOW,
		)
		const json = JSON.stringify(group)
		expect(json).not.toContain('dailySaleLimit')
		expect(json).not.toContain('showRemaining')
	})
})

import { describe, expect, it } from 'vitest'
import { cloverWire } from '../../src/pos/wire'

describe('Clover modifier import wire', () => {
	it('decodes nested modifier groups and options from expanded payloads', () => {
		const decoded = cloverWire.decode({
			id: 'ITEM1',
			name: 'Burger',
			price: 1200,
			available: true,
			categories: { elements: [{ name: 'Mains' }] },
			modifierGroups: {
				elements: [
					{
						id: 'MG1',
						name: 'Add-ons',
						minRequired: 0,
						maxAllowed: 3,
						modifiers: {
							elements: [
								{ id: 'MOD1', name: 'Bacon', price: 150, available: true },
								{ id: 'MOD2', name: 'Cheese', price: 100, available: true },
							],
						},
					},
				],
			},
		})
		expect(decoded.modifierGroups).toHaveLength(1)
		expect(decoded.modifierGroups[0]?.id).toBe('MG1')
		expect(decoded.modifierGroups[0]?.options).toHaveLength(2)
		expect(decoded.modifierGroups[0]?.options[0]?.id).toBe('MOD1')
		expect(decoded.modifierGroups[0]?.options[0]?.name).toBe('Bacon')
	})
})

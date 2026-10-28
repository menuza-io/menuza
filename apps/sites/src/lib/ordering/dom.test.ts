// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { quantityLabel } from './dom.ts'

describe('quantityLabel', () => {
	it('isolates the dish name so it never reorders the quantity', () => {
		const node = quantityLabel(2, 'Flat white', 'min-w-0')
		expect(node.className).toBe('min-w-0')
		expect(node.textContent).toBe('2× Flat white')
		const bdi = node.querySelector('bdi')
		expect(bdi?.textContent).toBe('Flat white')
		expect(node.firstChild?.textContent).toBe('2× ')
	})
})

import { i18n } from '@lingui/core'
import { INVENTORY_NOTIFY_KINDS } from '@repo/inventory'
import { beforeAll, describe, expect, it } from 'vitest'
import { inventoryAlertCopy } from './alert-copy.ts'

beforeAll(() => {
	i18n.load('en', {})
	i18n.activate('en')
})

const translate = (message: { id: string; message: string }) =>
	i18n._(message as never)

describe('inventory alert wording', () => {
	it('says how many, with the right singular and plural', () => {
		expect(
			inventoryAlertCopy('inventory_low_stock', 1, translate).subject,
		).toBe('1 item is below the level you order at')
		expect(
			inventoryAlertCopy('inventory_low_stock', 3, translate).subject,
		).toBe('3 items are below the level you order at')
	})

	it('has a subject and a next step for every kind, and names nothing', () => {
		for (const kind of INVENTORY_NOTIFY_KINDS) {
			const copy = inventoryAlertCopy(kind, 2, translate)
			expect(copy.subject).toMatch(/2/)
			expect(copy.body.length).toBeGreaterThan(5)
			expect(`${copy.subject}${copy.body}`).not.toMatch(/undefined|NaN|\{/)
		}
	})

	it('adds the location when there is one', () => {
		expect(
			inventoryAlertCopy('inventory_count_review', 1, translate, 'Olaya').body,
		).toContain('Olaya')
	})

	it('treats a missing or odd count as one', () => {
		for (const count of [Number.NaN, 0, -3, 0.4]) {
			expect(
				inventoryAlertCopy('inventory_price_rise', count, translate).subject,
			).toMatch(/^1 item went up/)
		}
	})
})

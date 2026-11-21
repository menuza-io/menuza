import { describe, expect, it } from 'vitest'
import {
	MENU_POPULAR_MAX_ITEM_IDS,
	MENU_POPULAR_MIN_SOLD,
	MENU_POPULAR_PATH,
	MENU_POPULAR_WINDOW_DAYS,
	menuPopularPayloadSchema,
	POPULAR_MODES,
} from './menu-popular.ts'

describe('menu-popular', () => {
	it('exports expected constants', () => {
		expect(MENU_POPULAR_PATH).toBe('/resources/menu/popular')
		expect(MENU_POPULAR_WINDOW_DAYS).toBe(28)
		expect(MENU_POPULAR_MIN_SOLD).toBe(20)
		expect(POPULAR_MODES).toEqual(['auto', 'always', 'never'])
	})

	it('accepts valid ids-only payloads', () => {
		expect(
			menuPopularPayloadSchema.parse({
				itemIds: ['item-1', 'item-2'],
				windowDays: MENU_POPULAR_WINDOW_DAYS,
			}),
		).toEqual({
			itemIds: ['item-1', 'item-2'],
			windowDays: 28,
		})

		expect(
			menuPopularPayloadSchema.parse({
				orgId: 'org-1',
				itemIds: [],
				windowDays: 28,
			}),
		).toEqual({
			orgId: 'org-1',
			itemIds: [],
			windowDays: 28,
		})
	})

	it('rejects extra fields (counts, PII) and oversized itemIds', () => {
		expect(
			menuPopularPayloadSchema.safeParse({
				itemIds: ['item-1'],
				windowDays: 28,
				counts: { 'item-1': 50 },
			}).success,
		).toBe(false)

		expect(
			menuPopularPayloadSchema.safeParse({
				itemIds: ['item-1'],
				windowDays: 28,
				customerName: 'Ali',
			}).success,
		).toBe(false)

		expect(
			menuPopularPayloadSchema.safeParse({
				itemIds: Array.from(
					{ length: MENU_POPULAR_MAX_ITEM_IDS + 1 },
					(_, i) => `item-${i}`,
				),
				windowDays: 28,
			}).success,
		).toBe(false)

		expect(
			menuPopularPayloadSchema.safeParse({
				itemIds: ['item-1'],
				windowDays: 0,
			}).success,
		).toBe(false)
	})
})

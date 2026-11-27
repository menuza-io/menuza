import { describe, expect, it } from 'vitest'
import {
	MENU_FILE_VERSION,
	menuFileContentKey,
	parseMenuFile,
	serializeMenuFile,
	type MenuFileRecord,
} from './menu-file.ts'

const records: MenuFileRecord = {
	menus: [
		{
			id: 'menu',
			displayName: '{"en":"Lunch"}',
			internalName: null,
			menuType: 'online_pos_kiosk',
			nutritionalInfo: true,
			calorieDisplay: null,
			specialInstructions: true,
			availabilityStatus: 'available',
			channels: '["web"]',
			position: 0,
		},
	],
	categories: [
		{
			id: 'cat',
			displayName: '{"en":"Mains"}',
			internalName: null,
			description: null,
			parentId: null,
			availabilityStatus: 'available',
			channels: '["web"]',
			position: 0,
		},
	],
	items: [
		{
			id: 'item',
			displayName: '{"en":"Soup"}',
			internalName: null,
			description: null,
			price: 8,
			imageUrl: 'https://example.com/soup.jpg',
			variations: '{"groups":[],"variants":[]}',
			dietaryTags: '["vegan"]',
			allergens: '["gluten"]',
			calorieMin: 120,
			calorieMax: 140,
			barcode: '1234567890123',
			availabilityStatus: 'available',
			channels: '["web"]',
			position: 0,
			isAlcohol: false,
			isPopular: false,
			isUpsell: false,
		},
	],
	modifierGroups: [],
	options: [],
	menuCategories: [{ menuId: 'menu', categoryId: 'cat', position: 0 }],
	categoryItems: [{ categoryId: 'cat', itemId: 'item', position: 0 }],
	itemGroups: [],
	groupOptions: [],
}

describe('menu file', () => {
	it('serializes every record and refuses an unknown version', () => {
		const file = serializeMenuFile(records, '2026-11-26T00:00:00.000Z')
		expect(file.version).toBe(MENU_FILE_VERSION)
		expect(file.items[0]?.barcode).toBe('1234567890123')
		expect(file.items[0]?.imageUrl).toBe('https://example.com/soup.jpg')
		expect(file).not.toHaveProperty('posLinks')
		const parsed = parseMenuFile(JSON.stringify(file))
		expect(parsed.ok).toBe(true)
		if (parsed.ok)
			expect(menuFileContentKey(parsed.file)).toBe(menuFileContentKey(file))
		const unknown = parseMenuFile(JSON.stringify({ ...file, version: 99 }))
		expect(unknown).toMatchObject({ ok: false, error: 'unsupported_version' })
	})

	it('refuses a file over 5 MB', () => {
		const huge = parseMenuFile(' '.repeat(5 * 1024 * 1024 + 1))
		expect(huge).toMatchObject({ ok: false, error: 'too_large' })
	})
})

import { describe, expect, test } from 'vitest'
import {
	foldInventoryFeatures,
	INVENTORY_FEATURES_OFF,
	INVENTORY_FLAG_KEY_LIST,
	readInventoryFeatures,
} from './flags.ts'

describe('inventory flags', () => {
	test('keys are namespaced and unique', () => {
		expect(new Set(INVENTORY_FLAG_KEY_LIST).size).toBe(
			INVENTORY_FLAG_KEY_LIST.length,
		)
		for (const key of INVENTORY_FLAG_KEY_LIST) {
			expect(key.startsWith('inventory.')).toBe(true)
		}
	})

	test('only a literal true turns a flag on', () => {
		for (const value of ['true', 1, 'yes', {}, null, undefined]) {
			expect(foldInventoryFeatures({ enabled: value }).enabled).toBe(false)
		}
		expect(foldInventoryFeatures({ enabled: true }).enabled).toBe(true)
	})

	test('children need the master flag', () => {
		expect(
			foldInventoryFeatures({
				enabled: false,
				purchasing: true,
				recipes: true,
				prep: true,
				transfers: true,
			}),
		).toEqual(INVENTORY_FEATURES_OFF)
		expect(foldInventoryFeatures({ enabled: true, recipes: true })).toEqual({
			enabled: true,
			purchasing: false,
			recipes: true,
			prep: false,
			transfers: false,
		})
	})

	test('untrusted payloads read as all off', () => {
		expect(readInventoryFeatures(null)).toEqual(INVENTORY_FEATURES_OFF)
		expect(readInventoryFeatures({ enabled: true })).toEqual(
			INVENTORY_FEATURES_OFF,
		)
		expect(
			readInventoryFeatures({
				enabled: false,
				purchasing: true,
				recipes: false,
				prep: false,
				transfers: false,
			}),
		).toEqual(INVENTORY_FEATURES_OFF)
	})
})

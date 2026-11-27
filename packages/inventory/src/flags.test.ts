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
				useBy: true,
				voiceCounts: true,
				invoiceInbox: true,
				routines: true,
			}),
		).toEqual(INVENTORY_FEATURES_OFF)
		expect(foldInventoryFeatures({ enabled: true, recipes: true })).toEqual({
			enabled: true,
			purchasing: false,
			recipes: true,
			prep: false,
			transfers: false,
			useBy: false,
			voiceCounts: false,
			invoiceInbox: false,
			routines: false,
		})
	})

	test('the freshness flags are additive: an older context has none and reads as off', () => {
		const older = {
			enabled: true,
			purchasing: true,
			recipes: true,
			prep: true,
			transfers: true,
		}
		expect(readInventoryFeatures(older)).toMatchObject({
			enabled: true,
			purchasing: true,
			useBy: false,
			voiceCounts: false,
			invoiceInbox: false,
			routines: false,
		})
		expect(
			readInventoryFeatures({ ...older, useBy: true, routines: true }),
		).toMatchObject({ useBy: true, voiceCounts: false, routines: true })
		expect(
			readInventoryFeatures({ ...older, enabled: false, useBy: true }),
		).toEqual(INVENTORY_FEATURES_OFF)
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

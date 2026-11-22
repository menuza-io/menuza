import { describe, expect, it } from 'vitest'
import {
	photoTestBeaconKey,
	verifyPhotoTestBeaconKey,
} from './photo-test-key.ts'

const SECRET = 'operator-secret-operator-secret'
const IDS = {
	organizationId: 'org_12345678',
	testId: 'test_12345678',
	itemId: 'item-1',
}

describe('photo test beacon key', () => {
	it('is stable and verifies', async () => {
		const key = await photoTestBeaconKey(SECRET, IDS)
		expect(key).toHaveLength(32)
		expect(await photoTestBeaconKey(SECRET, IDS)).toBe(key)
		expect(await verifyPhotoTestBeaconKey(SECRET, IDS, key)).toBe(true)
	})
	it('refuses another organization, test, dish, secret or a forged key', async () => {
		const key = await photoTestBeaconKey(SECRET, IDS)
		for (const other of [
			{ ...IDS, organizationId: 'org_other_9999' },
			{ ...IDS, testId: 'test_other_999' },
			{ ...IDS, itemId: 'item-2' },
		]) {
			expect(await verifyPhotoTestBeaconKey(SECRET, other, key)).toBe(false)
		}
		expect(
			await verifyPhotoTestBeaconKey('another-secret-another-secret', IDS, key),
		).toBe(false)
		expect(await verifyPhotoTestBeaconKey(SECRET, IDS, 'a'.repeat(32))).toBe(
			false,
		)
		expect(await verifyPhotoTestBeaconKey(SECRET, IDS, '')).toBe(false)
		expect(await verifyPhotoTestBeaconKey(SECRET, IDS, 'short')).toBe(false)
	})
})

import { describe, expect, it } from 'vitest'
import { RSV_TAG_SYSTEM_KEY_VALUES, rsvTags } from './schema.ts'

describe('rsv_tags system keys', () => {
	it('lists the occasion keys the seed and the occasion lookup store', () => {
		expect([...RSV_TAG_SYSTEM_KEY_VALUES]).toEqual([
			'first_visit',
			'frequent_no_show',
			'birthday',
			'anniversary',
		])
	})

	it('types the system_key column with the same values', () => {
		expect(rsvTags.systemKey.enumValues).toEqual([...RSV_TAG_SYSTEM_KEY_VALUES])
	})
})

import { describe, expect, it } from 'vitest'

import {
	LOCATION_TAG_NAME_MAX_LENGTH,
	locationTagNameKey,
	MAX_LOCATION_TAGS,
	normalizeLocationTagName,
	tagLimitAllows,
	validateLocationTagName,
} from './location-tags.ts'

describe('location tag names', () => {
	it('trims and collapses spaces, and ignores case for sameness', () => {
		expect(normalizeLocationTagName('  North   Texas ')).toBe('North Texas')
		expect(locationTagNameKey('North  TEXAS')).toBe(
			locationTagNameKey('north texas'),
		)
	})

	it('refuses empty and over-long names', () => {
		expect(validateLocationTagName('   ')).toEqual({
			ok: false,
			error: 'name_required',
		})
		expect(
			validateLocationTagName('x'.repeat(LOCATION_TAG_NAME_MAX_LENGTH + 1)),
		).toEqual({ ok: false, error: 'name_too_long' })
		expect(validateLocationTagName(' Texas ')).toEqual({
			ok: true,
			name: 'Texas',
			key: 'texas',
		})
	})

	it('counts the limit by distinct names', () => {
		const existing = Array.from(
			{ length: MAX_LOCATION_TAGS },
			(_, i) => `t${i}`,
		)
		expect(tagLimitAllows(existing, ['t1'])).toBe(true)
		expect(tagLimitAllows(existing, ['brand new'])).toBe(false)
	})
})

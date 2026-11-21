import { describe, expect, it } from 'vitest'
import {
	addTags,
	blocksArchive,
	canSetParent,
	chainRoot,
	isAttachable,
	MAX_TAGS_PER_ASSET,
	normalizeTag,
	parseTagList,
} from './media-library.ts'

describe('normalizeTag', () => {
	it('lowercases and trims', () => {
		expect(normalizeTag('  Ramadan ')).toBe('ramadan')
		expect(normalizeTag('Happy   Hour')).toBe('happy hour')
	})
	it('refuses empty, too long and unsafe tags', () => {
		expect(normalizeTag('')).toBeNull()
		expect(normalizeTag('   ')).toBeNull()
		expect(normalizeTag('a'.repeat(33))).toBeNull()
		expect(normalizeTag('a'.repeat(32))).toBe('a'.repeat(32))
		expect(normalizeTag('<script>')).toBeNull()
		expect(normalizeTag('-start')).toBeNull()
		expect(normalizeTag(12)).toBeNull()
	})
	it('keeps other scripts', () => {
		expect(normalizeTag('رمضان')).toBe('رمضان')
	})
})

describe('parseTagList', () => {
	it('splits, normalizes and de-duplicates', () => {
		expect(parseTagList('Hero, drinks,hero\n Ramadan')).toEqual({
			ok: true,
			tags: ['hero', 'drinks', 'ramadan'],
		})
	})
	it('splits entries of a list too, as a form field sends them', () => {
		expect(parseTagList(['hero, drinks', 'Ramadan'])).toEqual({
			ok: true,
			tags: ['hero', 'drinks', 'ramadan'],
		})
		expect(parseTagList([])).toEqual({ ok: true, tags: [] })
		expect(parseTagList(undefined)).toEqual({ ok: true, tags: [] })
	})
	it('refuses a bad tag as a whole', () => {
		expect(parseTagList('ok, <b>')).toEqual({ ok: false, error: 'bad_tag' })
	})
})

describe('addTags', () => {
	it('allows up to twenty', () => {
		const twenty = Array.from({ length: MAX_TAGS_PER_ASSET }, (_, i) => `t${i}`)
		expect(addTags(twenty, ['t0']).ok).toBe(true)
		expect(addTags(twenty, ['extra'])).toEqual({
			ok: false,
			error: 'too_many_tags',
		})
	})
})

describe('version chains', () => {
	const parentOf = new Map<string, string | null>([
		['b', 'a'],
		['c', 'b'],
		['a', null],
	])
	it('refuses itself and loops', () => {
		expect(canSetParent('a', 'a', parentOf)).toBe(false)
		expect(canSetParent('a', 'c', parentOf)).toBe(false)
		expect(canSetParent('a', 'b', parentOf)).toBe(false)
	})
	it('allows a fresh original and clearing', () => {
		expect(canSetParent('d', 'a', parentOf)).toBe(true)
		expect(canSetParent('c', null, parentOf)).toBe(true)
	})
	it('refuses a chain that is already looping', () => {
		const loop = new Map<string, string | null>([
			['x', 'y'],
			['y', 'x'],
		])
		expect(canSetParent('z', 'x', loop)).toBe(false)
	})
	it('finds the root original', () => {
		expect(chainRoot('c', parentOf)).toBe('a')
		expect(chainRoot('a', parentOf)).toBe('a')
	})
})

describe('archive blockers and status', () => {
	it('blocks dish photos and the website, not notes', () => {
		expect(blocksArchive('menu-item')).toBe(true)
		expect(blocksArchive('page')).toBe(true)
		expect(blocksArchive('note')).toBe(false)
		expect(blocksArchive('social-post')).toBe(false)
	})
	it('only ready assets attach', () => {
		expect(isAttachable('ready')).toBe(true)
		expect(isAttachable('processing')).toBe(false)
		expect(isAttachable('draft')).toBe(false)
	})
})

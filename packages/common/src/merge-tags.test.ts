import { describe, expect, it } from 'vitest'

import {
	buildMergeToken,
	collectMergeTags,
	findMergeSegmentAt,
	isMergeTagName,
	mergeTagLabel,
	parseMergeSegments,
	replaceMergeTokens,
	resolveWithFallback,
} from './merge-tags'

describe('merge token parsing', () => {
	it('parses plain text, tags, and fallbacks in order', () => {
		const segments = parseMergeSegments('Hey {{firstName|there}}, welcome!')
		expect(segments).toEqual([
			{ type: 'text', value: 'Hey ', start: 0, end: 4 },
			{
				type: 'tag',
				tag: 'firstName',
				fallback: 'there',
				raw: '{{firstName|there}}',
				start: 4,
				end: 23,
			},
			{ type: 'text', value: ', welcome!', start: 23, end: 33 },
		])
	})

	it('supports whitespace inside tokens', () => {
		expect(parseMergeSegments('{{ firstName }}')[0]).toMatchObject({
			type: 'tag',
			tag: 'firstName',
			fallback: '',
		})
	})

	it('tolerates a fallback containing spaces', () => {
		expect(parseMergeSegments('{{name|valued customer}}')[0]).toMatchObject({
			type: 'tag',
			tag: 'name',
			fallback: 'valued customer',
		})
	})

	it('returns a single text segment when there are no tags', () => {
		expect(parseMergeSegments('just text')).toEqual([
			{ type: 'text', value: 'just text', start: 0, end: 9 },
		])
	})

	it('finds the tag under a caret offset', () => {
		const text = 'Hey {{firstName}}, hi'
		expect(findMergeSegmentAt(text, 8)?.tag).toBe('firstName')
		expect(findMergeSegmentAt(text, 0)).toBeNull()
	})

	it('collects distinct tags', () => {
		expect(collectMergeTags('{{name}} {{email}} {{name}}')).toEqual([
			'name',
			'email',
		])
	})
})

describe('buildMergeToken', () => {
	it('omits an empty fallback and trims a set one', () => {
		expect(buildMergeToken('firstName')).toBe('{{firstName}}')
		expect(buildMergeToken('firstName', '   ')).toBe('{{firstName}}')
		expect(buildMergeToken('firstName', ' there ')).toBe('{{firstName|there}}')
	})

	it('round-trips through parseMergeSegments', () => {
		const token = buildMergeToken('lastName', 'friend')
		expect(parseMergeSegments(token)[0]).toMatchObject({
			type: 'tag',
			tag: 'lastName',
			fallback: 'friend',
		})
	})
})

describe('replaceMergeTokens', () => {
	it('leaves literal text untouched', () => {
		expect(replaceMergeTokens('<p>Hello</p>', () => 'x')).toBe('<p>Hello</p>')
	})

	it('passes tag, fallback, and raw token to the resolver', () => {
		const calls: Array<[string, string, string]> = []
		replaceMergeTokens('{{a|x}} {{b}}', (tag, fallback, raw) => {
			calls.push([tag, fallback, raw])
			return tag
		})
		expect(calls).toEqual([
			['a', 'x', '{{a|x}}'],
			['b', '', '{{b}}'],
		])
	})
})

describe('resolveWithFallback', () => {
	it('prefers the value, then the fallback, then the builtin default', () => {
		expect(resolveWithFallback('Alex', 'there', 'Customer')).toBe('Alex')
		expect(resolveWithFallback('', 'there', 'Customer')).toBe('there')
		expect(resolveWithFallback('   ', '', 'Customer')).toBe('Customer')
		expect(resolveWithFallback(null, '')).toBe('')
	})
})

describe('tag metadata', () => {
	it('labels known tags and falls back to the raw name', () => {
		expect(mergeTagLabel('firstName')).toBe('First name')
		expect(mergeTagLabel('customKey')).toBe('customKey')
	})

	it('recognises catalog tags', () => {
		expect(isMergeTagName('firstName')).toBe(true)
		expect(isMergeTagName('nope')).toBe(false)
	})
})

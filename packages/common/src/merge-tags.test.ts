import { describe, expect, it } from 'vitest'

import {
	buildMergeToken,
	collectMergeTags,
	findMergeSegmentAt,
	isMergeTagName,
	isSafeUrlAttributeValue,
	mergeTagLabel,
	parseMergeSegments,
	replaceMergeTokens,
	replaceMergeTokensInHtml,
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

describe('isSafeUrlAttributeValue', () => {
	it('allows http, https, mailto, tel and relative URLs', () => {
		for (const value of [
			'https://x.test/a?b=c:d',
			'HTTP://x.test',
			'mailto:a@x.test',
			'tel:+1555',
			'/path:with-colon',
			'?q=a:b',
			'#top',
			'logo.png',
			'',
		]) {
			expect(isSafeUrlAttributeValue(value), value).toBe(true)
		}
	})

	it('refuses other schemes, however they are written', () => {
		for (const value of [
			'javascript:alert(1)',
			'JaVaScRiPt:alert(1)',
			'  javascript:alert(1)',
			'java\tscript:alert(1)',
			'java&#x09;script:alert(1)',
			'java&Tab;script:alert(1)',
			'&#106;avascript:alert(1)',
			'&#x6A;avascript:alert(1)',
			'javascript&colon;alert(1)',
			'&#0;javascript:alert(1)',
			'data:text/html,x',
			'vbscript:x',
			'jav&unknown;script:x',
		]) {
			expect(isSafeUrlAttributeValue(value), value).toBe(false)
		}
	})
})

describe('replaceMergeTokensInHtml', () => {
	const resolve = (tag: string) =>
		({ a: 'javascript:alert(1)', b: 'https://x.test', c: '{{b}}' })[tag] ?? ''

	it('empties a URL attribute whose result is unsafe', () => {
		expect(replaceMergeTokensInHtml('<a href={{a}}>{{a}}</a>', resolve)).toBe(
			'<a href="">javascript:alert(1)</a>',
		)
		expect(replaceMergeTokensInHtml('<a HREF="{{b}}">x</a>', resolve)).toBe(
			'<a HREF="https://x.test">x</a>',
		)
	})

	it('checks a URL attribute after a quoted value that contains >', () => {
		expect(
			replaceMergeTokensInHtml('<a title="x>y" href="{{a}}">x</a>', resolve),
		).toBe('<a title="x>y" href="">x</a>')
		expect(
			replaceMergeTokensInHtml("<a title='x>y' href={{a}}>x</a>", resolve),
		).toBe('<a title=\'x>y\' href="">x</a>')
		expect(
			replaceMergeTokensInHtml('<p>1 > 0</p><a href="{{b}}">x</a>', resolve),
		).toBe('<p>1 > 0</p><a href="https://x.test">x</a>')
	})

	it('treats a quote inside an unquoted value as an ordinary character', () => {
		expect(
			replaceMergeTokensInHtml('<a title=a"b href="{{a}}">x</a>', resolve),
		).toBe('<a title=a"b href="">x</a>')
		expect(
			replaceMergeTokensInHtml("<a title=a='b href={{a}}>x</a>", resolve),
		).toBe('<a title=a=\'b href="">x</a>')
	})

	it('escapes everything from a tag that never ends', () => {
		expect(
			replaceMergeTokensInHtml(`<a title='x>y<a href="{{a}}">z</a>`, resolve),
		).toBe(`&lt;a title='x>y&lt;a href="javascript:alert(1)">z&lt;/a>`)
		expect(replaceMergeTokensInHtml('<b>ok</b><a<a<a', resolve)).toBe(
			'<b>ok</b>&lt;a&lt;a&lt;a',
		)
	})

	it('stays linear on many broken tags', () => {
		const input = '<a'.repeat(200_000)
		const started = performance.now()
		expect(replaceMergeTokensInHtml(input, resolve)).toBe(
			'&lt;a'.repeat(200_000),
		)
		expect(performance.now() - started).toBeLessThan(1000)
	})

	it('treats a quote outside a value as part of the tag', () => {
		expect(
			replaceMergeTokensInHtml('<a data-x"y href="{{a}}">x</a>', resolve),
		).toBe('<a data-x"y href="">x</a>')
	})

	it('does not re-read a substituted value as a token', () => {
		expect(replaceMergeTokensInHtml('<a href="{{c}}">{{c}}</a>', resolve)).toBe(
			'<a href="{{b}}">{{b}}</a>',
		)
	})
})

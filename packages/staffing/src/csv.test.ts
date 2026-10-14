import { describe, expect, it } from 'vitest'
import { neutralizeCsvCell, toCsv } from './csv.ts'

describe('neutralizeCsvCell', () => {
	it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tcmd', '\rcmd'])(
		'prefixes formula starter %j',
		(value) => {
			expect(neutralizeCsvCell(value)).toBe(`'${value}`)
		},
	)
	it('catches a trigger hidden behind leading spaces', () => {
		expect(neutralizeCsvCell('  =cmd|calc')).toBe("'  =cmd|calc")
	})
	it('catches a trigger hidden behind invisible characters', () => {
		expect(neutralizeCsvCell('​=1+1')).toBe("'=1+1")
		expect(neutralizeCsvCell('﻿@x')).toBe("'@x")
		expect(neutralizeCsvCell('\u0001=1')).toBe("'=1")
	})
	it('leaves ordinary text alone, including Arabic and names with hyphens inside', () => {
		expect(neutralizeCsvCell('Maria Lopez')).toBe('Maria Lopez')
		expect(neutralizeCsvCell('Anne-Marie')).toBe('Anne-Marie')
		expect(neutralizeCsvCell('محمد')).toBe('محمد')
		expect(neutralizeCsvCell('a=b')).toBe('a=b')
		expect(neutralizeCsvCell('')).toBe('')
	})
})

describe('toCsv', () => {
	it('quotes commas, quotes, and newlines per RFC 4180', () => {
		const csv = toCsv(['name', 'note'], [['Lopez, Maria', 'said "hi"\nbye']])
		expect(csv).toBe('name,note\r\n"Lopez, Maria","said ""hi""\nbye"\r\n')
	})
	it('neutralizes formulas in headers and cells', () => {
		const csv = toCsv(['=evil', 'ok'], [['=HYPERLINK("http://x","y")', '@a']])
		expect(csv).toBe(`'=evil,ok\r\n"'=HYPERLINK(""http://x"",""y"")",'@a\r\n`)
	})
	it('keeps numbers numeric, including negatives, and drops non-finite ones', () => {
		expect(toCsv(['n'], [[-5], [0.5], [Number.NaN], [Infinity]])).toBe(
			'n\r\n-5\r\n0.5\r\n\r\n\r\n',
		)
	})
	it('renders null, undefined, and booleans', () => {
		expect(toCsv(['a', 'b', 'c'], [[null, undefined, true]])).toBe(
			'a,b,c\r\n,,true\r\n',
		)
	})
	it('can prepend a BOM for Excel', () => {
		expect(toCsv(['a'], [], { bom: true }).startsWith('﻿a')).toBe(true)
	})
	it('never emits a raw formula starter at the start of any cell', () => {
		const payloads = ['=1', '+1', '-1', '@x', '\t=1', ' =1', '\r=1', '"=1']
		const csv = toCsv(
			['h'],
			payloads.map((p) => [p]),
		)
		for (const line of csv.trim().split('\r\n').slice(1)) {
			expect(line).not.toMatch(/^[=+\-@\t\r]/)
		}
	})
})

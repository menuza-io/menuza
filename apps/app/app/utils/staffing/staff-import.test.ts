import { describe, expect, it } from 'vitest'
import {
	IMPORT_MAX_ROWS,
	parseDelimited,
	parseStaffText,
	reviewDrafts,
	toCreatePayload,
} from './staff-import.ts'

describe('parseDelimited', () => {
	it('splits comma, tab and semicolon data and unquotes cells', () => {
		expect(parseDelimited('a,b\n"c, d",e')).toEqual([
			['a', 'b'],
			['c, d', 'e'],
		])
		expect(parseDelimited('a\tb\nc\td')).toEqual([
			['a', 'b'],
			['c', 'd'],
		])
		expect(parseDelimited('a;b\r\nc;d\r\n')).toEqual([
			['a', 'b'],
			['c', 'd'],
		])
	})

	it('keeps escaped quotes and line breaks inside a quoted cell', () => {
		expect(parseDelimited('name,note\n"Lee ""Jo""","a\nb"')).toEqual([
			['name', 'note'],
			['Lee "Jo"', 'a\nb'],
		])
	})

	it('drops blank lines and a leading byte order mark', () => {
		expect(parseDelimited('﻿a,b\n\n,\nc,d\n')).toEqual([
			['a', 'b'],
			['c', 'd'],
		])
	})
})

describe('parseStaffText', () => {
	it('reads a header row in any column order', () => {
		const { rows, hadHeader } = parseStaffText(
			'Email,First name,Last name,Phone\nsam@example.com,Sam,Cook,+14155550101',
		)
		expect(hadHeader).toBe(true)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			row: 1,
			firstName: 'Sam',
			lastName: 'Cook',
			email: 'sam@example.com',
			phone: '+14155550101',
			problems: [],
		})
	})

	it('classifies cells by content when there is no header', () => {
		const { rows, hadHeader } = parseStaffText(
			'Dana Lee, dana@example.com, +14155550123\nOmar Haddad, 0551234567',
			{ defaultDialCode: '966' },
		)
		expect(hadHeader).toBe(false)
		expect(rows[0]).toMatchObject({
			firstName: 'Dana',
			lastName: 'Lee',
			email: 'dana@example.com',
			phone: '+14155550123',
			problems: [],
		})
		expect(rows[1]).toMatchObject({
			firstName: 'Omar',
			lastName: 'Haddad',
			phone: '0551234567',
			problems: [],
		})
	})

	it('flags each problem on the row it belongs to', () => {
		const { rows } = parseStaffText(
			[
				'Dana Lee, dana@example.com',
				'Cher',
				'Sam Cook, sam@bad',
				'Kim Park, 12',
				'Pat Doe',
				', pat@example.com',
			].join('\n'),
		)
		expect(rows[0]!.problems).toEqual([])
		expect(rows[1]!.problems).toEqual([
			'last_name_required',
			'contact_required',
		])
		expect(rows[2]!.problems).toEqual(['bad_email'])
		// "12" is not phone-like so it becomes part of the name.
		expect(rows[3]!.problems).toEqual(['contact_required'])
		expect(rows[4]!.problems).toEqual(['contact_required'])
		expect(rows[5]!.problems).toEqual(['name_required'])
	})

	it('marks repeated emails and phones as duplicates of the first row', () => {
		const { rows } = parseStaffText(
			[
				'Dana Lee, dana@example.com, +14155550123',
				'Dana L, DANA@example.com',
				'Someone Else, +1 (415) 555-0123',
			].join('\n'),
		)
		expect(rows[0]!.problems).toEqual([])
		expect(rows[1]!.problems).toContain('duplicate')
		expect(rows[1]!.duplicateOf).toBe(1)
		expect(rows[2]!.problems).toContain('duplicate')
		expect(rows[2]!.duplicateOf).toBe(1)
	})

	it('caps the batch at the server limit and says so', () => {
		const lines = Array.from(
			{ length: IMPORT_MAX_ROWS + 5 },
			(_, i) => `Person${i} Last, p${i}@example.com`,
		).join('\n')
		const { rows, truncated } = parseStaffText(lines)
		expect(rows).toHaveLength(IMPORT_MAX_ROWS)
		expect(truncated).toBe(true)
	})

	it('treats a pasted formula as plain text, never as a command', () => {
		const { rows } = parseStaffText('=1+1 Cook, evil@example.com')
		expect(rows[0]!.firstName).toBe('=1+1')
		expect(rows[0]!.problems).toEqual([])
	})

	it('returns nothing for empty input', () => {
		expect(parseStaffText('  \n \n').rows).toEqual([])
	})
})

describe('toCreatePayload', () => {
	it('builds the API row for a valid line with a normalized phone', () => {
		const { rows } = parseStaffText('Omar Haddad, 0551234567', {
			defaultDialCode: '966',
		})
		expect(toCreatePayload(rows[0]!, 'loc1', '966')).toEqual({
			firstName: 'Omar',
			lastName: 'Haddad',
			phone: '+966551234567',
			assignments: [{ scopeId: 'loc1', isPrimary: true }],
		})
	})

	it('refuses a row with problems', () => {
		const { rows } = parseStaffText('Cher')
		expect(toCreatePayload(rows[0]!, 'loc1')).toBeNull()
	})
})

describe('reviewDrafts', () => {
	it('re-derives problems and duplicates after an edit', () => {
		const drafts = [
			{
				id: 'a',
				firstName: 'Dana',
				lastName: 'Lee',
				email: 'dana@example.com',
				phone: '',
			},
			{
				id: 'b',
				firstName: 'Dana',
				lastName: 'L',
				email: 'dana@example.com',
				phone: '',
			},
		]
		const before = reviewDrafts(drafts)
		expect(before[1]!.problems).toEqual(['duplicate'])
		const after = reviewDrafts([
			drafts[0]!,
			{ ...drafts[1]!, email: 'dana2@example.com' },
		])
		expect(after[1]!.problems).toEqual([])
		expect(after.map((row) => row.id)).toEqual(['a', 'b'])
	})

	it('keeps the member link and numbers rows from 1', () => {
		const [row] = reviewDrafts([
			{
				id: 'm1',
				firstName: 'Sam',
				lastName: 'Cook',
				email: 'SAM@example.com',
				phone: '',
				userId: 'user_1',
			},
		])
		expect(row).toMatchObject({
			row: 1,
			userId: 'user_1',
			email: 'sam@example.com',
			problems: [],
		})
	})
})

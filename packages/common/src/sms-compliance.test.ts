import { describe, expect, test } from 'vitest'
import {
	countMarketingSmsSegments,
	countSmsSegments,
	matchSmsKeyword,
	smsReplyText,
	smsSendWindow,
	SMS_OPT_OUT_PHRASE,
	withSmsOptOutFooter,
} from './sms-compliance.ts'

describe('matchSmsKeyword', () => {
	test.each([
		['STOP', 'stop'],
		['  stop \n', 'stop'],
		['StopAll', 'stop'],
		['UNSUBSCRIBE', 'stop'],
		['cancel', 'stop'],
		['End', 'stop'],
		['quit', 'stop'],
		['START', 'start'],
		['yes', 'start'],
		['Unstop', 'start'],
		['HELP', 'help'],
		['info', 'help'],
	])('%j is %s', (body, kind) => {
		expect(matchSmsKeyword(body)).toBe(kind)
	})

	test.each([
		'please stop',
		'stop it',
		'yes please',
		'stop.',
		'',
		'   ',
		'stopp',
		'help me',
		'st op',
	])('%j is not a keyword (whole trimmed body only)', (body) => {
		expect(matchSmsKeyword(body)).toBeNull()
	})

	test('a missing body is not a keyword', () => {
		expect(matchSmsKeyword(undefined)).toBeNull()
		expect(matchSmsKeyword(null)).toBeNull()
	})
})

describe('opt-out footer and segments', () => {
	test('adds the phrase once, on its own line', () => {
		const once = withSmsOptOutFooter('Taco Tuesday is on')
		expect(once).toBe(`Taco Tuesday is on\n${SMS_OPT_OUT_PHRASE}`)
		expect(withSmsOptOutFooter(once)).toBe(once)
	})

	test('the segment count includes the footer', () => {
		const body = 'a'.repeat(160 - SMS_OPT_OUT_PHRASE.length - 1)
		expect(countSmsSegments(body).segments).toBe(1)
		expect(countMarketingSmsSegments(body).segments).toBe(1)
		const longer = `${body}b`
		expect(countSmsSegments(longer).segments).toBe(1)
		expect(countMarketingSmsSegments(longer).segments).toBe(2)
	})

	test('GSM extension characters count twice and arabic is UCS-2', () => {
		expect(countSmsSegments('€'.repeat(80)).segments).toBe(1)
		expect(countSmsSegments('€'.repeat(81)).segments).toBe(2)
		const arabic = countSmsSegments('مرحبا')
		expect(arabic.encoding).toBe('ucs2')
		expect(countSmsSegments('م'.repeat(71)).segments).toBe(2)
	})

	test('reply text names the restaurant', () => {
		expect(smsReplyText('help', 'Casa Verde')).toContain('Casa Verde')
		expect(smsReplyText('stop', 'Casa Verde')).toContain('Casa Verde')
		expect(smsReplyText('start', '')).toContain('this restaurant')
	})
})

describe('smsSendWindow (9:00 to 20:00 local)', () => {
	const NY = 'America/New_York'

	test('inside the window sends now', () => {
		const now = Date.UTC(2026, 5, 10, 16, 0) // 12:00 EDT
		expect(smsSendWindow(now, NY)).toEqual({ open: true, notBefore: now })
	})

	test('the window is closed from 20:00 and opens again at 9:00 next morning', () => {
		const now = Date.UTC(2026, 5, 11, 0, 30) // 20:30 EDT on the 10th
		const result = smsSendWindow(now, NY)
		expect(result.open).toBe(false)
		expect(result.notBefore).toBe(Date.UTC(2026, 5, 11, 13, 0)) // 9:00 EDT
	})

	test('before 9:00 it waits for 9:00 the same day', () => {
		const now = Date.UTC(2026, 5, 10, 11, 0) // 7:00 EDT
		expect(smsSendWindow(now, NY).notBefore).toBe(Date.UTC(2026, 5, 10, 13, 0))
	})

	test('20:00 is closed and 9:00 is open (edges)', () => {
		expect(smsSendWindow(Date.UTC(2026, 5, 11, 0, 0), NY).open).toBe(false)
		expect(smsSendWindow(Date.UTC(2026, 5, 10, 13, 0), NY).open).toBe(true)
		expect(smsSendWindow(Date.UTC(2026, 5, 10, 12, 59), NY).open).toBe(false)
	})

	test('spring forward: the next 9:00 is 9:00 EDT, not 8:00 or 10:00', () => {
		// 2026-03-07 21:00 EST (UTC-5); the clocks jump on 2026-03-08 02:00.
		const now = Date.UTC(2026, 2, 8, 2, 0)
		const result = smsSendWindow(now, NY)
		expect(result.open).toBe(false)
		expect(result.notBefore).toBe(Date.UTC(2026, 2, 8, 13, 0)) // 9:00 EDT = 13:00Z
	})

	test('fall back: the next 9:00 is 9:00 EST', () => {
		// 2026-11-01: EDT until 02:00, then EST. Sent at 20:30 EDT on 10-31.
		const now = Date.UTC(2026, 10, 1, 0, 30)
		const result = smsSendWindow(now, NY)
		expect(result.open).toBe(false)
		expect(result.notBefore).toBe(Date.UTC(2026, 10, 1, 14, 0)) // 9:00 EST = 14:00Z
	})

	test('a zone east of UTC uses its own wall clock (Riyadh, UTC+3)', () => {
		const now = Date.UTC(2026, 5, 10, 17, 30) // 20:30 in Riyadh
		expect(smsSendWindow(now, 'Asia/Riyadh').notBefore).toBe(
			Date.UTC(2026, 5, 11, 6, 0),
		)
	})
})

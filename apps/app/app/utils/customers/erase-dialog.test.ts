import { describe, expect, it } from 'vitest'
import { classifyEraseError, matchesEraseConfirmation } from './erase-dialog.ts'

const customer = { name: 'Erin Erasable', phone: '+1 (555) 000-1111' }

describe('matchesEraseConfirmation', () => {
	it.each(['Erin Erasable', '  erin erasable ', 'ERIN ERASABLE'])(
		'accepts the name typed as %j',
		(typed) => expect(matchesEraseConfirmation(customer, typed)).toBe(true),
	)

	it.each(['+1 (555) 000-1111', '15550001111', '+15550001111'])(
		'accepts the phone typed as %j',
		(typed) => expect(matchesEraseConfirmation(customer, typed)).toBe(true),
	)

	it.each([
		'',
		'   ',
		'Erin',
		'Erin Erasable Jr',
		'5550001111',
		'erase',
		'1111',
	])('rejects %j', (typed) =>
		expect(matchesEraseConfirmation(customer, typed)).toBe(false),
	)

	it('a customer without a name uses the phone, one with neither uses "erase"', () => {
		expect(
			matchesEraseConfirmation(
				{ name: '', phone: '+15550001111' },
				'+15550001111',
			),
		).toBe(true)
		expect(
			matchesEraseConfirmation({ name: '', phone: '+15550001111' }, ''),
		).toBe(false)
		expect(matchesEraseConfirmation({ name: '', phone: null }, ' Erase ')).toBe(
			true,
		)
		expect(matchesEraseConfirmation({ name: '', phone: null }, 'yes')).toBe(
			false,
		)
	})

	it('a short phone is matched as typed, not by digits alone', () => {
		const short = { name: '', phone: '123' }
		expect(matchesEraseConfirmation(short, '123')).toBe(true)
		expect(matchesEraseConfirmation(short, '1-2-3')).toBe(false)
	})
})

describe('classifyEraseError', () => {
	it.each([
		[null, undefined, 'network'],
		[502, 'recording_delete_failed', 'recording'],
		[403, undefined, 'permission'],
		[401, undefined, 'permission'],
		[500, undefined, 'unavailable'],
		[502, 'other', 'unavailable'],
		[400, 'invalid_erase_call', 'generic'],
		[404, undefined, 'generic'],
	] as const)('status %s code %s is %s', (status, code, kind) => {
		expect(classifyEraseError(status, code)).toBe(kind)
	})
})

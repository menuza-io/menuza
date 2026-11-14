import { describe, expect, it } from 'vitest'
import {
	chooseOrderCredential,
	credentialHeaders,
	readOrderLink,
} from './order-link.ts'

const TOKEN = 'a'.repeat(64)

describe('readOrderLink', () => {
	it('reads a valid token from the fragment', () => {
		expect(readOrderLink(`#link=${TOKEN}`)).toEqual({
			status: 'valid',
			token: TOKEN,
		})
	})

	it('accepts a token beside other fragment parameters', () => {
		expect(readOrderLink(`#x=1&link=${TOKEN}`)).toEqual({
			status: 'valid',
			token: TOKEN,
		})
	})

	it('is absent without a fragment or a link parameter', () => {
		expect(readOrderLink('')).toEqual({ status: 'absent' })
		expect(readOrderLink('#')).toEqual({ status: 'absent' })
		expect(readOrderLink('#section')).toEqual({ status: 'absent' })
	})

	it('flags a malformed token as invalid', () => {
		expect(readOrderLink('#link=')).toEqual({ status: 'invalid' })
		expect(readOrderLink('#link=abc')).toEqual({ status: 'invalid' })
		expect(readOrderLink(`#link=${'z'.repeat(64)}`)).toEqual({
			status: 'invalid',
		})
		expect(readOrderLink(`#link=${TOKEN}0`)).toEqual({ status: 'invalid' })
	})

	it('refuses an over-long fragment without parsing it', () => {
		expect(readOrderLink(`#link=${'a'.repeat(5000)}`)).toEqual({
			status: 'invalid',
		})
		expect(readOrderLink(`#${'q'.repeat(5000)}`)).toEqual({ status: 'absent' })
	})
})

describe('chooseOrderCredential', () => {
	it('prefers the link token', () => {
		expect(
			chooseOrderCredential({
				link: { status: 'valid', token: TOKEN },
				receiptToken: 'receipt-token-123456',
			}),
		).toEqual({ kind: 'link', token: TOKEN })
	})

	it('falls back to the saved receipt token', () => {
		expect(
			chooseOrderCredential({
				link: { status: 'absent' },
				receiptToken: 'receipt-token-123456',
			}),
		).toEqual({ kind: 'receipt', token: 'receipt-token-123456' })
		expect(
			chooseOrderCredential({
				link: { status: 'invalid' },
				receiptToken: 'receipt-token-123456',
			}),
		).toEqual({ kind: 'receipt', token: 'receipt-token-123456' })
	})

	it('is null with neither', () => {
		expect(
			chooseOrderCredential({ link: { status: 'absent' }, receiptToken: null }),
		).toBeNull()
	})
})

describe('credentialHeaders', () => {
	it('sends the link as X-Order-Link and the receipt as Bearer', () => {
		expect(credentialHeaders({ kind: 'link', token: TOKEN })).toEqual({
			'X-Order-Link': TOKEN,
		})
		expect(credentialHeaders({ kind: 'receipt', token: 'r' })).toEqual({
			Authorization: 'Bearer r',
		})
	})
})

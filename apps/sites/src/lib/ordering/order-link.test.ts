import { describe, expect, it, vi } from 'vitest'
import {
	PENDING_HASH_KEY,
	chooseOrderCredential,
	claimOrderLink,
	credentialHeaders,
	orderLinkKey,
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

describe('claimOrderLink', () => {
	function env(hash: string, options: { throwing?: boolean } = {}) {
		const values = new Map<string, string>()
		const storage = {
			getItem: (k: string) => {
				if (options.throwing) throw new Error('denied')
				return values.get(k) ?? null
			},
			setItem: (k: string, v: string) => {
				if (options.throwing) throw new Error('denied')
				values.set(k, v)
			},
			removeItem: (k: string) => void values.delete(k),
		}
		const history = { replaceState: vi.fn() }
		const memory = new Map<string, string>()
		const location = { hash, pathname: '/menu/success', search: '?order=o1' }
		const run = (orderId: string | null, loc = location) =>
			claimOrderLink({
				orgId: 'org',
				orderId,
				location: loc,
				history,
				storage: () => storage as Storage,
				memory,
			})
		return { values, history, memory, location, run }
	}

	it('stores the token, strips the fragment and returns it', () => {
		const e = env(`#link=${TOKEN}`)
		expect(e.run('o1')).toEqual({ status: 'valid', token: TOKEN })
		expect(e.values.get(orderLinkKey('org', 'o1'))).toBe(TOKEN)
		expect(e.history.replaceState).toHaveBeenCalledWith(
			null,
			'',
			'/menu/success?order=o1',
		)
	})

	it('returns the stored token when the fragment is absent', () => {
		const e = env('')
		e.values.set(orderLinkKey('org', 'o1'), TOKEN)
		expect(e.run('o1')).toEqual({ status: 'valid', token: TOKEN })
		expect(e.history.replaceState).not.toHaveBeenCalled()
		expect(e.run('o2')).toEqual({ status: 'absent' })
	})

	it('claims a fragment parked by the inline head script', () => {
		const e = env('')
		e.values.set(PENDING_HASH_KEY, `#link=${TOKEN}`)
		expect(e.run('o1')).toEqual({ status: 'valid', token: TOKEN })
		expect(e.values.has(PENDING_HASH_KEY)).toBe(false)
		expect(e.values.get(orderLinkKey('org', 'o1'))).toBe(TOKEN)
	})

	it('replaces only the entry of the order in the fragment', () => {
		const e = env(`#link=${'b'.repeat(64)}`)
		e.values.set(orderLinkKey('org', 'o1'), TOKEN)
		e.values.set(orderLinkKey('org', 'o2'), TOKEN)
		e.run('o1')
		expect(e.values.get(orderLinkKey('org', 'o1'))).toBe('b'.repeat(64))
		expect(e.values.get(orderLinkKey('org', 'o2'))).toBe(TOKEN)
	})

	it('falls back to memory when storage throws', () => {
		const e = env(`#link=${TOKEN}`, { throwing: true })
		expect(e.run('o1')).toEqual({ status: 'valid', token: TOKEN })
		expect(e.run('o1', { ...e.location, hash: '' })).toEqual({
			status: 'valid',
			token: TOKEN,
		})
	})

	it('strips an invalid fragment and reports it invalid', () => {
		const e = env('#link=nope')
		expect(e.run('o1')).toEqual({ status: 'invalid' })
		expect(e.history.replaceState).toHaveBeenCalled()
		expect(e.values.size).toBe(0)
	})
})

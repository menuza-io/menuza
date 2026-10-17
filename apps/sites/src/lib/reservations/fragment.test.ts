import { describe, expect, it, vi } from 'vitest'
import {
	MANAGE_TOKEN_STORAGE_KEY,
	parseFragmentParam,
	readStoredManageToken,
	takeManageToken,
} from './fragment.ts'

function memoryStorage() {
	const data = new Map<string, string>()
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key),
	}
}

describe('fragment tokens', () => {
	it('parses a named fragment parameter', () => {
		expect(parseFragmentParam('#t=abc123', 't')).toBe('abc123')
		expect(parseFragmentParam('#x=1&t=abc', 't')).toBe('abc')
		expect(parseFragmentParam('#t=', 't')).toBeNull()
		expect(parseFragmentParam('', 't')).toBeNull()
	})

	it('reads the manage token, remembers it and strips the fragment', () => {
		const storage = memoryStorage()
		const replaceState = vi.fn()
		const token = takeManageToken(
			{ hash: '#t=tok-1', pathname: '/reserve/manage', search: '?lang=ar' },
			{ replaceState, state: { a: 1 } },
			storage,
		)
		expect(token).toBe('tok-1')
		expect(replaceState).toHaveBeenCalledWith(
			{ a: 1 },
			'',
			'/reserve/manage?lang=ar',
		)
		expect(storage.getItem(MANAGE_TOKEN_STORAGE_KEY)).toBe('tok-1')
	})

	it('falls back to the token kept for this tab after a reload', () => {
		const storage = memoryStorage()
		storage.setItem(MANAGE_TOKEN_STORAGE_KEY, 'kept')
		const replaceState = vi.fn()
		const token = takeManageToken(
			{ hash: '', pathname: '/reserve/manage', search: '' },
			{ replaceState, state: null },
			storage,
		)
		expect(token).toBe('kept')
		expect(replaceState).not.toHaveBeenCalled()
		expect(readStoredManageToken(storage)).toBe('kept')
	})

	it('returns null without a fragment or stored token', () => {
		expect(
			takeManageToken(
				{ hash: '', pathname: '/reserve/manage', search: '' },
				{ replaceState: vi.fn(), state: null },
				memoryStorage(),
			),
		).toBeNull()
	})
})

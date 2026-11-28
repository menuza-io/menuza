import { describe, expect, it } from 'vitest'
import {
	isSafeReturnPath,
	rememberReturnPath,
	takeReturnPath,
} from './return-after-login'

function memory() {
	const data = new Map<string, string>()
	return {
		setItem: (key: string, value: string) => void data.set(key, value),
		getItem: (key: string) => data.get(key) ?? null,
		removeItem: (key: string) => void data.delete(key),
	}
}

describe('return after login', () => {
	it('keeps only same-site paths', () => {
		expect(isSafeReturnPath('/menu?location=1')).toBe(true)
		expect(isSafeReturnPath('//evil.example')).toBe(false)
		expect(isSafeReturnPath('https://evil.example')).toBe(false)
		expect(isSafeReturnPath('/a\\b')).toBe(false)
		expect(isSafeReturnPath('')).toBe(false)
		expect(isSafeReturnPath(null)).toBe(false)
	})

	it('returns the remembered path once, then the fallback', () => {
		const storage = memory()
		rememberReturnPath('/ar/menu?item=1', storage)
		expect(takeReturnPath('/', storage)).toBe('/ar/menu?item=1')
		expect(takeReturnPath('/', storage)).toBe('/')
	})

	it('refuses to remember or return an unsafe path', () => {
		const storage = memory()
		rememberReturnPath('https://evil.example', storage)
		expect(takeReturnPath('/home', storage)).toBe('/home')
		storage.setItem('menuza_return_after_login', '//evil.example')
		expect(takeReturnPath('/home', storage)).toBe('/home')
	})

	it('works without storage', () => {
		rememberReturnPath('/menu', null)
		expect(takeReturnPath('/x', null)).toBe('/x')
	})
})

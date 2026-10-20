import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	assertConsentBaseUrl,
	consentBaseUrl,
	isLocalDevelopmentHost,
} from './email-consent.ts'

const ENV_KEYS = ['NODE_ENV', 'TENANT_API_URL', 'DATA_REGION'] as const

describe('consentBaseUrl', () => {
	const saved: Record<string, string | undefined> = {}

	beforeEach(() => {
		for (const key of ENV_KEYS) saved[key] = process.env[key]
		process.env.NODE_ENV = 'test'
		process.env.TENANT_API_URL = ''
		process.env.DATA_REGION = 'us'
	})

	afterEach(() => {
		// Empty instead of deleted: the varlock sync only copies defined values.
		for (const key of ENV_KEYS) process.env[key] = saved[key] ?? ''
	})

	describe('in production', () => {
		beforeEach(() => {
			process.env.NODE_ENV = 'production'
		})

		it('uses the configured origin and trims a trailing slash', () => {
			process.env.TENANT_API_URL = 'https://tenant.example.com/'
			expect(consentBaseUrl('https://evil.example')).toBe(
				'https://tenant.example.com',
			)
		})

		it('returns null when the variable is missing, never the request origin', () => {
			expect(consentBaseUrl('https://tenant.example.com')).toBeNull()
			expect(consentBaseUrl('http://localhost:3007')).toBeNull()
			expect(consentBaseUrl()).toBeNull()
		})

		it('treats an invalid value as missing', () => {
			process.env.TENANT_API_URL = 'not a url'
			expect(consentBaseUrl('https://tenant.example.com')).toBeNull()
			process.env.TENANT_API_URL = 'ftp://tenant.example.com'
			expect(consentBaseUrl()).toBeNull()
		})

		it('fails the startup check without the variable and passes with it', () => {
			expect(() => assertConsentBaseUrl()).toThrow(/TENANT_API_URL/)
			process.env.TENANT_API_URL = 'https://tenant.example.com'
			expect(() => assertConsentBaseUrl()).not.toThrow()
		})
	})

	describe('in development', () => {
		it('prefers the configured origin', () => {
			process.env.TENANT_API_URL = 'https://tenant.example.com'
			expect(consentBaseUrl('http://localhost:3007')).toBe(
				'https://tenant.example.com',
			)
		})

		it.each([
			'http://localhost:3007',
			'http://127.0.0.1:3007',
			'http://[::1]:3007',
			'https://api.menu.test:2999',
			'http://tenant.localhost:3007',
		])('falls back to the local request origin %s', (origin) => {
			expect(consentBaseUrl(origin)).toBe(new URL(origin).origin)
		})

		it('ignores a forged non-local Host and uses the local default', () => {
			expect(consentBaseUrl('https://evil.example')).toBe(
				'http://localhost:3007',
			)
			expect(consentBaseUrl('https://localhost.evil.example')).toBe(
				'http://localhost:3007',
			)
			expect(consentBaseUrl('https://nottest.example/test')).toBe(
				'http://localhost:3007',
			)
			process.env.DATA_REGION = 'ksa'
			expect(consentBaseUrl('https://evil.example')).toBe(
				'http://localhost:3009',
			)
		})

		it('does not fail the startup check', () => {
			expect(() => assertConsentBaseUrl()).not.toThrow()
		})
	})
})

describe('isLocalDevelopmentHost', () => {
	it('accepts only developer-machine hosts', () => {
		for (const host of [
			'localhost',
			'127.0.0.1',
			'[::1]',
			'a.test',
			'b.localhost',
		]) {
			expect(isLocalDevelopmentHost(host)).toBe(true)
		}
		for (const host of [
			'example.com',
			'test.com',
			'evil-localhost',
			'10.0.0.5',
		]) {
			expect(isLocalDevelopmentHost(host)).toBe(false)
		}
	})
})

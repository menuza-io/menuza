import { describe, expect, it } from 'vitest'
import { isLocalHostname, isLocalUrl } from './local-host.js'

describe('isLocalHostname', () => {
	it.each([
		'localhost',
		'LOCALHOST',
		' localhost ',
		'127.0.0.1',
		'::1',
		'[::1]',
		'app.localhost',
		'app.epic-startup.test',
	])('%s is local', (host) => expect(isLocalHostname(host)).toBe(true))

	it.each([
		'',
		'example.com',
		'localhost.example.com',
		'app.test.example.com',
		'test',
		'127.0.0.2',
		'::2',
	])('%s is not local', (host) => expect(isLocalHostname(host)).toBe(false))
})

describe('isLocalUrl', () => {
	it.each([
		'http://localhost:3001',
		'http://127.0.0.1:3001/path',
		// URL keeps the brackets on an IPv6 hostname.
		'http://[::1]:3001',
		'https://app.epic-startup.test:2999',
	])('%s is local', (url) => expect(isLocalUrl(url)).toBe(true))

	it.each([
		undefined,
		null,
		'',
		'not a url',
		'localhost',
		'https://localhost.evil.example',
		'https://app.example.com',
	])('%s is not local', (url) => expect(isLocalUrl(url)).toBe(false))
})

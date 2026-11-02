import { afterEach, describe, expect, it } from 'vitest'
import {
	assertSecretNotPlaceholder,
	isInsecureSecret,
} from './insecure-secret.js'

const original = { ...process.env }
afterEach(() => {
	process.env = { ...original }
})

function setEnv(nodeEnv: string, baseUrl?: string) {
	process.env.NODE_ENV = nodeEnv
	if (baseUrl === undefined) delete process.env.BASE_URL
	else process.env.BASE_URL = baseUrl
}

describe('isInsecureSecret', () => {
	it.each([
		'your-jwt-secret',
		'dev-operator-token-do-not-use-in-prod-32b',
		'Change-Me',
	])('flags %s', (value) => expect(isInsecureSecret(value)).toBe(true))
	it('passes a random secret', () => {
		expect(isInsecureSecret('f3a9c1d7e2b84a60a1c5d9e0b7f2a4c8')).toBe(false)
	})
})

describe('assertSecretNotPlaceholder', () => {
	it('throws in production on a real host', () => {
		setEnv('production', 'https://app.example.com')
		expect(() =>
			assertSecretNotPlaceholder('JWT_SECRET', 'your-jwt-secret'),
		).toThrow(/placeholder/)
	})

	it.each([
		'https://localhost.evil.com',
		'https://x.localhost-foo.com',
		'https://evil.com/?h=localhost',
		'https://user@evil.com:3000#localhost',
		'',
	])('does not treat %s as local', (baseUrl) => {
		setEnv('production', baseUrl)
		expect(() =>
			assertSecretNotPlaceholder('JWT_SECRET', 'your-jwt-secret'),
		).toThrow()
	})

	it.each([
		'http://localhost:3001',
		'https://app.epic-startup.test:2999',
		'http://127.0.0.1:3001',
	])('allows %s', (baseUrl) => {
		setEnv('production', baseUrl)
		expect(assertSecretNotPlaceholder('JWT_SECRET', 'your-jwt-secret')).toBe(
			'your-jwt-secret',
		)
	})

	it('is a no-op outside production and for real secrets', () => {
		setEnv('development', 'https://app.example.com')
		expect(assertSecretNotPlaceholder('X', 'your-jwt-secret')).toBe(
			'your-jwt-secret',
		)
		setEnv('production', 'https://app.example.com')
		expect(assertSecretNotPlaceholder('X', 'f3a9c1d7e2b84a60')).toBe(
			'f3a9c1d7e2b84a60',
		)
	})
})

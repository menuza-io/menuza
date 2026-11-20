import { describe, expect, it } from 'vitest'
import { secondaryHostRedirect } from './secondary-host.ts'

const base = {
	primaryHost: 'www.example.com',
	primaryActive: true,
}

describe('secondaryHostRedirect', () => {
	it('sends the root to the primary www with a path and query kept', () => {
		expect(
			secondaryHostRedirect({
				...base,
				customHost: 'example.com',
				url: new URL('https://example.com/menu/pizza?lng=ar&x=1'),
			}),
		).toBe('https://www.example.com/menu/pizza?lng=ar&x=1')
	})

	it('sends www to a primary root, and an old domain to the primary', () => {
		expect(
			secondaryHostRedirect({
				primaryHost: 'example.com',
				primaryActive: true,
				customHost: 'www.example.com',
				url: new URL('https://www.example.com/'),
			}),
		).toBe('https://example.com/')
		expect(
			secondaryHostRedirect({
				...base,
				customHost: 'old-name.com',
				url: new URL('https://old-name.com/reservations'),
			}),
		).toBe('https://www.example.com/reservations')
	})

	it('serves the primary itself', () => {
		expect(
			secondaryHostRedirect({
				...base,
				customHost: 'WWW.example.com',
				url: new URL('https://www.example.com/menu'),
			}),
		).toBeNull()
	})

	it('serves slug hosts and sites without a primary', () => {
		expect(
			secondaryHostRedirect({
				...base,
				customHost: null,
				url: new URL('https://acme.menuza.io/'),
			}),
		).toBeNull()
		expect(
			secondaryHostRedirect({
				primaryHost: null,
				primaryActive: false,
				customHost: 'example.com',
				url: new URL('https://example.com/'),
			}),
		).toBeNull()
	})

	it('does not redirect to a primary that is still being set up', () => {
		expect(
			secondaryHostRedirect({
				...base,
				primaryActive: false,
				customHost: 'example.com',
				url: new URL('https://example.com/menu'),
			}),
		).toBeNull()
	})

	it('keeps the request protocol for local development', () => {
		expect(
			secondaryHostRedirect({
				...base,
				customHost: 'example.com',
				url: new URL('http://example.com/a'),
			}),
		).toBe('http://www.example.com/a')
	})
})

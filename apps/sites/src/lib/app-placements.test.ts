import { describe, expect, it } from 'vitest'
import { placementStores } from './app-placements'

const app = (
	overrides: Partial<Parameters<typeof placementStores>[0] & object> = {},
) => ({
	displayName: 'Acme',
	binding: {
		appleTeamId: null,
		iosBundleId: 'com.acme.app',
		androidPackage: 'com.acme.app',
		androidSha256: [],
	},
	stores: {
		app_store: 'https://apps.apple.com/us/app/acme/id1',
		play_store: 'https://play.google.com/store/apps/details?id=com.acme.app',
	},
	invite: { banner: true, confirmation: true, footer: true, bannerText: '' },
	...overrides,
})

describe('placements appear only for stores that are live (#196)', () => {
	it('shows nothing without an app or without a live store', () => {
		expect(placementStores(null, 'footer')).toEqual([])
		expect(placementStores(undefined, 'banner')).toEqual([])
		expect(placementStores(app({ stores: {} }), 'footer')).toEqual([])
		expect(placementStores(app({ stores: {} }), 'block')).toEqual([])
	})

	it('shows only the live stores, through the counting redirect', () => {
		const onlyApple = placementStores(
			app({ stores: { app_store: 'https://apps.apple.com/us/app/acme/id1' } }),
			'confirmation',
		)
		expect(onlyApple).toEqual([
			{ store: 'app_store', href: '/get-app?store=app_store&p=confirmation' },
		])
		const both = placementStores(app(), 'footer', '/ar')
		expect(both.map((s) => s.href)).toEqual([
			'/ar/get-app?store=app_store&p=footer',
			'/ar/get-app?store=play_store&p=footer',
		])
		// The store link itself is never in the page.
		expect(JSON.stringify(both)).not.toContain('apps.apple.com')
	})

	it('follows the owner’s switch per placement', () => {
		const off = app({
			invite: {
				banner: false,
				confirmation: false,
				footer: false,
				bannerText: '',
			},
		})
		expect(placementStores(off, 'banner')).toEqual([])
		expect(placementStores(off, 'confirmation')).toEqual([])
		expect(placementStores(off, 'email')).toEqual([])
		expect(placementStores(off, 'footer')).toEqual([])
		// The builder block is placed by hand: it follows the page, not a switch.
		expect(placementStores(off, 'block').length).toBe(2)
	})
})

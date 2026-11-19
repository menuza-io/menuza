import { describe, expect, it } from 'vitest'
import { classifyOrderLink, placeActionKind } from './ordering-providers.ts'

const own = ['https://acme.menuza.test', 'https://order.acme.com']

describe('classifyOrderLink', () => {
	it.each([
		['https://www.ubereats.com/store/acme/abc', 'delivery_app', 'Uber Eats'],
		['https://order.doordash.com/store/1', 'delivery_app', 'DoorDash'],
		['https://www.grubhub.com/restaurant/acme', 'delivery_app', 'Grubhub'],
		['https://deliveroo.co.uk/menu/london/acme', 'delivery_app', 'Deliveroo'],
		['https://www.talabat.com/uae/acme', 'delivery_app', 'Talabat'],
		['https://order.toasttab.com/online/acme', 'other', 'Toast'],
		['https://www.opentable.com/r/acme', 'other', 'OpenTable'],
		[
			'https://acme-bistro.example.org/order',
			'other',
			'acme-bistro.example.org',
		],
	])('%s is %s (%s)', (url, classification, provider) => {
		expect(classifyOrderLink(url, own)).toMatchObject({
			classification,
			provider,
		})
	})

	it("knows the restaurant's own pages are Direct, on the site host or custom domain", () => {
		expect(
			classifyOrderLink('https://acme.menuza.test/menu', own).classification,
		).toBe('direct')
		expect(
			classifyOrderLink('https://order.acme.com/menu?x=1', own).classification,
		).toBe('direct')
	})

	it('matches sub-domains but not look-alike hosts', () => {
		expect(
			classifyOrderLink('https://eats.ubereats.com/x').classification,
		).toBe('delivery_app')
		expect(classifyOrderLink('https://notubereats.com/x').classification).toBe(
			'other',
		)
		expect(
			classifyOrderLink('https://ubereats.com.evil.example/x').classification,
		).toBe('other')
	})

	it('marks short links, which hide where they lead', () => {
		const result = classifyOrderLink('https://bit.ly/3abc')
		expect(result).toMatchObject({ classification: 'other', isShortLink: true })
	})

	it('treats a non-URL as Other', () => {
		expect(classifyOrderLink('not a url').classification).toBe('other')
		expect(classifyOrderLink('javascript:alert(1)').classification).toBe(
			'other',
		)
	})

	it('maps Google place action types to link kinds', () => {
		expect(placeActionKind('FOOD_ORDERING')).toBe('order')
		expect(placeActionKind('FOOD_TAKEOUT')).toBe('pickup')
		expect(placeActionKind('DINING_RESERVATION')).toBe('reservation')
		expect(placeActionKind('APPOINTMENT')).toBeNull()
	})
})

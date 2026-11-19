import { describe, expect, it } from 'vitest'
import {
	MAX_AREA_PAGES,
	buildAreaPages,
	dishSlugFor,
	isValidLandingSlug,
} from './site-landing-pages.ts'

const zone = (
	id: string,
	name: string,
	extra: Record<string, unknown> = {},
) => ({
	id,
	name,
	enabled: true,
	restriction: 'allowed',
	provider: 'in_house',
	minimumOrder: 15,
	deliveryFee: 3,
	...extra,
})

describe('dish slugs', () => {
	it('never takes an ordering path and stays unique', () => {
		expect(dishSlugFor('Checkout', new Set())).toBe('checkout-2')
		expect(dishSlugFor('Chicken Shawarma', new Set(['chicken-shawarma']))).toBe(
			'chicken-shawarma-2',
		)
		expect(isValidLandingSlug('chicken-shawarma')).toBe(true)
		expect(isValidLandingSlug('../x')).toBe(false)
	})
})

describe('buildAreaPages', () => {
	it('keeps named, enabled, allowed zones at active locations', () => {
		const pages = buildAreaPages(
			[
				{
					id: 'l1',
					isActive: true,
					deliveryZones: JSON.stringify([
						zone('z1', 'Al Malqa'),
						zone('z2', 'Off', { enabled: false }),
						zone('z3', 'Blocked', { restriction: 'disallowed' }),
						zone('z4', ''),
					]),
				},
				{ id: 'l2', isActive: false, deliveryZones: [zone('z5', 'Closed')] },
			],
			[],
		)
		expect(pages).toEqual([
			{
				slug: 'al-malqa',
				locationId: 'l1',
				zoneId: 'z1',
				name: 'Al Malqa',
				minimumOrder: 15,
				deliveryFee: 3,
				intro: null,
				noIndex: true,
			},
		])
	})

	it('is indexable only with intro text, and the operator can switch one off', () => {
		const pages = buildAreaPages(
			[
				{
					id: 'l1',
					isActive: true,
					deliveryZones: [zone('z1', 'Olaya'), zone('z2', 'Malqa')],
				},
			],
			[
				{
					organizationLocationId: 'l1',
					zoneId: 'z1',
					slug: 'olaya-delivery',
					intro: '{"en":"Hot food to Olaya in 30 minutes."}',
					enabled: true,
				},
				{
					organizationLocationId: 'l1',
					zoneId: 'z2',
					slug: 'malqa',
					intro: '{"en":"  "}',
					enabled: false,
				},
			],
		)
		expect(pages).toHaveLength(1)
		expect(pages[0]).toMatchObject({ slug: 'olaya-delivery', noIndex: false })
	})

	it('stops at 50 pages', () => {
		const zones = Array.from({ length: 70 }, (_, i) =>
			zone(`z${i}`, `Area ${i}`),
		)
		const pages = buildAreaPages(
			[{ id: 'l1', isActive: true, deliveryZones: zones }],
			[],
		)
		expect(pages).toHaveLength(MAX_AREA_PAGES)
		expect(new Set(pages.map((page) => page.slug)).size).toBe(MAX_AREA_PAGES)
	})
})

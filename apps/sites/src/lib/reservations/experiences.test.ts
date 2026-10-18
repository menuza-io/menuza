import { describe, expect, it, vi } from 'vitest'
import {
	fetchPublicExperience,
	fetchPublicExperiences,
	isExperienceSlug,
	partyText,
	priceText,
	safeImageUrl,
	seatingPreview,
	snippet,
} from './experiences.ts'
import { testLabels } from './test-labels.ts'
import { type PublicExperience } from './types.ts'

const labels = testLabels()

const experience: PublicExperience = {
	id: 'exp_1',
	slug: 'chefs-counter',
	locationId: 'loc_1',
	locationName: 'Main',
	kind: 'ticketed',
	name: "Chef's Counter",
	description: 'Eight courses at the pass.',
	imageUrl: 'https://cdn.example/a.jpg',
	price: { priceMinor: 25000, perCover: true, currency: 'SAR' },
	partyMin: 2,
	partyMax: 4,
	timeZone: 'Asia/Riyadh',
	seatings: [
		{
			date: '2026-11-07',
			times: [
				{ localMin: 1200, time: '20:00' },
				{ localMin: 1290, time: '21:30' },
			],
		},
	],
	policy: null,
}

describe('experience fetchers', () => {
	it('sends the site origin and locale, and only reads the public catalog', async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json({ experiences: [experience] }),
		)
		const list = await fetchPublicExperiences({
			tenantApiUrl: 'http://localhost:3009/',
			origin: 'http://riyadh-grill.menuza.test:3008',
			locale: 'ar',
			fetchImpl: fetchImpl as unknown as typeof fetch,
		})
		expect(list).toHaveLength(1)
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
		]
		expect(url).toBe('http://localhost:3009/reservations/experiences?locale=ar')
		expect((init.headers as Record<string, string>).Origin).toBe(
			'http://riyadh-grill.menuza.test:3008',
		)
		expect(init.method).toBeUndefined()
	})

	it('answers null for the uniform 404, network failures and bad slugs', async () => {
		const notFound = vi.fn(async () => new Response('{}', { status: 404 }))
		expect(
			await fetchPublicExperiences({
				tenantApiUrl: 'http://x',
				origin: 'http://o',
				fetchImpl: notFound as unknown as typeof fetch,
			}),
		).toBeNull()
		const boom = vi.fn(async () => {
			throw new Error('down')
		})
		expect(
			await fetchPublicExperience('chefs-counter', {
				tenantApiUrl: 'http://x',
				origin: 'http://o',
				fetchImpl: boom as unknown as typeof fetch,
			}),
		).toBeNull()
		expect(
			await fetchPublicExperience('../etc', {
				tenantApiUrl: 'http://x',
				origin: 'http://o',
			}),
		).toBeNull()
		expect(isExperienceSlug('chefs-counter')).toBe(true)
		expect(isExperienceSlug('Chef')).toBe(false)
	})
})

describe('experience presentation', () => {
	it('prices in the experience currency from minor units', () => {
		expect(priceText(experience, labels, 'en')).toMatch(/250\.00 per guest/)
		expect(
			priceText(
				{ price: { priceMinor: 7500, perCover: false, currency: 'USD' } },
				labels,
				'en',
			),
		).toBe('$75.00 per booking')
		expect(priceText({ price: null }, labels, 'en')).toBeNull()
	})
	it('words the party range, previews seatings and trims long text', () => {
		expect(partyText(experience, labels)).toBe('2 to 4 guests')
		expect(partyText({ partyMin: 2, partyMax: 2 }, labels)).toBe('2 guests')
		const [first] = seatingPreview(experience, 'en')
		expect(first?.times).toHaveLength(2)
		expect(first?.label).toContain('Nov')
		const long = 'word '.repeat(80)
		expect(snippet(long, 40).length).toBeLessThanOrEqual(41)
		expect(snippet(long, 40).endsWith('…')).toBe(true)
		expect(snippet(null)).toBe('')
	})
	it('shows only https images', () => {
		expect(safeImageUrl('https://a.example/x.jpg')).toBe(
			'https://a.example/x.jpg',
		)
		expect(safeImageUrl('http://a.example/x.jpg')).toBeNull()
		expect(safeImageUrl('javascript:alert(1)')).toBeNull()
		expect(safeImageUrl(null)).toBeNull()
	})
})

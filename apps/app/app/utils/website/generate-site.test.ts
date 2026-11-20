import { describe, expect, it } from 'vitest'
import {
	assembleGeneratedSite,
	fixtureSiteCopy,
	generatedSiteDishIds,
	generatedTextHasEveryLocale,
	generationAllowed,
	keepGeneratedSection,
	scrubGeneratedText,
	SITE_GENERATIONS_PER_DAY,
	type SiteFacts,
} from './generate-site.ts'

const facts: SiteFacts = {
	organizationName: 'Al Bait',
	description: 'A neighbourhood kitchen.',
	cuisines: ['Lebanese'],
	locales: ['en', 'ar'],
	defaultLocale: 'en',
	tone: 'warm',
	ordering: true,
	reservations: false,
	locations: [
		{
			name: 'Olaya',
			address: 'Olaya St, Riyadh',
			phone: '+966111',
			hours: '11:00–22:00',
		},
	],
	dishes: [
		{ id: 'soup', name: 'Lentil soup', description: 'Red lentils' },
		{ id: 'grill', name: 'Mixed grill', description: 'Lamb and chicken' },
	],
	photos: ['/media/a.jpg', '/media/b.jpg', '/media/c.jpg'],
	logoSamples: [{ r: 140, g: 40, b: 40 }],
}

describe('first-site generator (#141)', () => {
	it('builds a home, about and contact draft from the menu', () => {
		const started = Date.now()
		const site = assembleGeneratedSite(facts, fixtureSiteCopy(facts))
		expect(Date.now() - started).toBeLessThan(30_000)
		expect(site.pages.map((page) => page.role)).toEqual([
			'home',
			'about',
			'contact',
		])
		expect(site.pages.every((page) => page.slug !== 'login')).toBe(true)
		expect(JSON.stringify(site.pages)).not.toContain('/login')
		expect(generatedSiteDishIds(site)).toEqual(['soup', 'grill'])
		expect(generatedTextHasEveryLocale(site, ['en', 'ar'])).toBe(true)
		expect(site.theme?.cssVars?.primary).toMatch(/^#/)
		const hero = site.pages[0]!.sections[0]!
		expect(hero.type).toBe('hero')
		expect(hero.config.slides).toHaveLength(3)
	})

	it('drops dishes, awards and chef names that are not in our data', () => {
		const copy = fixtureSiteCopy(facts)
		copy.about = {
			en: 'Welcome. Chef Hana won an award in 1999. Try Unicorn Tartare.',
			ar: 'أهلاً. Chef Hana won an award. Try Unicorn Tartare.',
		}
		copy.mentionedDishNames = ['Unicorn Tartare', 'Lentil soup']
		const site = assembleGeneratedSite(facts, copy)
		const json = JSON.stringify(site)
		expect(json).not.toContain('Unicorn Tartare')
		expect(json).not.toContain('award')
		expect(json).not.toContain('Chef')
		expect(generatedSiteDishIds(site)).not.toContain('unicorn')
	})

	it('omits the book button when reservations are off', () => {
		const site = assembleGeneratedSite(facts, fixtureSiteCopy(facts))
		const links = site.pages[0]!.sections[0]!.config.links as Array<{
			when?: string
		}>
		expect(links.map((link) => link.when)).toEqual(['ordering'])
	})

	it('drops an invalid section and refuses a sixth generation', () => {
		expect(keepGeneratedSection({ type: 'not-a-block', config: {} })).toBe(
			false,
		)
		expect(
			keepGeneratedSection({
				type: 'hero',
				config: { links: [{ url: '/login', link: { label: 'In' } }] },
			}),
		).toBe(false)
		expect(generationAllowed(SITE_GENERATIONS_PER_DAY - 1)).toBe(true)
		expect(generationAllowed(SITE_GENERATIONS_PER_DAY)).toBe(false)
	})

	it('scrubs an unknown dish name out of a sentence', () => {
		expect(
			scrubGeneratedText('Try the Unicorn Tartare today.', facts, [
				'Unicorn Tartare',
			]),
		).not.toContain('Unicorn')
	})
})

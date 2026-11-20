/**
 * First-site generator (#141). Facts come from the organization. A model may
 * only suggest wording; dish names that are not on the menu are removed, and
 * claims we do not have (awards, a chef, a founding year) are dropped.
 * Sections are validated against the block registry. Invalid ones are dropped.
 *
 * Tests pass `fixtureSiteCopy`. A live model is optional and never required.
 */
import { containsLoginCta } from '@repo/common/restaurant-sections'
import {
	DEFAULT_SITE_THEME,
	suggestLogoPalette,
	themeWithLogoPalette,
	type Rgb,
	type SiteThemeConfig,
} from '@repo/common/site-theme'
import { BLOCK_TYPES, type BlockType } from './block-types.ts'

export const SITE_GENERATIONS_PER_DAY = 5

export const SITE_TONES = ['warm', 'modern', 'upscale'] as const
export type SiteTone = (typeof SITE_TONES)[number]

export type SiteFacts = {
	organizationName: string
	description: string | null
	cuisines: string[]
	locales: string[]
	defaultLocale: string
	tone: SiteTone
	ordering: boolean
	reservations: boolean
	locations: Array<{
		name: string
		address: string
		phone: string | null
		hours: string
	}>
	dishes: Array<{
		id: string
		name: string
		description: string
	}>
	photos: string[]
	logoSamples: Rgb[]
}

export type Localized = Record<string, string>

export type ModelSiteCopy = {
	welcome: Localized
	about: Localized
	contactIntro: Localized
	faq: Array<{ question: Localized; answer: Localized }>
	/** Dish names the model mentioned. Unknown ones are removed from the text. */
	mentionedDishNames: string[]
}

export type GeneratedSection = {
	type: BlockType
	config: Record<string, unknown>
}

export type GeneratedPage = {
	role: 'home' | 'about' | 'contact'
	title: string
	slug: string
	sections: GeneratedSection[]
}

export type GeneratedSite = {
	theme: SiteThemeConfig | null
	pages: GeneratedPage[]
}

const WELCOME: Record<string, (name: string) => string> = {
	en: (name) => `Welcome to ${name}`,
	ar: (name) => `أهلاً بكم في ${name}`,
	es: (name) => `Bienvenido a ${name}`,
	fr: (name) => `Bienvenue chez ${name}`,
	de: (name) => `Willkommen bei ${name}`,
	zh: (name) => `欢迎来到${name}`,
}

const ABOUT_LEAD: Record<string, (name: string, cuisine: string) => string> = {
	en: (name, cuisine) =>
		cuisine ? `${name} serves ${cuisine}.` : `${name} is open for you.`,
	ar: (name, cuisine) =>
		cuisine ? `يقدم ${name} ${cuisine}.` : `${name} في خدمتكم.`,
	es: (name, cuisine) =>
		cuisine ? `${name} sirve ${cuisine}.` : `${name} está abierto para ti.`,
	fr: (name, cuisine) =>
		cuisine ? `${name} sert ${cuisine}.` : `${name} vous accueille.`,
	de: (name, cuisine) =>
		cuisine ? `${name} serviert ${cuisine}.` : `${name} ist für Sie da.`,
	zh: (name, cuisine) =>
		cuisine ? `${name}供应${cuisine}。` : `${name}欢迎您。`,
}

function localesOf(facts: SiteFacts) {
	const locales =
		facts.locales.length > 0 ? facts.locales : [facts.defaultLocale]
	return [...new Set(locales.map((locale) => locale.trim()).filter(Boolean))]
}

function fill(facts: SiteFacts, write: (locale: string) => string): Localized {
	const out: Localized = {}
	for (const locale of localesOf(facts)) {
		const base = locale.split('-')[0] ?? locale
		out[locale] = write(
			WELCOME[base] ? base : facts.defaultLocale.split('-')[0] || 'en',
		)
	}
	return out
}

/** Wording from our data only. Used when no model is called. */
export function fixtureSiteCopy(facts: SiteFacts): ModelSiteCopy {
	const cuisine = facts.cuisines[0] ?? ''
	const hours = facts.locations.find((location) => location.hours)?.hours ?? ''
	const address =
		facts.locations.find((location) => location.address)?.address ?? ''
	const welcome = fill(facts, (locale) => {
		const write = WELCOME[locale] ?? WELCOME.en!
		return write(facts.organizationName)
	})
	const about = fill(facts, (locale) => {
		const write = ABOUT_LEAD[locale] ?? ABOUT_LEAD.en!
		const lead = write(facts.organizationName, cuisine)
		return facts.description ? `${lead} ${facts.description}` : lead
	})
	const contactIntro = fill(facts, () =>
		address ? facts.organizationName : facts.organizationName,
	)
	const faq: ModelSiteCopy['faq'] = []
	if (hours) {
		faq.push({
			question: fill(facts, (locale) =>
				locale === 'ar' ? 'ما هي ساعات العمل؟' : 'What are your hours?',
			),
			answer: fill(facts, () => hours),
		})
	}
	if (facts.ordering) {
		faq.push({
			question: fill(facts, (locale) =>
				locale === 'ar'
					? 'هل يمكنني الطلب عبر الإنترنت؟'
					: 'Can I order online?',
			),
			answer: fill(facts, (locale) =>
				locale === 'ar'
					? 'نعم. الطلب عبر الإنترنت متاح.'
					: 'Yes. Online ordering is available.',
			),
		})
	}
	if (facts.reservations) {
		faq.push({
			question: fill(facts, (locale) =>
				locale === 'ar' ? 'هل يمكنني حجز طاولة؟' : 'Can I book a table?',
			),
			answer: fill(facts, (locale) =>
				locale === 'ar'
					? 'نعم. الحجز متاح.'
					: 'Yes. Reservations are available.',
			),
		})
	}
	return {
		welcome,
		about,
		contactIntro,
		faq,
		mentionedDishNames: facts.dishes.slice(0, 6).map((dish) => dish.name),
	}
}

const INVENTION =
	/\b(award|awards|michelin|chef|founded|established|since\s+\d{4})\b/i

function knownDishNames(facts: SiteFacts) {
	return new Set(facts.dishes.map((dish) => dish.name.trim().toLowerCase()))
}

export function scrubGeneratedText(
	text: string,
	facts: SiteFacts,
	mentioned: readonly string[],
) {
	const known = knownDishNames(facts)
	let next = text
	for (const name of mentioned) {
		if (!name.trim()) continue
		if (known.has(name.trim().toLowerCase())) continue
		next = next.split(name).join('')
	}
	const sentences = next.split(/(?<=[.!?])\s+/)
	return sentences
		.filter((sentence) => sentence.trim() && !INVENTION.test(sentence))
		.join(' ')
		.replace(/\s{2,}/g, ' ')
		.trim()
}

function scrubMap(
	map: Localized,
	facts: SiteFacts,
	mentioned: readonly string[],
) {
	const out: Localized = {}
	for (const [locale, value] of Object.entries(map)) {
		const text = scrubGeneratedText(value, facts, mentioned)
		if (text) out[locale] = text
	}
	return out
}

function everyLocale(map: Localized, locales: readonly string[]) {
	return locales.every((locale) => Boolean(map[locale]?.trim()))
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null
	return value as Record<string, unknown>
}

export function isKnownBlockType(type: string): type is BlockType {
	return Object.prototype.hasOwnProperty.call(BLOCK_TYPES, type)
}

/** Drops a section the registry does not know, or one that links to /login. */
export function keepGeneratedSection(section: {
	type: string
	config: unknown
}): section is GeneratedSection {
	if (!isKnownBlockType(section.type)) return false
	const config = asRecord(section.config)
	if (!config) return false
	if (containsLoginCta(config)) return false
	return true
}

export function assembleGeneratedSite(
	facts: SiteFacts,
	copy: ModelSiteCopy,
): GeneratedSite {
	const locales = localesOf(facts)
	const mentioned = copy.mentionedDishNames
	const welcome = scrubMap(copy.welcome, facts, mentioned)
	const about = scrubMap(copy.about, facts, mentioned)
	const contactIntro = scrubMap(copy.contactIntro, facts, mentioned)
	const faq = copy.faq
		.map((item) => ({
			question: scrubMap(item.question, facts, mentioned),
			answer: scrubMap(item.answer, facts, mentioned),
		}))
		.filter(
			(item) =>
				everyLocale(item.question, locales) &&
				everyLocale(item.answer, locales),
		)
	const dishIds = facts.dishes.slice(0, 6).map((dish) => dish.id)
	const photos = facts.photos.filter((url) => url.trim()).slice(0, 6)
	const heroLinks = [
		...(facts.ordering
			? [
					{
						url: '/menu',
						link: { label: 'Order online' },
						variant: 'primary',
						when: 'ordering',
					},
				]
			: []),
		...(facts.reservations
			? [
					{
						url: '/reserve',
						link: { label: 'Book a table' },
						variant: 'secondary',
						when: 'reservations',
					},
				]
			: []),
	]
	const homeSections: GeneratedSection[] = [
		{
			type: 'hero',
			config: {
				heading: JSON.stringify(welcome),
				subheading: JSON.stringify(about),
				links: heroLinks,
				assetType: photos.length > 0 ? 'image' : 'none',
				imageUrl: photos[0] ?? '',
				slides: photos.map((url) => ({ url, alt: facts.organizationName })),
				textPosition: 'center',
				overlay: photos.length > 0 ? 'dark' : 'none',
				minHeight: 640,
			},
		},
		{
			type: 'menuHighlights',
			config: {
				heading: 'From the menu',
				subtitle: '',
				source: 'picked',
				categoryId: '',
				itemIds: dishIds,
				layout: 'row',
			},
		},
		{
			type: 'locationsHours',
			config: { heading: 'Visit us', subtitle: '', locationIds: [] },
		},
	]
	if (faq.length > 0) {
		homeSections.push({
			type: 'faq',
			config: {
				title: 'Questions',
				subtitle: '',
				background: 'none',
				items: faq.map((item) => ({
					question: JSON.stringify(item.question),
					answer: JSON.stringify(item.answer),
				})),
			},
		})
	}
	const aboutSections: GeneratedSection[] = [
		{
			type: 'content',
			config: {
				title: JSON.stringify(welcome),
				subtitle: '',
				body: JSON.stringify(about),
				layout: 'text',
				background: 'none',
				ctaLabel: '',
				ctaUrl: '',
			},
		},
	]
	const contactSections: GeneratedSection[] = [
		{
			type: 'contact',
			config: {
				heading: 'Contact',
				intro: JSON.stringify(contactIntro),
				email: '',
				showForm: false,
				formId: '',
			},
		},
		{
			type: 'locationsHours',
			config: { heading: 'Visit us', subtitle: '', locationIds: [] },
		},
	]
	const drafts: GeneratedPage[] = [
		{
			role: 'home',
			title: 'Home',
			slug: 'home-ai-draft',
			sections: homeSections,
		},
		{ role: 'about', title: 'About', slug: 'about', sections: aboutSections },
		{
			role: 'contact',
			title: 'Contact',
			slug: 'contact',
			sections: contactSections,
		},
	]
	const pages = drafts.map((page) => ({
		...page,
		sections: page.sections.filter((section) => keepGeneratedSection(section)),
	}))
	const theme =
		facts.logoSamples.length > 0
			? themeWithLogoPalette(DEFAULT_SITE_THEME, facts.logoSamples)
			: null
	if (theme) {
		const palette = suggestLogoPalette(facts.logoSamples)
		if (palette.contrast.primaryText < 4.5 || palette.contrast.bodyText < 4.5) {
			return { theme: null, pages }
		}
	}
	return { theme, pages }
}

export function generationAllowed(countInLastDay: number) {
	return countInLastDay < SITE_GENERATIONS_PER_DAY
}

export function generatedTextHasEveryLocale(
	site: GeneratedSite,
	locales: readonly string[],
) {
	const maps: Localized[] = []
	const visit = (value: unknown) => {
		if (typeof value === 'string' && value.startsWith('{')) {
			try {
				const parsed = JSON.parse(value) as unknown
				if (
					parsed &&
					typeof parsed === 'object' &&
					!Array.isArray(parsed) &&
					Object.values(parsed).every((item) => typeof item === 'string')
				) {
					maps.push(parsed as Localized)
					return
				}
			} catch {
				// Plain text is not a locale map.
			}
		}
		if (Array.isArray(value)) value.forEach(visit)
		else if (value && typeof value === 'object') {
			Object.values(value as Record<string, unknown>).forEach(visit)
		}
	}
	for (const page of site.pages) {
		for (const section of page.sections) visit(section.config)
	}
	return maps.every((map) => everyLocale(map, locales))
}

export function generatedSiteDishIds(site: GeneratedSite) {
	const ids: string[] = []
	for (const page of site.pages) {
		for (const section of page.sections) {
			if (section.type !== 'menuHighlights') continue
			const itemIds = section.config.itemIds
			if (Array.isArray(itemIds)) {
				for (const id of itemIds) if (typeof id === 'string') ids.push(id)
			}
		}
	}
	return ids
}

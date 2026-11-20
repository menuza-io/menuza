/**
 * Hero slideshow, feature icons and the scrolling strip (#240).
 * Config only: no new columns.
 */

export const MAX_HERO_SLIDES = 6

export const FEATURE_ICON_KEYS = [
	'utensils',
	'clock',
	'pin',
	'star',
	'truck',
	'leaf',
	'heart',
	'phone',
] as const

export type FeatureIconKey = (typeof FEATURE_ICON_KEYS)[number]

export function isFeatureIconKey(value: unknown): value is FeatureIconKey {
	return (
		typeof value === 'string' &&
		(FEATURE_ICON_KEYS as readonly string[]).includes(value)
	)
}

export type HeroSlide = { url: string; alt: string }

/** Up to six photos. A single `imageUrl` still works as the only slide. */
export function heroSlides(config: {
	slides?: unknown
	imageUrl?: unknown
	media?: { url?: unknown; alt?: unknown }
}): HeroSlide[] {
	const fromList = Array.isArray(config.slides) ? config.slides : []
	const slides: HeroSlide[] = []
	for (const item of fromList) {
		if (!item || typeof item !== 'object') continue
		const record = item as Record<string, unknown>
		const url = typeof record.url === 'string' ? record.url.trim() : ''
		if (!url) continue
		const alt = typeof record.alt === 'string' ? record.alt : ''
		slides.push({ url, alt })
		if (slides.length >= MAX_HERO_SLIDES) break
	}
	if (slides.length > 0) return slides
	const single =
		(typeof config.media?.url === 'string' && config.media.url.trim()) ||
		(typeof config.imageUrl === 'string' && config.imageUrl.trim()) ||
		''
	if (!single) return []
	const alt = typeof config.media?.alt === 'string' ? config.media.alt : ''
	return [{ url: single, alt }]
}

export function heroSlideshow(slides: readonly HeroSlide[]) {
	return slides.length >= 2
}

export type StripItem = { text: string }

export function scrollingStripItems(config: { items?: unknown }): StripItem[] {
	if (!Array.isArray(config.items)) return []
	const items: StripItem[] = []
	for (const item of config.items) {
		if (typeof item === 'string') {
			const text = item.trim()
			if (text) items.push({ text })
			continue
		}
		if (!item || typeof item !== 'object') continue
		const text = (item as { text?: unknown }).text
		if (typeof text === 'string' && text.trim())
			items.push({ text: text.trim() })
	}
	return items.slice(0, 12)
}

/** Seconds each slide stays up. The animation length is this times the count. */
export const HERO_SLIDE_SECONDS = 6

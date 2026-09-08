import { type IconName } from '@repo/ui/icon'

/**
 * Block type registry for the website page builder.
 *
 * All section data is self-contained in SQLite via the WebsitePageSection.config
 * JSON column. This registry defines the available block types, their labels,
 * icons, and default JSON configurations.
 *
 * Header and footer are site-wide chrome stored on the organization. They are
 * shown on every page, cannot be deleted, and cannot be reordered away from the
 * top and bottom of the page.
 *
 * To add a new block type:
 * 1. Add its entry to BLOCK_TYPES below
 * 2. Create a block editor in pages.$pageId.tsx
 * 3. Create a matching Astro renderer in apps/sites
 */

export const LOCKED_BLOCK_TYPES = ['header', 'footer'] as const

export const SITE_HEADER_ID = 'site-header'
export const SITE_FOOTER_ID = 'site-footer'

export function isLockedBlockType(type: string): boolean {
	return (LOCKED_BLOCK_TYPES as readonly string[]).includes(type)
}

export function isSiteChromeId(id: string): boolean {
	return id === SITE_HEADER_ID || id === SITE_FOOTER_ID
}

export function composePageSectionsWithChrome<
	T extends { id: string; type: string; config: string; position: number },
>(body: T[], headerConfig: string, footerConfig: string): T[] {
	const middle = body.filter((section) => !isLockedBlockType(section.type))
	return [
		{
			id: SITE_HEADER_ID,
			type: 'header',
			config: headerConfig,
			position: 0,
		} as T,
		...middle.map((section, index) => ({
			...section,
			position: index + 1,
		})),
		{
			id: SITE_FOOTER_ID,
			type: 'footer',
			config: footerConfig,
			position: middle.length + 1,
		} as T,
	]
}

export const BLOCK_TYPES = {
	header: {
		label: 'Global Header',
		icon: 'menu' as IconName,
		description: 'Logo, navigation, and call to action',
		locked: true,
		defaultConfig: {
			navLinks: [],
			ctaLabel: 'Get started',
			ctaUrl: '/login',
			showCta: true,
			showName: true,
			sticky: true,
		},
	},
	hero: {
		label: 'Hero',
		icon: 'sparkles' as IconName,
		description: 'Full-width banner with heading and CTA',
		defaultConfig: {
			heading: 'Welcome to our site',
			subheading: 'A brief description of what we do',
			links: [{ url: '#', link: { label: 'Get Started' }, variant: 'primary' }],
			assetType: 'image',
			assetPosition: 'background',
			textPosition: 'left',
			overlay: 'dark',
			minHeight: 560,
			imageUrl: '',
			videoSrc: '',
			videoAutoPlay: true,
			videoLoop: true,
			videoMuted: true,
			videoControls: false,
		},
	},
	content: {
		label: 'Content',
		icon: 'file-text' as IconName,
		description: 'Text with optional image in a split layout',
		defaultConfig: {
			title: '',
			subtitle: '',
			body: '',
			layout: 'split',
			imageUrl: '',
			imageAlt: '',
			imagePosition: 'left',
			imageShape: 'rounded',
			background: 'none',
			ctaLabel: '',
			ctaUrl: '',
		},
	},
	gallery: {
		label: 'Gallery',
		icon: 'image' as IconName,
		description: 'Photo and video grid with optional captions',
		defaultConfig: {
			title: '',
			subtitle: '',
			columns: 3,
			imageShape: 'rounded',
			gap: 'md',
			background: 'none',
			images: [{ url: '', alt: '', caption: '', type: 'image' }],
		},
	},
	testimonials: {
		label: 'Testimonials',
		icon: 'star' as IconName,
		description: 'Review cards with quotes and ratings',
		defaultConfig: {
			title: 'What people say',
			subtitle: '',
			background: 'muted',
			items: [
				{
					quote: 'An outstanding experience from start to finish.',
					name: 'Alex Rivera',
					rating: 5,
				},
				{
					quote: 'Warm, thoughtful, and consistently excellent.',
					name: 'Jordan Lee',
					rating: 5,
				},
				{
					quote: 'We keep coming back — it never misses.',
					name: 'Sam Patel',
					rating: 5,
				},
			],
		},
	},
	faq: {
		label: 'FAQ',
		icon: 'help-circle' as IconName,
		description: 'Expandable questions and answers',
		defaultConfig: {
			title: 'Frequently Asked Questions',
			subtitle: '',
			background: 'none',
			items: [
				{ question: 'Question 1?', answer: 'Answer 1.' },
				{ question: 'Question 2?', answer: 'Answer 2.' },
			],
		},
	},
	cta: {
		label: 'Call to Action',
		icon: 'move-up-right' as IconName,
		description: 'Image banner with a floating content card',
		defaultConfig: {
			heading: 'Ready to get started?',
			description: '',
			variant: 'overlay',
			imageUrl: '',
			cardPosition: 'left',
			background: 'none',
			primaryLabel: 'Get Started',
			primaryUrl: '#',
			secondaryLabel: '',
			secondaryUrl: '',
		},
	},
	features: {
		label: 'Features',
		icon: 'blocks' as IconName,
		description: 'Grid of feature highlights',
		defaultConfig: {
			title: 'Features',
			subtitle: '',
			background: 'none',
			items: [
				{ title: 'Feature 1', description: 'Description of feature 1' },
				{ title: 'Feature 2', description: 'Description of feature 2' },
				{ title: 'Feature 3', description: 'Description of feature 3' },
			],
		},
	},
	cards: {
		label: 'Cards',
		icon: 'layout-grid' as IconName,
		description: 'Linked cards with images',
		defaultConfig: {
			title: '',
			background: 'none',
			items: [
				{
					title: 'Card 1',
					description: '',
					imageUrl: '',
					linkUrl: '',
					ctaLabel: '',
				},
			],
		},
	},
	video: {
		label: 'Video',
		icon: 'play' as IconName,
		description: 'Embedded video',
		defaultConfig: {
			title: '',
			videoUrl: '',
			autoplay: false,
			background: 'none',
		},
	},
	form: {
		label: 'Form',
		icon: 'file-text' as IconName,
		description: 'Embed one of your website forms',
		defaultConfig: {
			formId: '',
			showTitle: true,
		},
	},
	footer: {
		label: 'Footer',
		icon: 'share-2' as IconName,
		description: 'Logo, links, CTA, and copyright',
		locked: true,
		defaultConfig: {
			columns: [
				{
					title: 'Explore',
					links: [{ label: 'Home', url: '/' }],
				},
			],
			ctaLabel: 'Get started',
			ctaUrl: '/login',
			showCta: true,
			socials: [],
			copyright: '',
		},
	},
} as const

export type BlockType = keyof typeof BLOCK_TYPES

export const BLOCK_TYPE_LIST = Object.entries(BLOCK_TYPES).map(
	([type, def]) => ({
		type: type as BlockType,
		...def,
	}),
)

export const ADDABLE_BLOCK_TYPES = BLOCK_TYPE_LIST.filter(
	(block) => !isLockedBlockType(block.type),
)

export function pinLockedChromeOrder(
	orderedIds: string[],
	typesById: Map<string, string>,
) {
	const headerId = orderedIds.find((id) => typesById.get(id) === 'header')
	const footerId = orderedIds.find((id) => typesById.get(id) === 'footer')
	const middleIds = orderedIds.filter(
		(id) => !isLockedBlockType(typesById.get(id) ?? ''),
	)
	return [
		...(headerId ? [headerId] : []),
		...middleIds,
		...(footerId ? [footerId] : []),
	]
}

/**
 * Extra locked chrome after the first header and first footer, in list order.
 * Used to collapse duplicates created by overlapping page loads.
 */
export function extraLockedChromeIds(
	sections: Array<{ id: string; type: string }>,
) {
	const seen = new Set<string>()
	const extra: string[] = []
	for (const section of sections) {
		if (!isLockedBlockType(section.type)) continue
		if (seen.has(section.type)) {
			extra.push(section.id)
		} else {
			seen.add(section.type)
		}
	}
	return extra
}

/**
 * Get the default config for a block type.
 * Returns a deep clone so mutations don't affect the registry.
 */
export function getDefaultConfig(type: BlockType): Record<string, unknown> {
	const def = BLOCK_TYPES[type]
	if (!def) {
		return {}
	}
	return JSON.parse(JSON.stringify(def.defaultConfig)) as Record<
		string,
		unknown
	>
}

/**
 * Parse a JSON config string safely.
 */
export function parseBlockConfig(configJson: string): Record<string, unknown> {
	try {
		return JSON.parse(configJson) as Record<string, unknown>
	} catch {
		return {}
	}
}

type TemplateSection = { type: BlockType; position: number }

function bodySections(sections: TemplateSection[]): TemplateSection[] {
	return sections
		.filter((section) => !isLockedBlockType(section.type))
		.map((section, index) => ({
			type: section.type,
			position: index,
		}))
}

/**
 * Template definitions with their initial page sections.
 * Header and footer are site-wide and are not stored on the page.
 */
export const PAGE_TEMPLATES = {
	blank: {
		label: 'Blank',
		description: 'Start from scratch with header and footer',
		sections: bodySections([]),
	},
	article: {
		label: 'Article',
		description: 'A page with a hero and content section',
		sections: bodySections([
			{ type: 'hero' as BlockType, position: 0 },
			{ type: 'content' as BlockType, position: 1 },
		]),
	},
	showcase: {
		label: 'Showcase',
		description: 'A landing page with hero, gallery, and CTA',
		sections: bodySections([
			{ type: 'hero' as BlockType, position: 0 },
			{ type: 'gallery' as BlockType, position: 1 },
			{ type: 'content' as BlockType, position: 2 },
			{ type: 'testimonials' as BlockType, position: 3 },
			{ type: 'cta' as BlockType, position: 4 },
			{ type: 'faq' as BlockType, position: 5 },
		]),
	},
} as const

export type PageTemplate = keyof typeof PAGE_TEMPLATES

export const LOCALIZED_FIELDS: Record<string, string[]> = {
	header: ['ctaLabel', 'navLinks.[].label'],
	hero: ['heading', 'subheading', 'links.[].link.label'],
	content: ['title', 'subtitle', 'body', 'ctaLabel', 'imageAlt'],
	gallery: ['title', 'subtitle', 'images.[].alt', 'images.[].caption'],
	testimonials: [
		'title',
		'subtitle',
		'items.[].quote',
		'items.[].name',
		'items.[].role',
	],
	faq: ['title', 'subtitle', 'items.[].question', 'items.[].answer'],
	cta: ['heading', 'description', 'primaryLabel', 'secondaryLabel'],
	features: ['title', 'subtitle', 'items.[].title', 'items.[].description'],
	cards: [
		'title',
		'subtitle',
		'items.[].title',
		'items.[].description',
		'items.[].ctaLabel',
	],
	video: ['title', 'subtitle'],
	footer: [
		'copyright',
		'ctaLabel',
		'columns.[].title',
		'columns.[].links.[].label',
	],
}

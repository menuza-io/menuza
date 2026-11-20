import { containsLoginCta } from '@repo/common/restaurant-sections'
import { getDefaultConfig, type BlockType } from './block-types.ts'

export const HOME_PAGE_SLUG = 'home'
export const HOME_PAGE_TITLE = 'Home'

export function isHomePageSlug(slug: string) {
	return slug === HOME_PAGE_SLUG
}

type HomePageSection = {
	type: BlockType
	position: number
	config: Record<string, unknown>
}

/**
 * Header and footer for a new restaurant. No sign-in call to action: guests
 * are not operators.
 */
export function getRestaurantChrome() {
	return {
		header: {
			...getDefaultConfig('header'),
			ctaLabel: '',
			ctaUrl: '',
			showCta: false,
		},
		footer: {
			...getDefaultConfig('footer'),
			ctaLabel: '',
			ctaUrl: '',
			showCta: false,
			copyright: '',
		},
	}
}

/**
 * The restaurant home (#86). Order and Book are stored with `when`, and the
 * site shows each one only while that feature is on. Rewards is the existing
 * rewards block; the site hides it unless loyalty is on.
 */
export function getDefaultHomePageSections({
	organizationName,
	description,
}: {
	organizationName: string
	description?: string | null
}): HomePageSection[] {
	const trimmedDescription = description?.trim()
	const heroSubheading = trimmedDescription
		? trimmedDescription.replace(/[.!?]?$/, '.')
		: `See what's on the menu and when you can visit ${organizationName}.`

	const sections: HomePageSection[] = [
		{
			type: 'hero',
			position: 0,
			config: {
				...getDefaultConfig('hero'),
				heading: `Welcome to ${organizationName}`,
				subheading: heroSubheading,
				links: [
					{
						url: '/menu',
						link: { label: 'Order online' },
						variant: 'primary',
						when: 'ordering',
					},
					{
						url: '/reserve',
						link: { label: 'Book a table' },
						variant: 'secondary',
						when: 'reservations',
					},
				],
				assetType: 'none',
				textPosition: 'center',
				overlay: 'none',
				minHeight: 640,
			},
		},
		{
			type: 'menuHighlights',
			position: 1,
			config: {
				...getDefaultConfig('menuHighlights'),
				heading: 'From the menu',
				source: 'popular',
				layout: 'row',
			},
		},
		{
			type: 'locationsHours',
			position: 2,
			config: {
				...getDefaultConfig('locationsHours'),
				heading: 'Visit us',
				locationIds: [],
			},
		},
		{
			type: 'reviews',
			position: 3,
			config: {
				...getDefaultConfig('reviews'),
				title: 'What guests say',
				items: [{ quote: '', name: '', rating: 5 }],
			},
		},
		{
			type: 'rewards',
			position: 4,
			config: {
				...getDefaultConfig('rewards'),
				heading: 'Rewards',
				body: '',
				ctaLabel: 'Join',
			},
		},
	]
	return sections
}

export function homePageHasLoginCta(
	sections: readonly { config: Record<string, unknown> }[],
) {
	return sections.some((section) => containsLoginCta(section.config))
}

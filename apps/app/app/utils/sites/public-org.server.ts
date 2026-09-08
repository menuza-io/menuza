import {
	negotiateSiteLocale,
	parseLocalizedString,
	parseSiteLocalesConfig,
	pickLocalized,
	type SiteContentLocale,
	type SiteLocalesConfig,
} from '@repo/common/site-locales'
import {
	buildSiteThemeCss,
	parseSiteThemeConfig,
	type SiteFontFormat,
	type SiteThemeConfig,
} from '@repo/common/site-theme'
import {
	and,
	db,
	eq,
	inArray,
	Organization,
	OrganizationAnnouncement,
	WebsiteRedirect,
} from '@repo/database'
import {
	composePageSectionsWithChrome,
	getDefaultConfig,
} from '#app/utils/website/block-types.ts'

export type PublicSiteAnnouncement = {
	id: string
	content: string
	type: 'info' | 'warning' | 'error' | 'success'
	linkUrl: string | null
	linkLabel: string | null
	linkNewTab: boolean
}

export type PublicSiteRedirect = {
	id: string
	fromPath: string
	toPath: string
	statusCode: number
}

export type PublicSiteOrganization = {
	id: string
	name: string
	slug: string
	customDomain: string | null
	dataRegion: string
	siteTheme: string | null
	siteLocales: string | null
	siteDefaultLocale: string | null
	siteIconKey: string | null
	facebookPixelId: string | null
	googleTagManagerId: string | null
	googleAnalyticsId: string | null
	tiktokPixelId: string | null
	announcements: Array<{
		id: string
		content: string
		type: string
		linkUrl: string | null
		linkLabel: string | null
		linkNewTab: boolean
	}>
	redirects: PublicSiteRedirect[]
}

export type PublicSitePayload = {
	id: string
	name: string
	slug: string
	customDomain: string | null
	dataRegion: string
	theme: Omit<SiteThemeConfig, 'headingCustomFont' | 'bodyCustomFont'> & {
		css: string
		headingCustomFont: { url: string; format: SiteFontFormat } | null
		bodyCustomFont: { url: string; format: SiteFontFormat } | null
	}
	locales: SiteContentLocale[]
	defaultLocale: SiteContentLocale
	locale: SiteContentLocale
	siteIcon: {
		favicon32: string
		favicon16: string
		appleTouchIcon: string
		original: string
	} | null
	announcements: PublicSiteAnnouncement[]
	redirects: PublicSiteRedirect[]
	facebookPixelId: string | null
	googleTagManagerId: string | null
	googleAnalyticsId: string | null
	tiktokPixelId: string | null
}

const ANNOUNCEMENT_TYPES = ['info', 'warning', 'error', 'success'] as const

function toPublicAnnouncement(
	announcement: PublicSiteOrganization['announcements'][number],
	locale: string,
	defaultLocale: string,
): PublicSiteAnnouncement | null {
	const type = ANNOUNCEMENT_TYPES.includes(
		announcement.type as (typeof ANNOUNCEMENT_TYPES)[number],
	)
		? (announcement.type as PublicSiteAnnouncement['type'])
		: 'info'

	const content = pickLocalized(
		parseLocalizedString(announcement.content, defaultLocale),
		locale,
		defaultLocale,
	)

	if (!content) return null

	const linkLabel = announcement.linkLabel
		? pickLocalized(
				parseLocalizedString(announcement.linkLabel, defaultLocale),
				locale,
				defaultLocale,
			) || null
		: null

	return {
		id: announcement.id,
		content,
		type,
		linkUrl: announcement.linkUrl,
		linkLabel,
		linkNewTab: announcement.linkNewTab,
	}
}

export function toPublicSitePayload(
	organization: PublicSiteOrganization,
	options?: {
		preferredLocale?: string | string[] | null
	},
): PublicSitePayload {
	const theme = parseSiteThemeConfig(organization.siteTheme)
	const localesConfig: SiteLocalesConfig = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)
	const locale = negotiateSiteLocale(
		options?.preferredLocale,
		localesConfig.locales,
		localesConfig.defaultLocale,
	)

	function publicCustomFont(font: SiteThemeConfig['headingCustomFont']): {
		url: string
		format: NonNullable<SiteThemeConfig['headingCustomFont']>['format']
	} | null {
		if (!font) return null
		return {
			url: `/resources/fonts?objectKey=${encodeURIComponent(font.objectKey)}`,
			format: font.format,
		}
	}

	return {
		id: organization.id,
		name: organization.name,
		slug: organization.slug,
		customDomain: organization.customDomain,
		dataRegion: organization.dataRegion || 'us',
		theme: {
			...theme,
			headingCustomFont: publicCustomFont(theme.headingCustomFont),
			bodyCustomFont: publicCustomFont(theme.bodyCustomFont),
			css: buildSiteThemeCss(theme),
		},
		locales: localesConfig.locales,
		defaultLocale: localesConfig.defaultLocale,
		locale,
		siteIcon: organization.siteIconKey
			? {
					original: `/resources/images?objectKey=${encodeURIComponent(organization.siteIconKey)}`,
					favicon32: `/resources/images?objectKey=${encodeURIComponent(`org/${organization.slug}/site-icon/favicon-32.png`)}`,
					favicon16: `/resources/images?objectKey=${encodeURIComponent(`org/${organization.slug}/site-icon/favicon-16.png`)}`,
					appleTouchIcon: `/resources/images?objectKey=${encodeURIComponent(`org/${organization.slug}/site-icon/apple-touch-icon.png`)}`,
				}
			: null,
		announcements: organization.announcements
			.map((announcement) =>
				toPublicAnnouncement(announcement, locale, localesConfig.defaultLocale),
			)
			.filter((item): item is PublicSiteAnnouncement => item !== null),
		redirects: organization.redirects ?? [],
		facebookPixelId: organization.facebookPixelId ?? null,
		googleTagManagerId: organization.googleTagManagerId ?? null,
		googleAnalyticsId: organization.googleAnalyticsId ?? null,
		tiktokPixelId: organization.tiktokPixelId ?? null,
	}
}

/**
 * Resolve a published org site by slug or custom domain host.
 */
export async function findPublishedSiteOrganization(options: {
	slug?: string | null
	host?: string | null
}): Promise<PublicSiteOrganization | null> {
	const slug = options.slug?.trim().toLowerCase() || null
	const host = options.host?.trim().toLowerCase().split(':')[0] || null

	if (!slug && !host) return null

	const [organization] = await db
		.select()
		.from(Organization)
		.where(
			slug
				? and(
						eq(Organization.slug, slug),
						eq(Organization.active, true),
						eq(Organization.sitePublished, true),
					)
				: and(
						eq(Organization.customDomain, host!),
						eq(Organization.active, true),
						eq(Organization.sitePublished, true),
						inArray(Organization.customDomainStatus, ['active', 'pending']),
					),
		)
		.limit(1)
	if (!organization) return null
	const announcements = await db
		.select({
			id: OrganizationAnnouncement.id,
			content: OrganizationAnnouncement.content,
			type: OrganizationAnnouncement.type,
			linkUrl: OrganizationAnnouncement.linkUrl,
			linkLabel: OrganizationAnnouncement.linkLabel,
			linkNewTab: OrganizationAnnouncement.linkNewTab,
		})
		.from(OrganizationAnnouncement)
		.where(
			and(
				eq(OrganizationAnnouncement.organizationId, organization.id),
				eq(OrganizationAnnouncement.isEnabled, true),
			),
		)
	const redirects = await db
		.select({
			id: WebsiteRedirect.id,
			fromPath: WebsiteRedirect.fromPath,
			toPath: WebsiteRedirect.toPath,
			statusCode: WebsiteRedirect.statusCode,
		})
		.from(WebsiteRedirect)
		.where(
			and(
				eq(WebsiteRedirect.organizationId, organization.id),
				eq(WebsiteRedirect.isEnabled, true),
			),
		)
	return { ...organization, announcements, redirects }
}

export type PublicSitePageSection = {
	id: string
	type: string
	position: number
	config: string
}

export type PublicSitePage = {
	id: string
	title: string
	slug: string
	isHomePage: boolean
	publishedData: string | null
	seoTitle: string | null
	seoDescription: string | null
	seoImageUrl: string | null
	seoNoIndex: boolean
	sections: PublicSitePageSection[]
}

/**
 * Recursively walk a parsed config value and resolve every localized JSON
 * string `{"en":"…","fr":"…"}` to the appropriate locale string.
 */
function deepLocalize(
	value: unknown,
	locale: string,
	defaultLocale: string,
): unknown {
	if (typeof value === 'string') {
		// Only attempt to resolve strings that look like JSON objects
		if (value.startsWith('{')) {
			const resolved = pickLocalized(value, locale, defaultLocale)
			// If resolution produced a non-empty result, return it.
			// Otherwise fall back to the original string so callers can handle it.
			return resolved !== '' ? resolved : value
		}
		return value
	}

	if (Array.isArray(value)) {
		return value.map((item) => deepLocalize(item, locale, defaultLocale))
	}

	if (typeof value === 'object' && value !== null) {
		const obj = value as Record<string, unknown>
		// Check if this object looks like a localized map (keys are locale codes)
		// A localized map has only string values and at least one locale-like key.
		const keys = Object.keys(obj)
		const looksLikeLocalizedMap =
			keys.length > 0 &&
			keys.every((k) => /^[a-z]{2}(-[A-Z]{2})?$/.test(k)) &&
			Object.values(obj).every((v) => typeof v === 'string')
		if (looksLikeLocalizedMap) {
			const map = obj as Record<string, string>
			const localeBase = locale?.split('-')[0] ?? ''
			const defaultLocaleBase = defaultLocale.split('-')[0] ?? defaultLocale
			return (
				(locale ? map[locale] : undefined) ??
				(localeBase ? map[localeBase] : undefined) ??
				map[defaultLocale] ??
				map[defaultLocaleBase] ??
				Object.values(map)[0] ??
				''
			)
		}

		// Regular nested object — recurse into each key
		const result: Record<string, unknown> = {}
		for (const key of keys) {
			result[key] = deepLocalize(obj[key], locale, defaultLocale)
		}
		return result
	}

	return value
}

export function toPublicPagePayload(
	page: PublicSitePage,
	requestedLocale: string = 'en',
	defaultLocale: string = 'en',
	chrome?: {
		headerConfig?: string | null
		footerConfig?: string | null
	},
) {
	const title =
		pickLocalized(page.title, requestedLocale, defaultLocale) || page.title
	const seoTitle =
		pickLocalized(page.seoTitle, requestedLocale, defaultLocale) || title
	const seoDescription =
		pickLocalized(page.seoDescription, requestedLocale, defaultLocale) || ''

	const sections = composePageSectionsWithChrome(
		page.sections,
		chrome?.headerConfig ?? JSON.stringify(getDefaultConfig('header')),
		chrome?.footerConfig ?? JSON.stringify(getDefaultConfig('footer')),
	)

	return {
		id: page.id,
		title,
		slug: page.slug,
		isHomePage: page.isHomePage,
		seo: {
			title: seoTitle,
			description: seoDescription,
			imageUrl: page.seoImageUrl?.trim() || null,
			noIndex: page.seoNoIndex,
		},
		sections: sections.map((sec) => {
			let config: any = {}
			try {
				const parsed = JSON.parse(sec.config)
				config = deepLocalize(parsed, requestedLocale, defaultLocale)
			} catch {}
			return {
				id: sec.id,
				type: sec.type,
				position: sec.position,
				config,
			}
		}),
	}
}

function withPublishedSections(
	page: PublicSitePage | null,
	preview?: boolean,
): PublicSitePage | null {
	if (page && !preview && page.publishedData) {
		try {
			page.sections = JSON.parse(page.publishedData) as PublicSitePageSection[]
		} catch {}
	}
	return page
}

export async function findPublishedSitePage(
	organizationId: string,
	pageSlug: string | null,
	options?: { preview?: boolean; home?: boolean },
): Promise<PublicSitePage | null> {
	if (options?.home) {
		const homePage =
			(await db.query.WebsitePage.findFirst({
				where: (page, _operators) =>
					and(
						eq(page.organizationId, organizationId),
						eq(page.isHomePage, true),
						...(options?.preview ? [] : [eq(page.status, 'published')]),
					),
				columns: {
					id: true,
					title: true,
					slug: true,
					isHomePage: true,
					publishedData: true,
					seoTitle: true,
					seoDescription: true,
					seoImageUrl: true,
					seoNoIndex: true,
				},
				with: {
					sections: {
						columns: { id: true, type: true, position: true, config: true },
						orderBy: (section, operators) => operators.asc(section.position),
					},
				},
			})) ??
			(await db.query.WebsitePage.findFirst({
				where: (page, _operators) =>
					and(
						eq(page.organizationId, organizationId),
						inArray(page.slug, ['', 'home']),
						...(options?.preview ? [] : [eq(page.status, 'published')]),
					),
				columns: {
					id: true,
					title: true,
					slug: true,
					isHomePage: true,
					publishedData: true,
					seoTitle: true,
					seoDescription: true,
					seoImageUrl: true,
					seoNoIndex: true,
				},
				with: {
					sections: {
						columns: { id: true, type: true, position: true, config: true },
						orderBy: (section, operators) => operators.asc(section.position),
					},
				},
			}))
		return withPublishedSections(homePage ?? null, options.preview)
	}

	if (!pageSlug) return null

	const page = await db.query.WebsitePage.findFirst({
		where: (websitePage) =>
			and(
				eq(websitePage.organizationId, organizationId),
				eq(websitePage.slug, pageSlug),
				...(options?.preview ? [] : [eq(websitePage.status, 'published')]),
			),
		columns: {
			id: true,
			title: true,
			slug: true,
			isHomePage: true,
			publishedData: true,
			seoTitle: true,
			seoDescription: true,
			seoImageUrl: true,
			seoNoIndex: true,
		},
		with: {
			sections: {
				columns: { id: true, type: true, position: true, config: true },
				orderBy: (section, operators) => operators.asc(section.position),
			},
		},
	})
	return withPublishedSections(page ?? null, options?.preview)
}

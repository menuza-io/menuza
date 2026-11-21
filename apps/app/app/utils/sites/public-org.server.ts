import { formatPriceRange, parseStoredCuisines } from '@repo/common/cuisines'
import {
	type ConsentMode,
	legalRegionFor,
	type LegalKind,
} from '@repo/common/legal'
import {
	negotiateSiteLocale,
	parseLocalizedString,
	parseSiteLocalesConfig,
	pickLocalized,
	type SiteContentLocale,
	type SiteLocalesConfig,
} from '@repo/common/site-locales'
import { isIndexNowKey, parseVerificationCode } from '@repo/common/site-seo'
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
	isNotNull,
	ne,
	Organization,
	OrganizationAnnouncement,
	WebsitePage,
	WebsiteRedirect,
} from '@repo/database'
import {
	consentBannerEnabled,
	effectiveConsentMode,
	hasTrackingTags,
} from '#app/utils/legal/consent-settings.server.ts'
import { parseLegalContact } from '#app/utils/legal/contact.server.ts'
import { isSafeAnnouncementLink } from '#app/utils/safe-link.ts'
import { readSearchConsoleVerificationToken } from '#app/utils/seo/search-console.server.ts'
import {
	loadPublicCustomerApp,
	type PublicCustomerApp,
} from '#app/utils/customer-apps/public.server.ts'
import { siteHostCondition } from '#app/utils/sites/site-host.server.ts'
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
	/**
	 * The show window (#238), ISO (UTC). The public site compares it with the
	 * time of each request, so it is sent for every enabled announcement.
	 */
	startsAt: string | null
	endsAt: string | null
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
	customDomainStatus?: string | null
	dataRegion: string
	siteTheme: string | null
	siteLocales: string | null
	siteDefaultLocale: string | null
	siteIconKey: string | null
	facebookPixelId: string | null
	googleTagManagerId: string | null
	googleAnalyticsId: string | null
	tiktokPixelId: string | null
	cuisines?: string | null
	priceRange?: number | null
	googleSiteVerification?: string | null
	bingSiteVerification?: string | null
	indexNowKey?: string | null
	/** The Search Console verification token (#138), when connected. */
	searchConsoleVerification?: string | null
	/** Published generated legal pages (#89, #260): kind and address. */
	legalPages?: Array<{ kind: string; slug: string }>
	/** The platform's banner switch for this site (#89); absent means on. */
	consentBanner?: boolean
	/** The branded app's public facts (#195, #196). */
	customerApp?: PublicCustomerApp | null
	announcements: Array<{
		id: string
		content: string
		type: string
		linkUrl: string | null
		linkLabel: string | null
		linkNewTab: boolean
		startsAt?: Date | null
		endsAt?: Date | null
	}>
	redirects: PublicSiteRedirect[]
}

export type PublicSitePayload = {
	/**
	 * The branded customer app (#195, #196): its public identifiers and the
	 * stores that are live, or null when there is none. Sites serves the
	 * app-association files from it and shows the "Get the app" placements.
	 */
	customerApp: PublicCustomerApp | null
	id: string
	name: string
	slug: string
	customDomain: string | null
	/**
	 * The primary domain answers on its certificate (#139). Sites redirects a
	 * secondary host to `customDomain` only when this is true, so a primary that
	 * is still being set up never receives visitors that already work.
	 */
	customDomainActive: boolean
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
	/** Cuisine keys (#182); empty when not set. */
	cuisines: string[]
	/** `$` to `$$$$` in the local currency symbol, or null. */
	priceRange: string | null
	/**
	 * Search engine verification codes for the home page meta tags (#138):
	 * the operator's own Google code and the Search Console one, and Bing's.
	 */
	siteVerification: { google: string[]; bing: string | null }
	/** IndexNow key (#138), served at `/<key>.txt`. */
	indexNowKey: string | null
	/**
	 * Published legal pages by kind (#89, #260), as site paths; a kind with no
	 * published page is absent, so no link is shown for it.
	 */
	legalPages: Partial<Record<LegalKind, string>>
	/**
	 * The cookie banner mode the site runs. `off` when the operator chose it
	 * (a site with no tracking tags) or the platform switched the banner off.
	 */
	consent: { mode: ConsentMode }
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
		// Rows saved before validation existed may hold `javascript:` URLs.
		linkUrl:
			announcement.linkUrl && isSafeAnnouncementLink(announcement.linkUrl)
				? announcement.linkUrl
				: null,
		linkLabel,
		linkNewTab: announcement.linkNewTab,
		startsAt: announcement.startsAt?.toISOString() ?? null,
		endsAt: announcement.endsAt?.toISOString() ?? null,
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
		customerApp: organization.customerApp ?? null,
		id: organization.id,
		name: organization.name,
		slug: organization.slug,
		customDomain: organization.customDomain,
		customDomainActive:
			Boolean(organization.customDomain) &&
			organization.customDomainStatus === 'active',
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
		cuisines: parseStoredCuisines(organization.cuisines) ?? [],
		priceRange:
			formatPriceRange(
				organization.priceRange,
				organization.dataRegion === 'ksa' ? 'SAR' : 'USD',
			) || null,
		siteVerification: {
			google: [
				organization.googleSiteVerification,
				organization.searchConsoleVerification,
			]
				.map((code) => (code ? parseVerificationCode('google', code) : null))
				.filter(
					(code, index, all): code is string =>
						Boolean(code) && all.indexOf(code) === index,
				),
			bing: organization.bingSiteVerification
				? parseVerificationCode('bing', organization.bingSiteVerification)
				: null,
		},
		indexNowKey: isIndexNowKey(organization.indexNowKey)
			? organization.indexNowKey
			: null,
		legalPages: publicLegalPages(organization.legalPages),
		consent: { mode: publicConsentMode(organization) },
	}
}

const LEGAL_PAGE_KINDS = ['privacy', 'terms', 'cookies', 'accessibility']

function publicLegalPages(
	pages: PublicSiteOrganization['legalPages'],
): Partial<Record<LegalKind, string>> {
	const out: Partial<Record<LegalKind, string>> = {}
	for (const page of pages ?? []) {
		if (LEGAL_PAGE_KINDS.includes(page.kind)) {
			out[page.kind as LegalKind] = `/${page.slug}`
		}
	}
	return out
}

function publicConsentMode(organization: PublicSiteOrganization): ConsentMode {
	if (organization.consentBanner === false) return 'off'
	const contact = parseLegalContact(
		(organization as { legalContact?: string | null }).legalContact,
	)
	return effectiveConsentMode({
		stored:
			(organization as { consentMode?: string | null }).consentMode ?? null,
		region: legalRegionFor({
			country: contact.country,
			dataRegion: organization.dataRegion,
			defaultLocale: organization.siteDefaultLocale,
			address: contact.address,
		}),
		hasTrackingTags: hasTrackingTags({
			facebookPixelId: organization.facebookPixelId ?? null,
			googleTagManagerId: organization.googleTagManagerId ?? null,
			googleAnalyticsId: organization.googleAnalyticsId ?? null,
			tiktokPixelId: organization.tiktokPixelId ?? null,
		}),
	})
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
						siteHostCondition(host!),
						eq(Organization.active, true),
						eq(Organization.sitePublished, true),
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
			startsAt: OrganizationAnnouncement.startsAt,
			endsAt: OrganizationAnnouncement.endsAt,
		})
		.from(OrganizationAnnouncement)
		.where(
			and(
				eq(OrganizationAnnouncement.organizationId, organization.id),
				eq(OrganizationAnnouncement.isEnabled, true),
			),
		)
	const redirectRows = await db
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
	// A redirect whose target page is unpublished goes to the home page for the
	// time being (302), and is back to normal once the page is published (#248).
	// The public payload is rebuilt on every publish and unpublish.
	const unpublished = redirectRows.length
		? await db
				.select({ slug: WebsitePage.slug })
				.from(WebsitePage)
				.where(
					and(
						eq(WebsitePage.organizationId, organization.id),
						ne(WebsitePage.status, 'published'),
					),
				)
		: []
	const redirects = redirectsWithUnpublishedFallback(
		redirectRows,
		unpublished.map((page) => `/${page.slug}`),
	)
	const searchConsoleVerification = await readSearchConsoleVerificationToken(
		organization.id,
	)
	const legalPages = (
		await db
			.select({
				kind: WebsitePage.legalKind,
				slug: WebsitePage.slug,
			})
			.from(WebsitePage)
			.where(
				and(
					eq(WebsitePage.organizationId, organization.id),
					eq(WebsitePage.status, 'published'),
					isNotNull(WebsitePage.legalKind),
				),
			)
	).flatMap((row) => (row.kind ? [{ kind: row.kind, slug: row.slug }] : []))
	return {
		...organization,
		announcements,
		redirects,
		searchConsoleVerification,
		legalPages,
		consentBanner: await consentBannerEnabled(organization.id),
		customerApp: await loadPublicCustomerApp(organization.id),
	}
}

/**
 * Sends a redirect whose internal target is an unpublished page to the home
 * page with a temporary 302 instead (#248). Everything else is unchanged.
 */
export function redirectsWithUnpublishedFallback<
	T extends { toPath: string; statusCode: number },
>(redirects: T[], unpublishedPaths: readonly string[]): T[] {
	if (unpublishedPaths.length === 0) return redirects
	const hidden = new Set(unpublishedPaths.map((path) => path.toLowerCase()))
	return redirects.map((redirect) => {
		if (!redirect.toPath.startsWith('/') || redirect.toPath.startsWith('//')) {
			return redirect
		}
		const path = redirect.toPath.split(/[?#]/u)[0]!.toLowerCase()
		const clean = path.length > 1 ? path.replace(/\/+$/u, '') : path
		return hidden.has(clean)
			? { ...redirect, toPath: '/', statusCode: 302 }
			: redirect
	})
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
export function deepLocalize(
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

/**
 * Serve a published page from its `publishedData` snapshot, taken by
 * `publishWebsitePage`. A page with no snapshot keeps its live sections only
 * for legacy rows: pages published before every publish path wrote a snapshot
 * (new organizations' Home pages and the Pages list's Publish). Such a page
 * stops exposing later edits once it is published again.
 */
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

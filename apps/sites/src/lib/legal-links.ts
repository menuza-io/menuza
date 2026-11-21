import { getLocaleHref } from '@repo/common/site-locales'

export type LegalKind = 'privacy' | 'terms' | 'cookies' | 'accessibility'

export const LEGAL_LINK_ORDER: readonly LegalKind[] = [
	'privacy',
	'terms',
	'cookies',
	'accessibility',
]

/**
 * The links to the restaurant's published legal pages (#89, #260), in the
 * visitor's language. A kind with no published page has no link, so the
 * footer, checkout, booking, apply and sign-in screens never point at a page
 * that does not exist.
 */
export function legalLinks(
	organization:
		| {
				legalPages?: Partial<Record<LegalKind, string>>
				defaultLocale?: string
		  }
		| null
		| undefined,
	locale: string | null | undefined,
	kinds: readonly LegalKind[] = LEGAL_LINK_ORDER,
): Array<{ kind: LegalKind; href: string }> {
	const pages = organization?.legalPages ?? {}
	const defaultLocale = organization?.defaultLocale ?? 'en'
	return kinds.flatMap((kind) => {
		const path = pages[kind]
		if (!path || !path.startsWith('/') || path.startsWith('//')) return []
		return [
			{
				kind,
				href: getLocaleHref(
					path,
					locale ?? defaultLocale,
					locale,
					defaultLocale,
				),
			},
		]
	})
}

/**
 * Whether the cookie banner applies: a mode other than `off`, and something to
 * ask about: a tracking tag, or (#259) an embedded third-party widget on this
 * page, which can set marketing cookies. Without either there is nothing to
 * consent to.
 */
export function bannerApplies(
	organization: {
		consent?: { mode: 'required' | 'notice' | 'off' }
		facebookPixelId?: string | null
		googleTagManagerId?: string | null
		googleAnalyticsId?: string | null
		tiktokPixelId?: string | null
	},
	page: { hasEmbeds?: boolean } = {},
) {
	const mode = organization.consent?.mode ?? 'off'
	if (mode === 'off') return false
	if (page.hasEmbeds) return true
	return Boolean(
		organization.facebookPixelId?.trim() ||
		organization.googleTagManagerId?.trim() ||
		organization.googleAnalyticsId?.trim() ||
		organization.tiktokPixelId?.trim(),
	)
}

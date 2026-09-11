import { resolveEmailTheme, type EmailTheme } from '@repo/common/email-theme'
import { db, eq, Organization } from '@repo/database'
import { type EmailSocialLink } from '@repo/email/marketing'

export type OrganizationEmailBranding = EmailTheme & {
	socials: EmailSocialLink[]
}

type EmailBrandingOrg = {
	name: string
	siteIconKey: string | null
	siteTheme: string | null
	siteFooterConfig: string | null
}

/**
 * Best-effort social links from the org's website footer config. Entries may be
 * localized (`{ en: 'https://…' }`), so the first string value wins.
 */
export function parseEmailSocials(
	siteFooterConfig: string | null,
): EmailSocialLink[] {
	if (!siteFooterConfig) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(siteFooterConfig)
	} catch {
		return []
	}
	if (!parsed || typeof parsed !== 'object') return []
	const socials = (parsed as { socials?: unknown }).socials
	if (!Array.isArray(socials)) return []

	return socials.flatMap((entry) => {
		if (!entry || typeof entry !== 'object') return []
		const { platform, url } = entry as { platform?: unknown; url?: unknown }
		const resolvedUrl =
			typeof url === 'string'
				? url
				: url && typeof url === 'object'
					? Object.values(url as Record<string, unknown>).find(
							(value): value is string => typeof value === 'string',
						)
					: undefined
		if (typeof platform !== 'string' || !resolvedUrl) return []
		return [{ platform, url: resolvedUrl }]
	})
}

export function buildEmailBranding(
	org: EmailBrandingOrg,
): OrganizationEmailBranding {
	const appUrl = process.env.BASE_URL || null
	const theme = resolveEmailTheme({
		organizationName: org.name,
		logoUrl: org.siteIconKey
			? `/resources/images?objectKey=${encodeURIComponent(org.siteIconKey)}`
			: null,
		appUrl,
		siteTheme: org.siteTheme,
	})

	return { ...theme, socials: parseEmailSocials(org.siteFooterConfig) }
}

export async function resolveEmailBrandingForOrg(
	organizationId: string,
): Promise<OrganizationEmailBranding> {
	const [org] = await db
		.select({
			name: Organization.name,
			siteIconKey: Organization.siteIconKey,
			siteTheme: Organization.siteTheme,
			siteFooterConfig: Organization.siteFooterConfig,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)

	if (!org) return { ...resolveEmailTheme({}), socials: [] }
	return buildEmailBranding(org)
}

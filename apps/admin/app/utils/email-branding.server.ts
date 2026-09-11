import { resolveEmailTheme, type EmailTheme } from '@repo/common/email-theme'
import { brand } from '@repo/config/brand'

export type PlatformEmailBranding = EmailTheme

/**
 * Platform marketing emails (admin → operators) use the platform brand rather
 * than a tenant's website branding.
 */
export function resolvePlatformEmailBranding(): PlatformEmailBranding {
	return resolveEmailTheme({
		organizationName: brand.name,
		appUrl: process.env.BASE_URL || null,
		siteTheme: null,
	})
}

import { z } from 'zod'

const optionalText = z.string().nullish()

/** Mirrors `PublicSiteAnnouncement` in apps/sites/src/lib/org.ts. */
export const publicSiteAnnouncementSchema = z.object({
	id: z.string(),
	content: z.string(),
	type: z.string(),
	linkUrl: optionalText,
	linkLabel: optionalText,
	linkNewTab: z.boolean().nullish(),
})

export const publicSiteIconSchema = z.object({
	original: z.string(),
	favicon32: optionalText,
	favicon16: optionalText,
	appleTouchIcon: optionalText,
})

/**
 * Mirrors `PublicOrganization` in apps/sites/src/lib/org.ts, the payload of
 * `GET {app}/resources/sites?slug=…|host=…`. Branding only: no customer data.
 * `theme` stays raw; lib/theme parses it and falls back to the defaults, so a
 * malformed theme never stops the app from loading.
 */
export const publicOrganizationSchema = z.object({
	id: z.string(),
	name: z.string(),
	slug: z.string(),
	customDomain: optionalText,
	dataRegion: optionalText,
	theme: z.unknown().optional(),
	locales: z.array(z.string()).nullish(),
	defaultLocale: optionalText,
	locale: optionalText,
	siteIcon: publicSiteIconSchema.nullish(),
	announcements: z.array(publicSiteAnnouncementSchema).nullish(),
})

export type PublicSiteAnnouncement = z.infer<
	typeof publicSiteAnnouncementSchema
>
export type PublicOrganization = z.infer<typeof publicOrganizationSchema>

export const customerProfileSchema = z.object({
	id: optionalText,
	name: optionalText,
	email: optionalText,
	phone: optionalText,
	needsName: z.boolean().nullish(),
})

export type CustomerProfile = z.infer<typeof customerProfileSchema>

export const customerProfileEnvelopeSchema = z.object({
	customer: customerProfileSchema.nullish(),
})

export const verifyResultSchema = z.object({
	success: z.boolean().nullish(),
	accessToken: optionalText,
	refreshToken: optionalText,
	needsName: z.boolean().nullish(),
	error: optionalText,
})

export type VerifyResult = z.infer<typeof verifyResultSchema>

/** Picks the tenant-api node that holds this organization's customer data. */
export function resolvedDataRegion(organization: PublicOrganization): string {
	const value = (organization.dataRegion ?? 'us').trim()
	return value ? value.toLowerCase() : 'us'
}

export function resolvedLocales(organization: PublicOrganization): string[] {
	const values = (organization.locales ?? []).filter(
		(value) => value.length > 0,
	)
	return values.length > 0 ? values : ['en']
}

export function resolvedDefaultLocale(
	organization: PublicOrganization,
): string {
	return organization.defaultLocale || 'en'
}

export function resolvedLocale(organization: PublicOrganization): string {
	return organization.locale || resolvedDefaultLocale(organization)
}

/** The site icon as an absolute URL (`/resources/images?…` is relative to the App). */
export function organizationIconUrl(
	organization: PublicOrganization,
	appBaseUrl: string,
): string | null {
	const original = organization.siteIcon?.original
	if (!original) return null
	if (original.startsWith('http://') || original.startsWith('https://')) {
		return original
	}
	const path = original.startsWith('/') ? original : `/${original}`
	try {
		return new URL(path, appBaseUrl).toString()
	} catch {
		return null
	}
}

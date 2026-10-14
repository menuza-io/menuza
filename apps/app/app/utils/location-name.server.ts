import { pickLocalized } from '@repo/common/site-locales'
import { db, eq, Organization } from '@repo/database'

/**
 * Location names are stored the way menu text is: plain text, or a JSON map of
 * language to name for a site written in several languages. Anything that
 * shows a name resolves it first, so nobody ever sees the raw map.
 */
export function displayLocationName(
	raw: string,
	locale: string | null | undefined,
	defaultLocale: string,
): string {
	return pickLocalized(raw, locale, defaultLocale) || raw
}

/** The organization's default site language, for names shown to its staff. */
export async function orgDefaultLocale(
	organizationId: string,
): Promise<string> {
	const [org] = await db
		.select({ siteDefaultLocale: Organization.siteDefaultLocale })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return org?.siteDefaultLocale || 'en'
}

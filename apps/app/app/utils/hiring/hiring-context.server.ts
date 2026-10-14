import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import { and, db, eq, Organization } from '@repo/database'
import { DEFAULT_SCOPE_ID } from '@repo/staffing'
import { type ApplicantScope } from './applicant-types.ts'

/**
 * What the hiring screens need beyond the postings themselves: where the
 * organization's public site lives, whether it is published, and the languages
 * job copy is written in. Control-plane facts only.
 */
export async function loadHiringContext(organizationId: string) {
	const [organization] = await db
		.select({
			sitePublished: Organization.sitePublished,
			customDomain: Organization.customDomain,
			customDomainStatus: Organization.customDomainStatus,
			siteLocales: Organization.siteLocales,
			siteDefaultLocale: Organization.siteDefaultLocale,
		})
		.from(Organization)
		.where(and(eq(Organization.id, organizationId)))
		.limit(1)
	const localesConfig = parseSiteLocalesConfig(
		organization?.siteLocales,
		organization?.siteDefaultLocale,
	)
	return {
		// The languages job copy is written in: the organization's site languages.
		defaultLocale: localesConfig.defaultLocale,
		supportedLocales: localesConfig.locales,
		sitePublished: organization?.sitePublished === true,
		customDomain:
			organization?.customDomain && organization.customDomainStatus === 'active'
				? organization.customDomain
				: null,
		defaultCurrency: 'USD',
	}
}

/**
 * The scope facts the applicant screens need: where an interview happens (its
 * time zone fixes what a typed time means) and which currency a hire is paid
 * in. An organization has one implicit scope, named after it.
 */
export async function loadApplicantScopes(
	organizationId: string,
): Promise<ApplicantScope[]> {
	const [organization] = await db
		.select({
			name: Organization.name,
			timeZone: Organization.staffingTimeZone,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	return [
		{
			id: DEFAULT_SCOPE_ID,
			name: organization?.name ?? '',
			timeZone: organization?.timeZone ?? 'UTC',
			currency: 'USD',
		},
	]
}

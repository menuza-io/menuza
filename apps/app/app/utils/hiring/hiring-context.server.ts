import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import { getLocationCurrency } from '@repo/common/location-currency'
import {
	and,
	asc,
	db,
	eq,
	inArray,
	Organization,
	OrganizationLocation,
} from '@repo/database'
import { DEFAULT_SCOPE_ID } from '@repo/staffing'
import {
	displayLocationName,
	orgDefaultLocale,
} from '#app/utils/location-name.server.ts'
import { type ApplicantScope } from './applicant-types.ts'
import { listPostingLocations } from './job-postings.server.ts'

/**
 * What the hiring screens need beyond the postings themselves: where the
 * organization's public site lives, whether it is published, and the languages
 * job copy is written in. Control-plane facts only.
 */
export async function loadHiringContext(
	organizationId: string,
	/** The member's location scope (`null` is every location). */
	locationIds: string[] | null = null,
) {
	const [[organization], locations] = await Promise.all([
		db
			.select({
				sitePublished: Organization.sitePublished,
				customDomain: Organization.customDomain,
				customDomainStatus: Organization.customDomainStatus,
				siteLocales: Organization.siteLocales,
				siteDefaultLocale: Organization.siteDefaultLocale,
			})
			.from(Organization)
			.where(and(eq(Organization.id, organizationId)))
			.limit(1),
		listPostingLocations(organizationId, locationIds),
	])
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
		// Locations a restaurant posts for; empty for an organization without any,
		// whose jobs are open at its one implicit scope.
		locations,
		canPostEverywhere: locationIds === null,
		defaultCurrency: locations[0]?.currency ?? 'USD',
	}
}

/**
 * The scope facts the applicant screens need: where an interview happens (its
 * time zone fixes what a typed time means) and which currency a hire is paid
 * in. An organization with locations has one scope per active location
 * (limited to the member's scope, `null` is every location); one without has a
 * single implicit scope named after it.
 */
export async function loadApplicantScopes(
	organizationId: string,
	locationIds: string[] | null = null,
): Promise<ApplicantScope[]> {
	const [anyLocation] = await db
		.select({ id: OrganizationLocation.id })
		.from(OrganizationLocation)
		.where(eq(OrganizationLocation.organizationId, organizationId))
		.limit(1)
	if (anyLocation) {
		const defaultLocale = await orgDefaultLocale(organizationId)
		const rows = await db
			.select({
				id: OrganizationLocation.id,
				name: OrganizationLocation.name,
				timeZone: OrganizationLocation.timezone,
				address: OrganizationLocation.address,
			})
			.from(OrganizationLocation)
			.where(
				and(
					eq(OrganizationLocation.organizationId, organizationId),
					eq(OrganizationLocation.isActive, true),
					...(locationIds
						? [inArray(OrganizationLocation.id, locationIds)]
						: []),
				),
			)
			.orderBy(asc(OrganizationLocation.name))
		return rows.map((row) => ({
			id: row.id,
			name: displayLocationName(row.name, defaultLocale, defaultLocale),
			timeZone: row.timeZone,
			currency: getLocationCurrency(row.address),
		}))
	}
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

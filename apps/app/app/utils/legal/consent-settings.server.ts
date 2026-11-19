import { getFeatureFlag } from '@repo/common/feature-flags'
import {
	defaultConsentMode,
	legalRegionFor,
	type ConsentMode,
	type LegalRegion,
} from '@repo/common/legal'
import { db, eq, Organization } from '@repo/database'
import { parseLegalContact } from './contact.server.ts'

/**
 * The cookie banner (#89) is on for every site; the flag is a kill switch.
 * Only a literal `false` turns it off (the site then behaves as before the
 * banner existed).
 */
export const CONSENT_BANNER_FLAG = 'website.consent_banner'

export async function consentBannerEnabled(organizationId: string) {
	return (
		(await getFeatureFlag(CONSENT_BANNER_FLAG, { organizationId })) !== false
	)
}

export function isConsentMode(value: unknown): value is ConsentMode {
	return value === 'required' || value === 'notice' || value === 'off'
}

/**
 * The mode a site runs: the one the operator chose, else the default for its
 * region (Required in the EU, UK and KSA, Notice only in the US). A site with
 * tracking tags can never run `off`: it is Required instead.
 */
export function effectiveConsentMode(input: {
	stored: string | null
	region: LegalRegion
	hasTrackingTags: boolean
}): ConsentMode {
	const chosen = isConsentMode(input.stored)
		? input.stored
		: defaultConsentMode(input.region)
	if (chosen === 'off' && input.hasTrackingTags) return 'required'
	return chosen
}

export type TrackingIds = {
	facebookPixelId: string | null
	googleTagManagerId: string | null
	googleAnalyticsId: string | null
	tiktokPixelId: string | null
}

export function hasTrackingTags(ids: TrackingIds) {
	return Boolean(
		ids.facebookPixelId?.trim() ||
		ids.googleTagManagerId?.trim() ||
		ids.googleAnalyticsId?.trim() ||
		ids.tiktokPixelId?.trim(),
	)
}

/** The consent setting and what it resolves to, for the settings card. */
export async function readConsentSettings(organizationId: string) {
	const [org] = await db
		.select({
			consentMode: Organization.consentMode,
			legalContact: Organization.legalContact,
			dataRegion: Organization.dataRegion,
			siteDefaultLocale: Organization.siteDefaultLocale,
			facebookPixelId: Organization.facebookPixelId,
			googleTagManagerId: Organization.googleTagManagerId,
			googleAnalyticsId: Organization.googleAnalyticsId,
			tiktokPixelId: Organization.tiktokPixelId,
		})
		.from(Organization)
		.where(eq(Organization.id, organizationId))
		.limit(1)
	if (!org) throw new Error('Organization not found')
	const contact = parseLegalContact(org.legalContact)
	const region = legalRegionFor({
		country: contact.country,
		dataRegion: org.dataRegion,
		defaultLocale: org.siteDefaultLocale,
		address: contact.address,
	})
	const tags = hasTrackingTags(org)
	return {
		stored: isConsentMode(org.consentMode) ? org.consentMode : null,
		region,
		hasTrackingTags: tags,
		effective: effectiveConsentMode({
			stored: org.consentMode,
			region,
			hasTrackingTags: tags,
		}),
		defaultMode: defaultConsentMode(region),
	}
}

export type SaveConsentResult =
	{ ok: true } | { ok: false; error: 'tags_need_consent' | 'invalid_mode' }

/** Saves the banner mode. Off is refused while any tracking tag is set. */
export async function saveConsentMode(
	organizationId: string,
	mode: unknown,
): Promise<SaveConsentResult> {
	if (!isConsentMode(mode)) return { ok: false, error: 'invalid_mode' }
	const settings = await readConsentSettings(organizationId)
	if (mode === 'off' && settings.hasTrackingTags) {
		return { ok: false, error: 'tags_need_consent' }
	}
	await db
		.update(Organization)
		.set({ consentMode: mode })
		.where(eq(Organization.id, organizationId))
	return { ok: true }
}

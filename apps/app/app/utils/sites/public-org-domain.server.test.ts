import { describe, expect, it } from 'vitest'
import {
	toPublicSitePayload,
	type PublicSiteOrganization,
} from './public-org.server.ts'

/** The public payload tells Sites whether the primary domain is live (#139). */
const base: PublicSiteOrganization = {
	id: 'o1',
	name: 'Al Bait',
	slug: 'al-bait',
	customDomain: 'www.albait.com',
	customDomainStatus: 'active',
	dataRegion: 'us',
	siteTheme: null,
	siteLocales: null,
	siteDefaultLocale: null,
	siteIconKey: null,
	facebookPixelId: null,
	googleTagManagerId: null,
	googleAnalyticsId: null,
	tiktokPixelId: null,
	announcements: [],
	redirects: [],
}

describe('toPublicSitePayload and the primary domain', () => {
	it('says the primary is active only when it is connected and active', () => {
		expect(toPublicSitePayload(base)).toMatchObject({
			customDomain: 'www.albait.com',
			customDomainActive: true,
		})
		expect(
			toPublicSitePayload({ ...base, customDomainStatus: 'pending' })
				.customDomainActive,
		).toBe(false)
		expect(
			toPublicSitePayload({ ...base, customDomainStatus: 'expired' })
				.customDomainActive,
		).toBe(false)
		expect(
			toPublicSitePayload({
				...base,
				customDomain: null,
				customDomainStatus: null,
			}).customDomainActive,
		).toBe(false)
		expect(
			toPublicSitePayload({ ...base, customDomainStatus: undefined })
				.customDomainActive,
		).toBe(false)
	})
})

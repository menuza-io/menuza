import {
	liveStores,
	readStoreUrls,
	type StoreUrls,
} from '@repo/common/customer-app'
import { CustomerApp, CustomerAppStoreHealth, db, eq } from '@repo/database'

/**
 * What the public site learns about the restaurant's branded app (#195,
 * #196): public identifiers for the app-association files, the store links of
 * the stores that are live, and the invite placement switches. Nothing about
 * credentials, builds, accounts or reviews, and nothing at all for an archived
 * or missing app.
 */
export type PublicCustomerApp = {
	displayName: string
	/** For `apple-app-site-association` and `assetlinks.json`; public by nature. */
	binding: {
		appleTeamId: string | null
		iosBundleId: string
		androidPackage: string
		androidSha256: string[]
	}
	/** Only stores that are live; a placement shows nothing without one. */
	stores: StoreUrls
	invite: {
		banner: boolean
		confirmation: boolean
		footer: boolean
		bannerText: string
	}
}

function parseSha(raw: string | null): string[] {
	if (!raw) return []
	try {
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === 'string')
			: []
	} catch {
		return []
	}
}

export async function loadPublicCustomerApp(
	organizationId: string,
): Promise<PublicCustomerApp | null> {
	const [app] = await db
		.select()
		.from(CustomerApp)
		.where(eq(CustomerApp.organizationId, organizationId))
		.limit(1)
	if (!app || app.status === 'archived') return null
	const health = await db
		.select({
			store: CustomerAppStoreHealth.store,
			status: CustomerAppStoreHealth.status,
		})
		.from(CustomerAppStoreHealth)
		.where(eq(CustomerAppStoreHealth.appId, app.id))
	return {
		displayName: app.displayName,
		binding: {
			appleTeamId: app.appleTeamId,
			iosBundleId: app.iosBundleId,
			androidPackage: app.androidPackage,
			androidSha256: parseSha(app.androidSha256),
		},
		stores: liveStores({
			status: app.status,
			storeUrls: readStoreUrls(app.storeUrls),
			health,
		}),
		invite: {
			banner: app.inviteBanner,
			confirmation: app.inviteConfirmation,
			footer: app.inviteFooter,
			bannerText: app.inviteBannerText,
		},
	}
}

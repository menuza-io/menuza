import {
	type AccountCheckResult,
	type AccountSnapshot,
	CUSTOMER_APP_STORES,
	evaluateAccountChecks,
	type CustomerAppStore,
	liveStores,
	pushCredentialsReady,
	readStoreUrls,
	rebuildRequired,
	showsAccountChecks,
	type StoreUrls,
} from '@repo/common/customer-app'
import {
	and,
	CustomerApp,
	CustomerAppBuild,
	CustomerAppStoreHealth,
	db,
	desc,
	eq,
	Organization,
} from '@repo/database'
import { listCredentialStatuses } from './credentials.server.ts'
import { tapTotals } from './service.server.ts'

export type CustomerAppStoreView = {
	store: CustomerAppStore
	url: string | null
	status: 'live' | 'removed' | 'unknown'
	version: string | null
	ratingX100: number | null
	ratingCount: number
	lastCheckedAt: string | null
	/** Present when the last read failed: the numbers above are the last known ones. */
	lastError: string | null
}

export type CustomerAppView = {
	id: string
	displayName: string
	status: 'draft' | 'published' | 'archived'
	publisher: 'menuza' | 'restaurant'
	marketingVersion: string
	stores: CustomerAppStoreView[]
	live: StoreUrls
	rebuildRequired: boolean
	/** Null for apps published under Menuza's own account (checks are not shown). */
	accountChecks: AccountCheckResult[] | null
	invite: {
		banner: boolean
		confirmation: boolean
		footer: boolean
		bannerText: string
	}
	taps: Array<{ placement: string; total: number }>
	push: { ios: boolean; android: boolean }
}

function parseSnapshot(raw: string | null): AccountSnapshot | null {
	if (!raw) return null
	try {
		return JSON.parse(raw) as AccountSnapshot
	} catch {
		return null
	}
}

/**
 * What the restaurant sees of its app: links, status, version and rating per
 * store with the time it was last read, the account checks when the
 * restaurant publishes under its own account, the invite switches and the tap
 * counts. Never a credential (only whether push credentials are set).
 */
export async function loadCustomerAppView(
	organizationId: string,
	now = Date.now(),
): Promise<CustomerAppView | null> {
	const [app] = await db
		.select()
		.from(CustomerApp)
		.where(eq(CustomerApp.organizationId, organizationId))
		.limit(1)
	if (!app) return null
	const [health, builds, organization, credentials, taps] = await Promise.all([
		db
			.select()
			.from(CustomerAppStoreHealth)
			.where(eq(CustomerAppStoreHealth.appId, app.id)),
		db
			.select({ dataRegion: CustomerAppBuild.dataRegion })
			.from(CustomerAppBuild)
			.where(
				and(
					eq(CustomerAppBuild.appId, app.id),
					eq(CustomerAppBuild.status, 'succeeded'),
				),
			)
			.orderBy(desc(CustomerAppBuild.finishedAt))
			.limit(1),
		db
			.select({ dataRegion: Organization.dataRegion })
			.from(Organization)
			.where(eq(Organization.id, organizationId))
			.limit(1),
		listCredentialStatuses(app.id),
		tapTotals(
			app.id,
			new Date(now - 30 * 86_400_000).toISOString().slice(0, 10),
		),
	])
	const urls = readStoreUrls(app.storeUrls)
	const snapshot = parseSnapshot(app.accountSnapshot)
	return {
		id: app.id,
		displayName: app.displayName,
		status: app.status,
		publisher: app.publisher,
		marketingVersion: app.marketingVersion,
		stores: CUSTOMER_APP_STORES.map((store) => {
			const row = health.find((r) => r.store === store)
			return {
				store,
				url: urls[store] ?? null,
				status: row?.status ?? 'unknown',
				version: row?.version ?? null,
				ratingX100: row?.ratingX100 ?? null,
				ratingCount: row?.ratingCount ?? 0,
				lastCheckedAt: row?.lastCheckedAt?.toISOString() ?? null,
				lastError: row?.lastError ?? null,
			}
		}),
		live: liveStores({ status: app.status, storeUrls: urls, health }),
		rebuildRequired: rebuildRequired({
			organizationRegion: organization[0]?.dataRegion ?? 'us',
			lastBuiltRegion: builds[0]?.dataRegion ?? null,
		}),
		accountChecks:
			showsAccountChecks(app.publisher) && snapshot
				? evaluateAccountChecks(snapshot, now)
				: showsAccountChecks(app.publisher)
					? []
					: null,
		invite: {
			banner: app.inviteBanner,
			confirmation: app.inviteConfirmation,
			footer: app.inviteFooter,
			bannerText: app.inviteBannerText,
		},
		taps,
		push: pushCredentialsReady(credentials),
	}
}

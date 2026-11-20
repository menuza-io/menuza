import {
	type AccountSnapshot,
	type CustomerAppPlatform,
	type CustomerAppStore,
	type CustomerAppStoreStatus,
} from '@repo/common/customer-app'

/**
 * The partners behind the customer app registry (#156), as small adapters so
 * the product behaves the same with a live partner or the local emulator: the
 * build pipeline, the stores (health, rating, reviews) and the store account
 * (expiry, terms, access). `getCustomerAppAdapters()` picks live ones, the
 * emulators on a local deployment that asked for them (`MOCKS=true`), and tests
 * inject their own. Nothing here calls a store for a binary submission: a
 * build is a recorded job plus status callbacks.
 */

export type BuildRequest = {
	appId: string
	buildId: string
	slug: string
	release: string
	platform: CustomerAppPlatform
	/** Internal endpoint the pipeline reads the app's build config from. */
	configUrl: string
	/** Internal endpoint the pipeline posts status to. */
	callbackUrl: string
}

export type BuildStart = {
	externalBuildId: string | null
	logUrl: string | null
}

export interface BuildAdapter {
	readonly name: string
	/** Records or dispatches one build. Throws when the pipeline refuses it. */
	start(request: BuildRequest): Promise<BuildStart>
}

export type StoreReview = {
	externalId: string
	rating: number
	title: string | null
	body: string
	appVersion: string | null
	reviewedAt: number
}

export type StoreSnapshot = {
	store: CustomerAppStore
	status: CustomerAppStoreStatus
	version: string | null
	ratingX100: number | null
	ratingCount: number
	reviews: StoreReview[]
}

export type StoreLookup = {
	iosBundleId: string
	androidPackage: string
	storeUrls: Partial<Record<CustomerAppStore, string>>
}

/** The store could not be reached: the caller keeps the last known state. */
export class StoreUnreachableError extends Error {
	constructor(readonly code: 'unreachable' | 'not_connected' | 'bad_response') {
		super(code)
		this.name = 'StoreUnreachableError'
	}
}

export interface StoreAdapter {
	readonly name: string
	isConfigured(store: CustomerAppStore): boolean
	/** Throws `StoreUnreachableError` when the store cannot answer. */
	fetch(app: StoreLookup, store: CustomerAppStore): Promise<StoreSnapshot>
}

export interface AccountAdapter {
	readonly name: string
	isConfigured(): boolean
	/** Null when the account cannot be read (the last snapshot stays). */
	snapshot(app: {
		id: string
		iosBundleId: string
		publisher: string
	}): Promise<AccountSnapshot | null>
}

export type CustomerAppAdapters = {
	build: BuildAdapter
	store: StoreAdapter
	account: AccountAdapter
}

import {
	type AccountSnapshot,
	type CustomerAppStore,
} from '@repo/common/customer-app'
import {
	type AccountAdapter,
	type BuildAdapter,
	type BuildRequest,
	type BuildStart,
	type CustomerAppAdapters,
	type StoreAdapter,
	type StoreLookup,
	StoreUnreachableError,
	type StoreSnapshot,
} from './adapters.server.ts'

/**
 * In-memory emulators for the build pipeline, the stores and the store
 * account. They serve local development (`MOCKS=true` with a local `BASE_URL`)
 * and tests, which script them: `builds.failFor`, `stores.set`,
 * `stores.unreachable`, `account.set`. No network, no secrets.
 */
export class MockBuildAdapter implements BuildAdapter {
	readonly name = 'mock'
	readonly started: BuildRequest[] = []
	/** App ids whose builds the pipeline refuses to start. */
	readonly failFor = new Set<string>()

	async start(request: BuildRequest): Promise<BuildStart> {
		if (this.failFor.has(request.appId)) {
			throw new Error('pipeline_refused')
		}
		this.started.push(request)
		return {
			externalBuildId: `mock-${request.buildId}`,
			logUrl: `https://builds.mock.test/log/${request.buildId}`,
		}
	}
}

export class MockStoreAdapter implements StoreAdapter {
	readonly name = 'mock'
	private snapshots = new Map<string, StoreSnapshot>()
	private down = new Set<CustomerAppStore>()
	fetches = 0

	private key(app: StoreLookup, store: CustomerAppStore) {
		return `${store}:${store === 'app_store' ? app.iosBundleId : app.androidPackage}`
	}

	set(
		app: StoreLookup,
		store: CustomerAppStore,
		snapshot: Partial<Omit<StoreSnapshot, 'store'>>,
	) {
		this.snapshots.set(this.key(app, store), {
			store,
			status: 'live',
			version: '1.0.0',
			ratingX100: 450,
			ratingCount: 12,
			reviews: [],
			...snapshot,
		})
	}

	/** Every call for this store throws `unreachable` until `reachable`. */
	unreachable(store: CustomerAppStore) {
		this.down.add(store)
	}

	reachable(store: CustomerAppStore) {
		this.down.delete(store)
	}

	isConfigured() {
		return true
	}

	async fetch(
		app: StoreLookup,
		store: CustomerAppStore,
	): Promise<StoreSnapshot> {
		this.fetches += 1
		if (this.down.has(store)) throw new StoreUnreachableError('unreachable')
		return (
			this.snapshots.get(this.key(app, store)) ?? {
				store,
				status: 'unknown',
				version: null,
				ratingX100: null,
				ratingCount: 0,
				reviews: [],
			}
		)
	}
}

export class MockAccountAdapter implements AccountAdapter {
	readonly name = 'mock'
	private snapshots = new Map<string, AccountSnapshot>()

	set(appId: string, snapshot: AccountSnapshot) {
		this.snapshots.set(appId, snapshot)
	}

	isConfigured() {
		return true
	}

	async snapshot(app: { id: string }) {
		return this.snapshots.get(app.id) ?? null
	}
}

export function createMockCustomerAppAdapters() {
	return {
		build: new MockBuildAdapter(),
		store: new MockStoreAdapter(),
		account: new MockAccountAdapter(),
	} satisfies CustomerAppAdapters
}

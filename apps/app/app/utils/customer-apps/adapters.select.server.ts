import { isLocalUrl } from '@repo/security/local-host'
import { readLiveEnv } from '#app/utils/env.server.ts'
import { type CustomerAppAdapters } from './adapters.server.ts'
import { createMockCustomerAppAdapters } from './adapters.mock.server.ts'
import {
	liveBuildAdapter,
	ManualAccountAdapter,
	PublicStoreAdapter,
} from './adapters.live.server.ts'

const ON = new Set(['1', 'true', 'yes', 'on'])

/** Emulators run only on a local deployment: a stray flag with a public BASE_URL is ignored. */
export function isCustomerAppMock(): boolean {
	const requested =
		ON.has(readLiveEnv('CUSTOMER_APP_MOCK').toLowerCase()) ||
		ON.has(readLiveEnv('MOCKS').toLowerCase())
	return requested && isLocalUrl(readLiveEnv('BASE_URL'))
}

let override: CustomerAppAdapters | null = null
let mockSet: ReturnType<typeof createMockCustomerAppAdapters> | null = null
let liveSet: CustomerAppAdapters | null = null

/** Tests inject adapters; `null` restores the default choice. */
export function setCustomerAppAdapters(adapters: CustomerAppAdapters | null) {
	override = adapters
}

export function getMockCustomerAppAdapters() {
	mockSet ??= createMockCustomerAppAdapters()
	return mockSet
}

export function getCustomerAppAdapters(): CustomerAppAdapters {
	if (override) return override
	if (isCustomerAppMock()) return getMockCustomerAppAdapters()
	liveSet ??= {
		build: liveBuildAdapter(),
		store: new PublicStoreAdapter(),
		account: new ManualAccountAdapter(),
	}
	return liveSet
}

import { isLocalUrl } from '@repo/security/local-host'
import { readLiveEnv } from '#app/utils/env.server.ts'
import {
	CloudflareDnsZoneProvider,
	CloudflareEmailRouting,
} from './adapters.cloudflare.server.ts'
import { createMockAdapters } from './adapters.mock.server.ts'
import { NameComRegistrar } from './adapters.namecom.server.ts'
import { type DomainAdapters } from './adapters.server.ts'
import { isDomainsMock } from './config.server.ts'
import { LiveDomainConnect } from './domain-connect.server.ts'

let override: DomainAdapters | null = null
let mockSet: ReturnType<typeof createMockAdapters> | null = null
let liveSet: DomainAdapters | null = null

/** Tests inject adapters; `null` restores the default choice. */
export function setDomainAdapters(adapters: DomainAdapters | null) {
	override = adapters
}

/** The emulator set (one per process), for local development and tests. */
export function getMockDomainAdapters() {
	mockSet ??= createMockAdapters()
	return mockSet
}

/**
 * The adapters for this deployment: injected ones, the emulators on a local
 * deployment that asked for them, otherwise the live partners (each reports
 * `isConfigured()`, and the screens hide what is not set up).
 */
export function getDomainAdapters(): DomainAdapters {
	if (override) return override
	if (isDomainsMock()) {
		const mock = getMockDomainAdapters()
		mock.dns.autoActivate = isLocalUrl(readLiveEnv('BASE_URL'))
		return mock
	}
	liveSet ??= {
		dns: new CloudflareDnsZoneProvider(),
		registrar: new NameComRegistrar(),
		routing: new CloudflareEmailRouting(),
		connect: new LiveDomainConnect(),
	}
	return liveSet
}

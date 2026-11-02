import { isLocalUrl } from '@repo/security/local-host'
import { readLiveEnv } from '#app/utils/env.server.ts'

/** Social posting settings, read live (see `readLiveEnv`). */
export function socialEnv(
	name: 'META_APP_ID' | 'META_APP_SECRET' | 'SOCIAL_MOCK' | 'BASE_URL',
): string {
	return readLiveEnv(name)
}

/**
 * The local Meta emulator (`SOCIAL_MOCK=true`). Only on a local deployment:
 * with a public BASE_URL a stray `SOCIAL_MOCK` is ignored.
 */
export function isSocialMock(): boolean {
	return (
		['1', 'true', 'on', 'yes'].includes(
			socialEnv('SOCIAL_MOCK').toLowerCase(),
		) && isLocalUrl(socialEnv('BASE_URL'))
	)
}

/** Accounts can be connected: the Meta app's keys are set, or the emulator runs. */
export function isMetaConfigured(): boolean {
	return (
		isSocialMock() ||
		Boolean(socialEnv('META_APP_ID') && socialEnv('META_APP_SECRET'))
	)
}

/** The one redirect URL registered with the Meta app. */
export function metaRedirectUri(): string {
	return `${socialEnv('BASE_URL').replace(/\/$/, '')}/resources/social/meta/callback`
}

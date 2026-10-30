import { ENV } from 'varlock/env'

/**
 * Social posting settings, read live (the Worker mirrors bindings into
 * `process.env`, so a rotated secret applies without a redeploy), then from
 * varlock.
 */
export function socialEnv(
	name: 'META_APP_ID' | 'META_APP_SECRET' | 'SOCIAL_MOCK' | 'BASE_URL',
): string {
	const live = typeof process !== 'undefined' ? process.env?.[name] : undefined
	return String(live ?? (ENV as Record<string, unknown>)[name] ?? '').trim()
}

function isLocalOrigin(value: string) {
	try {
		const host = new URL(value).hostname
		return (
			host === 'localhost' ||
			host === '127.0.0.1' ||
			host === '::1' ||
			host.endsWith('.localhost') ||
			host.endsWith('.test')
		)
	} catch {
		return false
	}
}

/**
 * The local Meta emulator (`SOCIAL_MOCK=true`). Only on a local deployment:
 * with a public BASE_URL a stray `SOCIAL_MOCK` is ignored.
 */
export function isSocialMock(): boolean {
	return (
		['1', 'true', 'on', 'yes'].includes(
			socialEnv('SOCIAL_MOCK').toLowerCase(),
		) && isLocalOrigin(socialEnv('BASE_URL'))
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

import { ENV } from 'varlock/env'

/**
 * Canva settings, read live (the Worker mirrors bindings into `process.env`,
 * so a rotated secret applies without a redeploy), then from varlock.
 */
export function canvaEnv(
	name: 'CANVA_CLIENT_ID' | 'CANVA_CLIENT_SECRET' | 'CANVA_MOCK' | 'BASE_URL',
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
 * The local Canva emulator (`CANVA_MOCK=true`). Only on a local deployment:
 * with a public BASE_URL a stray `CANVA_MOCK` is ignored.
 */
export function isCanvaMock(): boolean {
	return (
		['1', 'true', 'on', 'yes'].includes(canvaEnv('CANVA_MOCK').toLowerCase()) &&
		isLocalOrigin(canvaEnv('BASE_URL'))
	)
}

/** Canva can be used: the integration's keys are set, or the emulator runs. */
export function isCanvaConfigured(): boolean {
	return (
		isCanvaMock() ||
		Boolean(canvaEnv('CANVA_CLIENT_ID') && canvaEnv('CANVA_CLIENT_SECRET'))
	)
}

/** The one redirect URL registered with the Canva integration. */
export function canvaRedirectUri(): string {
	return `${canvaEnv('BASE_URL').replace(/\/$/, '')}/resources/print/canva/callback`
}

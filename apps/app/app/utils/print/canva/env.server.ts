import { isLocalUrl } from '@repo/security/local-host'
import { readLiveEnv } from '#app/utils/env.server.ts'

/** Canva settings, read live (see `readLiveEnv`). */
export function canvaEnv(
	name: 'CANVA_CLIENT_ID' | 'CANVA_CLIENT_SECRET' | 'CANVA_MOCK' | 'BASE_URL',
): string {
	return readLiveEnv(name)
}

/**
 * The local Canva emulator (`CANVA_MOCK=true`). Only on a local deployment:
 * with a public BASE_URL a stray `CANVA_MOCK` is ignored.
 */
export function isCanvaMock(): boolean {
	return (
		['1', 'true', 'on', 'yes'].includes(canvaEnv('CANVA_MOCK').toLowerCase()) &&
		isLocalUrl(canvaEnv('BASE_URL'))
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

export { ENV } from 'varlock/env'
import { ENV } from 'varlock/env'

/**
 * A setting read live, then from varlock: the Worker mirrors its bindings into
 * `process.env` (see workers/worker-env.ts), so a rotated secret applies
 * without a redeploy. Always a trimmed string, `''` when unset.
 */
export function readLiveEnv(name: string): string {
	const live = typeof process !== 'undefined' ? process.env?.[name] : undefined
	return String(live ?? (ENV as Record<string, unknown>)[name] ?? '').trim()
}

let _mockLaunchStatus: string | null = null
export function __setMockLaunchStatus(status: string | null) {
	_mockLaunchStatus = status
}

export function getLaunchStatus() {
	return _mockLaunchStatus ?? ENV.LAUNCH_STATUS
}

export function getDiscordInviteUrl() {
	return ENV.DISCORD_INVITE_URL
}

export function getWhatsAppGroupInviteUrl() {
	return ENV.WHATSAPP_GROUP_INVITE_URL
}

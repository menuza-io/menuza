export { ENV } from 'varlock/env'
import { ENV } from 'varlock/env'

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

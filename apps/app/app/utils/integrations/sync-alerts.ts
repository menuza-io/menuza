import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'

export const MENU_SYNC_FAILING_NOTIFICATION_TYPE = 'menu-sync-failing'

export function isMenuSyncFailingNotificationType(type: unknown): boolean {
	return type === MENU_SYNC_FAILING_NOTIFICATION_TYPE
}

export function menuSyncAlertPath(locationId?: string | null): string {
	return locationId
		? `/settings/integrations?locationId=${encodeURIComponent(locationId)}`
		: '/settings/integrations'
}

export function menuSyncAlertCopy(
	providerLabel: string | null,
	locationName: string | null,
	_: (descriptor: MessageDescriptor) => string,
): { subject: string; body: string } {
	const platform = providerLabel?.trim() || ''
	const location = locationName?.trim() || ''
	if (platform && location) {
		return {
			subject: _(msg`Menu sync failing for **${platform}** (${location})`),
			body: _(
				msg`Updates have failed for 24 hours. Open Integrations to reconnect or retry syncing.`,
			),
		}
	}
	if (platform) {
		return {
			subject: _(msg`Menu sync failing for **${platform}**`),
			body: _(
				msg`Updates have failed for 24 hours. Open Integrations to reconnect or retry syncing.`,
			),
		}
	}
	return {
		subject: _(msg`Menu sync is failing`),
		body: _(
			msg`Updates to a connected platform have failed for 24 hours. Open Integrations to check the connection.`,
		),
	}
}

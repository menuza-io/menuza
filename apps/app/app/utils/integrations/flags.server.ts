import { getFeatureFlag } from '@repo/common/feature-flags'

/**
 * Feature flags and kill switches for the Menu Sync cluster
 * (#93, #74, #95, #96, #144). All flags default off (`false` in ConfigFlag).
 */
export const INTEGRATION_FLAG_KEYS = {
	posOwnership: 'integrations.pos_ownership',
	autoSync: 'integrations.auto_sync',
	deliveryPause: 'integrations.delivery_pause',
	storeSettings: 'integrations.store_settings',
	menuCheck: 'integrations.menu_check',
} as const

export type IntegrationFlagName = keyof typeof INTEGRATION_FLAG_KEYS

const TRUE_VALUES = new Set(['true', '1', 'on', 'yes'])
const OFF_VALUES = new Set(['false', '0', 'off', 'no', 'disabled'])

export function isIntegrationFlagOn(value: unknown): boolean {
	if (value === true) return true
	if (typeof value === 'string') {
		return TRUE_VALUES.has(value.trim().toLowerCase())
	}
	return false
}

/** Kill switch env `MENU_AUTO_SYNC_ENABLED` (defaults on unless explicitly disabled). */
export function isMenuAutoSyncSwitchOn(): boolean {
	const raw =
		typeof process !== 'undefined' && process.env
			? process.env.MENU_AUTO_SYNC_ENABLED
			: undefined
	if (typeof raw !== 'string') return true
	const normalized = raw.trim().toLowerCase()
	if (!normalized) return true
	return !OFF_VALUES.has(normalized)
}

export async function isPosOwnershipEnabled(
	organizationId: string,
): Promise<boolean> {
	return isIntegrationFlagOn(
		await getFeatureFlag(INTEGRATION_FLAG_KEYS.posOwnership, {
			organizationId,
		}),
	)
}

export async function isAutoSyncEnabled(
	organizationId: string,
): Promise<boolean> {
	if (!isMenuAutoSyncSwitchOn()) return false
	return isIntegrationFlagOn(
		await getFeatureFlag(INTEGRATION_FLAG_KEYS.autoSync, {
			organizationId,
		}),
	)
}

export async function isDeliveryPauseEnabled(
	organizationId: string,
): Promise<boolean> {
	return isIntegrationFlagOn(
		await getFeatureFlag(INTEGRATION_FLAG_KEYS.deliveryPause, {
			organizationId,
		}),
	)
}

export async function isStoreSettingsEnabled(
	organizationId: string,
): Promise<boolean> {
	return isIntegrationFlagOn(
		await getFeatureFlag(INTEGRATION_FLAG_KEYS.storeSettings, {
			organizationId,
		}),
	)
}

export async function isMenuCheckEnabled(
	organizationId: string,
): Promise<boolean> {
	return isIntegrationFlagOn(
		await getFeatureFlag(INTEGRATION_FLAG_KEYS.menuCheck, {
			organizationId,
		}),
	)
}

export type IntegrationSyncFlags = {
	posOwnership: boolean
	autoSync: boolean
	deliveryPause: boolean
	storeSettings: boolean
	menuCheck: boolean
}

export async function getIntegrationSyncFlags(
	organizationId: string,
): Promise<IntegrationSyncFlags> {
	const [posOwnership, autoSyncFlag, deliveryPause, storeSettings, menuCheck] =
		await Promise.all([
			getFeatureFlag(INTEGRATION_FLAG_KEYS.posOwnership, { organizationId }),
			getFeatureFlag(INTEGRATION_FLAG_KEYS.autoSync, { organizationId }),
			getFeatureFlag(INTEGRATION_FLAG_KEYS.deliveryPause, { organizationId }),
			getFeatureFlag(INTEGRATION_FLAG_KEYS.storeSettings, { organizationId }),
			getFeatureFlag(INTEGRATION_FLAG_KEYS.menuCheck, { organizationId }),
		])
	return {
		posOwnership: isIntegrationFlagOn(posOwnership),
		autoSync: isMenuAutoSyncSwitchOn() && isIntegrationFlagOn(autoSyncFlag),
		deliveryPause: isIntegrationFlagOn(deliveryPause),
		storeSettings: isIntegrationFlagOn(storeSettings),
		menuCheck: isIntegrationFlagOn(menuCheck),
	}
}

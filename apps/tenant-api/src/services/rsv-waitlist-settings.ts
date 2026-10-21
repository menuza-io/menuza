import { type TenantDatabase } from '@repo/tenant-db'
import {
	getLocationSettingsWithContext,
	updateLocationSettings,
} from './rsv-setup-service.ts'

export type WaitlistSettingsPatch = {
	expectedVersion?: number
	waitlistEnabled?: boolean
	waitlistOnline?: boolean
	notifyMeEnabled?: boolean
	waitlistResponseMin?: number
	waitlistMaxParties?: number | null
}

type Serialized = Awaited<ReturnType<typeof getLocationSettingsWithContext>>

export function pickWaitlistSettings(settings: Serialized) {
	return {
		locationId: settings.locationId,
		version: settings.version,
		waitlistEnabled: settings.waitlistEnabled,
		waitlistOnline: settings.waitlistOnline,
		notifyMeEnabled: settings.notifyMeEnabled,
		waitlistResponseMin: settings.waitlistResponseMin,
		waitlistMaxParties: settings.waitlistMaxParties,
		location_id: settings.locationId,
		waitlist_enabled: settings.waitlistEnabled,
		waitlist_online: settings.waitlistOnline,
		notify_me_enabled: settings.notifyMeEnabled,
		waitlist_response_min: settings.waitlistResponseMin,
		waitlist_max_parties: settings.waitlistMaxParties,
		updatedAt: settings.updatedAt,
	}
}

export async function getWaitlistSettings(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
) {
	return pickWaitlistSettings(
		await getLocationSettingsWithContext(db, orgId, locationId),
	)
}

/** Goes through the general settings update so the version check and audit row stay in one place. */
export async function updateWaitlistSettings(
	db: TenantDatabase,
	orgId: string,
	locationId: string,
	actorId: string,
	patch: WaitlistSettingsPatch,
) {
	return pickWaitlistSettings(
		await updateLocationSettings(db, orgId, locationId, actorId, patch),
	)
}

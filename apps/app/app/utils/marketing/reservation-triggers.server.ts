import { isReservationJourneyTrigger } from '@repo/tenant-db/types/journey'
import { isReservationsFeatureEnabled } from '#app/utils/reservations/access.server.ts'

/** Whether the editor offers the `reservation_*` triggers for this organization. */
export function reservationTriggersEnabled(organizationId: string) {
	return isReservationsFeatureEnabled(organizationId, 'enabled')
}

/**
 * A reservation trigger can only be saved while the module is on. Journeys
 * that already use one keep their trigger on save (the module can be paused
 * without breaking a journey), so `currentTriggerType` is allowed through.
 */
export function reservationTriggerBlocked(params: {
	triggerType: unknown
	enabled: boolean
	currentTriggerType?: string | null
}) {
	if (!isReservationJourneyTrigger(params.triggerType)) return false
	if (params.enabled) return false
	return params.triggerType !== params.currentTriggerType
}

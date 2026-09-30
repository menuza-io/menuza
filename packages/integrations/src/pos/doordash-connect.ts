/**
 * DoorDash store linkage for multi-tenant platforms (Otter / Owner-style).
 *
 * - Menuza env JWT keys = one DoorDash **developer** app (all tenants).
 * - Each org integration = one merchant store on DoorDash.
 * - `partner_store_id` (SSIO / Store Onboarding Webhook) = Menuza location id.
 * - `merchantId` on the integration = DoorDash store id used in menu API paths.
 *
 * SSIO eventually maps locations via merchant OAuth + initialize onboarding; until
 * that ships, operators paste the DoorDash store id after onboarding in Portal.
 */

import { PosError } from './errors.ts'

export type DoorDashStoreLink = {
	/** Menuza {@link OrganizationLocation} id — DoorDash `partner_store_id` / `location_id`. */
	menuzaLocationId: string
	/** DoorDash store id or UUID for `/api/v1/stores/{id}` menu calls. */
	doorDashStoreId: string
}

export type DoorDashIntegrationConfig = {
	environment: 'live'
	merchantId: string
	locationId: string
	metadata: {
		partnerStoreId: string
		doorDashStoreId: string
		/** Set by SSIO webhook or local dev flag only. */
		doorDashVerified?: boolean
	}
}

export function normalizeDoorDashStoreId(value: string): string {
	const trimmed = value.trim()
	if (!trimmed) {
		throw new PosError('Enter your DoorDash store ID.', 400)
	}
	if (trimmed.length > 128) {
		throw new PosError('DoorDash store ID is too long.', 400)
	}
	return trimmed
}

export function buildDoorDashIntegrationConfig(
	link: DoorDashStoreLink,
): DoorDashIntegrationConfig {
	const menuzaLocationId = link.menuzaLocationId.trim()
	if (!menuzaLocationId) {
		throw new PosError(
			'Select the Menuza location for this DoorDash store.',
			400,
		)
	}
	const doorDashStoreId = normalizeDoorDashStoreId(link.doorDashStoreId)
	const allowManual =
		typeof process !== 'undefined' &&
		process.env?.DOORDASH_ALLOW_MANUAL_STORE_LINK === 'true'
	return {
		environment: 'live',
		merchantId: doorDashStoreId,
		locationId: menuzaLocationId,
		metadata: {
			partnerStoreId: menuzaLocationId,
			doorDashStoreId,
			doorDashVerified: allowManual,
		},
	}
}

export function isDoorDashStoreVerified(config: unknown): boolean {
	let raw: Record<string, unknown> = {}
	if (typeof config === 'string' && config.trim()) {
		try {
			raw = JSON.parse(config) as Record<string, unknown>
		} catch {
			return false
		}
	} else if (config && typeof config === 'object') {
		raw = config as Record<string, unknown>
	}
	const metadata =
		raw.metadata && typeof raw.metadata === 'object'
			? (raw.metadata as Record<string, unknown>)
			: {}
	return metadata.doorDashVerified === true
}

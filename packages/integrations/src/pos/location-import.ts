/**
 * Fetches a store profile from a connected platform and maps it into Menuza
 * location fields.
 */

import { OrganizationLocation, and, count, db, eq } from '@repo/database'
import { type Integration } from '../database-types'
import { integrationManager } from '../integration-manager.ts'
import { readRemoteLocation } from './location-fetch.ts'
import { type RemoteLocation } from './remote-location.ts'
import { parsePosConfig } from './transport.ts'
import { isPosProvider, type PosProvider } from './types.ts'
import { isPosIntegrationProvider } from './providers/index.ts'
import { providerRegistry } from '../provider.ts'

export async function importRemoteLocationForIntegration(
	integration: Integration,
): Promise<{ locationId: string; created: boolean } | null> {
	if (!isPosProvider(integration.providerName)) return null

	const organizationId = integration.organizationId

	if (!integration.organizationLocationId) return null
	const [location] = await db
		.select()
		.from(OrganizationLocation)
		.where(
			and(
				eq(OrganizationLocation.id, integration.organizationLocationId),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)
		.limit(1)
	if (!location) return null
	const remote = await readRemoteLocation(integration)
	if (!remote) return null

	// The connection already has a selected location. Fill missing profile
	// fields without replacing details the operator entered.
	await db
		.update(OrganizationLocation)
		.set({
			phone: location.phone || remote.phone || null,
			address:
				location.address ||
				(remote.address ? JSON.stringify(remote.address) : null),
			storeHours:
				location.storeHours ||
				(remote.storeHours ? JSON.stringify(remote.storeHours) : null),
			onlineHours:
				location.onlineHours ||
				(remote.onlineHours || remote.storeHours
					? JSON.stringify(remote.onlineHours ?? remote.storeHours)
					: null),
			specialHours:
				location.specialHours ||
				(remote.specialHours ? JSON.stringify(remote.specialHours) : null),
		})
		.where(
			and(
				eq(OrganizationLocation.id, location.id),
				eq(OrganizationLocation.organizationId, organizationId),
			),
		)

	const config = parsePosConfig(integration.config)
	const remoteLocationId =
		remote.remoteLocationId ?? config.locationId ?? config.merchantId
	const previous = safeParseConfig(integration.config)
	await integrationManager.updateIntegrationConfig(integration.id, {
		...previous,
		environment: config.environment,
		merchantId: config.merchantId || remoteLocationId,
		locationId: remoteLocationId,
		metadata: {
			...(typeof previous.metadata === 'object' && previous.metadata
				? (previous.metadata as Record<string, unknown>)
				: {}),
			importedLocationId: location.id,
			remoteLocationId,
		},
	})

	return { locationId: location.id, created: false }
}

function safeParseConfig(
	config: string | null | undefined,
): Record<string, unknown> {
	if (!config) return {}
	try {
		return JSON.parse(config) as Record<string, unknown>
	} catch {
		return {}
	}
}

export async function probePosCatalog(integration: Integration) {
	const providerName = integration.providerName as PosProvider
	const provider = providerRegistry.get(providerName)
	if (!isPosIntegrationProvider(provider)) return
	try {
		await provider.readCatalog(integration)
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_connect',
			'success',
			{ provider: providerName },
		)
	} catch (error) {
		await integrationManager.logIntegrationActivity(
			integration.id,
			'pos_connect_probe',
			'error',
			{ provider: providerName },
			error instanceof Error ? error.message : 'Unknown error',
		)
	}
}

export type { RemoteLocation }

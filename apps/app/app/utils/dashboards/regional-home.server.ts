import { ENV } from 'varlock/env'
import { getBoundTenantApiService } from '#app/utils/tenant-api-service.server.ts'
import { resolveRegionalTenantApiUrls } from '#app/utils/tenant-api.server.ts'

/**
 * POSTs to the regional node's `/internal/home/*` surface with
 * `INTERNAL_COMMAND_TOKEN`. Server to server only: the body carries the
 * organization id (and a location id), the answer ids, booleans and one
 * timestamp. Never a guest field. Answers null when the region cannot be
 * reached or refuses, so callers can skip the fact instead of failing.
 */
async function postRegionalHome<T>(
	dataRegion: string | null | undefined,
	path: 'launch-facts' | 'stock-sold-out',
	body: Record<string, unknown>,
	timeoutMs = 5_000,
): Promise<T | null> {
	const token = ENV.INTERNAL_COMMAND_TOKEN
	if (!token || token.length < 16) return null
	const region = (dataRegion || 'us').toLowerCase()
	const { tenantApiUrl } = resolveRegionalTenantApiUrls(region)
	const boundService = region !== 'ksa' ? getBoundTenantApiService() : null
	const fetchImpl = boundService ? boundService.fetch.bind(boundService) : fetch
	try {
		const response = await fetchImpl(`${tenantApiUrl}/internal/home/${path}`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(body),
			redirect: 'manual',
			signal: AbortSignal.timeout(timeoutMs),
		})
		if (!response.ok) return null
		return (await response.json()) as T
	} catch {
		return null
	}
}

export type LaunchFacts = {
	pairedLocationIds: string[]
	firstOrderAt: string | null
}

/** Paired terminal locations and the first counted order time, or null. */
export async function loadLaunchFacts(organization: {
	id: string
	dataRegion: string | null
}): Promise<LaunchFacts | null> {
	const raw = await postRegionalHome<Partial<LaunchFacts>>(
		organization.dataRegion,
		'launch-facts',
		{ orgId: organization.id },
	)
	if (!raw || !Array.isArray(raw.pairedLocationIds)) return null
	return {
		pairedLocationIds: raw.pairedLocationIds.filter(
			(id): id is string => typeof id === 'string',
		),
		firstOrderAt:
			typeof raw.firstOrderAt === 'string' &&
			!Number.isNaN(Date.parse(raw.firstOrderAt))
				? raw.firstOrderAt
				: null,
	}
}

/**
 * The dishes inventory holds off at a location (auto sold out). Null when the
 * region cannot say: callers must then refuse to give any dish back.
 */
export async function loadStockSoldOutItemIds(
	organization: { id: string; dataRegion: string | null },
	locationId: string,
): Promise<string[] | null> {
	const raw = await postRegionalHome<{ itemIds?: unknown }>(
		organization.dataRegion,
		'stock-sold-out',
		{ orgId: organization.id, locationId },
	)
	if (!raw || !Array.isArray(raw.itemIds)) return null
	return raw.itemIds.filter((id): id is string => typeof id === 'string')
}

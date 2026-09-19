import { getTenantDb, provisionTenantDb } from '@repo/tenant-db'
import { ENV } from 'varlock/env'
import { getBoundTenantApiService } from '../tenant-api-service.server.ts'

const DEFAULT_REGION = 'us'

function resolveRegion(dataRegion: string | null | undefined) {
	return (dataRegion || DEFAULT_REGION).toLowerCase() === 'ksa' ? 'ksa' : 'us'
}

function stripTrailingSlash(url: string) {
	return url.replace(/\/$/, '')
}

export function getRegionalTenantApiUrl(dataRegion: string | null | undefined) {
	if (resolveRegion(dataRegion) === 'ksa') {
		const url = process.env.TENANT_API_URL_KSA || ENV.TENANT_API_URL_KSA
		if (!url) {
			throw new Error(
				'TENANT_API_URL_KSA is not configured. KSA organizations cannot be provisioned through the US tenant API.',
			)
		}
		return stripTrailingSlash(url)
	}

	return stripTrailingSlash(
		process.env.TENANT_API_URL || ENV.TENANT_API_URL || 'http://localhost:3007',
	)
}

async function callTenantCommand(options: {
	orgId: string
	dataRegion: string | null | undefined
	slug?: string
	customDomain?: string | null
	path: '/api/provision' | '/api/deprovision'
}) {
	const tenantApiUrl = getRegionalTenantApiUrl(options.dataRegion)
	const token =
		process.env.INTERNAL_COMMAND_TOKEN || ENV.INTERNAL_COMMAND_TOKEN || ''

	if (token.length < 16) {
		throw new Error('INTERNAL_COMMAND_TOKEN is not configured')
	}

	const expectedRegion = resolveRegion(options.dataRegion)
	const boundService =
		expectedRegion === 'us' ? getBoundTenantApiService() : null
	const fetchImpl = boundService ? boundService.fetch.bind(boundService) : fetch

	let response: Response
	try {
		response = await fetchImpl(`${tenantApiUrl}${options.path}`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				orgId: options.orgId,
				slug: options.slug,
				customDomain: options.customDomain ?? null,
				dataRegion: expectedRegion,
			}),
		})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		throw new Error(
			`Failed to connect to Tenant API at ${tenantApiUrl}. Details: ${errorMessage}`,
		)
	}

	const payload = (await response.json().catch(() => ({}))) as {
		error?: string
		message?: string
		region?: string
	} | null

	if (!response.ok) {
		const detail =
			payload?.message ||
			payload?.error ||
			(payload && typeof payload === 'object' && Object.keys(payload).length > 0
				? JSON.stringify(payload)
				: `HTTP ${response.status} ${response.statusText || ''}`.trim())
		throw new Error(`Tenant API error: ${detail}`)
	}

	if (payload?.region && payload.region !== expectedRegion) {
		throw new Error(
			`Tenant API responded from "${payload.region}" but org dataRegion is "${expectedRegion}"`,
		)
	}

	return { region: payload?.region || expectedRegion }
}

export async function provisionTenantDatabase(options: {
	orgId: string
	dataRegion: string | null | undefined
	slug?: string
	customDomain?: string | null
}) {
	const result = await callTenantCommand({ ...options, path: '/api/provision' })
	if (resolveRegion(options.dataRegion) === 'us') {
		await provisionTenantDb(options.orgId)
		try {
			await getTenantDb(options.orgId)
		} catch {
			throw new Error(
				'Tenant database file was not created. Start tenant-api (port 3007) or run `npm run dev` so publish can provision customer data.',
			)
		}
	}
	return result
}

export async function deprovisionTenantDatabase(options: {
	orgId: string
	dataRegion: string | null | undefined
	slug?: string
	customDomain?: string | null
}) {
	return callTenantCommand({ ...options, path: '/api/deprovision' })
}

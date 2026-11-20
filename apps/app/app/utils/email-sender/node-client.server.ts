import {
	type EmailDomainCheck,
	type EmailDomainRecord,
	type EmailDomainRegistration,
	getMockEmailDomainProvider,
} from '@repo/email'
import { isDomainsMock } from '#app/utils/domains/config.server.ts'
import { readLiveEnv } from '#app/utils/env.server.ts'
import { getRegionalTenantApiUrl } from '#app/utils/sites/tenant-api.server.ts'
import { getBoundTenantApiService } from '#app/utils/tenant-api-service.server.ts'

/**
 * Registers, checks and removes an organization's sending domain at its data
 * region's email provider (#103). The OCI credentials of a region live on its
 * tenant-api node, so the App asks the node (internal token, DNS records and a
 * reference only). The emulator answers in process on a local deployment.
 */

export interface SenderDomainClient {
	register(input: {
		organizationId: string
		dataRegion: string
		domain: string
		localPart: string
	}): Promise<EmailDomainRegistration>
	check(input: {
		dataRegion: string
		providerRef: string
		domain: string
		records: EmailDomainRecord[]
	}): Promise<EmailDomainCheck>
	remove(input: { dataRegion: string; providerRef: string }): Promise<void>
}

export class SenderDomainClientError extends Error {
	constructor(readonly status: number) {
		super(`sender_domain_node_${status}`)
		this.name = 'SenderDomainClientError'
	}
}

async function call<T>(
	dataRegion: string,
	path: string,
	body: unknown,
): Promise<T> {
	const token = readLiveEnv('INTERNAL_COMMAND_TOKEN')
	if (token.length < 16) throw new SenderDomainClientError(503)
	const region = dataRegion === 'ksa' ? 'ksa' : 'us'
	const service = region === 'us' ? getBoundTenantApiService() : null
	const fetchImpl = service ? service.fetch.bind(service) : fetch
	const response = await fetchImpl(
		`${getRegionalTenantApiUrl(region)}${path}`,
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
			redirect: 'manual',
			signal: AbortSignal.timeout(20_000),
		},
	)
	if (!response.ok) throw new SenderDomainClientError(response.status)
	return (await response.json()) as T
}

export const nodeSenderDomainClient: SenderDomainClient = {
	register: (input) =>
		call(input.dataRegion, '/api/email-domains/register', {
			orgId: input.organizationId,
			domain: input.domain,
			localPart: input.localPart,
		}),
	check: (input) =>
		call(input.dataRegion, '/api/email-domains/check', {
			providerRef: input.providerRef,
			domain: input.domain,
			records: input.records,
		}),
	remove: async (input) => {
		await call(input.dataRegion, '/api/email-domains/remove', {
			providerRef: input.providerRef,
		})
	},
}

export const mockSenderDomainClient: SenderDomainClient = {
	register: (input) =>
		getMockEmailDomainProvider().register({
			domain: input.domain,
			localPart: input.localPart,
			selector: `mz${input.organizationId.slice(-10).toLowerCase()}`,
			organizationId: input.organizationId,
		}),
	check: (input) => getMockEmailDomainProvider().check(input),
	remove: (input) => getMockEmailDomainProvider().remove(input.providerRef),
}

let override: SenderDomainClient | null = null

export function setSenderDomainClient(client: SenderDomainClient | null) {
	override = client
}

export function getSenderDomainClient(): SenderDomainClient {
	if (override) return override
	return isDomainsMock() ? mockSenderDomainClient : nodeSenderDomainClient
}

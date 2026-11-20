import { type ZoneRecord } from '@repo/common/domain-zone'
import { readLiveEnv } from '#app/utils/env.server.ts'
import {
	type DnsZoneProvider,
	type EmailRoutingProvider,
	type ProviderZone,
	type ProviderZoneRecord,
	type RoutingDestination,
} from './adapters.server.ts'

/**
 * Cloudflare as the DNS zone host (#283, #183) and the email-routing service
 * (#276), in our own Cloudflare account. Uses a token of its own
 * (`CLOUDFLARE_DOMAINS_API_TOKEN`, scoped to zones, DNS and email routing)
 * apart from the one that manages custom hostnames.
 */

const API = 'https://api.cloudflare.com/client/v4'

type Envelope<T> = {
	success: boolean
	errors?: Array<{ code?: number; message: string }>
	result: T
}

export class CloudflareApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly codes: number[] = [],
	) {
		super(message)
		this.name = 'CloudflareApiError'
	}
}

export function createCloudflareClient(options: {
	fetchImpl?: typeof fetch
	token?: () => string
}) {
	const fetchImpl = options.fetchImpl ?? fetch
	const token =
		options.token ?? (() => readLiveEnv('CLOUDFLARE_DOMAINS_API_TOKEN'))
	return async function call<T>(path: string, init?: RequestInit): Promise<T> {
		const response = await fetchImpl(`${API}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${token()}`,
				'Content-Type': 'application/json',
				...init?.headers,
			},
			signal: AbortSignal.timeout(15_000),
		})
		const data = (await response.json().catch(() => null)) as Envelope<T> | null
		if (!response.ok || !data?.success) {
			throw new CloudflareApiError(
				data?.errors?.map((error) => error.message).join('; ') ||
					`Cloudflare API error (${response.status})`,
				response.status,
				data?.errors?.flatMap((error) => (error.code ? [error.code] : [])),
			)
		}
		return data.result
	}
}

type CfRecord = {
	id: string
	type: string
	name: string
	content: string
	ttl: number
	priority?: number
	proxied?: boolean
}

function toProviderRecord(record: CfRecord): ProviderZoneRecord {
	return {
		id: record.id,
		type: record.type as ProviderZoneRecord['type'],
		name: record.name.toLowerCase(),
		content: record.type === 'TXT' ? unquote(record.content) : record.content,
		ttl: record.ttl,
		priority: record.priority ?? null,
		proxied: record.proxied ?? false,
	}
}

function unquote(value: string) {
	return value.length > 1 && value.startsWith('"') && value.endsWith('"')
		? value.slice(1, -1)
		: value
}

function recordBody(record: ZoneRecord) {
	return {
		type: record.type,
		name: record.name,
		content: record.content,
		ttl: record.ttl ?? 1,
		...(record.type === 'MX' || record.type === 'SRV'
			? { priority: record.priority ?? 10 }
			: {}),
		...(record.type === 'A' || record.type === 'AAAA' || record.type === 'CNAME'
			? { proxied: record.proxied ?? false }
			: {}),
	}
}

export class CloudflareDnsZoneProvider implements DnsZoneProvider {
	readonly name = 'cloudflare'
	private readonly call: ReturnType<typeof createCloudflareClient>

	constructor(options: { fetchImpl?: typeof fetch } = {}) {
		this.call = createCloudflareClient(options)
	}

	isConfigured() {
		return Boolean(
			readLiveEnv('CLOUDFLARE_DOMAINS_API_TOKEN') &&
			readLiveEnv('CLOUDFLARE_ACCOUNT_ID'),
		)
	}

	private toZone(result: {
		id: string
		status: string
		name_servers?: string[]
	}): ProviderZone {
		return {
			zoneId: result.id,
			nameservers: (result.name_servers ?? []).map((ns) => ns.toLowerCase()),
			status:
				result.status === 'active'
					? 'active'
					: result.status === 'moved'
						? 'moved'
						: 'pending',
		}
	}

	async createZone(fqdn: string) {
		try {
			return this.toZone(
				await this.call('/zones', {
					method: 'POST',
					body: JSON.stringify({
						name: fqdn,
						account: { id: readLiveEnv('CLOUDFLARE_ACCOUNT_ID') },
						type: 'full',
					}),
				}),
			)
		} catch (error) {
			// 1061: the zone already exists in the account (a retry of a half-done setup).
			if (error instanceof CloudflareApiError && error.codes.includes(1061)) {
				const found = await this.call<
					Array<{ id: string; status: string; name_servers?: string[] }>
				>(
					`/zones?name=${encodeURIComponent(fqdn)}&account.id=${encodeURIComponent(readLiveEnv('CLOUDFLARE_ACCOUNT_ID'))}`,
				)
				if (found[0]) return this.toZone(found[0])
			}
			throw error
		}
	}

	async getZone(zoneId: string) {
		try {
			return this.toZone(await this.call(`/zones/${zoneId}`))
		} catch (error) {
			if (error instanceof CloudflareApiError && error.status === 404)
				return null
			throw error
		}
	}

	async recheckZone(zoneId: string) {
		await this.call(`/zones/${zoneId}/activation_check`, { method: 'PUT' })
	}

	async deleteZone(zoneId: string) {
		await this.call(`/zones/${zoneId}`, { method: 'DELETE' })
	}

	async listRecords(zoneId: string) {
		const records = await this.call<CfRecord[]>(
			`/zones/${zoneId}/dns_records?per_page=500`,
		)
		return records.map(toProviderRecord)
	}

	async createRecord(zoneId: string, record: ZoneRecord) {
		return toProviderRecord(
			await this.call<CfRecord>(`/zones/${zoneId}/dns_records`, {
				method: 'POST',
				body: JSON.stringify(recordBody(record)),
			}),
		)
	}

	async updateRecord(zoneId: string, recordId: string, record: ZoneRecord) {
		return toProviderRecord(
			await this.call<CfRecord>(`/zones/${zoneId}/dns_records/${recordId}`, {
				method: 'PUT',
				body: JSON.stringify(recordBody(record)),
			}),
		)
	}

	async deleteRecord(zoneId: string, recordId: string) {
		await this.call(`/zones/${zoneId}/dns_records/${recordId}`, {
			method: 'DELETE',
		})
	}
}

type CfDestination = { id: string; email: string; verified: string | null }

export class CloudflareEmailRouting implements EmailRoutingProvider {
	readonly name = 'cloudflare-email-routing'
	readonly spfInclude = 'include:_spf.mx.cloudflare.net'
	private readonly call: ReturnType<typeof createCloudflareClient>

	private readonly fetchImpl: typeof fetch | undefined

	constructor(options: { fetchImpl?: typeof fetch } = {}) {
		this.call = createCloudflareClient(options)
		this.fetchImpl = options.fetchImpl
	}

	private get account() {
		return readLiveEnv('CLOUDFLARE_ACCOUNT_ID')
	}

	isConfigured() {
		return Boolean(readLiveEnv('CLOUDFLARE_DOMAINS_API_TOKEN') && this.account)
	}

	async enable(zoneId: string) {
		// Cloudflare writes the MX and SPF records into the zone itself; the App
		// reads them back and merges the SPF record into the one the zone has.
		await this.call(`/zones/${zoneId}/email/routing/dns`, { method: 'POST' })
		return { records: [] as ZoneRecord[], spfInclude: this.spfInclude }
	}

	async disable(zoneId: string) {
		await this.call(`/zones/${zoneId}/email/routing/dns`, { method: 'DELETE' })
	}

	private async findDestination(email: string): Promise<CfDestination | null> {
		const all = await this.call<CfDestination[]>(
			`/accounts/${this.account}/email/routing/addresses?per_page=50`,
		)
		return (
			all.find((item) => item.email.toLowerCase() === email.toLowerCase()) ??
			null
		)
	}

	private toDestination(item: CfDestination): RoutingDestination {
		return { email: item.email.toLowerCase(), verified: Boolean(item.verified) }
	}

	async addDestination(email: string) {
		const existing = await this.findDestination(email)
		if (existing) return this.toDestination(existing)
		return this.toDestination(
			await this.call<CfDestination>(
				`/accounts/${this.account}/email/routing/addresses`,
				{
					method: 'POST',
					body: JSON.stringify({ email }),
				},
			),
		)
	}

	async getDestination(email: string) {
		const found = await this.findDestination(email)
		return found ? this.toDestination(found) : null
	}

	async upsertRule(input: Parameters<EmailRoutingProvider['upsertRule']>[0]) {
		const actions = [{ type: 'forward', value: [input.destination] }]
		if (input.localPart === '*') {
			await this.call(`/zones/${input.zoneId}/email/routing/rules/catch_all`, {
				method: 'PUT',
				body: JSON.stringify({
					name: 'Catch-all',
					enabled: true,
					matchers: [{ type: 'all' }],
					actions,
				}),
			})
			return { ruleId: 'catch_all' }
		}
		const body = JSON.stringify({
			name: `Forward ${input.localPart}@${input.domain}`,
			enabled: true,
			matchers: [
				{
					type: 'literal',
					field: 'to',
					value: `${input.localPart}@${input.domain}`,
				},
			],
			actions,
		})
		const result = input.ruleId
			? await this.call<{ id?: string; tag?: string }>(
					`/zones/${input.zoneId}/email/routing/rules/${input.ruleId}`,
					{ method: 'PUT', body },
				)
			: await this.call<{ id?: string; tag?: string }>(
					`/zones/${input.zoneId}/email/routing/rules`,
					{ method: 'POST', body },
				)
		return { ruleId: input.ruleId ?? result.id ?? result.tag ?? '' }
	}

	/**
	 * The last delivered message for a rule, from Cloudflare's email routing
	 * analytics (GraphQL). Counts and times only, never message content. A
	 * failure or an unknown dataset answers null: "not reported".
	 */
	async lastForwardedAt(zoneId: string, ruleId: string) {
		if (ruleId === 'catch_all') return null
		try {
			const response = await (this.fetchImpl ?? fetch)(`${API}/graphql`, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${readLiveEnv('CLOUDFLARE_DOMAINS_API_TOKEN')}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					query: `query($zone: string!, $since: Time!) { viewer { zones(filter: { zoneTag: $zone }) { emailRoutingAdaptive(limit: 1, orderBy: [datetime_DESC], filter: { datetime_geq: $since, status: "delivered" }) { datetime } } } }`,
					variables: {
						zone: zoneId,
						since: new Date(Date.now() - 30 * 86_400_000).toISOString(),
					},
				}),
				signal: AbortSignal.timeout(10_000),
			})
			if (!response.ok) return null
			const body = (await response.json()) as {
				data?: { viewer?: { zones?: Array<{ emailRoutingAdaptive?: Array<{ datetime?: string }> }> } }
			}
			const when = body.data?.viewer?.zones?.[0]?.emailRoutingAdaptive?.[0]?.datetime
			return when ? new Date(when) : null
		} catch {
			return null
		}
	}

	async removeRule(zoneId: string, ruleId: string, localPart: string) {
		if (localPart === '*' || ruleId === 'catch_all') {
			await this.call(`/zones/${zoneId}/email/routing/rules/catch_all`, {
				method: 'PUT',
				body: JSON.stringify({
					name: 'Catch-all',
					enabled: false,
					matchers: [{ type: 'all' }],
					actions: [{ type: 'drop' }],
				}),
			})
			return
		}
		await this.call(`/zones/${zoneId}/email/routing/rules/${ruleId}`, {
			method: 'DELETE',
		})
	}
}

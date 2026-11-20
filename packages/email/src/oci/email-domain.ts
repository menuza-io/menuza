import common from 'oci-common'
import { createOciAuthProvider, getOciEmailConfig } from './config.ts'
import { shouldUseOciEmailMockTransport } from './mock-transport.ts'

/**
 * Sending domains on the region's email provider (#103). A restaurant's own
 * domain is registered at OCI Email Delivery (email domain, DKIM, approved
 * sender) from the tenant-api node of its data region, because the OCI
 * credentials of a region live on that node. The App asks the node; the node
 * uses this provider.
 */

export type EmailDomainRecordPurpose = 'spf' | 'dkim' | 'return_path' | 'dmarc'

export type EmailDomainRecord = {
	purpose: EmailDomainRecordPurpose
	type: 'TXT' | 'CNAME' | 'MX'
	/** Fully qualified record name. */
	name: string
	value: string
	priority?: number
	/** Needed for the domain to verify (DMARC is advice). */
	required: boolean
}

export type EmailDomainStatus = 'pending' | 'verified' | 'failed'

export type EmailDomainRegistration = {
	providerRef: string
	dkimSelector: string
	records: EmailDomainRecord[]
}

export type EmailDomainCheck = {
	status: EmailDomainStatus
	/** Which required records the provider (or a lookup) found. */
	found: Record<EmailDomainRecordPurpose, boolean>
}

export interface EmailDomainProvider {
	isConfigured(): boolean
	register(input: {
		domain: string
		localPart: string
		selector: string
		organizationId: string
	}): Promise<EmailDomainRegistration>
	check(input: {
		providerRef: string
		domain: string
		records: EmailDomainRecord[]
	}): Promise<EmailDomainCheck>
	remove(providerRef: string): Promise<void>
}

/** The DKIM selector for an organization: stable, DNS-safe, one per domain. */
export function dkimSelectorFor(organizationId: string): string {
	return `mz${organizationId
		.replace(/[^a-z0-9]/giu, '')
		.toLowerCase()
		.slice(-10)}`
}

// ---------------------------------------------------------------------------
// OCI Email Delivery
// ---------------------------------------------------------------------------

type OciJson = Record<string, unknown>

function controlPlaneUrl(region: string) {
	return `https://ctrl.email.${region}.oci.oraclecloud.com/20170907`
}

export class OciEmailDomainProvider implements EmailDomainProvider {
	constructor(private readonly fetchImpl: typeof fetch = fetch) {}

	isConfigured() {
		return getOciEmailConfig() !== null
	}

	private async call<T = OciJson>(
		method: string,
		path: string,
		body?: unknown,
	): Promise<T> {
		const config = getOciEmailConfig()
		if (!config) throw new Error('OCI Email Delivery is not configured')
		const headers = new Headers({
			'content-type': 'application/json',
			accept: 'application/json',
		})
		const payload = body === undefined ? undefined : JSON.stringify(body)
		const uri = `${controlPlaneUrl(config.region)}${path}`
		const signer = new common.DefaultRequestSigner(
			createOciAuthProvider(config),
		)
		await signer.signHttpRequest({
			method: method as never,
			headers,
			uri,
			body: payload,
		})
		const response = await this.fetchImpl(uri, {
			method,
			headers,
			body: payload,
			signal: AbortSignal.timeout(20_000),
		})
		if (!response.ok)
			throw new Error(
				`OCI email API ${method} ${path} failed (${response.status})`,
			)
		return (response.status === 204 ? {} : await response.json()) as T
	}

	async register(input: Parameters<EmailDomainProvider['register']>[0]) {
		const config = getOciEmailConfig()!
		const domain = await this.call<{ id: string }>('POST', '/emailDomains', {
			compartmentId: config.compartmentId,
			name: input.domain,
			description: `Menuza organization ${input.organizationId}`,
		})
		const dkim = await this.call<{
			id: string
			cnameRecordValue?: string
			dnsSubdomainName?: string
		}>('POST', '/dkims', {
			emailDomainId: domain.id,
			name: input.selector,
		})
		await this.call('POST', '/senders', {
			compartmentId: config.compartmentId,
			emailAddress: `${input.localPart}@${input.domain}`,
		})
		const dkimName =
			dkim.dnsSubdomainName ?? `${input.selector}._domainkey.${input.domain}`
		return {
			providerRef: `${domain.id}|${dkim.id}`,
			dkimSelector: input.selector,
			records: [
				{
					purpose: 'spf' as const,
					type: 'TXT' as const,
					name: input.domain,
					value: 'v=spf1 include:rp.oracleemaildelivery.com ~all',
					required: true,
				},
				{
					purpose: 'dkim' as const,
					type: 'CNAME' as const,
					name: dkimName,
					value: dkim.cnameRecordValue ?? '',
					required: true,
				},
				{
					purpose: 'dmarc' as const,
					type: 'TXT' as const,
					name: `_dmarc.${input.domain}`,
					value: 'v=DMARC1; p=none',
					required: false,
				},
			],
		}
	}

	async check(input: Parameters<EmailDomainProvider['check']>[0]) {
		const [, dkimId = ''] = input.providerRef.split('|')
		const dkim = await this.call<{ lifecycleState?: string }>(
			'GET',
			`/dkims/${dkimId}`,
		)
		const dkimOk = dkim.lifecycleState === 'ACTIVE'
		return {
			// OCI verifies the DKIM record itself; SPF is checked by the caller's lookup.
			status: dkimOk ? ('verified' as const) : ('pending' as const),
			found: { dkim: dkimOk, spf: dkimOk, return_path: dkimOk, dmarc: false },
		}
	}

	async remove(providerRef: string) {
		const [domainId, dkimId] = providerRef.split('|')
		if (dkimId)
			await this.call('DELETE', `/dkims/${dkimId}`).catch(() => undefined)
		if (domainId)
			await this.call('DELETE', `/emailDomains/${domainId}`).catch(
				() => undefined,
			)
	}
}

// ---------------------------------------------------------------------------
// Emulator (MOCKS=true, tests)
// ---------------------------------------------------------------------------

export class MockEmailDomainProvider implements EmailDomainProvider {
	readonly registered = new Map<string, { domain: string; selector: string }>()
	/** Record names the emulated DNS shows (as `type name value`); empty: nothing found. */
	readonly dns = new Set<string>()
	private counter = 0

	isConfigured() {
		return true
	}

	static recordKey(record: { type: string; name: string; value: string }) {
		return `${record.type} ${record.name.toLowerCase()} ${record.value}`
	}

	async register(input: Parameters<EmailDomainProvider['register']>[0]) {
		this.counter += 1
		const providerRef = `mock-domain-${this.counter}`
		this.registered.set(providerRef, {
			domain: input.domain,
			selector: input.selector,
		})
		return {
			providerRef,
			dkimSelector: input.selector,
			records: [
				{
					purpose: 'spf' as const,
					type: 'TXT' as const,
					name: input.domain,
					value: 'v=spf1 include:rp.mock-email.test ~all',
					required: true,
				},
				{
					purpose: 'dkim' as const,
					type: 'CNAME' as const,
					name: `${input.selector}._domainkey.${input.domain}`,
					value: `${input.selector}.dkim.mock-email.test`,
					required: true,
				},
				{
					purpose: 'return_path' as const,
					type: 'CNAME' as const,
					name: `bounce.${input.domain}`,
					value: 'rp.mock-email.test',
					required: true,
				},
				{
					purpose: 'dmarc' as const,
					type: 'TXT' as const,
					name: `_dmarc.${input.domain}`,
					value: 'v=DMARC1; p=none',
					required: false,
				},
			],
		}
	}

	async check(input: Parameters<EmailDomainProvider['check']>[0]) {
		if (!this.registered.has(input.providerRef)) {
			return {
				status: 'failed' as const,
				found: { spf: false, dkim: false, return_path: false, dmarc: false },
			}
		}
		const found = { spf: false, dkim: false, return_path: false, dmarc: false }
		for (const record of input.records) {
			if (this.dns.has(MockEmailDomainProvider.recordKey(record)))
				found[record.purpose] = true
		}
		const ok = input.records
			.filter((r) => r.required)
			.every((r) => found[r.purpose])
		return { status: ok ? ('verified' as const) : ('pending' as const), found }
	}

	async remove(providerRef: string) {
		this.registered.delete(providerRef)
	}
}

let override: EmailDomainProvider | null = null
let mock: MockEmailDomainProvider | null = null
let live: OciEmailDomainProvider | null = null

export function setEmailDomainProvider(provider: EmailDomainProvider | null) {
	override = provider
}

export function getMockEmailDomainProvider() {
	mock ??= new MockEmailDomainProvider()
	return mock
}

export function getEmailDomainProvider(): EmailDomainProvider {
	if (override) return override
	if (shouldUseOciEmailMockTransport()) return getMockEmailDomainProvider()
	live ??= new OciEmailDomainProvider()
	return live
}

import { ssrfSafeFetch } from '@repo/security'
import { readLiveEnv } from '#app/utils/env.server.ts'
import {
	type DomainConnect,
	type DomainConnectSupport,
} from './adapters.server.ts'
import { getDnsResolver, lookupTxt } from './dns-resolver.server.ts'

/**
 * Domain Connect (#313): sets DNS records at the operator's DNS host after they
 * approve on that host's own consent screen. Discovery uses public DNS and the
 * provider's published settings only. Our templates live in
 * `docs/domain-connect/`; the provider id is `DOMAIN_CONNECT_PROVIDER_ID` (a
 * template must be onboarded with Domain Connect before this can be used, so
 * without it the feature stays off).
 */

const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/u

export class LiveDomainConnect implements DomainConnect {
	readonly name = 'domain-connect'

	private get providerId() {
		return readLiveEnv('DOMAIN_CONNECT_PROVIDER_ID')
	}

	async discover(domain: string): Promise<DomainConnectSupport | null> {
		if (!this.providerId) return null
		const [txt] = await lookupTxt(getDnsResolver(), `_domainconnect.${domain}`)
		const host = txt
			?.trim()
			.toLowerCase()
			.replace(/^https?:\/\//u, '')
			.split('/')[0]
		if (!host || !HOST_RE.test(host)) return null
		try {
			const response = await ssrfSafeFetch(
				`https://${host}/v2/${encodeURIComponent(domain)}/settings`,
				{
					headers: { Accept: 'application/json' },
					signal: AbortSignal.timeout(5_000),
				},
			)
			if (!response.ok) return null
			const settings = (await response.json()) as {
				providerId?: string
				providerName?: string
				providerDisplayName?: string
				urlSyncUX?: string
			}
			const syncUx = settings.urlSyncUX
			if (!settings.providerId || !syncUx) return null
			const url = new URL(syncUx)
			if (url.protocol !== 'https:') return null
			return {
				providerId: settings.providerId,
				providerName:
					settings.providerDisplayName ??
					settings.providerName ??
					settings.providerId,
				syncUxUrl: url.origin + url.pathname.replace(/\/$/u, ''),
			}
		} catch {
			return null
		}
	}

	async apply(input: Parameters<DomainConnect['apply']>[0]) {
		const apex = input.domain
		const subdomains = input.changes
			.map((change) => change.name)
			.filter((name) => name !== apex)
		const onlyRoot = input.changes.every(
			(change) => change.name === apex || change.name === `www.${apex}`,
		)
		const service = onlyRoot ? 'site-root' : 'site-subdomain'
		const target =
			input.changes.find((change) => change.type === 'CNAME')?.content ?? ''
		const ip =
			input.changes.find((change) => change.type === 'A')?.content ?? ''
		const url = new URL(
			`${input.support.syncUxUrl}/v2/domainTemplates/providers/${encodeURIComponent(this.providerId)}/services/${service}/apply`,
		)
		url.searchParams.set('domain', apex)
		if (!onlyRoot && subdomains[0]) {
			url.searchParams.set('host', subdomains[0].slice(0, -(apex.length + 1)))
		}
		url.searchParams.set('target', target)
		if (ip) url.searchParams.set('ip', ip)
		url.searchParams.set('redirect_uri', input.redirectUri)
		url.searchParams.set('state', input.state)
		return { kind: 'redirect' as const, url: url.toString() }
	}
}

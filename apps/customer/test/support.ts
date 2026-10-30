import { type TenantConfiguration } from '@/lib/config/configuration'

export function makeConfiguration(
	options: {
		slug?: string | null
		host?: string | null
		origin?: string | null
		region?: string
		useTls?: boolean
	} = {},
): TenantConfiguration {
	return {
		appBaseUrl: 'https://app.epic-startup.com',
		tenantApiBaseUrlUs: 'https://tenant-us.epic-startup.com',
		tenantApiBaseUrlKsa: 'https://tenant-ksa.epic-startup.com',
		siteAddress: {
			slug: options.slug === undefined ? 'acme' : options.slug,
			host: options.host ?? null,
			origin: options.origin ?? null,
		},
		brandDomain: 'epic-startup.com',
		requestTimeoutMs: 15_000,
		useTls: options.useTls ?? true,
		dataRegion: options.region ?? 'us',
	}
}

function base64Url(value: string): string {
	const bytes = new TextEncoder().encode(value)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Unsigned JWT with the claim shape tenant-api issues. */
export function makeAccessToken(
	options: {
		customerId?: string
		orgId?: string
		name?: string
		expiresIn?: number
	} = {},
): string {
	const header = { alg: 'HS256', typ: 'JWT' }
	const payload = {
		customerId: options.customerId ?? 'cust_1',
		orgId: options.orgId ?? 'org_1',
		name: options.name ?? 'Ada Lovelace',
		type: 'access',
		exp: Math.floor(Date.now() / 1000 + (options.expiresIn ?? 900)),
	}
	return `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}.signature`
}

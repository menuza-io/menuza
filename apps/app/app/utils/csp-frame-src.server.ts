import { getBrandDomain } from '@repo/config/brand'

type FrameSrcEnv = {
	PUBLIC_SITE_HOST_SUFFIXES?: string
	BASE_URL?: string
}

function splitHosts(value: string | undefined) {
	if (!value) return []
	return value
		.split(/[\s,]+/)
		.map((part) => part.trim().toLowerCase().replace(/^\./, ''))
		.filter((host) => host.length > 0 && host !== 'localhost')
}

function hostnameFromUrl(value: string | undefined) {
	if (!value) return null
	try {
		return new URL(value).hostname.toLowerCase()
	} catch {
		return null
	}
}

/**
 * Parent apex for `{sub}.{apex}` hosts used by App + tenant Sites.
 * `app.preview.example.dev` → `preview.example.dev`
 */
export function parentDomainFromHost(hostHeader: string | null | undefined) {
	const host = hostHeader?.split(':')[0]?.toLowerCase() ?? ''
	if (!host || host === 'localhost' || host.endsWith('.localhost')) {
		return null
	}

	const parts = host.split('.').filter(Boolean)
	if (parts.length < 2) return null
	return parts.slice(1).join('.')
}

export function sitePreviewHostSuffixes(
	env: FrameSrcEnv = {},
	requestHost?: string | null,
) {
	const values = [
		getBrandDomain(),
		...splitHosts(env.PUBLIC_SITE_HOST_SUFFIXES),
		parentDomainFromHost(requestHost),
		parentDomainFromHost(hostnameFromUrl(env.BASE_URL)),
	].filter((value): value is string => Boolean(value))

	return [...new Set(values)]
}

export function sitePreviewFrameSrc(
	env: FrameSrcEnv = {},
	requestHost?: string | null,
) {
	const sources = ["'self'", 'localhost:*']
	for (const suffix of sitePreviewHostSuffixes(env, requestHost)) {
		sources.push(`*.${suffix}:*`, `*.${suffix}`)
	}
	return [...new Set(sources)]
}

type TenantApiConnectEnv = {
	TENANT_API_URL?: string
	TENANT_API_URL_KSA?: string
}

function originFromUrl(value: string | undefined) {
	if (!value) return null
	try {
		return new URL(value).origin
	} catch {
		return null
	}
}

/**
 * Browser-facing tenant-api origins for operator pages (`connect-src`):
 * customers, marketing, and reports. Customer PII queries leave the App origin
 * and hit regional APIs directly.
 */
export function tenantApiConnectSrc(env: TenantApiConnectEnv = {}) {
	return [
		...new Set(
			[
				originFromUrl(env.TENANT_API_URL),
				originFromUrl(env.TENANT_API_URL_KSA),
			].filter((value): value is string => Boolean(value)),
		),
	]
}

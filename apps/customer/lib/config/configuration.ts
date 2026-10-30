import {
	makeSiteAddress,
	type SiteAddress,
	UNBOUND_SITE,
} from '../support/site-address'

/** How the app reaches the platform. */
export type TenantConfiguration = {
	/** US control-plane App origin, for the published Sites payload. */
	appBaseUrl: string
	/** Regional tenant-api nodes that own customer PII. */
	tenantApiBaseUrlUs: string
	/** `null`: this deployment has no KSA node. */
	tenantApiBaseUrlKsa: string | null
	/** Which organization this build is bound to (unbound: ask the customer). */
	siteAddress: SiteAddress
	brandDomain: string
	requestTimeoutMs: number
	/** Production builds: every address, typed ones included, is https. */
	useTls: boolean
	/** `us` | `ksa`, from the organization payload. */
	dataRegion: string
}

/** The Android emulator's alias for the host machine's loopback. */
export const ANDROID_EMULATOR_HOST = '10.0.2.2'

const DEFAULT_TIMEOUT_MS = 15_000

export function localDevelopment(platform?: string): TenantConfiguration {
	const host = platform === 'android' ? ANDROID_EMULATOR_HOST : 'localhost'
	return {
		appBaseUrl: `http://${host}:3001`,
		tenantApiBaseUrlUs: `http://${host}:3007`,
		tenantApiBaseUrlKsa: `http://${host}:3009`,
		siteAddress: UNBOUND_SITE,
		brandDomain: 'menuza.test',
		requestTimeoutMs: DEFAULT_TIMEOUT_MS,
		useTls: false,
		dataRegion: 'us',
	}
}

/**
 * Accepts `127.0.0.1` (any address in 127/8) but not a name that merely starts
 * with `127.`, which resolves wherever DNS says.
 */
function isIpv4Loopback(host: string): boolean {
	const octets = host.split('.')
	if (octets.length !== 4 || octets[0] !== '127') return false
	return octets.every(
		(octet) => /^\d{1,3}$/.test(octet) && Number.parseInt(octet, 10) <= 255,
	)
}

export function isLoopbackHost(host: string | null | undefined): boolean {
	const normalized = host?.trim().toLowerCase()
	if (!normalized) return false
	return (
		normalized === 'localhost' ||
		normalized === '::1' ||
		normalized === '[::1]' ||
		normalized === ANDROID_EMULATOR_HOST ||
		normalized.endsWith('.localhost') ||
		isIpv4Loopback(normalized)
	)
}

/**
 * HTTPS anywhere, HTTP only on loopback. The URL is parsed, so the host checked
 * is the host the request reaches: `http://localhost@evil.example` is refused.
 */
export function isTransportSafe(url: string): boolean {
	let parsed: URL
	try {
		parsed = new URL(url.trim())
	} catch {
		return false
	}
	if (parsed.username || parsed.password || !parsed.hostname) return false
	if (parsed.protocol === 'https:') return true
	if (parsed.protocol === 'http:') return isLoopbackHost(parsed.hostname)
	return false
}

/**
 * Refuses cleartext to a non-loopback host: a misconfigured build fails against
 * the development defaults instead of sending customer tokens over plain HTTP.
 */
export function normalizeEndpoint(
	raw: unknown,
	useTls: boolean,
	fallback: string,
): string {
	const trimmed = typeof raw === 'string' ? raw.trim() : ''
	if (!trimmed) return fallback
	const candidate = trimmed.includes('://')
		? trimmed
		: `${useTls ? 'https' : 'http'}://${trimmed}`
	if (!isTransportSafe(candidate)) return fallback
	return candidate.replace(/\/+$/, '')
}

function readBoolean(value: unknown): boolean | null {
	if (typeof value === 'boolean') return value
	if (typeof value !== 'string') return null
	switch (value.trim().toLowerCase()) {
		case 'yes':
		case 'true':
		case '1':
			return true
		case 'no':
		case 'false':
		case '0':
		case '':
			return false
		default:
			return null
	}
}

function readText(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readOrigin(value: unknown): string | null {
	const text = readText(value)
	if (!text) return null
	try {
		const url = new URL(text)
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
		if (url.username || url.password || !url.hostname) return null
		return url.origin
	} catch {
		return null
	}
}

export function rewriteLoopbackEndpoints(
	configuration: TenantConfiguration,
	machineHost: string,
): TenantConfiguration {
	const rewrite = (url: string | null): string | null => {
		if (!url) return null
		try {
			const parsed = new URL(url)
			if (parsed.protocol !== 'http:') return url.replace(/\/+$/, '')
			if (!isLoopbackHost(parsed.hostname)) return url.replace(/\/+$/, '')
			parsed.hostname = machineHost
			return parsed.toString().replace(/\/+$/, '')
		} catch {
			return url.replace(/\/+$/, '')
		}
	}
	return {
		...configuration,
		appBaseUrl: rewrite(configuration.appBaseUrl)!,
		tenantApiBaseUrlUs: rewrite(configuration.tenantApiBaseUrlUs)!,
		tenantApiBaseUrlKsa: rewrite(configuration.tenantApiBaseUrlKsa),
	}
}

/** Hostname from Expo Go / Metro (`192.168.x.x:8081`), without the port. */
export function developmentMachineHostFromDebugger(
	debuggerHost: string | null | undefined,
): string | null {
	const trimmed = debuggerHost?.trim()
	if (!trimmed || trimmed.includes('://')) return null
	const host = trimmed.split(':')[0]?.trim() ?? ''
	if (!host || isLoopbackHost(host)) return null
	return host
}

/** Hostname from `exp://192.168.x.x:8081` or `http://…` development URIs. */
export function developmentMachineHostFromLink(
	uri: string | null | undefined,
): string | null {
	const trimmed = uri?.trim()
	if (!trimmed) return null
	const withScheme = trimmed.includes('://')
		? trimmed.replace(/^exp:\/\//, 'http://')
		: `http://${trimmed}`
	try {
		const host = new URL(withScheme).hostname
		if (!host || isLoopbackHost(host)) return null
		return host
	} catch {
		return developmentMachineHostFromDebugger(trimmed)
	}
}

/** Best-effort LAN IP of the Mac running Metro / `npm run dev`. */
export function resolveDevelopmentMachineHost(sources: {
	configuredHost?: string | null
	debuggerHost?: string | null
	hostUri?: string | null
	linkingUri?: string | null
	experienceUrl?: string | null
}): string | null {
	const configured = sources.configuredHost?.trim()
	if (configured) {
		const fromConfigured =
			developmentMachineHostFromDebugger(configured) ??
			developmentMachineHostFromLink(configured)
		if (fromConfigured) return fromConfigured
	}
	for (const value of [
		sources.debuggerHost,
		sources.hostUri,
		sources.linkingUri,
		sources.experienceUrl,
	]) {
		const host =
			developmentMachineHostFromDebugger(value) ??
			developmentMachineHostFromLink(value)
		if (host) return host
	}
	return null
}

/**
 * On the Android emulator `localhost` is the emulator itself; the host machine
 * is `10.0.2.2`. `androidDevHost` overrides it (for example `localhost` with
 * `adb reverse` on a physical device).
 */
function forPlatform(
	url: string,
	platform: string | undefined,
	devHost: string,
) {
	if (platform !== 'android') return url
	try {
		const parsed = new URL(url)
		if (parsed.protocol !== 'http:') return url
		if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
			return url
		}
		parsed.hostname = devHost
		return parsed.toString().replace(/\/+$/, '')
	} catch {
		return url
	}
}

/** Reads `expoConfig.extra.customer` written by app.config.ts. */
export function configurationFromBuild(
	extra: unknown,
	options: { platform?: string } = {},
): TenantConfiguration {
	const fields =
		extra && typeof extra === 'object' ? (extra as Record<string, unknown>) : {}
	const fallback = localDevelopment(options.platform)
	const useTls = readBoolean(fields.useTls) ?? true
	const devHostSetting = readText(fields.androidDevHost)
	const devHost =
		devHostSetting && isLoopbackHost(devHostSetting)
			? devHostSetting
			: ANDROID_EMULATOR_HOST
	const endpoint = (raw: unknown, fallbackUrl: string) =>
		forPlatform(
			normalizeEndpoint(raw, useTls, fallbackUrl),
			options.platform,
			devHost,
		)

	const ksaSetting = fields.tenantApiKsa
	// A blank KSA node means a US-only deployment; a missing one is the
	// development default.
	const tenantApiBaseUrlKsa =
		ksaSetting === undefined
			? fallback.tenantApiBaseUrlKsa
			: readText(ksaSetting)
				? endpoint(ksaSetting, fallback.tenantApiBaseUrlKsa ?? '')
				: null

	const site =
		fields.site && typeof fields.site === 'object'
			? (fields.site as Record<string, unknown>)
			: {}

	return {
		appBaseUrl: endpoint(fields.appBaseUrl, fallback.appBaseUrl),
		tenantApiBaseUrlUs: endpoint(
			fields.tenantApiUs,
			fallback.tenantApiBaseUrlUs,
		),
		tenantApiBaseUrlKsa,
		siteAddress: makeSiteAddress({
			slug: readText(site.slug)?.toLowerCase(),
			host: readText(site.host)?.toLowerCase(),
			origin: readOrigin(site.origin),
		}),
		brandDomain:
			readText(fields.brandDomain)?.toLowerCase() ?? fallback.brandDomain,
		requestTimeoutMs: DEFAULT_TIMEOUT_MS,
		useTls,
		dataRegion: 'us',
	}
}

export function isBoundToTenant(configuration: TenantConfiguration): boolean {
	return Boolean(
		configuration.siteAddress.slug || configuration.siteAddress.host,
	)
}

/**
 * The regional node that owns this organization's customer data. `null` when
 * the organization is in KSA and this build has no KSA node: customer data
 * must never be sent to another region's node instead.
 */
export function tenantApiBaseUrl(
	configuration: TenantConfiguration,
	region: string = configuration.dataRegion,
): string | null {
	if (region.trim().toLowerCase() === 'ksa')
		return configuration.tenantApiBaseUrlKsa
	return configuration.tenantApiBaseUrlUs
}

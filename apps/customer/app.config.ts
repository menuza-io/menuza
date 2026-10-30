import { getLocalDomain } from '@repo/config/brand'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type ConfigContext, type ExpoConfig } from 'expo/config'

/**
 * Build-time configuration of the tenant customer app.
 *
 * - No `CUSTOMER_TENANT`: the un-branded app. The customer connects their own
 *   site on first launch. Endpoints are the local dev servers, or production
 *   with `CUSTOMER_ENV=production`.
 * - `CUSTOMER_TENANT=<slug>`: a white-label build from `tenants/<slug>.json`
 *   (name, bundle ids, endpoints, and the site the app is bound to).
 *
 * The site origin decides tenant-api's origin check: the app sends it as the
 * `Origin` header (https sites), which is how the server knows which tenant's
 * customers the app may authenticate. No secrets live in tenant files.
 */

type SiteBinding = { slug: string; host: string; origin: string }

type CustomerExtra = {
	useTls: boolean
	appBaseUrl: string
	tenantApiUs: string
	tenantApiKsa: string
	brandDomain: string
	/** Optional LAN IP when Metro does not expose a debugger host. */
	devMachineHost?: string
	site: SiteBinding
}

type TenantFile = {
	slug: string
	displayName: string
	bundleId: string
	androidPackage?: string
	marketingVersion?: string
	appUrl: string
	brandDomain?: string
	tenantApiUs: string
	tenantApiKsa?: string
	useTls?: boolean
	iconBackground?: string
	site?: { slug?: string; host?: string; origin?: string }
}

const TENANT_SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/
const LOCAL_HOST = /^(localhost|127\.|10\.0\.2\.2|\[::1\])/
const DEFAULT_ICON_BACKGROUND = '#0F172A'

const DEVELOPMENT = {
	useTls: false,
	appBaseUrl: 'localhost:3001',
	tenantApiUs: 'localhost:3007',
	tenantApiKsa: 'localhost:3009',
	brandDomain: getLocalDomain(),
}

const PRODUCTION = {
	useTls: true,
	appBaseUrl: 'app.epic-startup.com',
	tenantApiUs: 'tenant-us.epic-startup.com',
	tenantApiKsa: 'tenant-ksa.epic-startup.com',
	brandDomain: 'epic-startup.com',
}

function fail(message: string): never {
	throw new Error(`apps/customer: ${message}`)
}

function text(value: unknown): string {
	return typeof value === 'string' ? value.trim() : ''
}

function requireText(
	tenant: Record<string, unknown>,
	key: string,
	file: string,
) {
	const value = text(tenant[key])
	if (!value) fail(`tenants/${file} is missing "${key}"`)
	return value
}

function readTenant(slug: string): TenantFile {
	if (!TENANT_SLUG.test(slug)) {
		fail(`CUSTOMER_TENANT must name a file in tenants/ (got "${slug}")`)
	}
	const file = `${slug}.json`
	const path = join(__dirname, 'tenants', file)
	if (!existsSync(path)) fail(`no tenant config at tenants/${file}`)
	let raw: unknown
	try {
		raw = JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		fail(`tenants/${file} is not valid JSON (${(error as Error).message})`)
	}
	if (!raw || typeof raw !== 'object') fail(`tenants/${file} is not an object`)
	const tenant = raw as Record<string, unknown>
	requireText(tenant, 'displayName', file)
	requireText(tenant, 'bundleId', file)
	requireText(tenant, 'appUrl', file)
	requireText(tenant, 'tenantApiUs', file)
	const site = (tenant.site ?? {}) as Record<string, unknown>
	if (!text(site.slug) && !text(site.host)) {
		fail(
			`tenants/${file} needs site.slug or site.host: a white-label app is bound to one tenant`,
		)
	}
	return { ...(tenant as TenantFile), slug }
}

/**
 * The `Origin` the app sends: `site.origin`, or `site.host` with the build's
 * scheme. A TLS build must have an https origin; a local build may rely on the
 * `slug`/`host` binding that tenant-api accepts outside production.
 */
function siteOrigin(tenant: TenantFile, useTls: boolean): string {
	const configured = text(tenant.site?.origin)
	const host = text(tenant.site?.host)
	const raw =
		configured || (host ? `${useTls ? 'https' : 'http'}://${host}` : '')
	if (!raw) {
		if (useTls) {
			fail(
				`tenants/${tenant.slug}.json needs site.origin (or site.host): tenant-api resolves the tenant from the Origin header`,
			)
		}
		return ''
	}
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		fail(`tenants/${tenant.slug}.json has an invalid site.origin: ${raw}`)
	}
	if (!url.host || !['http:', 'https:'].includes(url.protocol)) {
		fail(`tenants/${tenant.slug}.json has an invalid site.origin: ${raw}`)
	}
	if (useTls && url.protocol !== 'https:') {
		fail(`tenants/${tenant.slug}.json site.origin must be https: ${raw}`)
	}
	return url.origin
}

function tenantExtra(tenant: TenantFile): CustomerExtra {
	const appBaseUrl = text(tenant.appUrl)
	const useTls =
		typeof tenant.useTls === 'boolean'
			? tenant.useTls
			: !LOCAL_HOST.test(appBaseUrl)
	const host = text(tenant.site?.host)
	return {
		useTls,
		appBaseUrl,
		tenantApiUs: text(tenant.tenantApiUs),
		tenantApiKsa: text(tenant.tenantApiKsa),
		brandDomain:
			text(tenant.brandDomain) ||
			(useTls ? PRODUCTION.brandDomain : DEVELOPMENT.brandDomain),
		site: {
			slug: host ? '' : text(tenant.site?.slug).toLowerCase(),
			host: host.toLowerCase(),
			origin: siteOrigin(tenant, useTls),
		},
	}
}

function generatedAsset(slug: string, name: string): string | null {
	const relative = `./tenants/generated/${slug}/${name}`
	return existsSync(join(__dirname, relative)) ? relative : null
}

export default ({ config }: ConfigContext): ExpoConfig => {
	const slug = text(process.env.CUSTOMER_TENANT)
	const tenant = slug ? readTenant(slug) : null
	const endpoints =
		process.env.CUSTOMER_ENV === 'production' ? PRODUCTION : DEVELOPMENT
	const extra: CustomerExtra = tenant
		? tenantExtra(tenant)
		: {
				...endpoints,
				...(text(process.env.CUSTOMER_DEV_HOST)
					? { devMachineHost: text(process.env.CUSTOMER_DEV_HOST) }
					: {}),
				site: { slug: '', host: '', origin: '' },
			}

	const bundleId = tenant ? text(tenant.bundleId) : 'com.epicstartup.tenant'
	const androidPackage = text(tenant?.androidPackage) || bundleId
	const buildNumber = text(process.env.CUSTOMER_BUILD_NUMBER) || '1'
	const icon =
		(tenant && generatedAsset(tenant.slug, 'icon.png')) ?? './assets/icon.png'
	const adaptiveIcon =
		(tenant && generatedAsset(tenant.slug, 'adaptive-icon.png')) ??
		'./assets/adaptive-icon.png'

	return {
		...config,
		name: tenant ? text(tenant.displayName) : 'Tenant',
		slug: tenant ? `tenant-${tenant.slug}` : 'tenant',
		version: text(tenant?.marketingVersion) || '1.0.0',
		orientation: 'portrait',
		icon,
		scheme: tenant ? `tenant-${tenant.slug}` : 'tenant',
		userInterfaceStyle: 'automatic',
		platforms: ['ios', 'android'],
		ios: {
			bundleIdentifier: bundleId,
			buildNumber,
			supportsTablet: true,
			infoPlist: {
				ITSAppUsesNonExemptEncryption: false,
			},
		},
		android: {
			package: androidPackage,
			versionCode: Number.parseInt(buildNumber, 10) || 1,
			adaptiveIcon: {
				foregroundImage: adaptiveIcon,
				backgroundColor:
					text(tenant?.iconBackground) || DEFAULT_ICON_BACKGROUND,
			},
			// The session lives in secure storage (Android Keystore) and must not
			// follow the customer to another device through backup or transfer.
			allowBackup: false,
			predictiveBackGestureEnabled: false,
		},
		plugins: [
			'expo-router',
			'expo-status-bar',
			['expo-secure-store', { configureAndroidBackup: true }],
			'expo-web-browser',
			[
				'expo-localization',
				{
					// Right-to-left layout is applied per screen tree from the app's
					// language (LayoutDirection), so the language can change without
					// a restart. React Native's global RTL flag stays off.
					supportsRTL: false,
					supportedLocales: ['en', 'ar', 'de', 'es', 'fr', 'zh'],
				},
			],
		],
		extra: {
			...config.extra,
			customer: extra,
		},
	}
}

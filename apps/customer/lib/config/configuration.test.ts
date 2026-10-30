import {
	configurationFromBuild,
	developmentMachineHostFromDebugger,
	developmentMachineHostFromLink,
	isBoundToTenant,
	isLoopbackHost,
	isTransportSafe,
	localDevelopment,
	resolveDevelopmentMachineHost,
	rewriteLoopbackEndpoints,
	tenantApiBaseUrl,
} from './configuration'
import { makeConfiguration } from '@/test/support'

describe('configurationFromBuild', () => {
	it('reads the build configuration', () => {
		const configuration = configurationFromBuild({
			appBaseUrl: 'https://app.epic-startup.com',
			tenantApiUs: 'tenant-us.epic-startup.com',
			tenantApiKsa: 'https://tenant-ksa.epic-startup.com',
			brandDomain: 'epic-startup.com',
			site: { slug: 'acme', origin: 'https://acme.epic-startup.com' },
		})

		expect(configuration.appBaseUrl).toBe('https://app.epic-startup.com')
		expect(configuration.tenantApiBaseUrlUs).toBe(
			'https://tenant-us.epic-startup.com',
		)
		expect(tenantApiBaseUrl(configuration, 'ksa')).toBe(
			'https://tenant-ksa.epic-startup.com',
		)
		expect(configuration.siteAddress).toEqual({
			slug: 'acme',
			host: null,
			origin: 'https://acme.epic-startup.com',
		})
		expect(isBoundToTenant(configuration)).toBe(true)
	})

	it('falls back to local development', () => {
		const configuration = configurationFromBuild({})

		expect(configuration.appBaseUrl).toBe('http://localhost:3001')
		expect(configuration.tenantApiBaseUrlUs).toBe('http://localhost:3007')
		expect(tenantApiBaseUrl(configuration, 'ksa')).toBe('http://localhost:3009')
		expect(isBoundToTenant(configuration)).toBe(false)
	})

	it('refuses cleartext to a non-loopback host', () => {
		// A misconfigured release build (production host, TLS off) must not use http.
		const configuration = configurationFromBuild({
			useTls: false,
			appBaseUrl: 'app.epic-startup.com',
			tenantApiUs: 'tenant-us.epic-startup.com',
		})
		expect(configuration.appBaseUrl).toBe('http://localhost:3001')
		expect(configuration.tenantApiBaseUrlUs).toBe('http://localhost:3007')

		// Loopback over http stays available for development.
		const development = configurationFromBuild({
			useTls: 'NO',
			appBaseUrl: 'localhost:3001',
			tenantApiUs: '127.0.0.1:3007',
		})
		expect(development.appBaseUrl).toBe('http://localhost:3001')
		expect(development.tenantApiBaseUrlUs).toBe('http://127.0.0.1:3007')

		// An explicit http:// URL is refused the same way.
		const explicit = configurationFromBuild({
			appBaseUrl: 'http://app.epic-startup.com',
		})
		expect(explicit.appBaseUrl).toBe('http://localhost:3001')
	})

	it('treats a blank KSA node as a US-only deployment', () => {
		const configuration = configurationFromBuild({
			appBaseUrl: 'app.epic-startup.com',
			tenantApiUs: 'tenant-us.epic-startup.com',
			tenantApiKsa: '',
		})
		expect(configuration.tenantApiBaseUrlKsa).toBeNull()
		// Never route a KSA organization's customers to another region's node.
		expect(tenantApiBaseUrl(configuration, 'ksa')).toBeNull()
		expect(tenantApiBaseUrl(configuration, 'us')).toBe(
			'https://tenant-us.epic-startup.com',
		)
	})

	it('points loopback endpoints at the host machine on the Android emulator', () => {
		const configuration = configurationFromBuild(
			{
				useTls: false,
				appBaseUrl: 'localhost:3001',
				tenantApiUs: 'localhost:3007',
				tenantApiKsa: '127.0.0.1:3009',
			},
			{ platform: 'android' },
		)
		expect(configuration.appBaseUrl).toBe('http://10.0.2.2:3001')
		expect(configuration.tenantApiBaseUrlUs).toBe('http://10.0.2.2:3007')
		expect(configuration.tenantApiBaseUrlKsa).toBe('http://10.0.2.2:3009')

		const reversed = configurationFromBuild(
			{
				useTls: false,
				appBaseUrl: 'localhost:3001',
				androidDevHost: 'localhost',
			},
			{ platform: 'android' },
		)
		expect(reversed.appBaseUrl).toBe('http://localhost:3001')

		const unsafe = configurationFromBuild(
			{
				useTls: false,
				appBaseUrl: 'localhost:3001',
				androidDevHost: '192.168.1.5',
			},
			{ platform: 'android' },
		)
		expect(unsafe.appBaseUrl).toBe('http://10.0.2.2:3001')
	})

	it('rewrites loopback dev endpoints to the Metro machine host', () => {
		const base = localDevelopment()
		expect(
			rewriteLoopbackEndpoints(base, '192.168.2.44').appBaseUrl,
		).toBe('http://192.168.2.44:3001')
		expect(
			rewriteLoopbackEndpoints(base, '192.168.2.44').tenantApiBaseUrlUs,
		).toBe('http://192.168.2.44:3007')
	})

	it('reads the debugger host from Expo Go', () => {
		expect(developmentMachineHostFromDebugger('192.168.2.44:8081')).toBe(
			'192.168.2.44',
		)
		expect(developmentMachineHostFromDebugger('localhost:8081')).toBeNull()
	})

	it('resolves the dev machine from Metro URIs', () => {
		expect(
			developmentMachineHostFromLink('exp://192.168.2.44:8081'),
		).toBe('192.168.2.44')
		expect(
			resolveDevelopmentMachineHost({
				linkingUri: 'exp://192.168.2.44:8081',
			}),
		).toBe('192.168.2.44')
		expect(
			resolveDevelopmentMachineHost({
				configuredHost: '192.168.9.1',
				debuggerHost: '192.168.2.44:8081',
			}),
		).toBe('192.168.9.1')
	})

	it('keeps only a well-formed site origin', () => {
		expect(
			configurationFromBuild({ site: { slug: 'acme', origin: 'not a url' } })
				.siteAddress.origin,
		).toBeNull()
		expect(
			configurationFromBuild({
				site: { host: 'WWW.Acme.com', origin: 'https://www.acme.com/' },
			}).siteAddress,
		).toEqual({
			slug: null,
			host: 'www.acme.com',
			origin: 'https://www.acme.com',
		})
	})
})

describe('isTransportSafe', () => {
	it('allows https anywhere and http on loopback only', () => {
		expect(isTransportSafe('https://acme.epic-startup.com')).toBe(true)
		expect(isTransportSafe('http://127.0.0.1:3001')).toBe(true)
		expect(isTransportSafe('http://10.0.2.2:3001')).toBe(true)
		expect(isTransportSafe('http://[::1]:3001')).toBe(true)
		expect(isTransportSafe('http://acme.localhost:3010')).toBe(true)
		expect(isTransportSafe('http://acme.epic-startup.com')).toBe(false)
		expect(isTransportSafe('http://localhost@evil.example')).toBe(false)
		expect(isTransportSafe('http://127.example.com')).toBe(false)
		expect(isTransportSafe('https://')).toBe(false)
		expect(isTransportSafe('ftp://acme.com')).toBe(false)
	})

	it('recognizes loopback hosts', () => {
		expect(isLoopbackHost('LOCALHOST')).toBe(true)
		expect(isLoopbackHost('127.0.0.300')).toBe(false)
		expect(isLoopbackHost('')).toBe(false)
		expect(isLoopbackHost(null)).toBe(false)
	})
})

describe('tenantApiBaseUrl', () => {
	it('selects the node of the organization region', () => {
		expect(tenantApiBaseUrl(makeConfiguration({ region: 'us' }))).toBe(
			'https://tenant-us.epic-startup.com',
		)
		expect(tenantApiBaseUrl(makeConfiguration({ region: 'KSA' }))).toBe(
			'https://tenant-ksa.epic-startup.com',
		)
	})
})

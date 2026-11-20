import { trimDnsName } from './domains.ts'

/**
 * The domain providers we recognise (#313): how to tell one from its
 * nameservers or its registrar name, and what its DNS page calls things. The
 * data only; the App writes the steps from it (and translates the words
 * around the provider's own labels). No I/O, no UI strings.
 */

export type ApexSupport =
	/** An ALIAS, ANAME or CNAME-flattening record works at the root. */
	| 'alias'
	/** No such record: use the A and AAAA records instead. */
	| 'a_only'

export type DomainProvider = {
	id: string
	name: string
	/** Matched against each nameserver host name, lower case, no trailing dot. */
	nsPatterns: RegExp[]
	/** Lower-case fragments of the registrar name RDAP reports. */
	registrarNames: string[]
	/** Where to click to reach the DNS records page. */
	dnsPath: string
	/** The button that adds a record. */
	addLabel: string
	/** What the fields are called there. */
	fields: { type: string; host: string; value: string }
	/** What to type in the host field for the root domain. */
	rootHost: string
	/** Whether the host field takes `www` (relative) or `www.example.com`. */
	hostStyle: 'relative' | 'full'
	apex: ApexSupport
	/** Supports the Domain Connect protocol (the real test is discovery). */
	autoConnect: boolean
	/** A note on this provider's quirks (shown under the steps), if any. */
	quirk?: 'proxy_off' | 'trailing_dot' | 'default_records'
}

export const GENERIC_PROVIDER: DomainProvider = {
	id: 'generic',
	name: '',
	nsPatterns: [],
	registrarNames: [],
	dnsPath: '',
	addLabel: '',
	fields: { type: 'Type', host: 'Host', value: 'Value' },
	rootHost: '@',
	hostStyle: 'relative',
	apex: 'a_only',
	autoConnect: false,
}

export const DOMAIN_PROVIDERS: DomainProvider[] = [
	{
		id: 'godaddy',
		name: 'GoDaddy',
		nsPatterns: [/\.domaincontrol\.com$/u],
		registrarNames: ['godaddy', 'wild west domains'],
		dnsPath: 'My Products > Domains > DNS',
		addLabel: 'Add New Record',
		fields: { type: 'Type', host: 'Name', value: 'Data' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: true,
		quirk: 'default_records',
	},
	{
		id: 'namecheap',
		name: 'Namecheap',
		nsPatterns: [/\.registrar-servers\.com$/u, /\.namecheaphosting\.com$/u],
		registrarNames: ['namecheap'],
		dnsPath: 'Domain List > Manage > Advanced DNS',
		addLabel: 'Add New Record',
		fields: { type: 'Type', host: 'Host', value: 'Value' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'alias',
		autoConnect: false,
	},
	{
		id: 'cloudflare',
		name: 'Cloudflare',
		nsPatterns: [/\.ns\.cloudflare\.com$/u],
		registrarNames: ['cloudflare'],
		dnsPath: 'Websites > your domain > DNS > Records',
		addLabel: 'Add record',
		fields: { type: 'Type', host: 'Name', value: 'Target' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'alias',
		autoConnect: true,
		quirk: 'proxy_off',
	},
	{
		id: 'squarespace',
		name: 'Squarespace Domains',
		nsPatterns: [/\.googledomains\.com$/u, /\.squarespacedns\.com$/u],
		registrarNames: ['squarespace', 'google domains', 'google llc'],
		dnsPath: 'Domains > your domain > DNS > DNS Settings',
		addLabel: 'Add Record',
		fields: { type: 'Type', host: 'Host', value: 'Data' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: true,
	},
	{
		id: 'route53',
		name: 'Amazon Route 53',
		nsPatterns: [/\.awsdns-\d+\.(com|net|org|co\.uk)$/u],
		registrarNames: ['amazon registrar', 'amazon'],
		dnsPath: 'Route 53 > Hosted zones > your domain',
		addLabel: 'Create record',
		fields: { type: 'Record type', host: 'Record name', value: 'Value' },
		rootHost: '',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: false,
	},
	{
		id: 'wix',
		name: 'Wix',
		nsPatterns: [/\.wixdns\.net$/u],
		registrarNames: ['wix.com'],
		dnsPath: 'Domains > Manage > DNS Records',
		addLabel: '+ Add Record',
		fields: { type: 'Record type', host: 'Host Name', value: 'Points to' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: true,
	},
	{
		id: 'hover',
		name: 'Hover',
		nsPatterns: [/\.hover\.com$/u],
		registrarNames: ['hover', 'tucows'],
		dnsPath: 'Domains > your domain > DNS',
		addLabel: 'Add a record',
		fields: { type: 'Type', host: 'Hostname', value: 'Target' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: false,
	},
	{
		id: 'bluehost',
		name: 'Bluehost',
		nsPatterns: [/\.bluehost\.com$/u],
		registrarNames: ['bluehost'],
		dnsPath: 'Domains > your domain > DNS',
		addLabel: 'Add Record',
		fields: { type: 'Type', host: 'Host Record', value: 'Points To' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: true,
	},
	{
		id: 'hostgator',
		name: 'HostGator',
		nsPatterns: [/\.hostgator\.com$/u],
		registrarNames: ['hostgator'],
		dnsPath: 'Domains > your domain > DNS',
		addLabel: 'Add Record',
		fields: { type: 'Type', host: 'Host Record', value: 'Points To' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: false,
	},
	{
		id: 'networksolutions',
		name: 'Network Solutions',
		nsPatterns: [/\.worldnic\.com$/u],
		registrarNames: ['network solutions'],
		dnsPath:
			'Account Manager > My Domain Names > Change Where Domain Points > Advanced DNS',
		addLabel: 'Edit DNS records',
		fields: { type: 'Type', host: 'Alias', value: 'Refers to' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: false,
	},
	{
		id: 'ionos',
		name: 'IONOS',
		nsPatterns: [/\.ui-dns\.(com|org|de|biz)$/u],
		registrarNames: ['ionos', '1&1'],
		dnsPath: 'Domains & SSL > your domain > DNS',
		addLabel: 'Add record',
		fields: { type: 'Type', host: 'Host name', value: 'Points to' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'alias',
		autoConnect: true,
	},
	{
		id: 'ovh',
		name: 'OVHcloud',
		nsPatterns: [/\.ovh\.(net|com)$/u],
		registrarNames: ['ovh'],
		dnsPath: 'Web Cloud > Domain names > your domain > DNS zone',
		addLabel: 'Add an entry',
		fields: { type: 'Field type', host: 'Subdomain', value: 'Target' },
		rootHost: '',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: false,
	},
	{
		id: 'gandi',
		name: 'Gandi',
		nsPatterns: [/\.dns\.gandi\.net$/u],
		registrarNames: ['gandi'],
		dnsPath: 'Domain > your domain > DNS Records',
		addLabel: 'Add record',
		fields: { type: 'Type', host: 'Name', value: 'Hostname' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'alias',
		autoConnect: false,
	},
	{
		id: 'porkbun',
		name: 'Porkbun',
		nsPatterns: [/\.porkbun\.com$/u],
		registrarNames: ['porkbun'],
		dnsPath: 'Domain Management > DNS',
		addLabel: 'Add',
		fields: { type: 'Type', host: 'Host', value: 'Answer' },
		rootHost: '',
		hostStyle: 'relative',
		apex: 'alias',
		autoConnect: false,
	},
	{
		id: 'namecom',
		name: 'Name.com',
		nsPatterns: [/\.name\.com$/u],
		registrarNames: ['name.com'],
		dnsPath: 'My Domains > your domain > DNS Records',
		addLabel: 'Add Record',
		fields: { type: 'Type', host: 'Host', value: 'Answer' },
		rootHost: '',
		hostStyle: 'relative',
		apex: 'alias',
		autoConnect: false,
	},
	{
		id: 'dnsimple',
		name: 'DNSimple',
		nsPatterns: [/\.dnsimple\.com$/u],
		registrarNames: ['dnsimple'],
		dnsPath: 'Domains > your domain > DNS',
		addLabel: 'Add record',
		fields: { type: 'Type', host: 'Name', value: 'Content' },
		rootHost: '',
		hostStyle: 'relative',
		apex: 'alias',
		autoConnect: false,
	},
	{
		id: 'azure',
		name: 'Microsoft Azure DNS',
		nsPatterns: [/\.azure-dns\.(com|net|org|info)$/u],
		registrarNames: [],
		dnsPath: 'DNS zones > your domain > Record sets',
		addLabel: '+ Add',
		fields: { type: 'Type', host: 'Name', value: 'Alias' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: false,
	},
	{
		id: 'vercel',
		name: 'Vercel',
		nsPatterns: [/\.vercel-dns\.com$/u],
		registrarNames: [],
		dnsPath: 'Domains > your domain > DNS Records',
		addLabel: 'Add',
		fields: { type: 'Type', host: 'Name', value: 'Value' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'alias',
		autoConnect: false,
	},
	{
		id: 'hostinger',
		name: 'Hostinger',
		nsPatterns: [/\.dns-parking\.com$/u, /\.hostinger\.com$/u],
		registrarNames: ['hostinger'],
		dnsPath: 'Domains > your domain > DNS / Nameservers',
		addLabel: 'Add Record',
		fields: { type: 'Type', host: 'Name', value: 'Points to' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'alias',
		autoConnect: true,
	},
	{
		id: 'enom',
		name: 'eNom',
		nsPatterns: [/\.name-services\.com$/u],
		registrarNames: ['enom'],
		dnsPath: 'Domain Manager > your domain > Host Records',
		addLabel: 'Save',
		fields: { type: 'Record Type', host: 'Host Name', value: 'Address' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: false,
	},
	{
		id: 'dynadot',
		name: 'Dynadot',
		nsPatterns: [/\.dyna-ns\.net$/u],
		registrarNames: ['dynadot'],
		dnsPath: 'My Domains > your domain > DNS Settings',
		addLabel: 'Add DNS Record',
		fields: {
			type: 'Record Type',
			host: 'Subdomain',
			value: 'IP Address or Target Host',
		},
		rootHost: '',
		hostStyle: 'relative',
		apex: 'a_only',
		autoConnect: false,
	},
	{
		id: 'menuza',
		name: 'Menuza',
		nsPatterns: [],
		registrarNames: [],
		dnsPath: '',
		addLabel: '',
		fields: { type: 'Type', host: 'Name', value: 'Content' },
		rootHost: '@',
		hostStyle: 'relative',
		apex: 'alias',
		autoConnect: false,
	},
]

export function getDomainProvider(
	id: string | null | undefined,
): DomainProvider {
	return (
		DOMAIN_PROVIDERS.find((provider) => provider.id === id) ?? GENERIC_PROVIDER
	)
}

/** Matches the nameservers of a domain; the first nameserver that matches wins. */
export function detectProviderFromNameservers(
	nameservers: readonly string[],
	extraNameservers: readonly string[] = [],
): DomainProvider | null {
	const hosts = nameservers.map(trimDnsName)
	if (
		extraNameservers.length > 0 &&
		hosts.length > 0 &&
		hosts.every((host) => extraNameservers.map(trimDnsName).includes(host))
	) {
		return getDomainProvider('menuza')
	}
	for (const host of hosts) {
		for (const provider of DOMAIN_PROVIDERS) {
			if (provider.nsPatterns.some((pattern) => pattern.test(host))) {
				return provider
			}
		}
	}
	return null
}

/** Matches the registrar name RDAP reports ("GoDaddy.com, LLC"). */
export function detectProviderFromRegistrar(
	registrarName: string | null | undefined,
): DomainProvider | null {
	const name = registrarName?.trim().toLowerCase()
	if (!name) return null
	return (
		DOMAIN_PROVIDERS.find((provider) =>
			provider.registrarNames.some((fragment) => name.includes(fragment)),
		) ?? null
	)
}

export type ProviderDetection = {
	nameservers: string[]
	registrarName: string | null
	/** Where the DNS records are edited (from the nameservers). */
	dns: { id: string; name: string } | null
	/** Where the domain is registered (from RDAP). */
	registrar: { id: string; name: string } | null
	/**
	 * The provider whose steps to show: DNS host first, then registrar. An id,
	 * so the answer serializes; `getDomainProvider` turns it back.
	 */
	stepsProviderId: string
	/** Menuza already hosts this domain's DNS. */
	managedByMenuza: boolean
}

export function detectDomainProvider(input: {
	nameservers: readonly string[]
	registrarName: string | null
	menuzaNameservers?: readonly string[]
}): ProviderDetection {
	const dns = detectProviderFromNameservers(
		input.nameservers,
		input.menuzaNameservers,
	)
	const registrar = detectProviderFromRegistrar(input.registrarName)
	const steps = dns ?? registrar ?? GENERIC_PROVIDER
	return {
		nameservers: input.nameservers.map(trimDnsName),
		registrarName: input.registrarName,
		dns: dns ? { id: dns.id, name: dns.name } : null,
		registrar: registrar
			? { id: registrar.id, name: registrar.name }
			: input.registrarName
				? { id: 'other', name: input.registrarName }
				: null,
		stepsProviderId: steps.id,
		managedByMenuza: dns?.id === 'menuza',
	}
}

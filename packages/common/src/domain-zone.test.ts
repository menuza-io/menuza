import { describe, expect, it } from 'vitest'
import {
	changeTouchesMail,
	emailConfirmationMatches,
	evaluateEmailSafety,
	exportZoneFile,
	mergeSpf,
	parseZoneFile,
	planSiteRecords,
	validateRecord,
	validateRecordRemoval,
	type ZoneRecord,
} from './domain-zone.ts'
import { describeHostname } from './domains.ts'
import {
	detectDomainProvider,
	detectProviderFromNameservers,
	detectProviderFromRegistrar,
	getDomainProvider,
} from './domain-providers.ts'

const domain = 'example.com'
const mx: ZoneRecord = {
	id: 'r1',
	type: 'MX',
	name: domain,
	content: 'aspmx.l.google.com',
	priority: 1,
}
const spf: ZoneRecord = {
	id: 'r2',
	type: 'TXT',
	name: domain,
	content: 'v=spf1 include:_spf.google.com ~all',
}
const site: ZoneRecord = {
	id: 'r3',
	type: 'CNAME',
	name: 'www.example.com',
	content: 'sites.menuza.io',
	managedBy: 'site',
}
const existing = [mx, spf, site]

describe('validateRecord', () => {
	const check = (next: ZoneRecord, editing?: ZoneRecord) =>
		validateRecord({ domain, existing, next, editing }).map((i) => i.code)

	it('accepts a valid record', () => {
		expect(
			check({ type: 'A', name: 'shop.example.com', content: '192.0.2.4' }),
		).toEqual([])
		expect(
			check({
				type: 'MX',
				name: domain,
				content: 'mx2.example.net',
				priority: 20,
			}),
		).toEqual([])
	})

	it('requires a priority on MX', () => {
		expect(
			check({ type: 'MX', name: domain, content: 'mx2.example.net' }),
		).toContain('mx_priority_required')
		expect(
			check({
				type: 'MX',
				name: domain,
				content: 'mx2.example.net',
				priority: -1,
			}),
		).toContain('mx_priority_required')
	})

	it('allows one SPF record per name', () => {
		expect(
			check({
				type: 'TXT',
				name: domain,
				content: 'v=spf1 include:other.example ~all',
			}),
		).toContain('spf_duplicate')
		// A different name may have its own.
		expect(
			check({ type: 'TXT', name: 'mail.example.com', content: 'v=spf1 -all' }),
		).toEqual([])
		// Editing the existing SPF record is not a duplicate of itself.
		expect(
			check({ ...spf, content: 'v=spf1 include:_spf.google.com -all' }, spf),
		).toEqual([])
	})

	it('refuses duplicates', () => {
		expect(
			check({
				type: 'MX',
				name: domain,
				content: 'aspmx.l.google.com',
				priority: 1,
			}),
		).toContain('duplicate')
	})

	it('refuses a CNAME beside other records, and records beside a CNAME', () => {
		expect(
			check({ type: 'CNAME', name: domain, content: 'other.example.net' }),
		).toContain('cname_conflict')
		expect(
			check({ type: 'A', name: 'www.example.com', content: '192.0.2.4' }),
		).toContain('cname_conflict')
	})

	it('keeps records inside the zone and checks content by type', () => {
		expect(
			check({ type: 'A', name: 'x.other.com', content: '192.0.2.4' }),
		).toContain('name_outside_zone')
		expect(
			check({ type: 'A', name: 'shop.example.com', content: '999.1.1.1' }),
		).toContain('invalid_content')
		expect(
			check({ type: 'AAAA', name: 'shop.example.com', content: '2001:db8::1' }),
		).toEqual([])
		expect(
			check({ type: 'AAAA', name: 'shop.example.com', content: '192.0.2.4' }),
		).toContain('invalid_content')
		expect(
			check({
				type: 'A',
				name: 'shop.example.com',
				content: '192.0.2.4',
				ttl: 5,
			}),
		).toContain('invalid_ttl')
		expect(
			check({ type: 'NS', name: domain, content: 'ns1.example.net' }),
		).toContain('apex_ns')
	})

	it('lets mail records sit beside the flattened site CNAME at the root', () => {
		const rootSite: ZoneRecord = {
			id: 'r9',
			type: 'CNAME',
			name: domain,
			content: 'sites.menuza.io',
			managedBy: 'site',
		}
		const withRoot = [mx, spf, rootSite]
		expect(
			validateRecord({
				domain,
				existing: withRoot,
				next: {
					type: 'MX',
					name: domain,
					content: 'mx2.example.net',
					priority: 20,
				},
			}),
		).toEqual([])
		// Another CNAME at the root still clashes with the records there.
		expect(
			validateRecord({
				domain,
				existing: withRoot,
				next: { type: 'CNAME', name: domain, content: 'other.example.net' },
			}).map((i) => i.code),
		).toContain('cname_conflict')
	})

	it('treats records we manage for the site as read-only', () => {
		expect(check({ ...site, content: 'evil.example.net' }, site)).toEqual([
			'managed_readonly',
		])
		expect(validateRecordRemoval(site)).toEqual([
			{ field: 'record', code: 'managed_readonly' },
		])
		expect(validateRecordRemoval(mx)).toEqual([])
	})
})

describe('mergeSpf', () => {
	it('adds a sender without a second record and keeps the existing all', () => {
		expect(
			mergeSpf('v=spf1 include:_spf.google.com -all', [
				'include:_spf.mx.cloudflare.net',
			]),
		).toBe('v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all')
	})
	it('does not repeat a sender and defaults to ~all', () => {
		expect(mergeSpf('v=spf1 include:a.example', ['include:a.example'])).toBe(
			'v=spf1 include:a.example ~all',
		)
		expect(mergeSpf(null, ['include:b.example'])).toBe(
			'v=spf1 include:b.example ~all',
		)
	})
})

describe('zone files', () => {
	const file = `
$ORIGIN example.com.
$TTL 3600
@ IN SOA ns1.old.net. admin.old.net. (
   2024010101 ; serial
   7200 3600 1209600 3600 )
@ IN NS ns1.old.net.
@ 300 IN MX 10 mail.example.com.
@ IN TXT "v=spf1 include:_spf.google.com ~all"
google._domainkey IN TXT ( "v=DKIM1; k=rsa; "
   "p=ABCDEF" )
www IN CNAME example.com.
mail IN A 192.0.2.10
	IN AAAA 2001:db8::10
_dmarc IN TXT "v=DMARC1; p=none" ; policy
weird IN LOC 1 2 3
`

	it('reads records, skips SOA and apex NS, and reports unsupported types', () => {
		const { records, errors } = parseZoneFile(file, domain)
		expect(records.map((r) => `${r.type} ${r.name}`)).toEqual([
			'MX example.com',
			'TXT example.com',
			'TXT google._domainkey.example.com',
			'CNAME www.example.com',
			'A mail.example.com',
			'AAAA mail.example.com',
			'TXT _dmarc.example.com',
		])
		expect(records[0]).toMatchObject({
			priority: 10,
			content: 'mail.example.com',
			ttl: 300,
		})
		expect(records[2]!.content).toBe('v=DKIM1; k=rsa; p=ABCDEF')
		expect(errors).toEqual([
			{ line: 16, message: 'Unsupported record type LOC' },
		])
	})

	it('round-trips through export', () => {
		const { records } = parseZoneFile(file, domain)
		const again = parseZoneFile(exportZoneFile(domain, records), domain)
		const key = (list: ZoneRecord[]) =>
			list
				.map((r) => `${r.type}|${r.name}|${r.content}|${r.priority ?? ''}`)
				.sort()
		expect(key(again.records)).toEqual(key(records))
		expect(again.errors).toEqual([])
	})
})

describe('email safety when moving to our nameservers', () => {
	const scanned = [mx, spf]

	it('is safe when there is no mail', () => {
		expect(
			evaluateEmailSafety({
				domain,
				mailKind: 'none',
				scanned: [],
				uploaded: null,
			}),
		).toBe('none')
	})

	it('needs attention when mail exists and no zone file backs the scan', () => {
		expect(
			evaluateEmailSafety({
				domain,
				mailKind: 'mail',
				scanned,
				uploaded: null,
			}),
		).toBe('attention')
	})

	it('is safe when a zone file holds every mail record found', () => {
		expect(
			evaluateEmailSafety({
				domain,
				mailKind: 'mail',
				scanned,
				uploaded: [mx, spf],
			}),
		).toBe('captured')
		expect(
			evaluateEmailSafety({
				domain,
				mailKind: 'mail',
				scanned,
				uploaded: [mx],
			}),
		).toBe('attention')
	})

	it('confirms in words by typing the domain', () => {
		expect(emailConfirmationMatches('Example.com', domain)).toBe(true)
		expect(emailConfirmationMatches('yes', domain)).toBe(false)
	})
})

describe('automatic connect plan', () => {
	const apexOf = (host: string) => describeHostname(host)!.apex

	it('only ever adds site routing records, never mail', () => {
		const changes = planSiteRecords({
			hostnames: ['www.example.com', 'example.com'],
			cnameTarget: 'sites.menuza.io',
			apexOf,
			apexIps: { a: ['192.0.2.1'], aaaa: [] },
			apexMode: 'a_only',
		})
		expect(changes).toEqual([
			{
				action: 'add',
				type: 'CNAME',
				name: 'www.example.com',
				content: 'sites.menuza.io',
			},
			{ action: 'add', type: 'A', name: 'example.com', content: '192.0.2.1' },
		])
		expect(changes.some((change) => changeTouchesMail(change, domain))).toBe(
			false,
		)
	})

	it('uses a root CNAME where the provider flattens it', () => {
		const changes = planSiteRecords({
			hostnames: ['example.com'],
			cnameTarget: 'sites.menuza.io',
			apexOf,
			apexMode: 'alias',
		})
		expect(changes).toEqual([
			{
				action: 'add',
				type: 'CNAME',
				name: 'example.com',
				content: 'sites.menuza.io',
			},
		])
	})

	it('recognises a change that would touch mail', () => {
		expect(
			changeTouchesMail(
				{ action: 'add', type: 'MX', name: domain, content: 'x.example.net' },
				domain,
			),
		).toBe(true)
		expect(
			changeTouchesMail(
				{ action: 'add', type: 'TXT', name: domain, content: 'v=spf1 -all' },
				domain,
			),
		).toBe(true)
	})
})

describe('provider detection', () => {
	it('names the DNS host from its nameservers', () => {
		expect(
			detectProviderFromNameservers([
				'ns41.domaincontrol.com',
				'ns42.domaincontrol.com',
			])?.name,
		).toBe('GoDaddy')
		expect(
			detectProviderFromNameservers(['dns1.registrar-servers.com.'])?.id,
		).toBe('namecheap')
		expect(detectProviderFromNameservers(['bob.ns.cloudflare.com'])?.id).toBe(
			'cloudflare',
		)
		expect(detectProviderFromNameservers(['ns-1234.awsdns-12.org'])?.id).toBe(
			'route53',
		)
		expect(
			detectProviderFromNameservers(['ns1.unknown-dns.example']),
		).toBeNull()
	})

	it('names the registrar from RDAP', () => {
		expect(detectProviderFromRegistrar('GoDaddy.com, LLC')?.id).toBe('godaddy')
		expect(detectProviderFromRegistrar('NameCheap, Inc.')?.id).toBe('namecheap')
		expect(detectProviderFromRegistrar('Some Tiny Registrar')).toBeNull()
		expect(detectProviderFromRegistrar(null)).toBeNull()
	})

	it('shows steps for the DNS host first, then the registrar, then the generic ones', () => {
		const both = detectDomainProvider({
			nameservers: ['bob.ns.cloudflare.com'],
			registrarName: 'GoDaddy.com, LLC',
		})
		expect(both.stepsProviderId).toBe('cloudflare')
		expect(both.registrar).toEqual({ id: 'godaddy', name: 'GoDaddy' })

		const registrarOnly = detectDomainProvider({
			nameservers: ['ns1.unknown-dns.example'],
			registrarName: 'GoDaddy.com, LLC',
		})
		expect(registrarOnly.stepsProviderId).toBe('godaddy')

		const none = detectDomainProvider({ nameservers: [], registrarName: null })
		expect(none.stepsProviderId).toBe('generic')
		expect(getDomainProvider(none.stepsProviderId).id).toBe('generic')
	})

	it('recognises a domain Menuza already hosts', () => {
		const managed = detectDomainProvider({
			nameservers: ['ada.ns.menuza-dns.net'],
			registrarName: null,
			menuzaNameservers: ['ada.ns.menuza-dns.net', 'bob.ns.menuza-dns.net'],
		})
		expect(managed.managedByMenuza).toBe(true)
	})
})

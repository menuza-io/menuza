/**
 * #283: scan before the move, the email guard, the nameserver move, and the
 * records list afterwards (validation, read-only site records, change log).
 */
import { AuditAction, auditService } from '@repo/audit'
import {
	db,
	DomainRecord,
	eq,
	ManagedDomain,
	Organization,
	SiteDomain,
} from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	getMockDomainAdapters,
	setDomainAdapters,
} from './adapters.select.server.ts'
import { setDnsResolver, type DnsResolver } from './dns-resolver.server.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return { ...actual, purgeOrganizationSiteCache: vi.fn(async () => true) }
})
vi.mock('./notify.server.ts', () => ({
	notifyDomainEvent: vi.fn(async () => 1),
}))

import { type ZoneError } from './zone.server.ts'

const {
	addZoneRecord,
	checkManagedDomain,
	connectByNameservers,
	deleteZoneRecord,
	exportManagedZone,
	leaveManagedZone,
	listDomainRecords,
	scanDomain,
	updateZoneRecord,
} = await import('./zone.server.ts')

let n = 0
const uniqueApex = () => `zone-${Date.now()}-${++n}.com`

function resolverWith(records: Record<string, string[]>): DnsResolver {
	return async (name, type) =>
		(records[`${type}:${name}`] ?? []).map((data) => ({ type, data }))
}

const mailDns = (apex: string) => ({
	[`MX:${apex}`]: ['1 aspmx.l.google.com.', '5 alt1.aspmx.l.google.com.'],
	[`TXT:${apex}`]: ['"v=spf1 include:_spf.google.com ~all"'],
	[`TXT:_dmarc.${apex}`]: ['"v=DMARC1; p=none"'],
	[`TXT:google._domainkey.${apex}`]: ['"v=DKIM1; k=rsa; p=ABC"'],
	[`A:${apex}`]: ['198.51.100.20'],
	[`CNAME:www.${apex}`]: ['old-site.wixdns.net.'],
})

beforeEach(() => {
	setDomainAdapters(getMockDomainAdapters())
})
afterEach(() => {
	setDnsResolver(null)
	vi.restoreAllMocks()
})

async function setup() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	return { organization, actor: { userId: user.id } }
}

describe('scanDomain', () => {
	it('captures website and mail records and says email may need attention', async () => {
		const apex = uniqueApex()
		const scan = await scanDomain({
			domain: apex,
			resolver: resolverWith(mailDns(apex)),
		})
		expect(scan.emailSafety).toBe('attention')
		expect(scan.mail).toMatchObject({
			kind: 'mail',
			provider: { name: 'Google Workspace' },
		})
		const labels = scan.records.map((r) => `${r.type} ${r.name}`)
		expect(labels).toEqual(
			expect.arrayContaining([
				`MX ${apex}`,
				`TXT ${apex}`,
				`TXT _dmarc.${apex}`,
				`TXT google._domainkey.${apex}`,
				`A ${apex}`,
				`CNAME www.${apex}`,
			]),
		)
	})

	it('says website safe and email safe when no mail exists', async () => {
		const apex = uniqueApex()
		const scan = await scanDomain({
			domain: apex,
			resolver: resolverWith({ [`A:${apex}`]: ['198.51.100.20'] }),
		})
		expect(scan.emailSafety).toBe('none')
	})

	it('treats a zone file that holds every mail record as captured, and adds what DNS missed', async () => {
		const apex = uniqueApex()
		const file = `
$ORIGIN ${apex}.
@ 3600 IN MX 1 aspmx.l.google.com.
@ 3600 IN MX 5 alt1.aspmx.l.google.com.
@ 3600 IN TXT "v=spf1 include:_spf.google.com ~all"
_dmarc 3600 IN TXT "v=DMARC1; p=none"
google._domainkey 3600 IN TXT "v=DKIM1; k=rsa; p=ABC"
selector9._domainkey 3600 IN TXT "v=DKIM1; k=rsa; p=ONLYINFILE"
`
		const scan = await scanDomain({
			domain: apex,
			zoneFile: file,
			resolver: resolverWith(mailDns(apex)),
		})
		expect(scan.emailSafety).toBe('captured')
		expect(scan.zoneFile).toMatchObject({ used: true, recordCount: 6 })
		expect(
			scan.records.some((r) => r.name === `selector9._domainkey.${apex}`),
		).toBe(true)
	})

	it('needs attention when the file misses a mail record DNS found', async () => {
		const apex = uniqueApex()
		const scan = await scanDomain({
			domain: apex,
			zoneFile: `$ORIGIN ${apex}.\n@ 3600 IN MX 1 aspmx.l.google.com.\n`,
			resolver: resolverWith(mailDns(apex)),
		})
		expect(scan.emailSafety).toBe('attention')
	})
})

describe('moving a domain to our nameservers', () => {
	async function scanWithMail(apex: string) {
		return scanDomain({ domain: apex, resolver: resolverWith(mailDns(apex)) })
	}

	it('keeps the existing email records in the new zone', async () => {
		const { organization, actor } = await setup()
		const apex = uniqueApex()
		const scan = await scanWithMail(apex)
		const result = await connectByNameservers({
			organization,
			hostname: apex,
			primaryForm: 'www',
			scan,
			emailConfirmation: apex,
			actor,
		})
		expect(result.nameservers).toEqual([
			'ada.ns.mock-dns.test',
			'bob.ns.mock-dns.test',
		])
		const records = await listDomainRecords(result.domain.id)
		const kept = records
			.filter((r) => r.managedBy === null)
			.map((r) => `${r.type} ${r.name} ${r.content}`)
		expect(kept).toEqual(
			expect.arrayContaining([
				`MX ${apex} aspmx.l.google.com`,
				`MX ${apex} alt1.aspmx.l.google.com`,
				`TXT ${apex} v=spf1 include:_spf.google.com ~all`,
				`TXT _dmarc.${apex} v=DMARC1; p=none`,
				`TXT google._domainkey.${apex} v=DKIM1; k=rsa; p=ABC`,
			]),
		)
		// The old website records at the connected hosts are replaced by ours.
		expect(records.some((r) => r.name === apex && r.type === 'A')).toBe(false)
		const site = records
			.filter((r) => r.managedBy === 'site')
			.map((r) => `${r.type} ${r.name} ${r.content}`)
		expect(site).toEqual(
			expect.arrayContaining([
				`CNAME www.${apex} sites.menuza.io`,
				`CNAME ${apex} sites.menuza.io`,
			]),
		)
		// The same records reached the zone at the provider.
		const provider = getMockDomainAdapters().dns
		const remote = await provider.listRecords(result.domain.zoneId!)
		expect(remote.map((r) => r.type)).toEqual(
			expect.arrayContaining(['MX', 'TXT', 'CNAME']),
		)
		// The sites are set up on the zone and wait for the nameservers.
		const sites = await db
			.select()
			.from(SiteDomain)
			.where(eq(SiteDomain.managedDomainId, result.domain.id))
		expect(
			sites.map((s) => `${s.hostname}|${s.method}|${s.status}`).sort(),
		).toEqual(
			[`${apex}|nameservers|pending`, `www.${apex}|nameservers|pending`].sort(),
		)
		expect(result.domain.zoneStatus).toBe('pending')
	})

	it('refuses to continue silently when email records might be lost', async () => {
		const { organization, actor } = await setup()
		const apex = uniqueApex()
		const scan = await scanWithMail(apex)
		await expect(
			connectByNameservers({
				organization,
				hostname: apex,
				primaryForm: 'www',
				scan,
				actor,
			}),
		).rejects.toMatchObject({ code: 'email_confirmation_required' })
		await expect(
			connectByNameservers({
				organization,
				hostname: apex,
				primaryForm: 'www',
				scan,
				emailConfirmation: 'yes please',
				actor,
			}),
		).rejects.toMatchObject({ code: 'email_confirmation_required' })
		// Nothing was created.
		expect(
			await db.select().from(ManagedDomain).where(eq(ManagedDomain.fqdn, apex)),
		).toEqual([])
		expect(
			await db
				.select()
				.from(SiteDomain)
				.where(eq(SiteDomain.organizationId, organization.id)),
		).toEqual([])
	})

	it('does not ask when there is no mail', async () => {
		const { organization, actor } = await setup()
		const apex = uniqueApex()
		const scan = await scanDomain({ domain: apex, resolver: resolverWith({}) })
		const result = await connectByNameservers({
			organization,
			hostname: apex,
			primaryForm: 'apex',
			scan,
			actor,
		})
		expect(result.sites.map((s) => s.hostname).sort()).toEqual(
			[apex, `www.${apex}`].sort(),
		)
	})

	it('asks for the root domain when a subdomain is entered', async () => {
		const { organization, actor } = await setup()
		const apex = uniqueApex()
		const scan = await scanDomain({ domain: apex, resolver: resolverWith({}) })
		await expect(
			connectByNameservers({
				organization,
				hostname: `shop.${apex}`,
				primaryForm: 'www',
				scan,
				actor,
			}),
		).rejects.toMatchObject({ code: 'subdomain_not_allowed' })
	})

	it('refuses a domain another organization manages', async () => {
		const first = await setup()
		const apex = uniqueApex()
		const scan = await scanDomain({ domain: apex, resolver: resolverWith({}) })
		await connectByNameservers({
			organization: first.organization,
			hostname: apex,
			primaryForm: 'www',
			scan,
			actor: first.actor,
		})
		const second = await setup()
		await expect(
			connectByNameservers({
				organization: second.organization,
				hostname: apex,
				primaryForm: 'www',
				scan,
				actor: second.actor,
			}),
		).rejects.toMatchObject({ code: 'hostname_taken' })
	})
})

describe('checking the nameservers', () => {
	async function moved() {
		const ctx = await setup()
		const apex = uniqueApex()
		const scan = await scanDomain({ domain: apex, resolver: resolverWith({}) })
		const result = await connectByNameservers({
			organization: ctx.organization,
			hostname: apex,
			primaryForm: 'www',
			scan,
			actor: ctx.actor,
		})
		return { ...ctx, apex, domain: result.domain }
	}

	it('waits, then notices the move and goes active', async () => {
		const { apex, domain } = await moved()
		const waiting = await checkManagedDomain(domain, {
			resolver: resolverWith({}),
		})
		expect(waiting.state).toBe('waiting')
		expect(waiting.row.zoneStatus).toBe('pending')

		const done = await checkManagedDomain(waiting.row, {
			resolver: resolverWith({
				[`NS:${apex}`]: ['ada.ns.mock-dns.test.', 'bob.ns.mock-dns.test.'],
			}),
		})
		expect(done.state).toBe('verified')
		expect(done.row.zoneStatus).toBe('active')
		expect(done.row.nsVerifiedAt).not.toBeNull()
		expect(done.becameActive).toBe(true)
	})

	it('detects nameservers changed at the wrong place', async () => {
		const { apex, domain } = await moved()
		const result = await checkManagedDomain(domain, {
			resolver: resolverWith({ [`NS:${apex}`]: ['ns41.domaincontrol.com.'] }),
		})
		expect(result.state).toBe('wrong_place')
		expect(result.current).toEqual(['ns41.domaincontrol.com'])
		expect(result.row.zoneStatus).toBe('pending')
	})
})

describe('the records list', () => {
	async function managed() {
		const ctx = await setup()
		const apex = uniqueApex()
		const scan = await scanDomain({
			domain: apex,
			resolver: resolverWith(mailDns(apex)),
		})
		const result = await connectByNameservers({
			organization: ctx.organization,
			hostname: apex,
			primaryForm: 'www',
			scan,
			emailConfirmation: apex,
			actor: ctx.actor,
		})
		return { ...ctx, apex, domain: result.domain }
	}

	it('adds a valid record at the provider and logs it', async () => {
		const { organization, actor, apex, domain } = await managed()
		const log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const row = await addZoneRecord({
			organizationId: organization.id,
			managedDomainId: domain.id,
			record: {
				type: 'A',
				name: `shop.${apex}`,
				content: '192.0.2.44',
				ttl: 300,
			},
			actor,
		})
		expect(row).toMatchObject({
			type: 'A',
			name: `shop.${apex}`,
			source: 'user',
			managedBy: null,
		})
		expect(row.providerRecordId).toBeTruthy()
		const entry = log.mock.calls
			.map(([c]) => c)
			.find((c) => c.action === AuditAction.WEBSITE_DOMAIN_CHANGED)
		expect(entry?.details).toContain(`Added a A record for shop.${apex}`)
	})

	it('rejects an invalid record with the reason', async () => {
		const { organization, actor, apex, domain } = await managed()
		const attempt = (record: Parameters<typeof addZoneRecord>[0]['record']) =>
			addZoneRecord({
				organizationId: organization.id,
				managedDomainId: domain.id,
				record,
				actor,
			}).catch((error: InstanceType<typeof ZoneError>) =>
				error.issues.map((i) => i.code),
			)
		expect(
			await attempt({ type: 'MX', name: apex, content: 'mx.example.net' }),
		).toEqual(['mx_priority_required'])
		expect(
			await attempt({
				type: 'TXT',
				name: apex,
				content: 'v=spf1 include:x.example ~all',
			}),
		).toContain('spf_duplicate')
		expect(
			await attempt({
				type: 'MX',
				name: apex,
				content: 'aspmx.l.google.com',
				priority: 1,
			}),
		).toContain('duplicate')
		expect(
			await attempt({ type: 'A', name: `x.${apex}`, content: 'nope' }),
		).toContain('invalid_content')
	})

	it('edits an operator record with validation and keeps the old SPF as the only one', async () => {
		const { organization, actor, apex, domain } = await managed()
		const records = await listDomainRecords(domain.id)
		const spf = records.find((r) => r.type === 'TXT' && r.name === apex)!
		const updated = await updateZoneRecord({
			organizationId: organization.id,
			managedDomainId: domain.id,
			recordId: spf.id,
			record: {
				type: 'TXT',
				name: apex,
				content: 'v=spf1 include:_spf.google.com -all',
			},
			actor,
		})
		expect(updated.content).toBe('v=spf1 include:_spf.google.com -all')
		await expect(
			updateZoneRecord({
				organizationId: organization.id,
				managedDomainId: domain.id,
				recordId: spf.id,
				record: { type: 'MX', name: apex, content: 'x.example.net' },
				actor,
			}),
		).rejects.toMatchObject({ code: 'invalid_record' })
	})

	it('keeps the records we manage for the site read-only', async () => {
		const { organization, actor, apex, domain } = await managed()
		const site = (await listDomainRecords(domain.id)).find(
			(r) => r.managedBy === 'site',
		)!
		await expect(
			updateZoneRecord({
				organizationId: organization.id,
				managedDomainId: domain.id,
				recordId: site.id,
				record: {
					type: 'CNAME',
					name: `www.${apex}`,
					content: 'evil.example.net',
				},
				actor,
			}),
		).rejects.toMatchObject({ code: 'managed_readonly' })
		await expect(
			deleteZoneRecord({
				organizationId: organization.id,
				managedDomainId: domain.id,
				recordId: site.id,
				actor,
			}),
		).rejects.toMatchObject({ code: 'managed_readonly' })
	})

	it('removes an operator record and logs every change', async () => {
		const { organization, actor, apex, domain } = await managed()
		const log = vi.spyOn(auditService, 'log').mockResolvedValue(undefined)
		const dmarc = (await listDomainRecords(domain.id)).find(
			(r) => r.name === `_dmarc.${apex}`,
		)!
		await deleteZoneRecord({
			organizationId: organization.id,
			managedDomainId: domain.id,
			recordId: dmarc.id,
			actor,
		})
		expect(
			await db.select().from(DomainRecord).where(eq(DomainRecord.id, dmarc.id)),
		).toEqual([])
		expect(log.mock.calls.map(([c]) => c.details).join('\n')).toContain(
			'Removed the TXT record',
		)
	})

	it("does not touch another organization's domain", async () => {
		const { domain } = await managed()
		const other = await setup()
		await expect(
			addZoneRecord({
				organizationId: other.organization.id,
				managedDomainId: domain.id,
				record: { type: 'A', name: `x.${domain.fqdn}`, content: '192.0.2.1' },
				actor: other.actor,
			}),
		).rejects.toMatchObject({ code: 'domain_not_found' })
	})

	it('exports the zone and switches back to the CNAME method when leaving', async () => {
		const { organization, actor, apex, domain } = await managed()
		const exported = await exportManagedZone(organization.id, domain.id)
		expect(exported.text).toContain(`$ORIGIN ${apex}.`)
		expect(exported.text).toMatch(/MX\s+1 aspmx\.l\.google\.com\./u)
		const left = await leaveManagedZone({
			organization,
			managedDomainId: domain.id,
			actor,
		})
		expect(left.text).toContain('v=spf1')
		const sites = await db
			.select()
			.from(SiteDomain)
			.where(eq(SiteDomain.organizationId, organization.id))
		expect(
			sites.every((s) => s.method === 'cname' && s.managedDomainId === null),
		).toBe(true)
		expect(
			await db
				.select()
				.from(ManagedDomain)
				.where(eq(ManagedDomain.id, domain.id)),
		).toEqual([])
		const [org] = await db
			.select({ customDomain: Organization.customDomain })
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(org?.customDomain).toBe(`www.${apex}`)
	})
})

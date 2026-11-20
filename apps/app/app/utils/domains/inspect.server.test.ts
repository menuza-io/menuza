/**
 * #139 and #313: what we tell the operator about a domain before anything is
 * changed (mail, an existing website, a subdomain typo, another site's host,
 * leftover challenge records) and which provider it is at.
 */
import { db, eq, Organization, SiteDomain } from '@repo/database'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	getMockDomainAdapters,
	setDomainAdapters,
} from './adapters.select.server.ts'
import { type DnsResolver } from './dns-resolver.server.ts'
import { inspectDomain } from './inspect.server.ts'

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return { ...actual, purgeOrganizationSiteCache: vi.fn(async () => true) }
})

function resolverWith(records: Record<string, string[]>): DnsResolver {
	return async (name, type) =>
		(records[`${type}:${name}`] ?? []).map((data) => ({ type, data }))
}

let n = 0
const uniqueApex = () => `inspect-${Date.now()}-${++n}.com`

beforeEach(() => {
	setDomainAdapters(getMockDomainAdapters())
})

async function org() {
	const user = await insertTestUser()
	return createTestOrganization(user.id, 'admin')
}

describe('inspectDomain', () => {
	it('names the DNS host and the registrar, and says which setup fits', async () => {
		const organization = await org()
		const apex = uniqueApex()
		const inspection = await inspectDomain({
			organizationId: organization.id,
			hostname: apex,
			resolver: resolverWith({
				[`NS:${apex}`]: ['ns41.domaincontrol.com.', 'ns42.domaincontrol.com.'],
			}),
			registrarLookup: async () => 'GoDaddy.com, LLC',
		})
		expect(inspection).toMatchObject({
			hostname: apex,
			apex,
			role: 'apex',
			setup: 'simple',
			warnings: [],
			takenByOther: false,
			canManageNameservers: true,
		})
		expect(inspection!.detection.dns).toEqual({
			id: 'godaddy',
			name: 'GoDaddy',
		})
		expect(inspection!.detection.registrar).toEqual({
			id: 'godaddy',
			name: 'GoDaddy',
		})
		expect(inspection!.detection.stepsProviderId).toBe('godaddy')
		// The emulated Domain Connect answers for every domain.
		expect(inspection!.autoConnect).toEqual({ providerName: 'Mock Registrar' })
	})

	it('shows the mail records and a warning when the domain receives email', async () => {
		const organization = await org()
		const apex = uniqueApex()
		const inspection = await inspectDomain({
			organizationId: organization.id,
			hostname: `www.${apex}`,
			resolver: resolverWith({
				[`MX:${apex}`]: ['1 aspmx.l.google.com.', '5 alt1.aspmx.l.google.com.'],
				[`TXT:${apex}`]: ['"v=spf1 include:_spf.google.com ~all"'],
				[`TXT:_dmarc.${apex}`]: ['"v=DMARC1; p=none"'],
				[`TXT:google._domainkey.${apex}`]: ['"v=DKIM1; k=rsa; p=ABC"'],
			}),
			registrarLookup: async () => null,
		})
		expect(inspection!.warnings).toContain('mail')
		expect(inspection!.setup).toBe('manual')
		expect(inspection!.mail.provider?.name).toBe('Google Workspace')
		expect(inspection!.mail.recordsToKeep.map((r) => r.label).sort()).toEqual(
			['dkim', 'dmarc', 'mx', 'mx', 'spf'].sort(),
		)
	})

	it('warns about mail records with no MX, an existing website and a challenge record', async () => {
		const organization = await org()
		const apex = uniqueApex()
		const inspection = await inspectDomain({
			organizationId: organization.id,
			hostname: apex,
			resolver: resolverWith({
				[`TXT:${apex}`]: ['"v=spf1 -all"'],
				[`CNAME:www.${apex}`]: ['ext-cust.squarespace.com.'],
				[`TXT:_acme-challenge.${apex}`]: ['"old-token"'],
			}),
			registrarLookup: async () => null,
		})
		expect(inspection!.warnings).toEqual(
			expect.arrayContaining(['mail_records_only', 'website', 'acme_leftover']),
		)
		expect(inspection!.website.builder).toBe('Squarespace')
		expect(inspection!.acmeLeftovers).toEqual([
			`TXT _acme-challenge.${apex} old-token`,
		])
	})

	it('suggests the main domain when a subdomain was typed, and refuses nameserver setup for it', async () => {
		const organization = await org()
		const apex = uniqueApex()
		const inspection = await inspectDomain({
			organizationId: organization.id,
			hostname: `shop.${apex}`,
			resolver: resolverWith({}),
			registrarLookup: async () => null,
		})
		expect(inspection).toMatchObject({
			role: 'subdomain',
			subdomainSuggestion: apex,
			canManageNameservers: false,
		})
		expect(inspection!.warnings).toContain('subdomain')
	})

	it('reports a domain another site already has before setup starts', async () => {
		const owner = await org()
		const apex = uniqueApex()
		await db.insert(SiteDomain).values({
			organizationId: owner.id,
			hostname: `www.${apex}`,
			isPrimary: true,
			status: 'active',
		})
		const other = await org()
		const inspection = await inspectDomain({
			organizationId: other.id,
			hostname: apex,
			resolver: resolverWith({}),
			registrarLookup: async () => null,
		})
		expect(inspection!.takenByOther).toBe(true)
		expect(inspection!.alreadyConnected).toBe(false)

		const mine = await inspectDomain({
			organizationId: owner.id,
			hostname: `www.${apex}`,
			resolver: resolverWith({}),
			registrarLookup: async () => null,
		})
		expect(mine!.takenByOther).toBe(false)
		expect(mine!.alreadyConnected).toBe(true)
	})

	it('warns when the restaurant already has a different live domain', async () => {
		const organization = await org()
		const live = uniqueApex()
		await db.insert(SiteDomain).values({
			organizationId: organization.id,
			hostname: live,
			isPrimary: true,
			status: 'active',
		})
		await db
			.update(Organization)
			.set({ customDomain: live, customDomainStatus: 'active' })
			.where(eq(Organization.id, organization.id))
		const inspection = await inspectDomain({
			organizationId: organization.id,
			hostname: uniqueApex(),
			resolver: resolverWith({}),
			registrarLookup: async () => null,
		})
		expect(inspection!.otherLiveDomain).toBe(live)
		expect(inspection!.warnings).toContain('other_live_domain')
	})

	it('answers null for something that is not a host', async () => {
		const organization = await org()
		expect(
			await inspectDomain({
				organizationId: organization.id,
				hostname: 'not a host',
				resolver: resolverWith({}),
			}),
		).toBeNull()
	})
})

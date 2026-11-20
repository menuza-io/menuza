/**
 * #139: apex and www, the secondary hosts, the checklist, the sweep and what
 * happens to domains that were connected before SiteDomain existed.
 */
import { db, eq, Organization, SiteDomain } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CloudflareModule from '#app/utils/sites/cloudflare-custom-hostnames.server.ts'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { siteHostCondition } from '#app/utils/sites/site-host.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import { setDnsResolver, type DnsResolver } from './dns-resolver.server.ts'

const cloudflare = vi.hoisted(() => ({
	statuses: new Map<string, { status: string; sslStatus?: string }>(),
	deleted: [] as string[],
	failCreateFor: new Set<string>(),
}))

vi.mock(
	'#app/utils/sites/cloudflare-custom-hostnames.server.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof CloudflareModule>()
		return {
			...actual,
			createCustomHostname: vi.fn(async (hostname: string) => {
				if (cloudflare.failCreateFor.has(hostname))
					throw new Error('Cloudflare said no')
				return {
					id: `cf-${hostname}`,
					hostname,
					status: 'pending',
					sslStatus: 'pending_validation',
					ownershipStatus: 'pending',
					ownershipVerification: {
						type: 'txt',
						name: `_cf-custom-hostname.${hostname}`,
						value: `own-${hostname}`,
					},
					sslValidationRecords: [],
					verificationErrors: [],
				}
			}),
			getCustomHostname: vi.fn(async (id: string) => {
				const known = cloudflare.statuses.get(id) ?? {
					status: 'pending',
					sslStatus: 'pending_validation',
				}
				return {
					id,
					hostname: id.replace(/^cf-/, ''),
					status: known.status,
					sslStatus: known.sslStatus,
					ownershipStatus: known.status === 'active' ? 'verified' : 'pending',
					ownershipVerification: {
						type: 'txt',
						name: `_cf-custom-hostname.${id.replace(/^cf-/, '')}`,
						value: `own-${id.replace(/^cf-/, '')}`,
					},
					sslValidationRecords: [],
					verificationErrors: [],
				}
			}),
			retryCustomHostnameValidation: vi.fn(async (id: string) => ({
				id,
				hostname: id.replace(/^cf-/, ''),
				status: 'pending',
				sslStatus: 'pending_validation',
			})),
			deleteCustomHostname: vi.fn(async (id: string) => {
				cloudflare.deleted.push(id)
			}),
		}
	},
)

const notices = vi.hoisted(() => ({
	calls: [] as Array<Record<string, unknown>>,
}))
vi.mock('./notify.server.ts', () => ({
	notifyDomainEvent: vi.fn(async (input: Record<string, unknown>) => {
		notices.calls.push(input)
		return 1
	}),
}))

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return { ...actual, purgeOrganizationSiteCache: vi.fn(async () => true) }
})

const {
	addSiteDomains,
	checkAndNotify,
	checkSiteDomain,
	disconnectAllDomains,
	DomainError,
	ensureSiteDomains,
	removeSiteDomain,
	retryExpiredDomain,
	setPrimaryDomain,
	sweepSiteDomains,
	toSiteDomainView,
} = await import('./site-domains.server.ts')

const target = 'sites.menuza.io'

function resolverWith(records: Record<string, string[]>): DnsResolver {
	return async (name, type) =>
		(records[`${type}:${name}`] ?? []).map((data) => ({ type, data }))
}

let suffix = 0
function uniqueHost() {
	suffix += 1
	return `eats-${Date.now()}-${suffix}.com`
}

async function setup() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	return { user, organization, actor: { userId: user.id } }
}

beforeEach(() => {
	cloudflare.statuses.clear()
	cloudflare.deleted.length = 0
	cloudflare.failCreateFor.clear()
	notices.calls.length = 0
})

afterEach(() => setDnsResolver(null))

describe('connecting a domain', () => {
	it('sets up both forms, the chosen one primary, and mirrors it on the organization', async () => {
		const { organization, actor } = await setup()
		const host = uniqueHost()
		const rows = await addSiteDomains({
			organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor,
		})
		expect(rows.map((row) => [row.hostname, row.isPrimary])).toEqual([
			[`www.${host}`, true],
			[host, false],
		])
		const [org] = await db
			.select({
				customDomain: Organization.customDomain,
				status: Organization.customDomainStatus,
				published: Organization.sitePublished,
			})
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(org).toEqual({
			customDomain: `www.${host}`,
			status: 'pending',
			published: true,
		})
	})

	it('shows every record the host needs, with the ownership record', async () => {
		const { organization, actor } = await setup()
		const host = uniqueHost()
		const [primary, apex] = await addSiteDomains({
			organization,
			hostname: `https://WWW.${host}/menu`,
			primaryForm: 'www',
			mode: 'primary',
			actor,
		})
		const www = toSiteDomainView(primary!)
		expect(www.records.map((r) => [r.kind, r.type, r.name, r.value])).toEqual([
			['route', 'CNAME', `www.${host}`, target],
			[
				'ownership',
				'TXT',
				`_cf-custom-hostname.www.${host}`,
				`own-www.${host}`,
			],
		])
		const root = toSiteDomainView(apex!)
		expect(root.role).toBe('apex')
		expect(root.records[0]).toMatchObject({ type: 'ALIAS', name: host })
	})

	it('connects another subdomain as a single host', async () => {
		const { organization, actor } = await setup()
		const host = `order.${uniqueHost()}`
		const rows = await addSiteDomains({
			organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor,
		})
		expect(rows.map((row) => row.hostname)).toEqual([host])
	})

	it('refuses platform hosts and invalid input before creating anything', async () => {
		const { organization, actor } = await setup()
		await expect(
			addSiteDomains({
				organization,
				hostname: 'acme.menuza.io',
				primaryForm: 'www',
				mode: 'primary',
				actor,
			}),
		).rejects.toMatchObject({ code: 'hostname_reserved' })
		await expect(
			addSiteDomains({
				organization,
				hostname: 'menuza.io',
				primaryForm: 'www',
				mode: 'primary',
				actor,
			}),
		).rejects.toMatchObject({ code: 'hostname_reserved' })
		await expect(
			addSiteDomains({
				organization,
				hostname: '10.1.1.1',
				primaryForm: 'www',
				mode: 'primary',
				actor,
			}),
		).rejects.toMatchObject({ code: 'hostname_invalid' })
		expect(await ensureSiteDomains(organization.id)).toEqual([])
	})

	it('reports a host another organization already has, from either form', async () => {
		const first = await setup()
		const second = await setup()
		const host = uniqueHost()
		await addSiteDomains({
			organization: first.organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor: first.actor,
		})
		await expect(
			addSiteDomains({
				organization: second.organization,
				hostname: `www.${host}`,
				primaryForm: 'apex',
				mode: 'primary',
				actor: second.actor,
			}),
		).rejects.toMatchObject({ code: 'hostname_taken' })
		expect(await ensureSiteDomains(second.organization.id)).toEqual([])
	})

	it('creates nothing when the second host fails at Cloudflare', async () => {
		const { organization, actor } = await setup()
		const host = uniqueHost()
		cloudflare.failCreateFor.add(host)
		await expect(
			addSiteDomains({
				organization,
				hostname: host,
				primaryForm: 'www',
				mode: 'primary',
				actor,
			}),
		).rejects.toMatchObject({ code: 'cloudflare_failed' })
		expect(await ensureSiteDomains(organization.id)).toEqual([])
		expect(cloudflare.deleted).toContain(`cf-www.${host}`)
	})

	it('adds extra domains that redirect, both forms of each', async () => {
		const { organization, actor } = await setup()
		const host = uniqueHost()
		await addSiteDomains({
			organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor,
		})
		const old = uniqueHost()
		const rows = await addSiteDomains({
			organization,
			hostname: old,
			primaryForm: 'www',
			mode: 'redirect',
			actor,
		})
		expect(rows.map((row) => [row.hostname, row.isPrimary])).toEqual([
			[`www.${old}`, false],
			[old, false],
		])
		await expect(
			addSiteDomains({
				organization,
				hostname: uniqueHost(),
				primaryForm: 'www',
				mode: 'primary',
				actor,
			}),
		).rejects.toMatchObject({ code: 'primary_exists' })
	})
})

describe('changing the primary', () => {
	it('keeps the old primary as a redirecting domain', async () => {
		const { organization, actor } = await setup()
		const host = uniqueHost()
		await addSiteDomains({
			organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor,
		})
		await setPrimaryDomain({ organization, hostname: host, actor })
		const rows = await ensureSiteDomains(organization.id)
		expect(rows.map((row) => [row.hostname, row.isPrimary])).toEqual([
			[host, true],
			[`www.${host}`, false],
		])
		const [org] = await db
			.select({ customDomain: Organization.customDomain })
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(org?.customDomain).toBe(host)
		// The old primary still answers (a secondary host the site redirects).
		const [found] = await db
			.select({ id: Organization.id })
			.from(Organization)
			.where(siteHostCondition(`www.${host}`))
		expect(found?.id).toBe(organization.id)
	})

	it('refuses a host the organization does not have', async () => {
		const { organization, actor } = await setup()
		await expect(
			setPrimaryDomain({ organization, hostname: 'nope.example.com', actor }),
		).rejects.toBeInstanceOf(DomainError)
	})
})

describe('public lookups by host', () => {
	it('find the organization from a secondary host with both query builders', async () => {
		const { organization, actor } = await setup()
		const host = uniqueHost()
		await addSiteDomains({
			organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor,
		})
		for (const name of [host, `www.${host}`]) {
			const [viaSelect] = await db
				.select({ id: Organization.id })
				.from(Organization)
				.where(siteHostCondition(name))
			expect(viaSelect?.id).toBe(organization.id)
			// The relational builder rewrites column aliases: it must work there too.
			const viaQuery = await db.query.Organization.findFirst({
				where: siteHostCondition(name),
				columns: { id: true },
			})
			expect(viaQuery?.id).toBe(organization.id)
		}
		expect(
			await db.query.Organization.findFirst({
				where: siteHostCondition(`other-${host}`),
				columns: { id: true },
			}),
		).toBeUndefined()
	})
})

describe('removing domains', () => {
	it('removes a redirecting host at once and frees it', async () => {
		const first = await setup()
		const host = uniqueHost()
		await addSiteDomains({
			organization: first.organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor: first.actor,
		})
		// The root is the redirecting form: it goes at once and is released at Cloudflare.
		await removeSiteDomain({
			organization: first.organization,
			hostname: host,
			actor: first.actor,
		})
		expect(cloudflare.deleted).toContain(`cf-${host}`)
		expect(
			(await ensureSiteDomains(first.organization.id)).map(
				(row) => row.hostname,
			),
		).toEqual([`www.${host}`])

		await disconnectAllDomains({
			organization: first.organization,
			actor: first.actor,
		})
		const second = await setup()
		const rows = await addSiteDomains({
			organization: second.organization,
			hostname: host,
			primaryForm: 'apex',
			mode: 'primary',
			actor: second.actor,
		})
		expect(rows.map((row) => row.hostname)).toContain(host)
	})

	it('keeps the primary while other hosts remain, and disconnects everything on request', async () => {
		const { organization, actor } = await setup()
		const host = uniqueHost()
		await addSiteDomains({
			organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor,
		})
		await expect(
			removeSiteDomain({ organization, hostname: `www.${host}`, actor }),
		).rejects.toMatchObject({ code: 'primary_in_use' })
		await disconnectAllDomains({ organization, actor })
		expect(await ensureSiteDomains(organization.id)).toEqual([])
		const [org] = await db
			.select({
				customDomain: Organization.customDomain,
				status: Organization.customDomainStatus,
			})
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(org).toEqual({ customDomain: null, status: null })
	})
})

describe('checking a host', () => {
	it('reports which records were found and which are missing', async () => {
		const { organization, actor } = await setup()
		const host = uniqueHost()
		const [primary] = await addSiteDomains({
			organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor,
		})

		const missing = await checkSiteDomain(primary!, {
			resolver: resolverWith({}),
		})
		expect(missing.complete).toBe(false)
		expect(missing.view.results.find((r) => r.id === 'route')?.check).toBe(
			'missing',
		)
		expect(missing.view.lastCheckedAt).not.toBeNull()

		const found = await checkSiteDomain(missing.row, {
			resolver: resolverWith({
				[`CNAME:www.${host}`]: [`${target}.`],
				[`TXT:_cf-custom-hostname.www.${host}`]: [`"own-www.${host}"`],
			}),
		})
		expect(found.complete).toBe(true)
		expect(found.view.results.map((r) => r.check)).toEqual(['found', 'found'])
	})

	it('shows ownership apart from the certificate', async () => {
		const { organization, actor } = await setup()
		const host = uniqueHost()
		const [primary] = await addSiteDomains({
			organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor,
		})
		cloudflare.statuses.set(`cf-www.${host}`, {
			status: 'pending',
			sslStatus: 'pending_validation',
		})
		const result = await checkSiteDomain(primary!, {
			resolver: resolverWith({}),
		})
		expect(result.view).toMatchObject({
			status: 'pending',
			ownershipStatus: 'pending',
			sslStatus: 'pending_validation',
			live: false,
		})
	})

	it('goes live and tells the operator once, mirroring the status on the organization', async () => {
		const { organization, actor } = await setup()
		const host = uniqueHost()
		const [primary] = await addSiteDomains({
			organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor,
		})
		cloudflare.statuses.set(`cf-www.${host}`, {
			status: 'active',
			sslStatus: 'active',
		})

		const first = await checkAndNotify(primary!, { resolver: resolverWith({}) })
		expect(first.becameLive).toBe(true)
		expect(notices.calls.map((c) => [c.kind, c.host])).toEqual([
			['live', `www.${host}`],
		])
		const [org] = await db
			.select({ status: Organization.customDomainStatus })
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(org?.status).toBe('active')

		await checkAndNotify(first.row, { resolver: resolverWith({}) })
		expect(notices.calls).toHaveLength(1)
	})
})

describe('the 15-minute sweep', () => {
	const day = 86_400_000

	async function pendingPrimary(ageDays: number) {
		const ctx = await setup()
		const host = uniqueHost()
		const [primary] = await addSiteDomains({
			organization: ctx.organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor: ctx.actor,
		})
		await db
			.update(SiteDomain)
			.set({ pendingSince: new Date(Date.now() - ageDays * day) })
			.where(eq(SiteDomain.organizationId, ctx.organization.id))
		return { ...ctx, host, primary: primary! }
	}

	it('brings a pending domain live without a click and notifies', async () => {
		const { primary, host } = await pendingPrimary(0.1)
		cloudflare.statuses.set(`cf-www.${host}`, {
			status: 'active',
			sslStatus: 'active',
		})
		const counts = await sweepSiteDomains({ resolver: resolverWith({}) })
		expect(counts.live).toBeGreaterThanOrEqual(1)
		const [row] = await db
			.select()
			.from(SiteDomain)
			.where(eq(SiteDomain.id, primary.id))
		expect(row?.status).toBe('active')
		expect(
			notices.calls.some((c) => c.kind === 'live' && c.host === `www.${host}`),
		).toBe(true)
	})

	it('emails a host pending for 7 days once, with the missing records', async () => {
		const { primary, host } = await pendingPrimary(8)
		await sweepSiteDomains({ resolver: resolverWith({}) })
		const reminders = notices.calls.filter(
			(c) => c.kind === 'pending_reminder' && c.host === `www.${host}`,
		)
		expect(reminders).toHaveLength(1)
		expect(String(reminders[0]!.detail)).toContain(
			`CNAME www.${host} -> ${target}`,
		)
		await sweepSiteDomains({ resolver: resolverWith({}) })
		expect(
			notices.calls.filter(
				(c) => c.kind === 'pending_reminder' && c.host === `www.${host}`,
			),
		).toHaveLength(1)
		const [row] = await db
			.select()
			.from(SiteDomain)
			.where(eq(SiteDomain.id, primary.id))
		expect(row?.status).toBe('pending')
	})

	it('expires a host pending for 30 days, frees it at Cloudflare and lets the operator retry', async () => {
		const { organization, actor, primary, host } = await pendingPrimary(31)
		const counts = await sweepSiteDomains({ resolver: resolverWith({}) })
		expect(counts.expired).toBeGreaterThanOrEqual(1)
		expect(cloudflare.deleted).toContain(`cf-www.${host}`)
		const [row] = await db
			.select()
			.from(SiteDomain)
			.where(eq(SiteDomain.id, primary.id))
		expect(row).toMatchObject({ status: 'expired', cloudflareHostnameId: null })
		const [org] = await db
			.select({ status: Organization.customDomainStatus })
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		// The name is released: the organization no longer holds it, and it no longer serves.
		expect(org?.status).toBeNull()
		const found = await db
			.select({ id: Organization.id })
			.from(Organization)
			.where(siteHostCondition(`www.${host}`))
		expect(found).toEqual([])
		expect(notices.calls.some((c) => c.kind === 'expired')).toBe(true)

		const again = await retryExpiredDomain({
			organization,
			hostname: `www.${host}`,
			actor,
		})
		expect(again.status).toBe('pending')
	})

	it('lets the organization connect a different primary after its primary expired', async () => {
		const { organization, actor } = await pendingPrimary(31)
		await sweepSiteDomains({ resolver: resolverWith({}) })
		const replacement = uniqueHost()
		const rows = await addSiteDomains({
			organization,
			hostname: replacement,
			primaryForm: 'www',
			mode: 'primary',
			actor,
		})
		expect(rows.map((row) => [row.hostname, row.isPrimary])).toEqual([
			[`www.${replacement}`, true],
			[replacement, false],
		])
		const [org] = await db
			.select({ customDomain: Organization.customDomain })
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(org?.customDomain).toBe(`www.${replacement}`)
	})

	it('releases an expired name for another organization', async () => {
		const { host } = await pendingPrimary(31)
		await sweepSiteDomains({ resolver: resolverWith({}) })
		const other = await setup()
		const rows = await addSiteDomains({
			organization: other.organization,
			hostname: host,
			primaryForm: 'www',
			mode: 'primary',
			actor: other.actor,
		})
		expect(rows.map((row) => row.hostname)).toContain(`www.${host}`)
	})
})

describe('domains connected before SiteDomain existed', () => {
	it('keep serving, and get their row on first read', async () => {
		const { organization } = await setup()
		const host = `legacy-${Date.now()}.example.com`
		await db
			.update(Organization)
			.set({
				customDomain: host,
				customDomainStatus: 'active',
				cloudflareHostnameId: 'cf-legacy',
				sitePublished: true,
			})
			.where(eq(Organization.id, organization.id))

		// No SiteDomain row yet: the public lookup still finds the organization.
		const before = await db
			.select({ id: Organization.id })
			.from(Organization)
			.where(siteHostCondition(host))
		expect(before.map((r) => r.id)).toEqual([organization.id])

		const rows = await ensureSiteDomains(organization.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			hostname: host,
			isPrimary: true,
			status: 'active',
			cloudflareHostnameId: 'cf-legacy',
		})
		expect(await ensureSiteDomains(organization.id)).toHaveLength(1)
	})

	it('lets such a domain be removed through the new model', async () => {
		const { organization, actor } = await setup()
		const host = `legacy-${Date.now()}-b.example.com`
		await db
			.update(Organization)
			.set({
				customDomain: host,
				customDomainStatus: 'active',
				cloudflareHostnameId: 'cf-legacy-b',
			})
			.where(eq(Organization.id, organization.id))
		await removeSiteDomain({ organization, hostname: host, actor })
		const [org] = await db
			.select({ customDomain: Organization.customDomain })
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(org?.customDomain).toBeNull()
		expect(cloudflare.deleted).toContain('cf-legacy-b')
	})
})

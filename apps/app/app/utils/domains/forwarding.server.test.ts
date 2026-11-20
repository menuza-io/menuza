/**
 * #276: forwarding mail to the restaurant's own inbox, only where Menuza
 * manages the DNS, with the typed confirmation over an existing mail provider,
 * one SPF record, and destinations that must confirm first.
 */
import { db, eq, ManagedDomain } from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import { createMockAdapters } from './adapters.mock.server.ts'
import { setDomainAdapters } from './adapters.select.server.ts'
import {
	getMockPublicDns,
	setDnsResolver,
	type DnsResolver,
} from './dns-resolver.server.ts'

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

import { type ForwardingError } from './forwarding.server.ts'

const forwarding = await import('./forwarding.server.ts')
const zone = await import('./zone.server.ts')
const {
	addForward,
	disableForwarding,
	enableForwarding,
	forwardingAvailability,
	isValidLocalPart,
	listForwards,
	MAX_FORWARDS_PER_DOMAIN,
	refreshForwarding,
	removeForward,
} = forwarding

let n = 0
const uniqueApex = () => `fwd-${Date.now()}-${++n}.com`
let adapters: ReturnType<typeof createMockAdapters>

function resolverWith(records: Record<string, string[]>): DnsResolver {
	return async (name, type) =>
		(records[`${type}:${name}`] ?? []).map((data) => ({ type, data }))
}

beforeEach(() => {
	notices.calls.length = 0
	adapters = createMockAdapters(getMockPublicDns())
	setDomainAdapters(adapters)
})
afterEach(() => {
	setDomainAdapters(null)
	setDnsResolver(null)
})

async function managedDomain(options: { mail: boolean; active?: boolean }) {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	const apex = uniqueApex()
	const dns = options.mail
		? {
				[`MX:${apex}`]: ['1 aspmx.l.google.com.'],
				[`TXT:${apex}`]: ['"v=spf1 include:_spf.google.com ~all"'],
			}
		: {}
	const scan = await zone.scanDomain({
		domain: apex,
		resolver: resolverWith(dns),
	})
	const result = await zone.connectByNameservers({
		organization: organization,
		hostname: apex,
		primaryForm: 'www',
		scan,
		emailConfirmation: apex,
		actor: { userId: user.id },
	})
	let domain = result.domain
	if (options.active !== false) {
		adapters.dns.activate(domain.zoneId!)
		const checked = await zone.checkManagedDomain(domain, {
			resolver: resolverWith({
				[`NS:${apex}`]: ['ada.ns.mock-dns.test', 'bob.ns.mock-dns.test'],
			}),
		})
		domain = checked.row
	}
	return { organization, actor: { userId: user.id }, apex, domain }
}

const ctxOf = (m: Awaited<ReturnType<typeof managedDomain>>) => ({
	organizationId: m.organization.id,
	managedDomainId: m.domain.id,
	actor: m.actor,
})

describe('availability', () => {
	it('is only available where Menuza manages the DNS, and says why not', async () => {
		expect(forwardingAvailability(null)).toEqual({
			available: false,
			reason: 'not_managed',
		})
		expect(
			forwardingAvailability({
				zoneId: null,
				zoneStatus: 'none',
				source: 'transferred',
			}),
		).toEqual({ available: false, reason: 'not_managed' })
		expect(
			forwardingAvailability({
				zoneId: 'z',
				zoneStatus: 'moved',
				source: 'nameservers',
			}),
		).toEqual({ available: false, reason: 'not_managed' })
		expect(
			forwardingAvailability({
				zoneId: 'z',
				zoneStatus: 'pending',
				source: 'nameservers',
			}),
		).toEqual({ available: false, reason: 'nameservers_pending' })
		expect(
			forwardingAvailability({
				zoneId: 'z',
				zoneStatus: 'active',
				source: 'nameservers',
			}),
		).toEqual({
			available: true,
		})
		// A domain we registered uses our nameservers from the start.
		expect(
			forwardingAvailability({
				zoneId: 'z',
				zoneStatus: 'pending',
				source: 'registered',
			}),
		).toEqual({
			available: true,
		})
	})

	it('refuses to add an address while the nameservers have not moved', async () => {
		const m = await managedDomain({ mail: false, active: false })
		await expect(
			addForward({
				...ctxOf(m),
				localPart: 'info',
				destination: 'owner@gmail.example',
			}),
		).rejects.toMatchObject({ code: 'nameservers_pending' })
		expect(await listForwards(m.domain.id)).toEqual([])
	})

	it("does not touch another organization's domain", async () => {
		const m = await managedDomain({ mail: false })
		const other = await insertTestUser()
		const otherOrg = await createTestOrganization(other.id, 'admin')
		await expect(
			addForward({
				organizationId: otherOrg.id,
				managedDomainId: m.domain.id,
				localPart: 'info',
				destination: 'owner@gmail.example',
				actor: { userId: other.id },
			}),
		).rejects.toMatchObject({ code: 'not_found' })
	})
})

describe('turning it on', () => {
	it('cannot switch a domain with an existing mail provider without the typed confirmation', async () => {
		const m = await managedDomain({ mail: true })
		const attempt = (mxConfirmation?: string) =>
			enableForwarding({ ...ctxOf(m), mxConfirmation }).catch(
				(error: InstanceType<typeof ForwardingError>) => error,
			)

		const refused = await attempt()
		expect(refused).toMatchObject({ code: 'mx_confirmation_required' })
		expect((refused as InstanceType<typeof ForwardingError>).detail).toEqual([
			expect.objectContaining({ host: 'aspmx.l.google.com' }),
		])
		expect(await attempt('yes')).toMatchObject({
			code: 'mx_confirmation_required',
		})
		// Nothing changed.
		expect(adapters.routing.enabledZones.size).toBe(0)
		const records = await zone.listDomainRecords(m.domain.id)
		expect(
			records.some(
				(r) => r.type === 'MX' && r.content === 'aspmx.l.google.com',
			),
		).toBe(true)

		const enabled = await attempt(m.apex)
		expect(enabled).toMatchObject({
			emailForwardingEnabledAt: expect.any(Date),
		})
		expect(adapters.routing.enabledZones.has(m.domain.zoneId!)).toBe(true)
	})

	it('replaces the old MX records and keeps one SPF record with every sender merged', async () => {
		const m = await managedDomain({ mail: true })
		await enableForwarding({ ...ctxOf(m), mxConfirmation: m.apex })
		const records = await zone.listDomainRecords(m.domain.id)
		const mx = records.filter((r) => r.type === 'MX')
		expect(mx.map((r) => r.content).sort()).toEqual([
			'route1.mock-routing.test',
			'route2.mock-routing.test',
		])
		expect(mx.every((r) => r.managedBy === 'email_forwarding')).toBe(true)
		const spf = records.filter(
			(r) =>
				r.type === 'TXT' && r.name === m.apex && r.content.startsWith('v=spf1'),
		)
		expect(spf).toHaveLength(1)
		expect(spf[0]!.content).toBe(
			'v=spf1 include:_spf.google.com include:_spf.mock-routing.test ~all',
		)
		// The same records are at the provider: the old mailbox is really cut off.
		const remote = await adapters.dns.listRecords(m.domain.zoneId!)
		expect(
			remote.filter((r) => r.type === 'MX').map((r) => r.content),
		).not.toContain('aspmx.l.google.com')
	})

	it('needs no confirmation without mail, and creates the SPF record itself', async () => {
		const m = await managedDomain({ mail: false })
		await enableForwarding(ctxOf(m))
		const spf = (await zone.listDomainRecords(m.domain.id)).filter(
			(r) => r.type === 'TXT' && r.content.startsWith('v=spf1'),
		)
		expect(spf).toHaveLength(1)
		expect(spf[0]).toMatchObject({
			content: 'v=spf1 include:_spf.mock-routing.test ~all',
			managedBy: 'email_forwarding',
		})
	})

	it('turns it back off, removing what it added and the sender from the SPF record', async () => {
		const m = await managedDomain({ mail: true })
		await enableForwarding({ ...ctxOf(m), mxConfirmation: m.apex })
		await addForward({
			...ctxOf(m),
			localPart: 'info',
			destination: 'owner@gmail.example',
		})
		await disableForwarding(ctxOf(m))
		const records = await zone.listDomainRecords(m.domain.id)
		expect(records.some((r) => r.managedBy === 'email_forwarding')).toBe(false)
		expect(
			records.find((r) => r.type === 'TXT' && r.content.startsWith('v=spf1'))!
				.content,
		).toBe('v=spf1 include:_spf.google.com ~all')
		expect(await listForwards(m.domain.id)).toEqual([])
		expect(adapters.routing.rules.size).toBe(0)
		const [row] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.id, m.domain.id))
		expect(row!.emailForwardingEnabledAt).toBeNull()
	})
})

describe('addresses', () => {
	it('forwards mail to a confirmed inbox once the destination confirmed', async () => {
		const m = await managedDomain({ mail: false })
		const row = await addForward({
			...ctxOf(m),
			localPart: 'Info',
			destination: 'Unconfirmed.Owner@gmail.example',
		})
		expect(row).toMatchObject({
			localPart: 'info',
			destination: 'unconfirmed.owner@gmail.example',
			status: 'pending_confirmation',
		})
		// Before the click nothing arrives.
		expect(adapters.routing.deliver(`info@${m.apex}`)).toBeNull()
		expect(adapters.routing.confirmationsSent).toContain(
			'unconfirmed.owner@gmail.example',
		)

		adapters.routing.confirmDestination('unconfirmed.owner@gmail.example')
		const counts = await refreshForwarding(
			(
				await db
					.select()
					.from(ManagedDomain)
					.where(eq(ManagedDomain.id, m.domain.id))
			)[0]!,
		)
		expect(counts.activated).toBe(1)
		const [active] = await listForwards(m.domain.id)
		expect(active).toMatchObject({ status: 'active' })
		expect(active!.providerRuleId).toBeTruthy()

		// Mail to the address arrives in the verified inbox.
		expect(adapters.routing.deliver(`info@${m.apex}`)).toEqual({
			forwardedTo: 'unconfirmed.owner@gmail.example',
		})
		// Other addresses of the domain do not.
		expect(adapters.routing.deliver(`catering@${m.apex}`)).toBeNull()
		// And the last time mail was forwarded is shown after the next look.
		await refreshForwarding(
			(
				await db
					.select()
					.from(ManagedDomain)
					.where(eq(ManagedDomain.id, m.domain.id))
			)[0]!,
		)
		expect(
			(await listForwards(m.domain.id))[0]!.lastForwardedAt,
		).toBeInstanceOf(Date)
	})

	it('starts at once when the destination is already confirmed, and supports a catch-all', async () => {
		const m = await managedDomain({ mail: false })
		const info = await addForward({
			...ctxOf(m),
			localPart: 'info',
			destination: 'owner@gmail.example',
		})
		expect(info.status).toBe('active')
		await addForward({
			...ctxOf(m),
			localPart: '*',
			destination: 'office@gmail.example',
		})
		expect(adapters.routing.deliver(`info@${m.apex}`)).toEqual({
			forwardedTo: 'owner@gmail.example',
		})
		expect(adapters.routing.deliver(`anything@${m.apex}`)).toEqual({
			forwardedTo: 'office@gmail.example',
		})
	})

	it('allows at most 10 addresses and refuses duplicates and bad input', async () => {
		const m = await managedDomain({ mail: false })
		for (let i = 0; i < MAX_FORWARDS_PER_DOMAIN; i += 1) {
			await addForward({
				...ctxOf(m),
				localPart: `box${i}`,
				destination: 'owner@gmail.example',
			})
		}
		const code = (input: { localPart: string; destination: string }) =>
			addForward({ ...ctxOf(m), ...input }).catch(
				(e: InstanceType<typeof ForwardingError>) => e.code,
			)
		expect(
			await code({ localPart: 'one-more', destination: 'owner@gmail.example' }),
		).toBe('limit_reached')
		expect(
			await code({ localPart: 'box1', destination: 'owner@gmail.example' }),
		).toBe('duplicate')
		await removeForward({
			...ctxOf(m),
			forwardId: (await listForwards(m.domain.id))[0]!.id,
		})
		expect(
			await code({
				localPart: 'bad..name',
				destination: 'owner@gmail.example',
			}),
		).toBe('invalid_address')
		expect(await code({ localPart: 'ok', destination: 'not-an-email' })).toBe(
			'invalid_destination',
		)
		expect(await code({ localPart: 'ok', destination: `loop@${m.apex}` })).toBe(
			'destination_on_domain',
		)
		expect(
			await code({ localPart: 'ok', destination: 'a@b.com\nBcc: x@y.com' }),
		).toBe('invalid_destination')
	})

	it('marks an address failing when its destination stops being confirmed, and tells the operator', async () => {
		const m = await managedDomain({ mail: false })
		await addForward({
			...ctxOf(m),
			localPart: 'info',
			destination: 'owner@gmail.example',
		})
		adapters.routing.destinations.get('owner@gmail.example')!.verified = false
		const domain = (
			await db
				.select()
				.from(ManagedDomain)
				.where(eq(ManagedDomain.id, m.domain.id))
		)[0]!
		const counts = await refreshForwarding(domain)
		expect(counts.failing).toBe(1)
		expect((await listForwards(m.domain.id))[0]).toMatchObject({
			status: 'failing',
			lastError: 'destination_unverified',
		})
		expect(notices.calls.some((c) => c.kind === 'forwarding_failing')).toBe(
			true,
		)
	})

	it('removing an address removes its rule at the provider', async () => {
		const m = await managedDomain({ mail: false })
		const row = await addForward({
			...ctxOf(m),
			localPart: 'info',
			destination: 'owner@gmail.example',
		})
		expect(adapters.routing.rules.size).toBe(1)
		await removeForward({ ...ctxOf(m), forwardId: row.id })
		expect(adapters.routing.rules.size).toBe(0)
		expect(adapters.routing.deliver(`info@${m.apex}`)).toBeNull()
	})
})

describe('address rules', () => {
	it('accepts plain local parts and the catch-all only', () => {
		for (const ok of ['info', 'catering', 'a.b', 'sales+web', '*', 'x1'])
			expect(isValidLocalPart(ok)).toBe(true)
		for (const bad of [
			'',
			'.a',
			'a.',
			'a..b',
			'a b',
			'a@b',
			'-a',
			'a'.repeat(65),
			'ä',
		])
			expect(isValidLocalPart(bad)).toBe(false)
	})
})

import { type ZoneRecord } from '@repo/common/domain-zone'
import {
	type DnsZoneProvider,
	type DomainAvailability,
	type DomainConnect,
	type DomainConnectSupport,
	type EmailRoutingProvider,
	type ProviderZone,
	type ProviderZoneRecord,
	type RegistrantContact,
	type Registrar,
	RegistrarError,
	type RegistrarDomainInfo,
	type RoutingDestination,
} from './adapters.server.ts'
import { getMockPublicDns, type MockPublicDns } from './dns-resolver.server.ts'

/**
 * The emulators behind the domain adapters. They keep their state in memory,
 * behave like the real partners in the cases the product has to handle
 * (taken names, failed registrations, locked transfers, unconfirmed
 * destinations), and are what `MOCKS=true` and the unit tests run on.
 */

let counter = 0
const nextId = (prefix: string) => `${prefix}_${++counter}`

// ---------------------------------------------------------------------------
// DNS zones
// ---------------------------------------------------------------------------

export class MockDnsZoneProvider implements DnsZoneProvider {
	readonly name = 'mock-dns'
	readonly zones = new Map<
		string,
		{
			fqdn: string
			status: ProviderZone['status']
			records: ProviderZoneRecord[]
		}
	>()
	/** Zones go live on the first look (local development). */
	autoActivate = false

	isConfigured() {
		return true
	}

	async createZone(fqdn: string): Promise<ProviderZone> {
		const zoneId = nextId('zone')
		this.zones.set(zoneId, { fqdn, status: 'pending', records: [] })
		return {
			zoneId,
			nameservers: ['ada.ns.mock-dns.test', 'bob.ns.mock-dns.test'],
			status: 'pending',
		}
	}

	activate(zoneId: string) {
		const zone = this.zones.get(zoneId)
		if (zone) zone.status = 'active'
	}

	async getZone(zoneId: string): Promise<ProviderZone | null> {
		const zone = this.zones.get(zoneId)
		if (!zone) return null
		if (this.autoActivate && zone.status === 'pending') zone.status = 'active'
		return {
			zoneId,
			nameservers: ['ada.ns.mock-dns.test', 'bob.ns.mock-dns.test'],
			status: zone.status,
		}
	}

	async deleteZone(zoneId: string) {
		this.zones.delete(zoneId)
	}

	async listRecords(zoneId: string) {
		return [...(this.zones.get(zoneId)?.records ?? [])]
	}

	async createRecord(zoneId: string, record: ZoneRecord) {
		const zone = this.zones.get(zoneId)
		if (!zone) throw new Error('zone_not_found')
		const created: ProviderZoneRecord = { ...record, id: nextId('rec') }
		zone.records.push(created)
		return created
	}

	async updateRecord(zoneId: string, recordId: string, record: ZoneRecord) {
		const zone = this.zones.get(zoneId)
		const index =
			zone?.records.findIndex((entry) => entry.id === recordId) ?? -1
		if (!zone || index < 0) throw new Error('record_not_found')
		const updated: ProviderZoneRecord = { ...record, id: recordId }
		zone.records[index] = updated
		return updated
	}

	async deleteRecord(zoneId: string, recordId: string) {
		const zone = this.zones.get(zoneId)
		if (zone)
			zone.records = zone.records.filter((entry) => entry.id !== recordId)
	}
}

// ---------------------------------------------------------------------------
// Registrar
// ---------------------------------------------------------------------------

const MOCK_COST_CENTS: Record<string, number> = {
	com: 1299,
	net: 1499,
	co: 2999,
	menu: 3499,
	restaurant: 3999,
}

type MockDomain = RegistrarDomainInfo & {
	registrarDomainId: string
	authCode: string
	nameservers: string[]
	contact: RegistrantContact | null
}

export class MockRegistrar implements Registrar {
	readonly name = 'mock-registrar'
	readonly domains = new Map<string, MockDomain>()
	readonly calls: Array<{
		method: string
		fqdn?: string
		idempotencyKey?: string
	}> = []
	/** Names the emulator reports as taken, in addition to `taken*` names. */
	readonly taken = new Set<string>()
	/** Registrations that fail (the registry refuses), in addition to `fail*`. */
	readonly failRegistration = new Set<string>()
	/** Renewals that fail. */
	readonly failRenewal = new Set<string>()
	/** The first availability answer of a name says free, the second taken. */
	readonly takenAfterFirstCheck = new Set<string>()
	private readonly checked = new Map<string, number>()

	isConfigured() {
		return true
	}

	private isTaken(fqdn: string) {
		const label = fqdn.split('.')[0] ?? ''
		return (
			this.taken.has(fqdn) ||
			label.startsWith('taken') ||
			this.domains.has(fqdn)
		)
	}

	async checkAvailability(fqdns: string[]): Promise<DomainAvailability[]> {
		return fqdns.map((fqdn) => {
			this.calls.push({ method: 'checkAvailability', fqdn })
			const tld = fqdn.split('.').slice(1).join('.')
			const seen = (this.checked.get(fqdn) ?? 0) + 1
			this.checked.set(fqdn, seen)
			const racedAway = this.takenAfterFirstCheck.has(fqdn) && seen > 1
			const cost = MOCK_COST_CENTS[tld]
			return {
				fqdn,
				available: cost !== undefined && !this.isTaken(fqdn) && !racedAway,
				premium: fqdn.split('.')[0]!.startsWith('premium'),
				costCents: cost ?? 0,
				renewalCostCents: cost ?? 0,
				currency: 'usd',
			}
		})
	}

	async register(input: Parameters<Registrar['register']>[0]) {
		this.calls.push({
			method: 'register',
			fqdn: input.fqdn,
			idempotencyKey: input.idempotencyKey,
		})
		const existing = this.domains.get(input.fqdn)
		// Idempotent: the same key answers with the registration it made.
		if (
			existing &&
			existing.registrarDomainId === `reg_${input.idempotencyKey}`
		) {
			return {
				registrarDomainId: existing.registrarDomainId,
				expiresAt: existing.expiresAt!,
			}
		}
		const label = input.fqdn.split('.')[0] ?? ''
		if (this.failRegistration.has(input.fqdn) || label.startsWith('fail')) {
			throw new RegistrarError('registry_error')
		}
		if (this.isTaken(input.fqdn)) throw new RegistrarError('domain_unavailable')
		const expiresAt = new Date(Date.now() + input.years * 365 * 86_400_000)
		this.domains.set(input.fqdn, {
			fqdn: input.fqdn,
			status: 'active',
			expiresAt,
			autoRenew: input.autoRenew,
			locked: true,
			privacy: input.privacy,
			registrantEmailConfirmed: false,
			registrarDomainId: `reg_${input.idempotencyKey}`,
			authCode: `AUTH-${input.fqdn.length}-${counter}`,
			nameservers: input.nameservers,
			contact: input.contact,
		})
		return { registrarDomainId: `reg_${input.idempotencyKey}`, expiresAt }
	}

	confirmRegistrantEmail(fqdn: string) {
		const domain = this.domains.get(fqdn)
		if (domain) domain.registrantEmailConfirmed = true
	}

	async getDomain(fqdn: string) {
		const domain = this.domains.get(fqdn)
		if (!domain) return null
		return {
			fqdn,
			status: domain.status,
			expiresAt: domain.expiresAt,
			autoRenew: domain.autoRenew,
			locked: domain.locked,
			privacy: domain.privacy,
			registrantEmailConfirmed: domain.registrantEmailConfirmed,
		}
	}

	async setAutoRenew(fqdn: string, autoRenew: boolean) {
		this.calls.push({ method: 'setAutoRenew', fqdn })
		const domain = this.domains.get(fqdn)
		if (domain) domain.autoRenew = autoRenew
	}

	async renew(fqdn: string, years: number, idempotencyKey: string) {
		this.calls.push({ method: 'renew', fqdn, idempotencyKey })
		const domain = this.domains.get(fqdn)
		if (!domain) throw new RegistrarError('provider_error')
		if (this.failRenewal.has(fqdn)) throw new RegistrarError('registry_error')
		domain.expiresAt = new Date(
			(domain.expiresAt?.getTime() ?? Date.now()) + years * 365 * 86_400_000,
		)
		return { expiresAt: domain.expiresAt }
	}

	async getAuthCode(fqdn: string) {
		this.calls.push({ method: 'getAuthCode', fqdn })
		const domain = this.domains.get(fqdn)
		if (!domain) throw new RegistrarError('provider_error')
		return domain.authCode
	}

	async setLock(fqdn: string, locked: boolean) {
		this.calls.push({ method: 'setLock', fqdn })
		const domain = this.domains.get(fqdn)
		if (domain) domain.locked = locked
	}

	async setNameservers(fqdn: string, nameservers: string[]) {
		const domain = this.domains.get(fqdn)
		if (domain) domain.nameservers = nameservers
	}

	async transferIn(input: Parameters<Registrar['transferIn']>[0]) {
		this.calls.push({ method: 'transferIn', fqdn: input.fqdn })
		const label = input.fqdn.split('.')[0] ?? ''
		if (label.startsWith('locked')) throw new RegistrarError('locked')
		if (label.startsWith('new')) throw new RegistrarError('too_new')
		if (input.authCode === 'wrong')
			throw new RegistrarError('invalid_auth_code')
		const registrarDomainId = `reg_${input.idempotencyKey}`
		this.domains.set(input.fqdn, {
			fqdn: input.fqdn,
			status: 'active',
			expiresAt: new Date(Date.now() + 365 * 86_400_000),
			autoRenew: input.autoRenew,
			locked: true,
			privacy: input.privacy,
			registrantEmailConfirmed: true,
			registrarDomainId,
			authCode: `AUTH-T-${counter}`,
			nameservers: [],
			contact: input.contact,
		})
		return { registrarDomainId, status: 'active' as const }
	}

	async resendRegistrantVerification(fqdn: string) {
		this.calls.push({ method: 'resendRegistrantVerification', fqdn })
	}
}

// ---------------------------------------------------------------------------
// Email routing
// ---------------------------------------------------------------------------

type MockRule = {
	ruleId: string
	zoneId: string
	domain: string
	localPart: string
	destination: string
	lastForwardedAt: Date | null
}

export class MockEmailRouting implements EmailRoutingProvider {
	readonly name = 'mock-routing'
	readonly spfInclude = 'include:_spf.mock-routing.test'
	readonly destinations = new Map<string, RoutingDestination>()
	readonly rules = new Map<string, MockRule>()
	readonly enabledZones = new Set<string>()
	readonly confirmationsSent: string[] = []

	isConfigured() {
		return true
	}

	async enable(zoneId: string, domain: string) {
		this.enabledZones.add(zoneId)
		return {
			spfInclude: this.spfInclude,
			records: [
				{
					type: 'MX' as const,
					name: domain,
					content: 'route1.mock-routing.test',
					priority: 10,
				},
				{
					type: 'MX' as const,
					name: domain,
					content: 'route2.mock-routing.test',
					priority: 20,
				},
			],
		}
	}

	async disable(zoneId: string) {
		this.enabledZones.delete(zoneId)
		for (const [id, rule] of this.rules) {
			if (rule.zoneId === zoneId) this.rules.delete(id)
		}
	}

	async addDestination(email: string) {
		const key = email.toLowerCase()
		const existing = this.destinations.get(key)
		if (existing) return existing
		// Addresses that start with `unconfirmed` wait for a click; others are
		// treated as confirmed so local development needs no mailbox.
		const verified = !key.startsWith('unconfirmed')
		const destination = { email: key, verified }
		this.destinations.set(key, destination)
		if (!verified) this.confirmationsSent.push(key)
		return destination
	}

	/** The destination clicked the provider's link. */
	confirmDestination(email: string) {
		const key = email.toLowerCase()
		const destination = this.destinations.get(key)
		if (destination) destination.verified = true
	}

	async getDestination(email: string) {
		return this.destinations.get(email.toLowerCase()) ?? null
	}

	async upsertRule(input: Parameters<EmailRoutingProvider['upsertRule']>[0]) {
		const destination = this.destinations.get(input.destination.toLowerCase())
		if (!destination?.verified) throw new Error('destination_unverified')
		const ruleId = input.ruleId ?? nextId('rule')
		this.rules.set(ruleId, {
			ruleId,
			zoneId: input.zoneId,
			domain: input.domain,
			localPart: input.localPart,
			destination: destination.email,
			lastForwardedAt: this.rules.get(ruleId)?.lastForwardedAt ?? null,
		})
		return { ruleId }
	}

	async removeRule(_zoneId: string, ruleId: string) {
		this.rules.delete(ruleId)
	}

	async lastForwardedAt(_zoneId: string, ruleId: string) {
		return this.rules.get(ruleId)?.lastForwardedAt ?? null
	}

	/**
	 * Mail arrives for `to`. Returns the inbox it is delivered to, or null when
	 * no rule matches, routing is off or the destination never confirmed.
	 * Nothing about the message itself is kept.
	 */
	deliver(to: string): { forwardedTo: string } | null {
		const [localPart = '', domain = ''] = to.toLowerCase().split('@')
		const rules = [...this.rules.values()].filter(
			(rule) => rule.domain === domain,
		)
		if (rules.length === 0) return null
		const rule =
			rules.find((entry) => entry.localPart === localPart) ??
			rules.find((entry) => entry.localPart === '*')
		if (!rule || !this.enabledZones.has(rule.zoneId)) return null
		if (!this.destinations.get(rule.destination)?.verified) return null
		rule.lastForwardedAt = new Date()
		return { forwardedTo: rule.destination }
	}
}

// ---------------------------------------------------------------------------
// Domain Connect
// ---------------------------------------------------------------------------

export class MockDomainConnect implements DomainConnect {
	readonly name = 'mock-domain-connect'
	/** Domains with Domain Connect support; empty means every domain has it. */
	readonly supported = new Set<string>()
	readonly applied: Array<{
		domain: string
		changes: Array<{ type: string; name: string; content: string }>
	}> = []

	constructor(private readonly publicDns: MockPublicDns = getMockPublicDns()) {}

	async discover(domain: string): Promise<DomainConnectSupport | null> {
		if (this.supported.size > 0 && !this.supported.has(domain)) return null
		return {
			providerId: 'mock-registrar',
			providerName: 'Mock Registrar',
			syncUxUrl: 'https://domainconnect.mock-registrar.test',
		}
	}

	async apply(input: Parameters<DomainConnect['apply']>[0]) {
		this.applied.push({ domain: input.domain, changes: input.changes })
		for (const change of input.changes) {
			const type = change.type as 'A' | 'AAAA' | 'CNAME'
			this.publicDns.add(change.name, type, change.content)
		}
		return { kind: 'applied' as const }
	}
}

export function createMockAdapters(
	publicDns: MockPublicDns = getMockPublicDns(),
) {
	return {
		dns: new MockDnsZoneProvider(),
		registrar: new MockRegistrar(),
		routing: new MockEmailRouting(),
		connect: new MockDomainConnect(publicDns),
	}
}

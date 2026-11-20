import { type ZoneRecord } from '@repo/common/domain-zone'

/**
 * The partners behind the domain features, as small adapters so the product
 * behaves the same with a live partner or the local emulator (#313, #283,
 * #183, #276): a DNS zone host, a registrar, an email-routing service and
 * Domain Connect. `getDomainAdapters()` picks the real one when it is
 * configured, the emulator on a local deployment, and tests inject their own.
 */

// ---------------------------------------------------------------------------
// DNS zones (#283, also used by #183 and #276)
// ---------------------------------------------------------------------------

export type ProviderZoneRecord = ZoneRecord & { id: string }

export type ProviderZone = {
	zoneId: string
	nameservers: string[]
	/** `pending` until the registrar points at the nameservers. */
	status: 'pending' | 'active' | 'moved'
}

export interface DnsZoneProvider {
	readonly name: string
	/** Whether the provider can be used in this environment. */
	isConfigured(): boolean
	createZone(fqdn: string): Promise<ProviderZone>
	getZone(zoneId: string): Promise<ProviderZone | null>
	/** Ask the provider to look at the nameservers again. */
	recheckZone?(zoneId: string): Promise<void>
	deleteZone(zoneId: string): Promise<void>
	listRecords(zoneId: string): Promise<ProviderZoneRecord[]>
	createRecord(zoneId: string, record: ZoneRecord): Promise<ProviderZoneRecord>
	updateRecord(
		zoneId: string,
		recordId: string,
		record: ZoneRecord,
	): Promise<ProviderZoneRecord>
	deleteRecord(zoneId: string, recordId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Registrar (#183)
// ---------------------------------------------------------------------------

export type RegistrantContact = {
	firstName: string
	lastName: string
	organization: string
	email: string
	phone: string
	address1: string
	address2?: string
	city: string
	state: string
	postalCode: string
	/** ISO 3166-1 alpha-2. */
	country: string
}

export type DomainAvailability = {
	fqdn: string
	available: boolean
	premium: boolean
	/** What the registrar charges us for one year, in cents. */
	costCents: number
	renewalCostCents: number
	currency: string
}

export type RegistrarDomainInfo = {
	fqdn: string
	status: 'active' | 'pending' | 'expired' | 'transferred_out' | 'unknown'
	expiresAt: Date | null
	autoRenew: boolean
	locked: boolean
	privacy: boolean
	/**
	 * ICANN: the registrant must click the confirmation email. `null` when the
	 * registrar does not report it (the screen then asks the operator).
	 */
	registrantEmailConfirmed: boolean | null
}

export type RegistrarErrorCode =
	| 'domain_unavailable'
	| 'tld_not_supported'
	| 'locked'
	| 'invalid_auth_code'
	| 'too_new'
	| 'transfer_failed'
	| 'registry_error'
	| 'provider_error'

export class RegistrarError extends Error {
	constructor(
		readonly code: RegistrarErrorCode,
		message?: string,
	) {
		super(message ?? code)
		this.name = 'RegistrarError'
	}
}

export interface Registrar {
	readonly name: string
	isConfigured(): boolean
	checkAvailability(fqdns: string[]): Promise<DomainAvailability[]>
	register(input: {
		fqdn: string
		years: number
		contact: RegistrantContact
		privacy: boolean
		autoRenew: boolean
		nameservers: string[]
		idempotencyKey: string
	}): Promise<{ registrarDomainId: string; expiresAt: Date }>
	getDomain(fqdn: string): Promise<RegistrarDomainInfo | null>
	setAutoRenew(fqdn: string, autoRenew: boolean): Promise<void>
	renew(
		fqdn: string,
		years: number,
		idempotencyKey: string,
	): Promise<{ expiresAt: Date }>
	getAuthCode(fqdn: string): Promise<string>
	setLock(fqdn: string, locked: boolean): Promise<void>
	setNameservers(fqdn: string, nameservers: string[]): Promise<void>
	transferIn(input: {
		fqdn: string
		authCode: string
		contact: RegistrantContact
		privacy: boolean
		autoRenew: boolean
		idempotencyKey: string
	}): Promise<{ registrarDomainId: string; status: 'pending' | 'active' }>
	resendRegistrantVerification(fqdn: string): Promise<void>
}

// ---------------------------------------------------------------------------
// Email routing (#276)
// ---------------------------------------------------------------------------

export type RoutingDestination = { email: string; verified: boolean }

export interface EmailRoutingProvider {
	readonly name: string
	/** The SPF mechanism of the provider's sending servers, merged into the domain's one SPF record. */
	readonly spfInclude: string
	isConfigured(): boolean
	/**
	 * Turns routing on for a zone. Returns the records the provider needs in the
	 * zone (MX, SPF) so the App can write them through the zone code.
	 */
	enable(
		zoneId: string,
		domain: string,
	): Promise<{ records: ZoneRecord[]; spfInclude: string }>
	disable(zoneId: string): Promise<void>
	/** Sends the destination's confirmation email (idempotent per address). */
	addDestination(email: string): Promise<RoutingDestination>
	getDestination(email: string): Promise<RoutingDestination | null>
	/** `localPart` is `*` for the catch-all. */
	upsertRule(input: {
		zoneId: string
		domain: string
		localPart: string
		destination: string
		ruleId?: string | null
	}): Promise<{ ruleId: string }>
	removeRule(zoneId: string, ruleId: string, localPart: string): Promise<void>
	/** Present when the provider reports when mail last went through (else the screen says so). */
	lastForwardedAt?(zoneId: string, ruleId: string): Promise<Date | null>
}

// ---------------------------------------------------------------------------
// Domain Connect (#313)
// ---------------------------------------------------------------------------

export type DomainConnectSupport = {
	providerId: string
	providerName: string
	/** The provider's consent screen (urlSyncUX). */
	syncUxUrl: string
}

export interface DomainConnect {
	readonly name: string
	/** Looks the domain's DNS host up for Domain Connect support (public data only). */
	discover(domain: string): Promise<DomainConnectSupport | null>
	/**
	 * Applies the records after the operator approved. A live provider answers
	 * with the consent URL to send the operator to; the emulator applies at once.
	 */
	apply(input: {
		support: DomainConnectSupport
		domain: string
		changes: Array<{ type: string; name: string; content: string }>
		redirectUri: string
		state: string
	}): Promise<{ kind: 'redirect'; url: string } | { kind: 'applied' }>
}

export type DomainAdapters = {
	dns: DnsZoneProvider
	registrar: Registrar
	routing: EmailRoutingProvider
	connect: DomainConnect
}

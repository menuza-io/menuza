/**
 * #183: search with prices and suggestions, buying (re-check before the charge,
 * refund on a failed registration), the site serving on the new domain, renewals
 * and reminders, auto-renew off, and the transfers.
 */
import {
	ConfigFlag,
	db,
	DomainCharge,
	eq,
	ManagedDomain,
	Organization,
	SiteDomain,
} from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import { createMockAdapters } from './adapters.mock.server.ts'
import { setDomainAdapters } from './adapters.select.server.ts'
import { getMockPublicDns, setDnsResolver } from './dns-resolver.server.ts'
import { MockDomainPayments, setDomainPayments } from './payments.server.ts'

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

const registrar = await import('./registrar.server.ts')
const {
	cityFromAddress,
	confirmRegistrantEmail,
	getDomainJobStatus,
	openContact,
	processDueDomainJobs,
	processRegistrationJob,
	processRenewals,
	RegistrarFlowError,
	retailCents,
	searchDomains,
	setAutoRenew,
	startPurchase,
	startTransferIn,
	suggestionLabels,
	transferOut,
} = registrar
void RegistrarFlowError

const contact = {
	firstName: 'Sara',
	lastName: 'Haddad',
	organization: 'Al Bait Restaurant LLC',
	email: 'sara@albait.example',
	phone: '+966 11 555 0100',
	address1: '12 King Fahd Road',
	city: 'Riyadh',
	state: 'Riyadh',
	postalCode: '11564',
	country: 'SA',
}

let n = 0
const uniqueName = () => `buy${Date.now()}x${++n}`
const day = 86_400_000

let adapters: ReturnType<typeof createMockAdapters>
let payments: MockDomainPayments

beforeEach(() => {
	notices.calls.length = 0
	getMockPublicDns().clear()
	adapters = createMockAdapters()
	setDomainAdapters(adapters)
	payments = new MockDomainPayments()
	setDomainPayments(payments)
	setDnsResolver(getMockPublicDns().resolver)
})
afterEach(() => {
	setDomainAdapters(null)
	setDomainPayments(null)
	setDnsResolver(null)
})

async function setup(options: { flag?: boolean } = {}) {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	await db
		.update(Organization)
		.set({ name: 'Al Bait', stripeCustomerId: 'cus_test' })
		.where(eq(Organization.id, organization.id))
	if (options.flag !== false) {
		await db.insert(ConfigFlag).values({
			key: 'domains.registrar',
			value: true,
			level: 'organization',
			organizationId: organization.id,
		})
	}
	return {
		organization: {
			id: organization.id,
			slug: organization.slug,
			name: 'Al Bait',
		},
		actor: { userId: user.id },
	}
}

async function buy(
	ctx: Awaited<ReturnType<typeof setup>>,
	fqdn: string,
	price = retailCents(1299),
) {
	return startPurchase({
		organization: ctx.organization,
		fqdn,
		contact,
		acceptedPriceCents: price,
		actor: ctx.actor,
	})
}

describe('search', () => {
	it('is off without the flag', async () => {
		const ctx = await setup({ flag: false })
		await expect(
			searchDomains({ organizationId: ctx.organization.id, query: 'albait' }),
		).rejects.toMatchObject({
			code: 'feature_off',
		})
	})

	it('shows availability, the yearly price with our markup, and suggestions from the name and city', async () => {
		const ctx = await setup()
		adapters.registrar.taken.add('albait.com')
		const found = await searchDomains({
			organizationId: ctx.organization.id,
			query: 'albait',
			city: 'Riyadh',
		})
		expect(found.results).toEqual([
			expect.objectContaining({
				fqdn: 'albait.com',
				available: false,
				buyable: false,
				priceCents: retailCents(1299),
				currency: 'usd',
				suggestion: false,
			}),
		])
		expect(found.suggestions.map((s) => s.fqdn)).toEqual(
			expect.arrayContaining(['albaitriyadh.com', 'eatalbait.com']),
		)
		expect(
			found.suggestions.every(
				(s) => s.available && s.suggestion && s.priceCents === 1559,
			),
		).toBe(true)
		// A typed extension is searched as typed.
		const typed = await searchDomains({
			organizationId: ctx.organization.id,
			query: 'albait.com',
		})
		expect(typed.results.map((r) => r.fqdn)).toEqual(['albait.com'])
	})

	it('refuses an extension we do not sell, and marks premium names not buyable', async () => {
		const ctx = await setup()
		await expect(
			searchDomains({
				organizationId: ctx.organization.id,
				query: 'albait.sa',
			}),
		).rejects.toMatchObject({ code: 'tld_not_supported' })
		const premium = await searchDomains({
			organizationId: ctx.organization.id,
			query: 'premiumcars',
		})
		expect(premium.results[0]).toMatchObject({
			available: true,
			premium: true,
			buyable: false,
		})
	})

	it('builds suggestions and reads the city from an address', () => {
		expect(suggestionLabels('Al Bait!', 'Riyadh')).toEqual(
			expect.arrayContaining(['albaitriyadh', 'eatalbait', 'albaitmenu']),
		)
		expect(suggestionLabels('!!', null)).toEqual([])
		expect(cityFromAddress('12 King Fahd Rd, Riyadh 11564, Saudi Arabia')).toBe(
			'Riyadh',
		)
		expect(cityFromAddress('no commas')).toBeNull()
	})
})

describe('buying', () => {
	it('registers the domain, serves the site on it with no manual DNS, and tells the operator', async () => {
		const ctx = await setup()
		const fqdn = `${uniqueName()}.com`
		const started = await buy(ctx, fqdn)
		expect(started.amountCents).toBe(1559)
		expect(payments.charges).toHaveLength(1)
		expect(payments.charges[0]).toMatchObject({
			amountCents: 1559,
			currency: 'usd',
		})

		// Registration is a background job with a progress screen.
		expect(
			await getDomainJobStatus(ctx.organization.id, started.jobId),
		).toMatchObject({
			status: 'queued',
			step: 'registering',
			fqdn,
		})
		const counts = await processDueDomainJobs()
		expect(counts.succeeded).toBeGreaterThanOrEqual(1)
		expect(
			await getDomainJobStatus(ctx.organization.id, started.jobId),
		).toMatchObject({
			status: 'succeeded',
			step: 'done',
		})

		const [domain] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.fqdn, fqdn))
		expect(domain).toMatchObject({
			source: 'registered',
			registrationStatus: 'active',
			privacy: true,
			autoRenew: true,
			locked: true,
			registrantEmailConfirmedAt: null,
		})
		expect(domain!.zoneId).toBeTruthy()
		expect(domain!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 300 * day)
		// The registrar got our nameservers and the contact, once.
		const registered = adapters.registrar.domains.get(fqdn)!
		expect(registered.nameservers).toEqual([
			'ada.ns.mock-dns.test',
			'bob.ns.mock-dns.test',
		])
		expect(registered.privacy).toBe(true)
		expect(registered.contact?.organization).toBe('Al Bait Restaurant LLC')
		expect(
			adapters.registrar.calls.filter((c) => c.method === 'register'),
		).toHaveLength(1)

		// The site is attached as the primary host with its records written for it.
		const hosts = await db
			.select()
			.from(SiteDomain)
			.where(eq(SiteDomain.managedDomainId, domain!.id))
		expect(
			hosts.map((h) => [h.hostname, h.isPrimary, h.method]).sort(),
		).toEqual(
			[
				[fqdn, true, 'registered'],
				[`www.${fqdn}`, false, 'registered'],
			].sort(),
		)
		const [org] = await db
			.select({ customDomain: Organization.customDomain })
			.from(Organization)
			.where(eq(Organization.id, ctx.organization.id))
		expect(org?.customDomain).toBe(fqdn)
		const zoneRecords = await adapters.dns.listRecords(domain!.zoneId!)
		expect(
			zoneRecords.map((r) => `${r.type} ${r.name} ${r.content}`).sort(),
		).toEqual(
			[
				`CNAME ${fqdn} sites.menuza.io`,
				`CNAME www.${fqdn} sites.menuza.io`,
			].sort(),
		)
		expect(
			notices.calls.some((c) => c.kind === 'registered' && c.host === fqdn),
		).toBe(true)
	})

	it('keeps the registrant contact encrypted', async () => {
		const ctx = await setup()
		const fqdn = `${uniqueName()}.com`
		await buy(ctx, fqdn)
		const [domain] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.fqdn, fqdn))
		expect(domain!.registrantContact).not.toContain('Al Bait Restaurant')
		expect(domain!.registrantContact).not.toContain('sara@albait.example')
		expect(openContact(domain!.registrantContact)).toEqual(contact)
	})

	it('re-checks availability right before charging: taken in between means no charge', async () => {
		const ctx = await setup()
		const fqdn = `${uniqueName()}.com`
		adapters.registrar.takenAfterFirstCheck.add(fqdn)
		// The operator searched (first answer: free) ...
		await adapters.registrar.checkAvailability([fqdn])
		// ... and someone else bought it before they pressed Buy.
		await expect(buy(ctx, fqdn)).rejects.toMatchObject({
			code: 'domain_unavailable',
		})
		expect(payments.charges).toEqual([])
		expect(
			await db.select().from(ManagedDomain).where(eq(ManagedDomain.fqdn, fqdn)),
		).toEqual([])
	})

	it('asks again when the price moved, and refuses premium names and other extensions', async () => {
		const ctx = await setup()
		await expect(buy(ctx, `${uniqueName()}.com`, 100)).rejects.toMatchObject({
			code: 'price_changed',
		})
		await expect(buy(ctx, 'premiumcars.com')).rejects.toMatchObject({
			code: 'domain_unavailable',
		})
		await expect(buy(ctx, `${uniqueName()}.net`)).rejects.toMatchObject({
			code: 'tld_not_supported',
		})
		await expect(buy(ctx, 'acme.menuza.io')).rejects.toMatchObject({
			code: 'hostname_invalid',
		})
		expect(payments.charges).toEqual([])
	})

	it('needs the flag, a card on file, a valid contact, and a name nobody holds', async () => {
		const off = await setup({ flag: false })
		await expect(buy(off, `${uniqueName()}.com`)).rejects.toMatchObject({
			code: 'feature_off',
		})

		const ctx = await setup()
		payments.cardOnFile = false
		await expect(buy(ctx, `${uniqueName()}.com`)).rejects.toMatchObject({
			code: 'no_card_on_file',
		})
		payments.cardOnFile = true
		await expect(
			startPurchase({
				organization: ctx.organization,
				fqdn: `${uniqueName()}.com`,
				contact: { ...contact, email: 'nope' },
				acceptedPriceCents: 1559,
				actor: ctx.actor,
			}),
		).rejects.toMatchObject({ code: 'invalid_contact' })

		// A domain we registered cannot also be connected by another organization.
		const fqdn = `${uniqueName()}.com`
		await buy(ctx, fqdn)
		const other = await setup()
		await expect(buy(other, fqdn)).rejects.toMatchObject({
			code: 'hostname_taken',
		})
	})

	it('does not register when the card is declined', async () => {
		const ctx = await setup()
		payments.declineNext = true
		const fqdn = `${uniqueName()}.com`
		await expect(buy(ctx, fqdn)).rejects.toMatchObject({
			code: 'card_declined',
		})
		expect(
			adapters.registrar.calls.filter((c) => c.method === 'register'),
		).toEqual([])
		expect(
			await db.select().from(ManagedDomain).where(eq(ManagedDomain.fqdn, fqdn)),
		).toEqual([])
	})

	it('refunds the charge automatically when the registration fails, and frees the name', async () => {
		const ctx = await setup()
		const fqdn = `fail${uniqueName()}.com`
		const started = await buy(ctx, fqdn)
		expect(payments.charges).toHaveLength(1)
		await processRegistrationJob(started.jobId)
		expect(
			await getDomainJobStatus(ctx.organization.id, started.jobId),
		).toMatchObject({
			status: 'failed',
			error: 'registry_error',
			refunded: true,
			fqdn,
		})
		expect(payments.refunds).toEqual([
			{ paymentIntentId: 'pi_mock_1', amountCents: 1559 },
		])
		const [charge] = await db
			.select()
			.from(DomainCharge)
			.where(eq(DomainCharge.jobId, started.jobId))
		expect(charge).toMatchObject({
			status: 'refunded',
			stripeRefundId: 're_mock_1',
		})
		expect(
			await db.select().from(ManagedDomain).where(eq(ManagedDomain.fqdn, fqdn)),
		).toEqual([])
		expect(notices.calls.some((c) => c.kind === 'registration_failed')).toBe(
			true,
		)
		// Nothing is left holding the name, so it can be tried again by anyone.
		await expect(
			startPurchase({
				organization: ctx.organization,
				fqdn: `${uniqueName()}.com`,
				contact,
				acceptedPriceCents: 1559,
				actor: ctx.actor,
			}),
		).resolves.toBeTruthy()
	})

	it('retries a provider that is down, then refunds after five attempts', async () => {
		const ctx = await setup()
		const fqdn = `${uniqueName()}.com`
		const started = await buy(ctx, fqdn)
		vi.spyOn(adapters.registrar, 'register').mockRejectedValue(
			new Error('network'),
		)
		let now = new Date()
		for (let attempt = 1; attempt <= 4; attempt += 1) {
			expect(await processRegistrationJob(started.jobId, { now })).toBe('retry')
			// Not before its delay.
			expect(await processRegistrationJob(started.jobId, { now })).toBe(
				'skipped',
			)
			now = new Date(now.getTime() + 2 * 3_600_000)
		}
		expect(await processRegistrationJob(started.jobId, { now })).toBe('failed')
		expect(payments.refunds).toHaveLength(1)
	})

	it('registers once however many times the job runs', async () => {
		const ctx = await setup()
		const fqdn = `${uniqueName()}.com`
		const started = await buy(ctx, fqdn)
		expect(await processRegistrationJob(started.jobId)).toBe('succeeded')
		expect(await processRegistrationJob(started.jobId)).toBe('skipped')
		expect(
			adapters.registrar.calls.filter((c) => c.method === 'register'),
		).toHaveLength(1)
		expect(payments.charges).toHaveLength(1)
	})

	it('survives a crash after the registrar accepted: the retry does not register or charge again', async () => {
		const ctx = await setup()
		const fqdn = `${uniqueName()}.com`
		const started = await buy(ctx, fqdn)
		// The registrar registered, then the job failed before saving anything.
		await adapters.registrar.register({
			fqdn,
			years: 1,
			contact,
			privacy: true,
			autoRenew: true,
			nameservers: [],
			idempotencyKey: started.jobId,
		})
		adapters.registrar.calls.length = 0
		expect(await processRegistrationJob(started.jobId)).toBe('succeeded')
		expect(
			adapters.registrar.calls.filter((c) => c.method === 'register'),
		).toEqual([])
		expect(payments.charges).toHaveLength(1)
	})

	it('cannot be connected by another organization once we registered it (hostname_taken)', async () => {
		const ctx = await setup()
		const fqdn = `${uniqueName()}.com`
		await processRegistrationJob((await buy(ctx, fqdn)).jobId)
		const other = await setup()
		const { addSiteDomains } = await import('./site-domains.server.ts')
		await expect(
			addSiteDomains({
				organization: other.organization,
				hostname: fqdn,
				primaryForm: 'www',
				mode: 'primary',
				actor: other.actor,
			}),
		).rejects.toMatchObject({ code: 'hostname_taken' })
		const { connectByNameservers, scanDomain } =
			await import('./zone.server.ts')
		await expect(
			connectByNameservers({
				organization: other.organization,
				hostname: fqdn,
				primaryForm: 'www',
				scan: await scanDomain({ domain: fqdn, resolver: async () => [] }),
				actor: other.actor,
			}),
		).rejects.toMatchObject({ code: 'hostname_taken' })
	})

	it('adds a bought domain beside an existing primary instead of replacing it', async () => {
		const ctx = await setup()
		const first = `${uniqueName()}.com`
		await processRegistrationJob((await buy(ctx, first)).jobId)
		const second = `${uniqueName()}.com`
		await processRegistrationJob((await buy(ctx, second)).jobId)
		const [org] = await db
			.select({ customDomain: Organization.customDomain })
			.from(Organization)
			.where(eq(Organization.id, ctx.organization.id))
		expect(org?.customDomain).toBe(first)
		const hosts = await db
			.select()
			.from(SiteDomain)
			.where(eq(SiteDomain.organizationId, ctx.organization.id))
		expect(hosts.filter((h) => h.isPrimary)).toHaveLength(1)
		expect(hosts.map((h) => h.hostname)).toEqual(
			expect.arrayContaining([second, `www.${second}`]),
		)
	})
})

describe('the registrant email', () => {
	it('stays unconfirmed until the registry reports it, and believes the registry over the operator', async () => {
		const ctx = await setup()
		const fqdn = `${uniqueName()}.com`
		const started = await buy(ctx, fqdn)
		await processRegistrationJob(started.jobId)
		const [domain] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.fqdn, fqdn))
		expect(
			await confirmRegistrantEmail({
				organizationId: ctx.organization.id,
				managedDomainId: domain!.id,
			}),
		).toBe(false)
		adapters.registrar.confirmRegistrantEmail(fqdn)
		expect(
			await confirmRegistrantEmail({
				organizationId: ctx.organization.id,
				managedDomainId: domain!.id,
			}),
		).toBe(true)
		const [after] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.id, domain!.id))
		expect(after!.registrantEmailConfirmedAt).not.toBeNull()
	})
})

describe('renewals', () => {
	async function owned(
		daysLeft: number,
		extra: Partial<typeof ManagedDomain.$inferInsert> = {},
	) {
		const ctx = await setup()
		const fqdn = `${uniqueName()}.com`
		await processRegistrationJob((await buy(ctx, fqdn)).jobId)
		const now = new Date()
		const [domain] = await db
			.update(ManagedDomain)
			.set({ expiresAt: new Date(now.getTime() + daysLeft * day), ...extra })
			.where(eq(ManagedDomain.fqdn, fqdn))
			.returning()
		adapters.registrar.domains.get(fqdn)!.expiresAt = domain!.expiresAt
		return { ...ctx, fqdn, domain: domain!, now }
	}

	it('sends reminders 30 and 7 days before, once each', async () => {
		const { domain, now, fqdn } = await owned(29)
		await processRenewals({ now })
		await processRenewals({ now })
		const reminders = () =>
			notices.calls.filter(
				(c) => c.kind === 'renewal_reminder' && c.host === fqdn,
			)
		expect(reminders()).toHaveLength(1)
		expect(String(reminders()[0]!.detail)).toContain('card on file is charged')

		await db
			.update(ManagedDomain)
			.set({ expiresAt: new Date(now.getTime() + 6 * day) })
			.where(eq(ManagedDomain.id, domain.id))
		await processRenewals({ now })
		await processRenewals({ now })
		expect(reminders()).toHaveLength(2)
	})

	it('renews with the card on file near expiry and starts a new term', async () => {
		const { fqdn, domain, now } = await owned(2)
		const before = payments.charges.length
		const result = await processRenewals({ now })
		expect(result.renewed).toBeGreaterThanOrEqual(1)
		expect(payments.charges).toHaveLength(before + 1)
		expect(payments.charges.at(-1)).toMatchObject({
			amountCents: 1559,
			description: `Domain renewal: ${fqdn}`,
		})
		const [after] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.id, domain.id))
		expect(after!.expiresAt!.getTime()).toBeGreaterThan(
			now.getTime() + 360 * day,
		)
		expect(after!.reminders).toBeNull()
		expect(
			adapters.registrar.calls.filter(
				(c) => c.method === 'renew' && c.fqdn === fqdn,
			),
		).toHaveLength(1)
	})

	it('keeps renewing after the Menuza subscription is cancelled', async () => {
		const { domain, organization, now } = await owned(1)
		await db
			.update(Organization)
			.set({ subscriptionStatus: 'canceled' })
			.where(eq(Organization.id, organization.id))
		const result = await processRenewals({ now })
		expect(result.renewed).toBeGreaterThanOrEqual(1)
		const [after] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.id, domain.id))
		expect(after!.expiresAt!.getTime()).toBeGreaterThan(
			now.getTime() + 360 * day,
		)
	})

	it('switching auto-renew off stops the renewal and the charge', async () => {
		const { organization, actor, fqdn, domain, now } = await owned(1)
		await setAutoRenew({
			organizationId: organization.id,
			managedDomainId: domain.id,
			autoRenew: false,
			actor,
		})
		expect(adapters.registrar.domains.get(fqdn)!.autoRenew).toBe(false)
		const before = payments.charges.length
		await processRenewals({ now })
		expect(payments.charges).toHaveLength(before)
		expect(
			adapters.registrar.calls.filter((c) => c.method === 'renew'),
		).toEqual([])
		// The reminder says it will expire instead.
		const reminder = notices.calls.find(
			(c) => c.kind === 'renewal_reminder' && c.host === fqdn,
		)
		expect(String(reminder?.detail)).toContain('Auto-renew is off')
		// Past its date it is expired, not renewed.
		await processRenewals({ now: new Date(now.getTime() + 3 * day) })
		const [after] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.id, domain.id))
		expect(after!.registrationStatus).toBe('expired')
	})

	it('retries a declined card daily for 7 days, then sends urgent emails', async () => {
		const { domain, fqdn, now } = await owned(2)
		payments.declineNext = true
		await processRenewals({ now })
		let [row] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.id, domain.id))
		expect(row!.renewalFailedSince).not.toBeNull()
		expect(
			notices.calls.some((c) => c.kind === 'renewal_failed' && c.host === fqdn),
		).toBe(true)
		const failedAt = row!.renewalFailedSince!

		// The same day: no second attempt.
		const charges = payments.charges.length
		await processRenewals({ now: new Date(now.getTime() + 3_600_000) })
		expect(payments.charges).toHaveLength(charges)

		// Next day the card works again: renewed, failure cleared.
		await processRenewals({ now: new Date(now.getTime() + day + 120_000) })
		;[row] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.id, domain.id))
		expect(row!.renewalFailedSince).toBeNull()
		expect(payments.charges).toHaveLength(charges + 1)
		expect(failedAt.getTime()).toBeLessThanOrEqual(now.getTime())
	})

	it('after 7 days of failures stops charging and sends urgent emails each day', async () => {
		const { domain, fqdn, now } = await owned(1)
		await db
			.update(ManagedDomain)
			.set({
				renewalFailedSince: new Date(now.getTime() - 8 * day),
				renewalAttemptedAt: new Date(now.getTime() - 2 * day),
			})
			.where(eq(ManagedDomain.id, domain.id))
		const charges = payments.charges.length
		const result = await processRenewals({ now })
		expect(result.urgent).toBe(1)
		expect(payments.charges).toHaveLength(charges)
		const urgent = notices.calls.find(
			(c) =>
				c.kind === 'renewal_failed' && String(c.detail).startsWith('URGENT'),
		)
		expect(urgent?.host).toBe(fqdn)
	})
})

describe('transfers', () => {
	it('transfer out unlocks the domain and shows the authorization code', async () => {
		const ctx = await setup()
		const fqdn = `${uniqueName()}.com`
		await processRegistrationJob((await buy(ctx, fqdn)).jobId)
		const [domain] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.fqdn, fqdn))

		// ICANN: not within 60 days of registering.
		await expect(
			transferOut({
				organizationId: ctx.organization.id,
				managedDomainId: domain!.id,
				actor: ctx.actor,
			}),
		).rejects.toMatchObject({ code: 'too_new' })

		const result = await transferOut({
			organizationId: ctx.organization.id,
			managedDomainId: domain!.id,
			now: new Date(Date.now() + 61 * day),
			actor: ctx.actor,
		})
		expect(result.authCode).toBe(adapters.registrar.domains.get(fqdn)!.authCode)
		expect(adapters.registrar.domains.get(fqdn)!.locked).toBe(false)
		const [after] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.id, domain!.id))
		expect(after).toMatchObject({ locked: false, autoRenew: false })
	})

	it('does not offer transfer out for a domain we only host DNS for', async () => {
		const ctx = await setup()
		const [row] = await db
			.insert(ManagedDomain)
			.values({
				organizationId: ctx.organization.id,
				fqdn: `${uniqueName()}.com`,
				source: 'nameservers',
			})
			.returning()
		await expect(
			transferOut({
				organizationId: ctx.organization.id,
				managedDomainId: row!.id,
				actor: ctx.actor,
			}),
		).rejects.toMatchObject({ code: 'not_found' })
	})

	it('transfers a domain in with its code and charges a year', async () => {
		const ctx = await setup()
		const fqdn = `${uniqueName()}.com`
		const result = await startTransferIn({
			organization: ctx.organization,
			fqdn,
			authCode: 'GOOD-CODE',
			contact,
			acceptedPriceCents: 1559,
			actor: ctx.actor,
		})
		expect(result.status).toBe('active')
		const [domain] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.fqdn, fqdn))
		expect(domain).toMatchObject({
			source: 'transferred',
			registrationStatus: 'active',
			zoneStatus: 'none',
		})
		expect(payments.charges.at(-1)).toMatchObject({ amountCents: 1559 })
	})

	it.each([
		['locked', 'GOOD', 'locked'],
		['new', 'GOOD', 'too_new'],
		['any', 'wrong', 'invalid_auth_code'],
	])(
		'fails a %s domain clearly and refunds',
		async (prefix, authCode, code) => {
			const ctx = await setup()
			await expect(
				startTransferIn({
					organization: ctx.organization,
					fqdn: `${prefix}${uniqueName()}.com`,
					authCode,
					contact,
					acceptedPriceCents: 1559,
					actor: ctx.actor,
				}),
			).rejects.toMatchObject({ code })
			expect(payments.refunds).toHaveLength(1)
			expect(payments.refunds[0]).toMatchObject({ amountCents: 1559 })
			// Nothing is left holding the name.
			expect(
				await db
					.select()
					.from(ManagedDomain)
					.where(eq(ManagedDomain.organizationId, ctx.organization.id)),
			).toEqual([])
		},
	)
})

describe('retail price', () => {
	it('adds our markup to the registrar cost', () => {
		expect(retailCents(1299)).toBe(1559)
		expect(retailCents(1000, 0)).toBe(1000)
		expect(retailCents(1000, 50)).toBe(1500)
	})
})

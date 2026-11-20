/**
 * #103: sender name, reply-to verified by a code, the custom sending domain
 * (records, status, fallback and notice), one domain per organization, region
 * change, and what the region is told.
 */
import {
	ConfigFlag,
	db,
	DomainRecord,
	eq,
	ManagedDomain,
	Organization,
	OrganizationEmailSender,
} from '@repo/database'
import type * as EmailModule from '@repo/email'
import {
	getMockEmailDomainProvider,
	MockEmailDomainProvider,
} from '@repo/email'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockAdapters } from '#app/utils/domains/adapters.mock.server.ts'
import {
	getMockDomainAdapters,
	setDomainAdapters,
} from '#app/utils/domains/adapters.select.server.ts'
import {
	getMockPublicDns,
	setDnsResolver,
} from '#app/utils/domains/dns-resolver.server.ts'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import {
	mockSenderDomainClient,
	setSenderDomainClient,
} from './node-client.server.ts'

const mail = vi.hoisted(() => ({
	sent: [] as Array<{
		to: string
		subject: string
		react: { props: Record<string, unknown> }
	}>,
}))
vi.mock('@repo/email', async (importOriginal) => {
	const actual = await importOriginal<typeof EmailModule>()
	return {
		...actual,
		sendEmail: vi.fn(async (input: (typeof mail.sent)[number]) => {
			mail.sent.push(input)
			return { status: 'success', data: { id: 'mail_1' } }
		}),
	}
})
const notices = vi.hoisted(() => ({
	calls: [] as Array<Record<string, unknown>>,
}))
vi.mock('#app/utils/domains/notify.server.ts', () => ({
	notifyDomainEvent: vi.fn(async (input: Record<string, unknown>) => {
		notices.calls.push(input)
		return 1
	}),
}))
vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return { ...actual, purgeOrganizationSiteCache: vi.fn(async () => true) }
})

const sender = await import('./sender.server.ts')
const {
	buildEmailIdentity,
	checkSenderDomain,
	clearReplyTo,
	parseStoredRecords,
	REPLY_TO_MAX_ATTEMPTS,
	removeSenderDomain,
	requestReplyToCode,
	resetSenderDomainForRegionChange,
	saveSenderName,
	senderView,
	SenderFlowError,
	startSenderDomain,
	sweepSenderDomains,
	verifyReplyToCode,
} = sender

const publicDns = getMockPublicDns()
const provider = getMockEmailDomainProvider()
let n = 0
const uniqueDomain = () => `send-${Date.now()}-${++n}.com`

beforeEach(() => {
	mail.sent.length = 0
	notices.calls.length = 0
	publicDns.clear()
	provider.dns.clear()
	setDnsResolver(publicDns.resolver)
	setSenderDomainClient(mockSenderDomainClient)
})
afterEach(() => {
	setDnsResolver(null)
	setSenderDomainClient(null)
	setDomainAdapters(null)
	vi.useRealTimers()
})

async function setup(options: { flag?: boolean } = {}) {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	await db
		.update(Organization)
		.set({ name: 'Al Bait' })
		.where(eq(Organization.id, organization.id))
	if (options.flag !== false) {
		await db.insert(ConfigFlag).values({
			key: 'messaging.custom_sender',
			value: true,
			level: 'organization',
			organizationId: organization.id,
		})
	}
	return { organization: { id: organization.id, name: 'Al Bait' } }
}

/** Puts every record of the sending domain into the emulated DNS, as the operator would. */
async function publish(organizationId: string) {
	const row = (
		await db
			.select()
			.from(OrganizationEmailSender)
			.where(eq(OrganizationEmailSender.organizationId, organizationId))
	)[0]!
	for (const record of parseStoredRecords(row)) {
		const type = record.type as 'TXT' | 'CNAME' | 'MX'
		publicDns.add(
			record.name,
			type,
			record.type === 'TXT' ? `"${record.value}"` : record.value,
		)
		provider.dns.add(MockEmailDomainProvider.recordKey(record))
	}
}

describe('sender name', () => {
	it('saves a name, defaults to none, and refuses header-injection attempts', async () => {
		const { organization } = await setup()
		expect(
			(await saveSenderName(organization.id, '  Acme Pizza ')).senderName,
		).toBe('Acme Pizza')
		expect((await saveSenderName(organization.id, '')).senderName).toBeNull()
		for (const bad of [
			'Acme <x@y.com>',
			'Acme\r\nBcc: x@y.com',
			'a@b',
			'x'.repeat(65),
		]) {
			await expect(saveSenderName(organization.id, bad)).rejects.toMatchObject({
				code: 'invalid_sender_name',
			})
		}
		expect((await senderView(organization.id)).senderName).toBeNull()
	})
})

describe('reply-to', () => {
	function lastCode() {
		return String((mail.sent.at(-1)!.react.props as { code: string }).code)
	}

	it('is used only after the code sent to that address was entered', async () => {
		const { organization } = await setup()
		await requestReplyToCode({
			organization,
			address: 'Owner@AlRestaurant.com',
		})
		expect(mail.sent).toHaveLength(1)
		expect(mail.sent[0]!.to).toBe('owner@alrestaurant.com')
		expect(lastCode()).toMatch(/^\d{6}$/u)
		// Not yet used: the region is told nothing.
		expect(await buildEmailIdentity(organization.id)).toMatchObject({
			replyTo: null,
		})
		await expect(
			verifyReplyToCode({ organizationId: organization.id, code: '000000' }),
		).rejects.toMatchObject({ code: 'code_invalid' })

		const row = await verifyReplyToCode({
			organizationId: organization.id,
			code: lastCode(),
		})
		expect(row).toMatchObject({
			replyTo: 'owner@alrestaurant.com',
			pendingReplyTo: null,
		})
		expect(await buildEmailIdentity(organization.id)).toMatchObject({
			replyTo: 'owner@alrestaurant.com',
		})
	})

	it('keeps the old verified address until the new one is proven (changing re-verifies)', async () => {
		const { organization } = await setup()
		await requestReplyToCode({ organization, address: 'old@alrestaurant.com' })
		await verifyReplyToCode({
			organizationId: organization.id,
			code: lastCode(),
		})
		await requestReplyToCode({
			organization,
			address: 'new@alrestaurant.com',
			now: new Date(Date.now() + 120_000),
		})
		expect((await buildEmailIdentity(organization.id))?.replyTo).toBe(
			'old@alrestaurant.com',
		)
		await verifyReplyToCode({
			organizationId: organization.id,
			code: lastCode(),
		})
		expect((await buildEmailIdentity(organization.id))?.replyTo).toBe(
			'new@alrestaurant.com',
		)
		await clearReplyTo(organization.id)
		expect((await buildEmailIdentity(organization.id))?.replyTo).toBeNull()
	})

	it('expires, limits attempts, and limits how fast codes are sent', async () => {
		const { organization } = await setup()
		const now = new Date()
		await requestReplyToCode({
			organization,
			address: 'owner@alrestaurant.com',
			now,
		})
		await expect(
			requestReplyToCode({
				organization,
				address: 'owner@alrestaurant.com',
				now,
			}),
		).rejects.toMatchObject({ code: 'resend_too_soon' })
		await expect(
			verifyReplyToCode({
				organizationId: organization.id,
				code: lastCode(),
				now: new Date(now.getTime() + 16 * 60_000),
			}),
		).rejects.toMatchObject({ code: 'code_expired' })

		await requestReplyToCode({
			organization,
			address: 'owner@alrestaurant.com',
			now: new Date(now.getTime() + 120_000),
		})
		const right = lastCode()
		for (let i = 0; i < REPLY_TO_MAX_ATTEMPTS; i += 1) {
			await expect(
				verifyReplyToCode({ organizationId: organization.id, code: '1' }),
			).rejects.toMatchObject({ code: 'code_invalid' })
		}
		// Even the right code is refused after too many wrong ones.
		await expect(
			verifyReplyToCode({ organizationId: organization.id, code: right }),
		).rejects.toMatchObject({ code: 'too_many_attempts' })
	})

	it('refuses anything but a single plain address, and sends no email for it', async () => {
		const { organization } = await setup()
		for (const bad of [
			'nope',
			'a@b.com, c@d.com',
			'a@b.com\nBcc: x@y.com',
			'Name <a@b.com>',
		]) {
			await expect(
				requestReplyToCode({ organization, address: bad }),
			).rejects.toMatchObject({ code: 'invalid_reply_to' })
		}
		expect(mail.sent).toEqual([])
	})
})

describe('the custom sending domain', () => {
	it('is off without the flag, and checks the domain and local part', async () => {
		const off = await setup({ flag: false })
		await expect(
			startSenderDomain({
				organization: off.organization,
				domain: uniqueDomain(),
			}),
		).rejects.toMatchObject({ code: 'feature_off' })
		const { organization } = await setup()
		await expect(
			startSenderDomain({ organization, domain: 'nope' }),
		).rejects.toMatchObject({ code: 'invalid_domain' })
		await expect(
			startSenderDomain({
				organization,
				domain: uniqueDomain(),
				localPart: 'Bad Part',
			}),
		).rejects.toMatchObject({ code: 'invalid_local_part' })
	})

	it('shows SPF, DKIM and return-path records as Pending, then Verified when they are in DNS', async () => {
		const { organization } = await setup()
		const domain = uniqueDomain()
		const started = await startSenderDomain({ organization, domain })
		expect(started.row).toMatchObject({
			domain,
			localPart: 'hello',
			domainStatus: 'pending',
		})
		const view = await senderView(organization.id)
		expect(
			view.records.filter((r) => r.required).map((r) => [r.purpose, r.type]),
		).toEqual([
			['spf', 'TXT'],
			['dkim', 'CNAME'],
			['return_path', 'CNAME'],
		])
		expect(view.records.every((r) => r.found === false)).toBe(true)
		expect(view.managedDns).toBe(false)
		// Until verified the region still sends from the platform address.
		expect((await buildEmailIdentity(organization.id))?.fromEmail).toBeNull()

		await publish(organization.id)
		const checked = await checkSenderDomain({ organizationId: organization.id })
		expect(checked.domainStatus).toBe('verified')
		expect(
			parseStoredRecords(checked)
				.filter((r) => r.required)
				.every((r) => r.found),
		).toBe(true)
		expect(await buildEmailIdentity(organization.id)).toMatchObject({
			fromEmail: `hello@${domain}`,
		})
	})

	it('stays Pending while a record is missing, showing which one', async () => {
		const { organization } = await setup()
		const domain = uniqueDomain()
		await startSenderDomain({ organization, domain })
		const row = (
			await db
				.select()
				.from(OrganizationEmailSender)
				.where(eq(OrganizationEmailSender.organizationId, organization.id))
		)[0]!
		const spf = parseStoredRecords(row).find((r) => r.purpose === 'spf')!
		publicDns.add(spf.name, 'TXT', `"${spf.value}"`)
		provider.dns.add(MockEmailDomainProvider.recordKey(spf))
		const checked = await checkSenderDomain({ organizationId: organization.id })
		expect(checked.domainStatus).toBe('pending')
		expect(
			parseStoredRecords(checked).map((r) => [r.purpose, r.found]),
		).toEqual([
			['spf', true],
			['dkim', false],
			['return_path', false],
			['dmarc', false],
		])
	})

	it('accepts an SPF record that already lists other senders', async () => {
		const { organization } = await setup()
		const domain = uniqueDomain()
		await startSenderDomain({ organization, domain })
		await publish(organization.id)
		publicDns.set(domain, 'TXT', [
			'"v=spf1 include:_spf.google.com include:rp.mock-email.test -all"',
		])
		expect(
			(await checkSenderDomain({ organizationId: organization.id }))
				.domainStatus,
		).toBe('verified')
	})

	it('writes the records itself when Menuza already manages the domain DNS', async () => {
		const adapters = createMockAdapters(publicDns)
		setDomainAdapters(adapters)
		const { organization } = await setup()
		const domain = uniqueDomain()
		const zone = await adapters.dns.createZone(domain)
		await db.insert(ManagedDomain).values({
			organizationId: organization.id,
			fqdn: domain,
			source: 'nameservers',
			zoneId: zone.zoneId,
			zoneStatus: 'active',
		})
		const started = await startSenderDomain({ organization, domain })
		expect(started.wroteToZone).toBe(true)
		const [managed] = await db
			.select()
			.from(ManagedDomain)
			.where(eq(ManagedDomain.fqdn, domain))
		const rows = await db
			.select()
			.from(DomainRecord)
			.where(eq(DomainRecord.managedDomainId, managed!.id))
		expect(rows.every((r) => r.managedBy === 'email_sending')).toBe(true)
		expect(rows.map((r) => r.type).sort()).toEqual([
			'CNAME',
			'CNAME',
			'TXT',
			'TXT',
		])
		expect((await senderView(organization.id)).managedDns).toBe(true)

		// Removing the domain takes the records out again.
		await removeSenderDomain(organization.id)
		expect(
			await db
				.select()
				.from(DomainRecord)
				.where(eq(DomainRecord.managedDomainId, managed!.id)),
		).toEqual([])
		expect((await senderView(organization.id)).domainStatus).toBe('none')
	})

	it('merges its SPF into the one SPF record a managed zone already has', async () => {
		const adapters = createMockAdapters(publicDns)
		setDomainAdapters(adapters)
		const { organization } = await setup()
		const domain = uniqueDomain()
		const zone = await adapters.dns.createZone(domain)
		const [managed] = await db
			.insert(ManagedDomain)
			.values({
				organizationId: organization.id,
				fqdn: domain,
				source: 'nameservers',
				zoneId: zone.zoneId,
				zoneStatus: 'active',
			})
			.returning()
		await db
			.insert(DomainRecord)
			.values({
				managedDomainId: managed!.id,
				type: 'TXT',
				name: domain,
				content: 'v=spf1 include:_spf.google.com ~all',
				source: 'imported',
			})
		await startSenderDomain({ organization, domain })
		const spf = (
			await db
				.select()
				.from(DomainRecord)
				.where(eq(DomainRecord.managedDomainId, managed!.id))
		).filter((r) => r.type === 'TXT' && r.content.startsWith('v=spf1'))
		expect(spf).toHaveLength(1)
		expect(spf[0]!.content).toBe(
			'v=spf1 include:_spf.google.com include:rp.mock-email.test ~all',
		)
	})

	it('allows one domain per organization: a domain used elsewhere is refused, a new one replaces the old', async () => {
		const first = await setup()
		const domain = uniqueDomain()
		await startSenderDomain({ organization: first.organization, domain })
		const second = await setup()
		await expect(
			startSenderDomain({ organization: second.organization, domain }),
		).rejects.toMatchObject({ code: 'domain_in_use' })

		const replacement = uniqueDomain()
		const before = provider.registered.size
		await startSenderDomain({
			organization: first.organization,
			domain: replacement,
		})
		expect((await senderView(first.organization.id)).domain).toBe(replacement)
		// The old registration at the provider was removed.
		expect(provider.registered.size).toBe(before)
	})

	it('falls back to the platform address and tells the operator when the records go away', async () => {
		const { organization } = await setup()
		const domain = uniqueDomain()
		await startSenderDomain({ organization, domain })
		await publish(organization.id)
		await checkSenderDomain({ organizationId: organization.id })
		expect((await buildEmailIdentity(organization.id))?.fromEmail).toBe(
			`hello@${domain}`,
		)

		// The operator (or their registrar) removes the DKIM record.
		const row = (
			await db
				.select()
				.from(OrganizationEmailSender)
				.where(eq(OrganizationEmailSender.organizationId, organization.id))
		)[0]!
		const dkim = parseStoredRecords(row).find((r) => r.purpose === 'dkim')!
		publicDns.remove(dkim.name, 'CNAME')
		const next = new Date(Date.now() + 25 * 3_600_000)
		const counts = await sweepSenderDomains({ now: next })
		expect(counts.failed).toBeGreaterThanOrEqual(1)
		const view = await senderView(organization.id)
		expect(view.domainStatus).toBe('failed')
		// The region now sends from the platform address, with the name and reply-to still applied.
		expect((await buildEmailIdentity(organization.id))?.fromEmail).toBeNull()
		const told = () =>
			notices.calls.filter(
				(c) =>
					c.kind === 'sender_fallback' && c.organizationId === organization.id,
			)
		expect(told()).toHaveLength(1)
		expect(told()[0]).toMatchObject({ host: domain })
		// Told once, however often it is checked.
		await sweepSenderDomains({ now: new Date(next.getTime() + 25 * 3_600_000) })
		expect(told()).toHaveLength(1)

		// Fixing the records and re-checking brings it back.
		publicDns.add(dkim.name, 'CNAME', dkim.value)
		const rechecked = await checkSenderDomain({
			organizationId: organization.id,
		})
		expect(rechecked.domainStatus).toBe('verified')
		expect((await buildEmailIdentity(organization.id))?.fromEmail).toBe(
			`hello@${domain}`,
		)
	})

	it('does not use the domain when the feature is switched off, even if verified', async () => {
		const { organization } = await setup()
		await startSenderDomain({ organization, domain: uniqueDomain() })
		await publish(organization.id)
		await checkSenderDomain({ organizationId: organization.id })
		await db
			.delete(ConfigFlag)
			.where(eq(ConfigFlag.organizationId, organization.id))
		expect((await buildEmailIdentity(organization.id))?.fromEmail).toBeNull()
	})

	it('needs re-verification after a data region change', async () => {
		const { organization } = await setup()
		const domain = uniqueDomain()
		await startSenderDomain({ organization, domain })
		await publish(organization.id)
		await checkSenderDomain({ organizationId: organization.id })
		expect((await buildEmailIdentity(organization.id))?.fromEmail).toBe(
			`hello@${domain}`,
		)

		await db
			.update(Organization)
			.set({ dataRegion: 'ksa' })
			.where(eq(Organization.id, organization.id))
		// Until the reset the old region's verification no longer counts for the new region.
		expect((await buildEmailIdentity(organization.id))?.fromEmail).toBeNull()
		const registration = await resetSenderDomainForRegionChange(
			organization.id,
			'ksa',
		)
		expect(registration).not.toBeNull()
		const view = await senderView(organization.id)
		expect(view).toMatchObject({ domain, domainStatus: 'pending' })
		expect(
			view.records.filter((r) => r.required).every((r) => r.found === false),
		).toBe(true)
		expect((await buildEmailIdentity(organization.id))?.fromEmail).toBeNull()
		// The new records verify the domain in the new region.
		provider.dns.clear()
		publicDns.clear()
		await publish(organization.id)
		expect(
			(await checkSenderDomain({ organizationId: organization.id }))
				.domainStatus,
		).toBe('verified')
		expect((await buildEmailIdentity(organization.id))?.fromEmail).toBe(
			`hello@${domain}`,
		)
	})
})

describe('what the region is told', () => {
	it('is nothing until something is set, then only business identity', async () => {
		const { organization } = await setup()
		expect(await buildEmailIdentity(organization.id)).toBeNull()
		await saveSenderName(organization.id, 'Acme Pizza')
		expect(await buildEmailIdentity(organization.id)).toEqual({
			senderName: 'Acme Pizza',
			replyTo: null,
			fromEmail: null,
		})
		expect(SenderFlowError).toBeTruthy()
		void getMockDomainAdapters
	})
})

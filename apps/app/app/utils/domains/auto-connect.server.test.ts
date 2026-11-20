/**
 * #313: connect automatically (after approval, never email records) and send
 * the steps to someone else.
 */
import { db, eq, SiteDomain } from '@repo/database'
import type * as EmailModule from '@repo/email'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import { createTestOrganization } from '#tests/test-utils.ts'
import { createMockAdapters } from './adapters.mock.server.ts'
import { setDomainAdapters } from './adapters.select.server.ts'
import { getMockPublicDns, setDnsResolver } from './dns-resolver.server.ts'

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
vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return { ...actual, purgeOrganizationSiteCache: vi.fn(async () => true) }
})
vi.mock('./notify.server.ts', () => ({
	notifyDomainEvent: vi.fn(async () => 1),
}))

const {
	approveAutoConnect,
	AutoConnectError,
	planAutoConnect,
	sendDomainInstructions,
	InstructionsError,
} = await import('./auto-connect.server.ts')

let n = 0
const uniqueApex = () => `auto-${Date.now()}-${++n}.com`

let adapters: ReturnType<typeof createMockAdapters>
const publicDns = getMockPublicDns()

beforeEach(() => {
	publicDns.clear()
	mail.sent.length = 0
	adapters = createMockAdapters(publicDns)
	setDomainAdapters(adapters)
	setDnsResolver(publicDns.resolver)
})
afterEach(() => {
	setDnsResolver(null)
	setDomainAdapters(null)
})

function seedMail(apex: string) {
	publicDns.set(apex, 'MX', ['1 aspmx.l.google.com.'])
	publicDns.set(apex, 'TXT', ['"v=spf1 include:_spf.google.com ~all"'])
	publicDns.set(`_dmarc.${apex}`, 'TXT', ['"v=DMARC1; p=none"'])
	publicDns.set(apex, 'NS', [
		'ns41.domaincontrol.com.',
		'ns42.domaincontrol.com.',
	])
}

async function org() {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	return { organization, actor: { userId: user.id } }
}

describe('planAutoConnect', () => {
	it('shows every change first: routing records only', async () => {
		const apex = uniqueApex()
		seedMail(apex)
		const planned = await planAutoConnect({
			hostname: apex,
			primaryForm: 'www',
		})
		expect(planned?.plan.providerName).toBe('Mock Registrar')
		// GoDaddy has no ALIAS at the root and no addresses are configured: the root is skipped.
		expect(planned?.plan.changes).toEqual([
			{
				action: 'add',
				type: 'CNAME',
				name: `www.${apex}`,
				content: 'sites.menuza.io',
			},
		])
		expect(planned?.plan.rootSkipped).toBe(true)
	})

	it('answers null where the DNS host does not support it', async () => {
		adapters.connect.supported.add('other.com')
		expect(
			await planAutoConnect({ hostname: uniqueApex(), primaryForm: 'www' }),
		).toBeNull()
	})
})

describe('approveAutoConnect', () => {
	it('sets the records after approval and leaves the mail records untouched', async () => {
		const { organization, actor } = await org()
		const apex = uniqueApex()
		seedMail(apex)
		const before = {
			mx: await publicDns.resolver(apex, 'MX'),
			txt: await publicDns.resolver(apex, 'TXT'),
			dmarc: await publicDns.resolver(`_dmarc.${apex}`, 'TXT'),
		}
		const result = await approveAutoConnect({
			organization,
			hostname: apex,
			primaryForm: 'www',
			actor,
			redirectUri: 'https://app.menuza.test/x',
		})
		expect(result.kind).toBe('applied')
		expect(adapters.connect.applied).toHaveLength(1)
		expect(
			adapters.connect.applied[0]!.changes.every((c) =>
				['CNAME', 'A', 'AAAA'].includes(c.type),
			),
		).toBe(true)
		// The records now answer, and the mail records are exactly as they were.
		expect(
			(await publicDns.resolver(`www.${apex}`, 'CNAME')).map((a) => a.data),
		).toEqual(['sites.menuza.io'])
		expect(await publicDns.resolver(apex, 'MX')).toEqual(before.mx)
		expect(await publicDns.resolver(apex, 'TXT')).toEqual(before.txt)
		expect(await publicDns.resolver(`_dmarc.${apex}`, 'TXT')).toEqual(
			before.dmarc,
		)
		const rows = await db
			.select()
			.from(SiteDomain)
			.where(eq(SiteDomain.organizationId, organization.id))
		expect(rows.map((r) => r.hostname).sort()).toEqual(
			[apex, `www.${apex}`].sort(),
		)
	})

	it('refuses where it is not supported, creating nothing', async () => {
		const { organization, actor } = await org()
		adapters.connect.supported.add('other.com')
		await expect(
			approveAutoConnect({
				organization,
				hostname: uniqueApex(),
				primaryForm: 'www',
				actor,
				redirectUri: 'https://x.test',
			}),
		).rejects.toBeInstanceOf(AutoConnectError)
		expect(
			await db
				.select()
				.from(SiteDomain)
				.where(eq(SiteDomain.organizationId, organization.id)),
		).toEqual([])
	})
})

describe('sendDomainInstructions', () => {
	it('emails the records and the provider steps to a third person', async () => {
		const apex = uniqueApex()
		publicDns.set(apex, 'NS', ['ns41.domaincontrol.com.'])
		const result = await sendDomainInstructions({
			organizationName: 'Al Bait',
			requestedBy: 'Sara',
			hostname: apex,
			primaryForm: 'www',
			to: 'it-guy@example.org',
			registrarLookup: async () => 'GoDaddy.com, LLC',
		})
		expect(result).toEqual({ sent: true, provider: 'godaddy' })
		expect(mail.sent).toHaveLength(1)
		const message = mail.sent[0]!
		expect(message.to).toBe('it-guy@example.org')
		expect(message.subject).toBe(`Please connect ${apex} to Al Bait's website`)
		const props = message.react.props as {
			steps: string[]
			records: string[]
			providerName: string
			requestedBy: string
		}
		expect(props.providerName).toBe('GoDaddy')
		expect(props.requestedBy).toBe('Sara')
		expect(props.steps.join('\n')).toContain('My Products > Domains > DNS')
		expect(props.steps.join('\n')).toContain(
			'Do not change or delete any MX or TXT records',
		)
		expect(props.records).toContain(`CNAME www.${apex} sites.menuza.io`)
	})

	it('refuses anything that is not a single plain address', async () => {
		for (const to of [
			'not-an-email',
			'a@b.com\nBcc: x@y.com',
			'a@b.com, c@d.com',
			'<a@b.com>',
			'',
		]) {
			await expect(
				sendDomainInstructions({
					organizationName: 'Al Bait',
					requestedBy: 'Sara',
					hostname: uniqueApex(),
					primaryForm: 'www',
					to,
				}),
			).rejects.toBeInstanceOf(InstructionsError)
		}
		expect(mail.sent).toEqual([])
	})
})

import {
	db,
	eq,
	Organization,
	OrganizationInvitation,
	UserOrganization,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { consoleError } from '#tests/setup/setup-test-env.ts'
import { createTestUser, setupTestOrgWithUser } from '#tests/test-utils.ts'
import {
	checkDomainClaim,
	domainVerificationRecordName,
	inviteExistingDomainUsers,
	isDomainClaimedElsewhere,
	lookupTxtRecords,
	startDomainClaim,
} from './verified-domain.server.ts'

vi.mock('./invitation.server.ts', async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	sendOrganizationInvitationEmail: vi.fn().mockResolvedValue(undefined),
}))

function dnsAnswer(values: string[]) {
	return vi.fn(async () =>
		Response.json({
			Answer: values.map((value) => ({ type: 16, data: `"${value}"` })),
		}),
	) as unknown as typeof fetch
}

function uniqueDomain() {
	return `corp-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.test`
}

describe('verified domain proof', () => {
	it('a claim changes nothing until the TXT record is there', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const domain = uniqueDomain()
		const claim = await startDomainClaim(organization.id, domain)
		expect(claim.recordName).toBe(domainVerificationRecordName(domain))

		const missing = await checkDomainClaim(
			organization.id,
			dnsAnswer(['other']),
		)
		expect(missing.status).toBe('not_found')
		const [row] = await db
			.select({ verifiedDomain: Organization.verifiedDomain })
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(row!.verifiedDomain).toBeNull()

		const found = await checkDomainClaim(
			organization.id,
			dnsAnswer([claim.recordValue]),
		)
		expect(found).toEqual({ status: 'verified', domain })
		const [after] = await db
			.select({
				verifiedDomain: Organization.verifiedDomain,
				provedAt: Organization.verifiedDomainProvedAt,
				pending: Organization.pendingVerifiedDomain,
			})
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(after).toMatchObject({ verifiedDomain: domain, pending: null })
		expect(after!.provedAt).toBeInstanceOf(Date)
	})

	it('claiming the pending domain again keeps its token', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const domain = uniqueDomain()
		const first = await startDomainClaim(organization.id, domain)
		const again = await startDomainClaim(organization.id, domain)
		expect(again.recordValue).toBe(first.recordValue)

		const other = await startDomainClaim(organization.id, uniqueDomain())
		expect(other.recordValue).not.toBe(first.recordValue)
	})

	it('does not verify a claim that changed during the DNS lookup', async () => {
		const { organization } = await setupTestOrgWithUser('admin')
		const domain = uniqueDomain()
		const claim = await startDomainClaim(organization.id, domain)
		const nextDomain = uniqueDomain()
		const lookup = vi.fn(async () => {
			// An admin claims another domain while the lookup is in flight.
			await startDomainClaim(organization.id, nextDomain)
			return Response.json({
				Answer: [{ type: 16, data: `"${claim.recordValue}"` }],
			})
		}) as unknown as typeof fetch

		expect(await checkDomainClaim(organization.id, lookup)).toEqual({
			status: 'no_claim',
		})
		const [row] = await db
			.select({
				verifiedDomain: Organization.verifiedDomain,
				pending: Organization.pendingVerifiedDomain,
			})
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(row).toEqual({ verifiedDomain: null, pending: nextDomain })
	})

	it('one organization per domain', async () => {
		const first = await setupTestOrgWithUser('admin')
		const second = await setupTestOrgWithUser('admin')
		const domain = uniqueDomain()
		const claim = await startDomainClaim(first.organization.id, domain)
		await checkDomainClaim(
			first.organization.id,
			dnsAnswer([claim.recordValue]),
		)

		expect(await isDomainClaimedElsewhere(domain, second.organization.id)).toBe(
			true,
		)
		const secondClaim = await startDomainClaim(second.organization.id, domain)
		expect(
			await checkDomainClaim(
				second.organization.id,
				dnsAnswer([secondClaim.recordValue]),
			),
		).toEqual({ status: 'taken' })
	})

	it('an unproven legacy domain does not hold the domain', async () => {
		const legacy = await setupTestOrgWithUser('admin')
		const owner = await setupTestOrgWithUser('admin')
		const domain = uniqueDomain()
		await db
			.update(Organization)
			.set({ verifiedDomain: domain, verifiedDomainProvedAt: null })
			.where(eq(Organization.id, legacy.organization.id))

		expect(await isDomainClaimedElsewhere(domain, owner.organization.id)).toBe(
			false,
		)
	})

	it('invites existing users on the domain instead of adding them', async () => {
		// The test database has no onboarding steps; invitations log that.
		consoleError.mockImplementation(() => {})
		const { user: admin, organization } = await setupTestOrgWithUser('admin')
		const domain = uniqueDomain()
		const existing = await createTestUser({
			email: `someone@${domain}`,
		} as never)
		const result = await inviteExistingDomainUsers({
			organizationId: organization.id,
			organizationName: organization.name,
			domain,
			inviterId: admin.id,
			inviterName: 'Admin',
		})
		expect(result).toEqual({ invited: 1, more: false })
		const memberships = await db
			.select()
			.from(UserOrganization)
			.where(eq(UserOrganization.userId, existing.id))
		expect(memberships).toHaveLength(0)
		const invites = await db
			.select({ email: OrganizationInvitation.email })
			.from(OrganizationInvitation)
			.where(eq(OrganizationInvitation.organizationId, organization.id))
		expect(invites.map((invite) => invite.email)).toEqual([`someone@${domain}`])
		// Running again does not re-invite.
		expect(
			await inviteExistingDomainUsers({
				organizationId: organization.id,
				organizationName: organization.name,
				domain,
				inviterId: admin.id,
				inviterName: 'Admin',
			}),
		).toEqual({ invited: 0, more: false })
	})

	it('joins TXT strings a resolver split into chunks', async () => {
		const fetchImpl = vi.fn(async () =>
			Response.json({ Answer: [{ type: 16, data: '"abc" "def"' }] }),
		) as unknown as typeof fetch
		expect(await lookupTxtRecords('x.test', fetchImpl)).toEqual(['abcdef'])
	})

	it('matches the domain exactly and finds a mixed-case invitation', async () => {
		consoleError.mockImplementation(() => {})
		const { user: admin, organization } = await setupTestOrgWithUser('admin')
		const domain = uniqueDomain()
		const lookalike = domain.replace('-', '_')
		await createTestUser({ email: `exact@${domain}` })
		// Would match an unescaped `%@corp_...` pattern only if `_` were a wildcard.
		await createTestUser({ email: `near@x${domain}` })
		await createTestUser({ email: `under@${lookalike}` })
		const invite = () =>
			inviteExistingDomainUsers({
				organizationId: organization.id,
				organizationName: organization.name,
				domain,
				inviterId: admin.id,
				inviterName: 'Admin',
			})
		expect(await invite()).toEqual({ invited: 1, more: false })
		const invites = await db
			.select({ email: OrganizationInvitation.email })
			.from(OrganizationInvitation)
			.where(eq(OrganizationInvitation.organizationId, organization.id))
		expect(invites.map((row) => row.email)).toEqual([`exact@${domain}`])
		expect(await invite()).toEqual({ invited: 0, more: false })
	})
})

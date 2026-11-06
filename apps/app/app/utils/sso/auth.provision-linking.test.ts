import { db, eq, Organization, User, UserOrganization } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { ssoAuthService } from './auth.server.ts'

// Real database (no mocks): a tenant's identity provider must not be able to
// sign in as, or enroll, an account that exists outside its organization.
async function seed() {
	const id = `lnk${Math.random().toString(36).slice(2, 10)}`
	const [victim] = await db
		.insert(User)
		.values({
			id: `v-${id}`,
			email: `victim-${id}@other.example`,
			username: `victim-${id}`,
			name: 'Victim',
		})
		.returning()
	const [org] = await db
		.insert(Organization)
		.values({ id: `o-${id}`, name: `Org ${id}`, slug: `org-${id}` })
		.returning()
	return { victim: victim!, org: org!, id }
}

function config(
	organizationId: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		organizationId,
		providerName: 'Test IdP',
		issuerUrl: 'https://idp.example/',
		autoProvision: true,
		defaultRole: 'member',
		allowedEmailDomains: null,
		requireVerifiedEmail: false,
		attributeMapping: null,
		...overrides,
	} as any
}

describe('SSO provisioning never links foreign accounts', () => {
	it('refuses every sign-in while the configuration lists no allowed domains', async () => {
		const { victim, org, id } = await seed()
		await expect(
			ssoAuthService.provisionUser(
				{ sub: id, email: victim.email, email_verified: true } as any,
				config(org.id),
			),
		).rejects.toThrow(/no allowed email domains/)
		const memberships = await db.select().from(UserOrganization)
		expect(memberships.some((m) => m.userId === victim.id)).toBe(false)
	})

	it('refuses when the email is unverified even if the domain is allowed', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { victim, org, id } = await seed()
		await expect(
			ssoAuthService.provisionUser(
				{ sub: id, email: victim.email, email_verified: false } as any,
				config(org.id, { allowedEmailDomains: 'other.example' }),
			),
		).rejects.toThrow(/cannot be linked/)
		warn.mockRestore()
	})

	it('refuses an unverified email and logs that the claim was missing', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { victim, org, id } = await seed()
		await expect(
			ssoAuthService.provisionUser(
				{ sub: id, email: victim.email } as any,
				config(org.id, { allowedEmailDomains: 'other.example' }),
			),
		).rejects.toThrow(/cannot be linked/)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('email_verified'))
		warn.mockRestore()
	})

	it('refuses a verified email outside the allowlist', async () => {
		const { victim, org, id } = await seed()
		await expect(
			ssoAuthService.provisionUser(
				{ sub: id, email: victim.email, email_verified: true } as any,
				config(org.id, { allowedEmailDomains: 'corp.example' }),
			),
		).rejects.toThrow(/not allowed/)
	})

	it('allows a verified email in the organization domain allowlist', async () => {
		const { victim, org, id } = await seed()
		const user = await ssoAuthService.provisionUser(
			{
				sub: id,
				email: victim.email,
				email_verified: true,
				name: 'Renamed By Idp',
			} as any,
			config(org.id, { allowedEmailDomains: 'other.example' }),
		)
		expect(user.id).toBe(victim.id)
	})
})

describe('SSO identity link (issuer + subject)', () => {
	async function orgWithDomain() {
		const id = `idl${Math.random().toString(36).slice(2, 10)}`
		const [org] = await db
			.insert(Organization)
			.values({ id: `o-${id}`, name: `Org ${id}`, slug: `org-${id}` })
			.returning()
		const domain = `${id}.example`
		return {
			id,
			domain,
			org: org!,
			cfg: config(org!.id, { allowedEmailDomains: domain }),
		}
	}

	it('a new account is linked, and later sign-ins match the subject, not the email', async () => {
		const { id, domain, cfg } = await orgWithDomain()
		const created = await ssoAuthService.provisionUser(
			{ sub: `sub-${id}`, email: `ann@${domain}` } as any,
			cfg,
		)
		const again = await ssoAuthService.provisionUser(
			{ sub: `sub-${id}`, email: `ann.renamed@${domain}` } as any,
			cfg,
		)
		expect(again.id).toBe(created.id)
	})

	it('another IdP user asserting a linked member email is refused', async () => {
		const { id, domain, cfg } = await orgWithDomain()
		const member = await ssoAuthService.provisionUser(
			{ sub: `real-${id}`, email: `bob@${domain}` } as any,
			cfg,
		)
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		await expect(
			ssoAuthService.provisionUser(
				{ sub: `impostor-${id}`, email: `bob@${domain}` } as any,
				cfg,
			),
		).rejects.toThrow(/linked to a different identity provider account/)
		warn.mockRestore()
		const [still] = await db
			.select({ email: User.email })
			.from(User)
			.where(eq(User.id, member.id))
		expect(still!.email).toBe(`bob@${domain}`)
	})

	it('an IdP cannot sign in an existing member whose email is outside its domains', async () => {
		const { id, org, cfg } = await orgWithDomain()
		// A consultant who is a member here but whose address is elsewhere.
		const [consultant] = await db
			.insert(User)
			.values({
				id: `c-${id}`,
				email: `consultant-${id}@agency.example`,
				username: `consultant-${id}`,
			})
			.returning()
		await db.insert(UserOrganization).values({
			userId: consultant!.id,
			organizationId: org.id,
			organizationRoleId: 'org_role_member',
		})
		await expect(
			ssoAuthService.provisionUser(
				{
					sub: `x-${id}`,
					email: consultant!.email,
					email_verified: true,
				} as any,
				cfg,
			),
		).rejects.toThrow(/not allowed/)
	})
})

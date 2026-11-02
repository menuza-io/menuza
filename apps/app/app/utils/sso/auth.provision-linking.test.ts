import { db, Organization, User, UserOrganization } from '@repo/database'
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
		autoProvision: true,
		defaultRole: 'member',
		allowedEmailDomains: null,
		requireVerifiedEmail: false,
		attributeMapping: null,
		...overrides,
	} as any
}

describe('SSO provisioning never links foreign accounts', () => {
	it('refuses an existing user who is not a member (default config)', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const { victim, org, id } = await seed()
		await expect(
			ssoAuthService.provisionUser(
				{ sub: id, email: victim.email, email_verified: true } as any,
				config(org.id),
			),
		).rejects.toThrow(/cannot be linked/)
		const memberships = await db.select().from(UserOrganization)
		expect(memberships.some((m) => m.userId === victim.id)).toBe(false)
		// The log names the real cause, so an operator can tell an IdP that omits
		// the claim from a domain that is not allowlisted.
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('allowedEmailDomains'),
		)
		warn.mockRestore()
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

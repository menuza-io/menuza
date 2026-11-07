import {
	db,
	eq,
	Organization,
	SSOConfiguration,
	SSOIdentity,
	User,
	UserOrganization,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { ssoAuthService } from './auth.server.ts'
import { SSOProvisioningError } from './provisioning-error.ts'

// Identity links reference a stored configuration (one per organization).
const configIdByOrg = new Map<string, string>()

async function insertConfig(
	organizationId: string,
	values: { issuerUrl?: string; clientId?: string } = {},
) {
	const [row] = await db
		.insert(SSOConfiguration)
		.values({
			organizationId,
			providerName: 'Test IdP',
			issuerUrl: values.issuerUrl ?? 'https://idp.example/',
			clientId: values.clientId ?? `client-${organizationId}`,
			clientSecret: 'encrypted',
		})
		.returning({ id: SSOConfiguration.id })
	configIdByOrg.set(organizationId, row!.id)
	return row!.id
}

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
	await insertConfig(org!.id)
	return { victim: victim!, org: org!, id }
}

function config(
	organizationId: string,
	overrides: Record<string, unknown> = {},
) {
	return {
		id: configIdByOrg.get(organizationId),
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
		).rejects.toThrow(SSOProvisioningError)
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

describe('SSO identity link (configuration + subject)', () => {
	async function orgWithDomain() {
		const id = `idl${Math.random().toString(36).slice(2, 10)}`
		const [org] = await db
			.insert(Organization)
			.values({ id: `o-${id}`, name: `Org ${id}`, slug: `org-${id}` })
			.returning()
		await insertConfig(org!.id)
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

	it('two first sign-ins racing for one account bind exactly one subject', async () => {
		const { id, domain, org, cfg } = await orgWithDomain()
		const [member] = await db
			.insert(User)
			.values({
				id: `m-${id}`,
				email: `dana@${domain}`,
				username: `dana-${id}`,
			})
			.returning()
		await db.insert(UserOrganization).values({
			userId: member!.id,
			organizationId: org.id,
			organizationRoleId: 'org_role_member',
		})
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const results = await Promise.allSettled(
			['a', 'b', 'c'].map((suffix) =>
				ssoAuthService.provisionUser(
					{ sub: `${suffix}-${id}`, email: `dana@${domain}` } as any,
					cfg,
				),
			),
		)
		warn.mockRestore()
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
		const links = await db
			.select({ subject: SSOIdentity.subject })
			.from(SSOIdentity)
			.where(eq(SSOIdentity.userId, member!.id))
		expect(links).toHaveLength(1)
	})

	it('a sign-in that dies between creating the user and linking the subject can be resumed', async () => {
		const { id, domain, cfg } = await orgWithDomain()
		const email = `eve@${domain}`
		// The isolate is killed right after the user insert: the identity link
		// (if it is a separate step) never happens and no cleanup runs.
		const link = vi
			.spyOn(ssoAuthService as any, 'linkIdentity')
			.mockImplementationOnce(() => new Promise(() => {}))
		const first = ssoAuthService.provisionUser(
			{ sub: `sub-${id}`, email } as any,
			cfg,
		)
		void first.catch(() => {})
		await new Promise((resolve) => setTimeout(resolve, 200))
		link.mockRestore()

		// The same person signs in again (the IdP sends no email_verified).
		const user = await ssoAuthService.provisionUser(
			{ sub: `sub-${id}`, email } as any,
			cfg,
		)
		expect(user.email).toBe(email)
		const users = await db.select().from(User).where(eq(User.email, email))
		expect(users).toHaveLength(1)
		const links = await db
			.select({ userId: SSOIdentity.userId })
			.from(SSOIdentity)
			.where(eq(SSOIdentity.subject, `sub-${id}`))
		expect(links).toEqual([{ userId: user.id }])
	})

	it('two first sign-ins of one new IdP user create one account and no orphan', async () => {
		const { id, domain, cfg } = await orgWithDomain()
		const results = await Promise.allSettled(
			[`fay@${domain}`, `fay.other@${domain}`].map((email) =>
				ssoAuthService.provisionUser({ sub: `fay-${id}`, email } as any, cfg),
			),
		)
		const ok = results.filter((r) => r.status === 'fulfilled')
		expect(ok.length).toBeGreaterThanOrEqual(1)
		const links = await db
			.select({ userId: SSOIdentity.userId })
			.from(SSOIdentity)
			.where(eq(SSOIdentity.subject, `fay-${id}`))
		expect(links).toHaveLength(1)
		const created = await db
			.select({ id: User.id })
			.from(User)
			.where(eq(User.email, `fay.other@${domain}`))
		const createdA = await db
			.select({ id: User.id })
			.from(User)
			.where(eq(User.email, `fay@${domain}`))
		expect([...created, ...createdA].map((u) => u.id)).toEqual([
			links[0]!.userId,
		])
	})
	it('links per configuration: the same person signs in to two organizations on one IdP', async () => {
		// Entra ID sends a pairwise subject per application, so one person has
		// a different subject in each organization's app registration.
		const first = await orgWithDomain()
		const second = await orgWithDomain()
		const email = `gus@${first.domain}`
		const user = await ssoAuthService.provisionUser(
			{ sub: `app1-${first.id}`, email } as any,
			first.cfg,
		)
		await db.insert(UserOrganization).values({
			userId: user.id,
			organizationId: second.org.id,
			organizationRoleId: 'org_role_member',
		})
		const again = await ssoAuthService.provisionUser(
			{ sub: `app2-${first.id}`, email } as any,
			config(second.org.id, { allowedEmailDomains: first.domain }),
		)
		expect(again.id).toBe(user.id)
		const links = await db
			.select({ ssoConfigId: SSOIdentity.ssoConfigId })
			.from(SSOIdentity)
			.where(eq(SSOIdentity.userId, user.id))
		expect(links.map((l) => l.ssoConfigId).sort()).toEqual(
			[first.cfg.id, configIdByOrg.get(second.org.id)].sort(),
		)
	})

	it('a new client id or issuer resets the configuration links; other edits keep them', async () => {
		const { id, domain, cfg } = await orgWithDomain()
		const user = await ssoAuthService.provisionUser(
			{ sub: `old-${id}`, email: `hal@${domain}` } as any,
			cfg,
		)
		const linksFor = () =>
			db
				.select({ subject: SSOIdentity.subject })
				.from(SSOIdentity)
				.where(eq(SSOIdentity.userId, user.id))

		await db
			.update(SSOConfiguration)
			.set({ providerName: 'Renamed', issuerUrl: 'https://idp.example' })
			.where(eq(SSOConfiguration.id, cfg.id))
		expect(await linksFor()).toEqual([{ subject: `old-${id}` }])

		// The organization replaces its app registration: new subjects.
		await db
			.update(SSOConfiguration)
			.set({ clientId: `replacement-${id}` })
			.where(eq(SSOConfiguration.id, cfg.id))
		expect(await linksFor()).toEqual([])

		// The same member signs in with the new subject and is linked again.
		const again = await ssoAuthService.provisionUser(
			{ sub: `new-${id}`, email: `hal@${domain}` } as any,
			cfg,
		)
		expect(again.id).toBe(user.id)
		expect(await linksFor()).toEqual([{ subject: `new-${id}` }])

		await db
			.update(SSOConfiguration)
			.set({ issuerUrl: 'https://other-idp.example/' })
			.where(eq(SSOConfiguration.id, cfg.id))
		expect(await linksFor()).toEqual([])
	})

	it('deleting the configuration deletes its links', async () => {
		const { id, domain, org, cfg } = await orgWithDomain()
		const user = await ssoAuthService.provisionUser(
			{ sub: `del-${id}`, email: `ida@${domain}` } as any,
			cfg,
		)
		await db
			.delete(SSOConfiguration)
			.where(eq(SSOConfiguration.organizationId, org.id))
		const links = await db
			.select()
			.from(SSOIdentity)
			.where(eq(SSOIdentity.userId, user.id))
		expect(links).toEqual([])
	})
})

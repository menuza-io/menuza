/**
 * #194 through Settings, Legal and the app shell: the list of acceptances,
 * accepting as an owner (and only an owner, never from a support session), the
 * hand-off from a module that has its own terms, and the guard that every
 * module with terms asks first.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type * as AuthModule from '@repo/auth'
import {
	db,
	eq,
	LegalAcceptance,
	Organization,
	UserOrganization,
} from '@repo/database'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loader as layoutLoader } from '#app/routes/_app+/_layout.tsx'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
} from '#tests/test-utils.ts'
import { action, loader } from './legal.tsx'

const impersonating = vi.hoisted(() => ({ value: false }))
vi.mock('@repo/auth', async (importOriginal) => {
	const actual = await importOriginal<typeof AuthModule>()
	return {
		...actual,
		isImpersonating: vi.fn(async () => impersonating.value),
	}
})

const created: string[] = []
beforeEach(() => {
	impersonating.value = false
})
afterEach(async () => {
	for (const id of created.splice(0)) {
		await db.delete(Organization).where(eq(Organization.id, id))
	}
})

async function setup(role: 'admin' | 'member' = 'admin') {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, role)
	created.push(organization.id)
	const { cookie } = await createTestSession(user.id)
	return { user, organization, cookie }
}
type Ctx = Awaited<ReturnType<typeof setup>>

const url = (ctx: Ctx, query = '') =>
	`http://localhost:3000/${ctx.organization.slug}/settings/legal${query}`

async function accept(ctx: Ctx, items: unknown) {
	const response = (await action({
		request: createAuthenticatedRequest(
			url(ctx),
			{
				method: 'POST',
				body: new URLSearchParams({
					intent: 'accept-agreements',
					items: JSON.stringify(items),
				}),
			},
			ctx.cookie,
		),
		params: { orgSlug: ctx.organization.slug },
		context: {},
	} as never)) as unknown as {
		init?: { status?: number }
		data?: unknown
	} & Response
	// `data()` answers with a DataWithResponseInit.
	const status = response.status ?? response.init?.status ?? 200
	const body = (response.data ?? (await response.json())) as Record<string, any>
	return { status, body }
}

const load = async (ctx: Ctx, query = '') =>
	(await loader({
		request: createAuthenticatedRequest(url(ctx, query), {}, ctx.cookie),
		params: { orgSlug: ctx.organization.slug },
		context: {},
	} as never)) as unknown as {
		acceptances: Array<{
			key: string
			version: number
			acceptedBy: string | null
		}>
		pending: Array<{ key: string }>
		canAccept: boolean
		next: string | null
	}

describe('Settings, Legal (#194)', () => {
	it('lists what is pending, accepts as an owner, then lists the acceptances', async () => {
		const ctx = await setup()
		const before = await load(ctx)
		expect(before.acceptances).toEqual([])
		expect(before.pending.map((a) => a.key).sort()).toEqual([
			'dpa',
			'privacy',
			'terms',
		])
		expect(before.canAccept).toBe(true)

		const result = await accept(
			ctx,
			before.pending.map((a: any) => ({
				key: a.key,
				version: a.version,
			})),
		)
		expect(result.status).toBe(200)
		const after = await load(ctx)
		expect(after.pending).toEqual([])
		expect(
			after.acceptances.map((a) => `${a.key}:${a.version}`).sort(),
		).toEqual(['dpa:1', 'privacy:1', 'terms:1'])
		expect(after.acceptances.every((a) => a.acceptedBy)).toBe(true)
	})

	it('refuses a member who is not an owner', async () => {
		const owner = await setup()
		const member = await insertTestUser()
		await db.insert(UserOrganization).values({
			userId: member.id,
			organizationId: owner.organization.id,
			organizationRoleId: 'org_role_member',
		})
		const { cookie } = await createTestSession(member.id)
		const asMember = { ...owner, cookie, user: member }
		const result = await accept(asMember, [{ key: 'terms', version: 1 }])
		expect(result.status).toBe(403)
		expect(result.body.error).toBe('not_owner')
	})

	it('refuses a support session acting as the owner', async () => {
		const ctx = await setup()
		impersonating.value = true
		const result = await accept(ctx, [{ key: 'terms', version: 1 }])
		expect(result.status).toBe(403)
		expect(result.body.error).toBe('impersonating')
		expect(
			await db
				.select({ id: LegalAcceptance.id })
				.from(LegalAcceptance)
				.where(eq(LegalAcceptance.organizationId, ctx.organization.id)),
		).toHaveLength(0)
	})

	it('refuses a malformed or unknown request', async () => {
		const ctx = await setup()
		expect((await accept(ctx, 'nope')).status).toBe(400)
		expect((await accept(ctx, [])).status).toBe(400)
		expect((await accept(ctx, [{ key: 'ghost', version: 1 }])).status).toBe(400)
	})

	it('a module with its own terms hands the owner here, then back', async () => {
		const ctx = await setup()
		const back = `/${ctx.organization.slug}/settings/shop`
		const data = await load(
			ctx,
			`?agreement=payments&next=${encodeURIComponent(back)}`,
		)
		expect(data.pending.map((a) => a.key)).toContain('payments')
		expect(data.next).toBe(back)
		// A return address outside this organization is dropped.
		expect(
			(
				await load(
					ctx,
					`?agreement=payments&next=${encodeURIComponent('//evil.com')}`,
				)
			).next,
		).toBeNull()
		expect(
			(
				await load(
					ctx,
					`?agreement=payments&next=${encodeURIComponent('/other-org/x')}`,
				)
			).next,
		).toBeNull()
		// Accepting it is recorded as a module acceptance.
		await accept(ctx, [{ key: 'payments', version: 1 }])
		const [row] = await db
			.select()
			.from(LegalAcceptance)
			.where(eq(LegalAcceptance.organizationId, ctx.organization.id))
		expect(row).toMatchObject({ agreementKey: 'payments', source: 'module' })
		// Once accepted it is no longer asked.
		expect(
			(await load(ctx, '?agreement=payments')).pending.map((a) => a.key),
		).not.toContain('payments')
	})
})

describe('the app shell prompt (#194)', () => {
	it('shows an owner the pending agreements, and a member nothing', async () => {
		const owner = await setup()
		const member = await insertTestUser()
		await db.insert(UserOrganization).values({
			userId: member.id,
			organizationId: owner.organization.id,
			organizationRoleId: 'org_role_member',
		})
		const memberSession = await createTestSession(member.id)
		const run = async (cookie: string) =>
			(await layoutLoader({
				request: createAuthenticatedRequest(url(owner), {}, cookie),
				params: { orgSlug: owner.organization.slug },
			} as never)) as unknown as {
				agreementPrompt: {
					pending: Array<{ key: string }>
					blocking: boolean
					canAccept: boolean
					orgSlug: string | null
				}
			}
		const asOwner = await run(owner.cookie)
		expect(asOwner.agreementPrompt.orgSlug).toBe(owner.organization.slug)
		expect(asOwner.agreementPrompt.pending.map((a) => a.key).sort()).toEqual([
			'dpa',
			'privacy',
			'terms',
		])
		expect(asOwner.agreementPrompt.blocking).toBe(false)
		const asMember = await run(memberSession.cookie)
		expect(asMember.agreementPrompt.pending).toEqual([])
	})
})

describe('modules with their own terms ask first (guard)', () => {
	const root = path.resolve(__dirname, '../../../../..')
	const read = (relative: string) =>
		readFileSync(path.join(root, relative), 'utf8')

	it('payouts, text campaigns and text programs call requireModuleAgreement', () => {
		expect(read('app/routes/_app+/$orgSlug_+/settings+/shop.tsx')).toMatch(
			/requireModuleAgreement\(\s*organization\.id,\s*'payments'/,
		)
		expect(read('app/utils/marketing/campaign-submit.server.ts')).toMatch(
			/requireModuleAgreement\(\s*input\.organizationId,\s*'text_marketing'/,
		)
		expect(read('app/utils/marketing/programs.server.ts')).toMatch(
			/requireModuleAgreement\(\s*input\.organizationId,\s*'text_marketing'/,
		)
	})

	it('the shop gate comes before the account is created', () => {
		const source = read('app/routes/_app+/$orgSlug_+/settings+/shop.tsx')
		expect(source.indexOf("'payments'")).toBeGreaterThan(-1)
		expect(source.indexOf("'payments'")).toBeLessThan(
			source.indexOf('startConnectOnboarding(request, organization)'),
		)
	})
})

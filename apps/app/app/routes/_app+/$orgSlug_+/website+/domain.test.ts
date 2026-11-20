/**
 * The Website, Domain screen: who may read it, who may change it, and that
 * every intent goes through the same permission gate.
 */
import { db, eq, Organization, SiteDomain } from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import { DOMAIN_INTENTS } from '#app/utils/domains/actions.server.ts'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
} from '#tests/test-utils.ts'
import { action, loader } from './domain.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return { ...actual, purgeOrganizationSiteCache: vi.fn(async () => true) }
})

async function member(role: 'admin' | 'member' | 'viewer') {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, role)
	const { cookie } = await createTestSession(user.id)
	return { user, organization, cookie }
}

function post(
	ctx: Awaited<ReturnType<typeof member>>,
	body: Record<string, string>,
) {
	return action({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${ctx.organization.slug}/website/domain`,
			{ method: 'POST', body: new URLSearchParams(body) },
			ctx.cookie,
		),
		params: { orgSlug: ctx.organization.slug },
		context: {},
	} as never)
}

function read(ctx: Awaited<ReturnType<typeof member>>) {
	return loader({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${ctx.organization.slug}/website/domain`,
			{},
			ctx.cookie,
		),
		params: { orgSlug: ctx.organization.slug },
		context: {},
	} as never)
}

describe('the Domain screen', () => {
	it('lists what exists, with the checklist of every host, for an admin', async () => {
		const ctx = await member('admin')
		const host = `screen-${Date.now()}.com`
		const added = (await post(ctx, {
			intent: 'add-domain',
			hostname: host,
			primaryForm: 'www',
		})) as Response
		expect(added.status).toBe(200)
		const data = (await read(ctx)) as Awaited<ReturnType<typeof loader>>
		expect(data.canUpdate).toBe(true)
		expect(
			data.overview.siteDomains.map((d) => [d.hostname, d.isPrimary]),
		).toEqual([
			[`www.${host}`, true],
			[host, false],
		])
		expect(data.overview.siteDomains[0]!.records[0]).toMatchObject({
			type: 'CNAME',
			name: `www.${host}`,
		})
		expect(data.overview.registrar.enabled).toBe(false)
	})

	it('is closed to roles that cannot see or edit the website', async () => {
		for (const role of ['member', 'viewer'] as const) {
			const ctx = await member(role)
			await expect(read(ctx)).rejects.toMatchObject({ status: 403 })
			await expect(
				post(ctx, {
					intent: 'add-domain',
					hostname: `closed-${Date.now()}.com`,
				}),
			).rejects.toMatchObject({ status: 403 })
		}
	})

	it('refuses every intent without permission to edit settings, before reading anything', async () => {
		const ctx = await member('viewer')
		for (const intent of DOMAIN_INTENTS) {
			await expect(post(ctx, { intent })).rejects.toMatchObject({ status: 403 })
		}
	})

	it('answers an unknown or malformed intent with an error, not a crash', async () => {
		const ctx = await member('admin')
		const unknown = (await post(ctx, { intent: 'nope' })) as Response
		expect(unknown.status).toBe(400)
		expect(await unknown.json()).toMatchObject({
			ok: false,
			error: 'invalid_request',
		})
		const bad = (await post(ctx, { intent: 'add-domain' })) as Response
		expect(bad.status).toBe(400)
	})

	it('reports a reserved host and a host another organization has', async () => {
		const first = await member('admin')
		const host = `taken-${Date.now()}.com`
		await post(first, { intent: 'add-domain', hostname: host })
		const second = await member('admin')
		const reserved = (await post(second, {
			intent: 'add-domain',
			hostname: 'acme.menuza.io',
		})) as Response
		expect(await reserved.json()).toMatchObject({
			ok: false,
			error: 'hostname_reserved',
		})
		const taken = (await post(second, {
			intent: 'add-domain',
			hostname: host,
		})) as Response
		expect(taken.status).toBe(409)
		expect(await taken.json()).toMatchObject({
			ok: false,
			error: 'hostname_taken',
		})
	})

	it('changes the primary and keeps the old one redirecting', async () => {
		const ctx = await member('admin')
		const host = `swap-${Date.now()}.com`
		await post(ctx, {
			intent: 'add-domain',
			hostname: host,
			primaryForm: 'www',
		})
		const swapped = (await post(ctx, {
			intent: 'set-primary',
			hostname: host,
		})) as Response
		expect(swapped.status).toBe(200)
		const rows = await db
			.select()
			.from(SiteDomain)
			.where(eq(SiteDomain.organizationId, ctx.organization.id))
		expect(rows.find((r) => r.isPrimary)?.hostname).toBe(host)
		const [org] = await db
			.select({ customDomain: Organization.customDomain })
			.from(Organization)
			.where(eq(Organization.id, ctx.organization.id))
		expect(org?.customDomain).toBe(host)
	})

	it('keeps registrar actions off without the flag', async () => {
		const ctx = await member('admin')
		const search = (await post(ctx, {
			intent: 'search-domains',
			query: 'albait',
		})) as Response
		expect(search.status).toBe(404)
		expect(await search.json()).toMatchObject({ error: 'feature_off' })
	})
})

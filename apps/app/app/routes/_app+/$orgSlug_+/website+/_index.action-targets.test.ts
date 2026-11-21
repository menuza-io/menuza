/**
 * #318: Website settings, "Where buttons go": the choice is saved per
 * organization and per location, links are checked (https, never the site's own
 * domains), the public payload carries it for Sites, and Google's links follow.
 */
import {
	db,
	eq,
	Organization,
	OrganizationLocation,
	SiteDomain,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import { siteLinks } from '#app/utils/gbp/context.server.ts'
import {
	findPublishedSiteOrganization,
	toPublicSitePayload,
} from '#app/utils/sites/public-org.server.ts'
import {
	addOrganizationMember,
	createAuthenticatedRequest,
	createTestSession,
	createTestUser,
	setupTestOrgWithUser,
} from '#tests/test-utils.ts'
import { action } from './_index.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', () => ({
	purgeOrganizationSiteCache: vi.fn(),
}))

async function post(
	slug: string,
	cookie: string,
	fields: Record<string, string>,
) {
	const body = new URLSearchParams({
		intent: 'update-action-targets',
		...fields,
	})
	try {
		return (await action({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${slug}/website`,
				{ method: 'POST', body },
				cookie,
			),
			params: { orgSlug: slug },
			context: new RouterContextProvider(),
		} as never)) as Response
	} catch (thrown) {
		if (thrown instanceof Response) return thrown
		throw thrown
	}
}

async function org() {
	const { organization, cookie, user } = await setupTestOrgWithUser('admin')
	await db
		.update(Organization)
		.set({ sitePublished: true })
		.where(eq(Organization.id, organization.id))
	return { organization, cookie, user }
}

async function stored(organizationId: string) {
	const [row] = await db
		.select({ actionTargets: Organization.actionTargets })
		.from(Organization)
		.where(eq(Organization.id, organizationId))
	return row?.actionTargets ? JSON.parse(row.actionTargets) : null
}

describe('saving where buttons go (#318)', () => {
	it('saves Order online as another site and Menuza for the rest', async () => {
		const { organization, cookie } = await org()
		const res = await post(organization.slug, cookie, {
			locationId: '',
			orderMode: 'external',
			orderUrl: 'https://order.toast.example/acme',
			gift_cardsMode: 'menuza',
			reservationsMode: 'menuza',
		})
		expect(res.status).toBe(200)
		expect(await stored(organization.id)).toEqual({
			order: { mode: 'external', url: 'https://order.toast.example/acme' },
			gift_cards: { mode: 'menuza' },
			reservations: { mode: 'menuza' },
		})
	})

	it('refuses a link that is not https, not a web address, or the site itself', async () => {
		const { organization, cookie } = await org()
		await db.insert(SiteDomain).values({
			organizationId: organization.id,
			hostname: 'www.mycafe.example',
			isPrimary: true,
			status: 'active',
		} as never)
		const cases: Array<[string, string]> = [
			['http://order.example/x', 'https_required'],
			['javascript:alert(1)', 'https_required'],
			['order.example', 'invalid_url'],
			['', 'invalid_url'],
			['https://www.mycafe.example/order', 'own_domain'],
			['https://shop.mycafe.example/order', 'invalid_url'],
		]
		for (const [url, error] of cases) {
			const res = await post(organization.slug, cookie, {
				locationId: '',
				orderMode: 'external',
				orderUrl: url,
			})
			const body = (await res.json()) as { error: string; kind: string }
			if (url.includes('shop.mycafe')) {
				// A different host of another domain is allowed: not "own".
				expect(res.status).toBe(200)
				continue
			}
			expect({
				url,
				status: res.status,
				error: body.error,
				kind: body.kind,
			}).toEqual({
				url,
				status: 400,
				error,
				kind: 'order',
			})
		}
		expect(await stored(organization.id)).toEqual({
			order: { mode: 'external', url: 'https://shop.mycafe.example/order' },
		})
	})

	it("refuses the site's default address too", async () => {
		const { organization, cookie } = await org()
		const res = await post(organization.slug, cookie, {
			locationId: '',
			orderMode: 'external',
			orderUrl: `https://${organization.slug}.menuza.test/menu`,
		})
		// The default host is derived from the slug; it must never be accepted.
		const body = (await res.json()) as { error?: string }
		expect(body.error ?? 'ok').toBe('own_domain')
	})

	it('saves nothing when one of the links is refused', async () => {
		const { organization, cookie } = await org()
		await post(organization.slug, cookie, {
			locationId: '',
			orderMode: 'external',
			orderUrl: 'https://order.example/ok',
		})
		const res = await post(organization.slug, cookie, {
			locationId: '',
			orderMode: 'menuza',
			reservationsMode: 'external',
			reservationsUrl: 'http://book.example/x',
		})
		expect(res.status).toBe(400)
		expect(await stored(organization.id)).toEqual({
			order: { mode: 'external', url: 'https://order.example/ok' },
		})
	})

	it('switching back to Menuza clears the other site everywhere at once', async () => {
		const { organization, cookie } = await org()
		await post(organization.slug, cookie, {
			locationId: '',
			orderMode: 'external',
			orderUrl: 'https://order.example/ok',
		})
		await post(organization.slug, cookie, {
			locationId: '',
			orderMode: 'menuza',
		})
		expect(await stored(organization.id)).toEqual({ order: { mode: 'menuza' } })
		const payload = toPublicSitePayload(
			(await findPublishedSiteOrganization({ slug: organization.slug }))!,
		)
		expect(payload.actionTargets.organization).toEqual({
			order: { mode: 'menuza' },
		})
	})

	it('a domain added after the link was saved takes that link out of the public site', async () => {
		const { organization, cookie } = await org()
		await post(organization.slug, cookie, {
			locationId: '',
			orderMode: 'external',
			orderUrl: 'https://order.shop-later.example/acme',
		})
		const before = toPublicSitePayload(
			(await findPublishedSiteOrganization({ slug: organization.slug }))!,
		)
		expect(before.actionTargets.organization.order?.mode).toBe('external')
		// The restaurant now owns that domain: sending guests there would loop.
		await db
			.update(Organization)
			.set({ customDomain: 'shop-later.example' })
			.where(eq(Organization.id, organization.id))
		const after = toPublicSitePayload(
			(await findPublishedSiteOrganization({ slug: organization.slug }))!,
		)
		expect(after.actionTargets.organization.order).toBeUndefined()
		// What the operator saved is still there for the editor to show.
		expect(
			((await stored(organization.id)) as { order: { mode: string } }).order
				.mode,
		).toBe('external')
	})

	it('only a member who can update the website may change it', async () => {
		const { organization } = await org()
		const viewer = await createTestUser()
		await addOrganizationMember(viewer.id, organization.id, 'org_role_viewer')
		const cookie = (await createTestSession(viewer.id)).cookie
		const res = await post(organization.slug, cookie, {
			locationId: '',
			orderMode: 'external',
			orderUrl: 'https://order.example/ok',
		})
		expect(res.status).toBe(403)
		expect(await stored(organization.id)).toBeNull()
	})
})

describe('per location (#318)', () => {
	async function twoLocations() {
		const ctx = await org()
		const [a, b] = await db
			.insert(OrganizationLocation)
			.values([
				{
					organizationId: ctx.organization.id,
					name: 'Downtown',
					slug: 'downtown',
				},
				{
					organizationId: ctx.organization.id,
					name: 'Airport',
					slug: 'airport',
				},
			] as never)
			.returning()
		return { ...ctx, a: a!, b: b! }
	}

	it("saves a location's own choice, and 'same as the whole site' removes it", async () => {
		const { organization, cookie, a } = await twoLocations()
		await post(organization.slug, cookie, {
			locationId: a.id,
			orderMode: 'external',
			orderUrl: 'https://downtown.example/order',
			reservationsMode: 'inherit',
		})
		const payload = toPublicSitePayload(
			(await findPublishedSiteOrganization({ slug: organization.slug }))!,
		)
		expect(payload.actionTargets.locations[a.id]).toEqual({
			order: { mode: 'external', url: 'https://downtown.example/order' },
		})
		await post(organization.slug, cookie, {
			locationId: a.id,
			orderMode: 'inherit',
		})
		const after = toPublicSitePayload(
			(await findPublishedSiteOrganization({ slug: organization.slug }))!,
		)
		expect(after.actionTargets.locations[a.id]).toBeUndefined()
	})

	it("treats another organization's location as not found", async () => {
		const mine = await org()
		const other = await twoLocations()
		const res = await post(mine.organization.slug, mine.cookie, {
			locationId: other.a.id,
			orderMode: 'external',
			orderUrl: 'https://x.example/order',
		})
		expect(res.status).toBe(404)
		const [row] = await db
			.select({ actionTargets: OrganizationLocation.actionTargets })
			.from(OrganizationLocation)
			.where(eq(OrganizationLocation.id, other.a.id))
		expect(row?.actionTargets).toBeNull()
	})

	it('inherit is not a choice for the whole site', async () => {
		const { organization, cookie } = await org()
		const res = await post(organization.slug, cookie, {
			locationId: '',
			orderMode: 'inherit',
		})
		expect(res.status).toBe(400)
	})
})

describe("Google's links follow the choice (#318)", () => {
	const organization = {
		id: 'o1',
		slug: 'acme',
		name: 'Acme',
		customDomain: 'www.acme.example',
		customDomainStatus: 'active',
		dataRegion: 'us',
	}
	const location = { id: 'l1', slug: 'downtown', sitePageEnabled: false }

	it('points Google at our pages while buttons stay on Menuza', () => {
		const links = siteLinks(organization, location as never, 1)
		expect(links.order).toContain('www.acme.example')
		expect(links.reservation).toContain('/reserve')
	})

	it('points Order and Reserve where the site sends them', () => {
		const links = siteLinks(
			{
				...organization,
				actionTargets: JSON.stringify({
					order: { mode: 'external', url: 'https://order.toast.example/acme' },
					reservations: { mode: 'external', url: 'https://book.example/acme' },
				}),
			},
			location as never,
			1,
		)
		expect(links.order).toBe('https://order.toast.example/acme')
		expect(links.reservation).toBe('https://book.example/acme')
		expect(links.website).toContain('www.acme.example')
	})

	it("a location's own choice wins over the organization's", () => {
		const links = siteLinks(
			{
				...organization,
				actionTargets: JSON.stringify({
					order: { mode: 'external', url: 'https://all.example/order' },
				}),
			},
			{
				...location,
				actionTargets: JSON.stringify({ order: { mode: 'menuza' } }),
			} as never,
			2,
		)
		expect(links.order).toContain('www.acme.example')
		expect(links.order).toContain('location=l1')
	})
})

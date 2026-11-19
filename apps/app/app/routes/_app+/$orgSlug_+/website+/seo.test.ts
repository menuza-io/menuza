/**
 * Website, SEO (#138): verification codes on the home page, IndexNow pings on
 * publish, and Google Search Console (connect, verify, submit the sitemap,
 * 28-day figures). Google and IndexNow are replaced by test doubles.
 */
import {
	db,
	eq,
	IndexNowPing,
	Integration,
	Organization,
	WebsitePage,
} from '@repo/database'
import { afterEach, describe, expect, it } from 'vitest'
import {
	type IndexNowRequest,
	notifyIndexNowForPages,
	setIndexNowSender,
} from '#app/utils/seo/indexnow.server.ts'
import {
	mockSearchConsoleClient,
	readSearchConsoleSummary,
	type SearchConsoleClient,
	SearchConsoleError,
	setSearchConsoleClientFactory,
	setupSearchConsole,
	syncSearchConsole,
} from '#app/utils/seo/search-console.server.ts'
import {
	callAction,
	callLoader,
	publicSitePayload,
	setOrgFlag,
	setupSeoOrganization,
} from '#tests/seo-utils.ts'
import { action as listAction } from './pages._index.tsx'
import { action, loader } from './seo._index.tsx'

afterEach(() => {
	setIndexNowSender(null)
	setSearchConsoleClientFactory(null)
})

const seoUrl = (slug: string) =>
	`http://localhost:3000/${slug}/website/seo?index`

describe('verification codes (#138)', () => {
	it('puts the Google code on the home page as a meta tag, escaped by format', async () => {
		const { organization, cookie } = await setupSeoOrganization()
		const response = await callAction(action, {
			url: seoUrl(organization.slug),
			cookie,
			params: { orgSlug: organization.slug },
			fields: {
				intent: 'save-verification',
				google:
					'<meta name="google-site-verification" content="AbC_123-xyz987" />',
				bing: '0123456789abcdef0123456789ABCDEF',
			},
		})
		expect(response.status).toBe(200)
		const payload = await publicSitePayload(organization.slug)
		expect(payload.siteVerification).toEqual({
			google: ['AbC_123-xyz987'],
			bing: '0123456789abcdef0123456789ABCDEF',
		})
		// Saving also gives the site its IndexNow key file.
		expect(payload.indexNowKey).toMatch(/^[a-f0-9]{32}$/)
	})

	it('refuses something that is not a code', async () => {
		const { organization, cookie } = await setupSeoOrganization()
		const response = await callAction(action, {
			url: seoUrl(organization.slug),
			cookie,
			params: { orgSlug: organization.slug },
			fields: {
				intent: 'save-verification',
				google: '"><script>alert(1)</script>',
			},
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({
			error: 'invalid_verification_code',
			field: 'google',
		})
		const [row] = await db
			.select({ code: Organization.googleSiteVerification })
			.from(Organization)
			.where(eq(Organization.id, organization.id))
		expect(row!.code).toBeNull()
	})

	it('needs update:website:any to change and membership to read', async () => {
		const viewer = await setupSeoOrganization('viewer')
		const refused = await callAction(action, {
			url: seoUrl(viewer.organization.slug),
			cookie: viewer.cookie,
			params: { orgSlug: viewer.organization.slug },
			fields: { intent: 'save-verification', google: 'AbC_123-xyz987' },
		})
		expect(refused.status).toBe(403)
		const other = await setupSeoOrganization()
		const outsider = await callLoader(loader, {
			url: seoUrl(viewer.organization.slug),
			cookie: other.cookie,
			params: { orgSlug: viewer.organization.slug },
		})
		expect((outsider as Response).status).toBe(404)
	})
})

describe('IndexNow on publish (#138)', () => {
	it('sends one ping listing every language version of the published page', async () => {
		const { organization, cookie, userId } = await setupSeoOrganization(
			'admin',
			{
				siteLocales: JSON.stringify(['en', 'ar']),
			},
		)
		const sent: IndexNowRequest[] = []
		setIndexNowSender(async (body) => {
			sent.push(body)
			return true
		})
		const [page] = await db
			.insert(WebsitePage)
			.values({
				organizationId: organization.id,
				createdById: userId,
				title: 'About',
				slug: 'about',
			})
			.returning({ id: WebsitePage.id })
		const response = await callAction(listAction, {
			url: `http://localhost:3000/${organization.slug}/website/pages?index`,
			cookie,
			params: { orgSlug: organization.slug },
			fields: { intent: 'publish-page', pageId: page!.id },
		})
		expect(response.status).toBe(200)
		// The action hands the ping to `runAfterResponse`; wait for it.
		for (let i = 0; i < 50 && !sent.length; i++) {
			await new Promise((resolve) => setTimeout(resolve, 20))
		}
		expect(sent).toHaveLength(1)
		const origin = new URL(sent[0]!.keyLocation).origin
		expect(sent[0]!.urlList).toEqual([`${origin}/about`, `${origin}/ar/about`])
		expect(sent[0]!.keyLocation).toBe(`${origin}/${sent[0]!.key}.txt`)
		expect(sent[0]!.host).toBe(new URL(origin).host)
	})

	it('pings a URL at most once an hour and never for noindex pages', async () => {
		const { organization, userId } = await setupSeoOrganization()
		const sent: IndexNowRequest[] = []
		setIndexNowSender(async (body) => {
			sent.push(body)
			return true
		})
		const [visible, hidden] = await db
			.insert(WebsitePage)
			.values([
				{
					organizationId: organization.id,
					createdById: userId,
					title: 'A',
					slug: 'a',
					status: 'published',
				},
				{
					organizationId: organization.id,
					createdById: userId,
					title: 'B',
					slug: 'b',
					status: 'published',
					seoNoIndex: true,
				},
			])
			.returning({ id: WebsitePage.id })
		const now = new Date('2026-11-19T10:00:00Z')
		const first = await notifyIndexNowForPages(
			organization.id,
			[visible!.id, hidden!.id],
			now,
		)
		expect(first).toHaveLength(1)
		expect(first[0]).toMatch(/\/a$/)
		expect(
			await notifyIndexNowForPages(
				organization.id,
				[visible!.id],
				new Date(now.getTime() + 30 * 60_000),
			),
		).toEqual([])
		expect(
			await notifyIndexNowForPages(
				organization.id,
				[visible!.id],
				new Date(now.getTime() + 61 * 60_000),
			),
		).toHaveLength(1)
		expect(sent).toHaveLength(2)
		const rows = await db
			.select()
			.from(IndexNowPing)
			.where(eq(IndexNowPing.organizationId, organization.id))
		expect(rows).toHaveLength(1)
	})
})

async function connectSearchConsole(organizationId: string) {
	await db.insert(Integration).values({
		organizationId,
		providerName: 'google-search-console',
		providerType: 'business-profile',
		accessToken: 'test-access-token',
		config: '{}',
	})
}

function recordingClient(overrides: Partial<SearchConsoleClient> = {}) {
	const calls: string[] = []
	const base = mockSearchConsoleClient()
	const client: SearchConsoleClient = {
		getVerificationToken: async (site) => {
			calls.push(`token ${site}`)
			return 'gsc-token-abcdef12345'
		},
		addSite: async (site) => {
			calls.push(`add ${site}`)
		},
		verifySite: async (site) => {
			calls.push(`verify ${site}`)
		},
		submitSitemap: async (site, sitemap) => {
			calls.push(`sitemap ${sitemap}`)
		},
		getSitemap: base.getSitemap,
		query: base.query,
		...overrides,
	}
	return { client, calls }
}

describe('Search Console (#138)', () => {
	it('verifies the site through the meta tag and submits the sitemap without manual steps', async () => {
		const { organization, cookie } = await setupSeoOrganization()
		await setOrgFlag(organization.id, 'seo.search_console', true)
		await connectSearchConsole(organization.id)
		const { client, calls } = recordingClient()
		setSearchConsoleClientFactory(async () => client)

		// The screen starts the setup by itself right after connecting.
		const response = await callAction(action, {
			url: seoUrl(organization.slug),
			cookie,
			params: { orgSlug: organization.slug },
			fields: { intent: 'setup-search-console' },
		})
		expect(response.status).toBe(200)
		const site = calls[0]!.slice('token '.length)
		expect(site).toMatch(/^https?:\/\/.+\/$/)
		expect(calls).toEqual([
			`token ${site}`,
			`add ${site}`,
			`verify ${site}`,
			`sitemap ${site}sitemap.xml`,
		])
		// The token is on the home page before Google is asked to verify.
		const payload = await publicSitePayload(organization.slug)
		expect(payload.siteVerification.google).toContain('gsc-token-abcdef12345')
		const summary = await readSearchConsoleSummary(organization.id)
		expect(summary.config).toMatchObject({ status: 'ready', siteUrl: site })
	})

	it('reports gsc_not_owner when Google refuses', async () => {
		const { organization } = await setupSeoOrganization()
		await connectSearchConsole(organization.id)
		const { client } = recordingClient({
			verifySite: async () => {
				throw new SearchConsoleError('gsc_not_owner', 403)
			},
		})
		setSearchConsoleClientFactory(async () => client)
		const result = await setupSearchConsole({
			...organization,
			customDomainStatus: null,
		})
		expect(result).toMatchObject({ ok: false, error: 'gsc_not_owner' })
		const summary = await readSearchConsoleSummary(organization.id)
		expect(summary.warnings).toContain('gsc_not_owner')
	})

	it('adds the new property and resubmits when the primary host changes', async () => {
		const { organization } = await setupSeoOrganization()
		await connectSearchConsole(organization.id)
		const { client, calls } = recordingClient()
		setSearchConsoleClientFactory(async () => client)
		await setupSearchConsole({
			...organization,
			customDomain: null,
			customDomainStatus: null,
		})
		calls.length = 0
		await setupSearchConsole({
			...organization,
			customDomain: 'www.albait.example',
			customDomainStatus: 'active',
		})
		expect(calls).toEqual([
			'token https://www.albait.example/',
			'add https://www.albait.example/',
			'verify https://www.albait.example/',
			'sitemap https://www.albait.example/sitemap.xml',
		])
	})

	it('shows 28-day clicks, impressions and top queries on the SEO screen', async () => {
		const { organization, cookie } = await setupSeoOrganization()
		await setOrgFlag(organization.id, 'seo.search_console', true)
		await connectSearchConsole(organization.id)
		const { client } = recordingClient()
		setSearchConsoleClientFactory(async () => client)
		const now = new Date()
		expect(
			await syncSearchConsole(
				{ ...organization, customDomainStatus: null },
				now,
			),
		).toEqual({ ok: true })

		const data = (await callLoader(loader, {
			url: seoUrl(organization.slug),
			cookie,
			params: { orgSlug: organization.slug },
		})) as Awaited<ReturnType<typeof loader>>
		const summary = data.searchConsole!
		expect(summary.connected).toBe(true)
		expect(summary.daily).toHaveLength(28)
		expect(summary.totals.clicks).toBe(
			summary.daily.reduce((n, d) => n + d.clicks, 0),
		)
		expect(summary.totals.clicks).toBeGreaterThan(0)
		expect(summary.totals.impressions).toBeGreaterThan(0)
		expect(summary.totals.position).not.toBeNull()
		expect(summary.topQueries.map((row) => row.value)).toEqual([
			'shawarma near me',
			'lebanese restaurant',
			'best falafel',
			'brunch olaya',
		])
		expect(summary.topPages[0]!.value).toBe('/')
		// The mock sitemap has unindexed pages and a warning.
		expect(summary.warnings).toEqual(
			expect.arrayContaining(['sitemap_warnings', 'pages_not_indexed']),
		)
	})

	it('is hidden and refused while seo.search_console is off', async () => {
		const { organization, cookie } = await setupSeoOrganization()
		const data = (await callLoader(loader, {
			url: seoUrl(organization.slug),
			cookie,
			params: { orgSlug: organization.slug },
		})) as Awaited<ReturnType<typeof loader>>
		expect(data.searchConsole).toBeNull()
		const response = await callAction(action, {
			url: seoUrl(organization.slug),
			cookie,
			params: { orgSlug: organization.slug },
			fields: { intent: 'setup-search-console' },
		})
		expect(response.status).toBe(404)
	})
})

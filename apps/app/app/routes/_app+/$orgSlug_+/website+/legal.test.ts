/**
 * #89 and #260 through the Legal pages screen: one generator creates the
 * privacy, terms, cookie and accessibility pages in every site language,
 * regenerating never overwrites the operator's edits without a diff and a
 * confirm, and the banner mode follows the region and the tracking tags.
 */
import {
	parseLocalizedString,
	serializeLocalizedString,
} from '@repo/common/site-locales'
import {
	db,
	eq,
	Organization,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { describe, expect, it, vi } from 'vitest'
import type * as KvCacheModule from '#app/utils/sites/kv-cache.server.ts'
import { insertTestUser } from '#tests/dashboard-utils.ts'
import {
	createAuthenticatedRequest,
	createTestOrganization,
	createTestSession,
} from '#tests/test-utils.ts'
import {
	action as analyticsAction,
	loader as analyticsLoader,
} from './analytics.tsx'
import { action, loader } from './legal.tsx'

vi.mock('#app/utils/sites/kv-cache.server.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof KvCacheModule>()
	return {
		...actual,
		purgeOrganizationSiteCache: vi.fn(),
		getSiteCacheVersion: vi.fn().mockResolvedValue(null),
	}
})

async function setup(options: { locales?: string[] } = {}) {
	const user = await insertTestUser()
	const organization = await createTestOrganization(user.id, 'admin')
	await db
		.update(Organization)
		.set({
			name: 'Acme Kitchen',
			siteLocales: JSON.stringify(options.locales ?? ['en', 'ar']),
			siteDefaultLocale: 'en',
		})
		.where(eq(Organization.id, organization.id))
	const { cookie } = await createTestSession(user.id)
	return { organization, cookie }
}
type Ctx = Awaited<ReturnType<typeof setup>>

async function post(ctx: Ctx, fields: Record<string, string | string[]>) {
	const body = new URLSearchParams()
	for (const [key, value] of Object.entries(fields)) {
		for (const item of Array.isArray(value) ? value : [value]) {
			body.append(key, item)
		}
	}
	const response = (await action({
		request: createAuthenticatedRequest(
			`http://localhost:3000/${ctx.organization.slug}/website/legal`,
			{ method: 'POST', body },
			ctx.cookie,
		),
		params: { orgSlug: ctx.organization.slug },
		context: {},
	} as never)) as Response
	return {
		status: response.status,
		body: (await response.json()) as Record<string, any>,
	}
}

const saveContact = (ctx: Ctx, extra: Record<string, string> = {}) =>
	post(ctx, {
		intent: 'save-contact',
		legalName: 'Acme Kitchen LLC',
		email: 'hello@acme.example',
		phone: '+1 555 0100',
		address: '1 Main Street',
		country: 'US',
		...extra,
	})

const pageOf = async (ctx: Ctx, kind: string) =>
	(await db.query.WebsitePage.findFirst({
		where: (page, { and, eq }) =>
			and(
				eq(page.organizationId, ctx.organization.id),
				eq(page.legalKind, kind),
			),
	}))!

const sectionsOf = (pageId: string) =>
	db.query.WebsitePageSection.findMany({
		where: eq(WebsitePageSection.pageId, pageId),
		orderBy: (section, { asc }) => [asc(section.position)],
	})

const textOf = (config: string, field: 'title' | 'body', locale: string) =>
	parseLocalizedString(
		(JSON.parse(config) as Record<string, string>)[field],
		'en',
	)[locale] ?? ''

describe('generating legal pages (#89)', () => {
	it('creates privacy, terms and cookie pages in every site language with the restaurant’s details', async () => {
		const ctx = await setup({ locales: ['en', 'ar', 'es'] })
		await saveContact(ctx)
		const result = await post(ctx, {
			intent: 'generate',
			kind: ['privacy', 'terms', 'cookies'],
		})
		expect(result.status).toBe(200)
		expect(result.body.created.sort()).toEqual(['cookies', 'privacy', 'terms'])

		for (const kind of ['privacy', 'terms', 'cookies'] as const) {
			const page = await pageOf(ctx, kind)
			expect(page.slug).toBe(kind)
			expect(page.status).toBe('draft')
			expect(page.legalTemplateVersion).toBe(1)
			expect(page.legalGeneratedHash).toBeTruthy()
			// The title is in every language.
			const titles = parseLocalizedString(page.title, 'en')
			expect(Object.keys(titles).sort()).toEqual(['ar', 'en', 'es'])
			const sections = await sectionsOf(page.id)
			expect(sections.length).toBeGreaterThan(3)
			for (const section of sections) {
				expect(section.type).toBe('content')
				for (const locale of ['en', 'ar', 'es']) {
					expect(textOf(section.config, 'title', locale).trim()).not.toBe('')
					expect(textOf(section.config, 'body', locale).trim()).not.toBe('')
				}
			}
			const english = sections
				.map((s) => textOf(s.config, 'body', 'en'))
				.join('\n')
			expect(english).toContain('hello@acme.example')
			expect(english).toContain('Acme Kitchen')
			const arabic = sections
				.map((s) => textOf(s.config, 'body', 'ar'))
				.join('\n')
			expect(arabic).toContain('hello@acme.example')
		}
	})

	it('needs a contact email, and the accessibility statement a phone number', async () => {
		const ctx = await setup()
		const noEmail = await post(ctx, { intent: 'generate', kind: 'privacy' })
		expect(noEmail.status).toBe(400)
		expect(noEmail.body).toMatchObject({
			error: 'missing_details',
			missing: ['email'],
		})
		expect(
			await db
				.select()
				.from(WebsitePage)
				.where(eq(WebsitePage.organizationId, ctx.organization.id)),
		).toHaveLength(0)

		await saveContact(ctx, { phone: '' })
		const noPhone = await post(ctx, {
			intent: 'generate',
			kind: 'accessibility',
		})
		expect(noPhone.status).toBe(400)
		expect(noPhone.body.missing).toEqual(['phone'])
		// Privacy needs no phone.
		expect(
			(await post(ctx, { intent: 'generate', kind: 'privacy' })).status,
		).toBe(200)
	})

	it('leaves an existing page alone and avoids a slug an operator page uses', async () => {
		const ctx = await setup()
		const user = await insertTestUser()
		await db.insert(WebsitePage).values({
			organizationId: ctx.organization.id,
			createdById: user.id,
			title: 'My own terms',
			slug: 'terms',
		})
		await saveContact(ctx)
		const first = await post(ctx, { intent: 'generate', kind: 'terms' })
		expect(first.body.created).toEqual(['terms'])
		expect((await pageOf(ctx, 'terms')).slug).toBe('terms-policy')
		const second = await post(ctx, { intent: 'generate', kind: 'terms' })
		expect(second.body).toMatchObject({ created: [], skipped: ['terms'] })
	})

	it('reflects the features that are on', async () => {
		const ctx = await setup({ locales: ['en'] })
		await saveContact(ctx, {
			refundText: 'Refunds within 7 days.',
			reservationText: 'Deposits are 10 USD.',
		})
		await db
			.update(Organization)
			.set({ facebookPixelId: '1234567890' })
			.where(eq(Organization.id, ctx.organization.id))
		await post(ctx, { intent: 'generate', kind: ['terms', 'cookies'] })
		const terms = (await sectionsOf((await pageOf(ctx, 'terms')).id))
			.map((s) => textOf(s.config, 'body', 'en'))
			.join('\n')
		expect(terms).toContain('Refunds within 7 days.')
		const cookies = (await sectionsOf((await pageOf(ctx, 'cookies')).id))
			.map((s) => textOf(s.config, 'body', 'en'))
			.join('\n')
		expect(cookies).toContain('Meta Pixel')
	})
})

describe('regenerating (#89)', () => {
	async function generated() {
		const ctx = await setup({ locales: ['en', 'ar'] })
		await saveContact(ctx)
		await post(ctx, { intent: 'generate', kind: 'privacy' })
		return ctx
	}

	it('an untouched page regenerates straight away, as a draft', async () => {
		const ctx = await generated()
		await saveContact(ctx, { email: 'new@acme.example' })
		const plan = await post(ctx, {
			intent: 'preview-regenerate',
			kind: 'privacy',
		})
		expect(plan.body).toMatchObject({ status: 'plan', edited: false })
		const done = await post(ctx, { intent: 'regenerate', kind: 'privacy' })
		expect(done.status).toBe(200)
		const english = (await sectionsOf((await pageOf(ctx, 'privacy')).id))
			.map((s) => textOf(s.config, 'body', 'en'))
			.join('\n')
		expect(english).toContain('new@acme.example')
		expect(english).not.toContain('hello@acme.example')
		// Still a draft: nothing is published by regenerating.
		expect((await pageOf(ctx, 'privacy')).status).toBe('draft')
	})

	it('never overwrites the operator’s edits without a diff and a confirm', async () => {
		const ctx = await generated()
		const page = await pageOf(ctx, 'privacy')
		const [first] = await sectionsOf(page.id)
		const edited = {
			...(JSON.parse(first!.config) as Record<string, string>),
			body: serializeLocalizedString({
				en: 'Our own lawyer wrote this.',
				ar: 'كتبه محامينا.',
			}),
		}
		await db
			.update(WebsitePageSection)
			.set({ config: JSON.stringify(edited) })
			.where(eq(WebsitePageSection.id, first!.id))
		await saveContact(ctx, { email: 'new@acme.example' })

		const plan = await post(ctx, {
			intent: 'preview-regenerate',
			kind: 'privacy',
		})
		expect(plan.body.edited).toBe(true)
		const diffEn = plan.body.diffs.en as Array<{ kind: string; text: string }>
		expect(
			diffEn.some(
				(l) => l.kind === 'removed' && l.text.includes('Our own lawyer'),
			),
		).toBe(true)
		expect(diffEn.some((l) => l.kind === 'added')).toBe(true)
		expect(Object.keys(plan.body.diffs).sort()).toEqual(['ar', 'en'])

		const refused = await post(ctx, { intent: 'regenerate', kind: 'privacy' })
		expect(refused.status).toBe(409)
		expect(refused.body.error).toBe('edited_needs_confirm')
		const stillEdited = (await sectionsOf(page.id))[0]!
		expect(textOf(stillEdited.config, 'body', 'en')).toBe(
			'Our own lawyer wrote this.',
		)

		const confirmed = await post(ctx, {
			intent: 'regenerate',
			kind: 'privacy',
			confirm: 'true',
		})
		expect(confirmed.status).toBe(200)
		const replaced = (await sectionsOf(page.id))[0]!
		expect(textOf(replaced.config, 'body', 'en')).not.toContain(
			'Our own lawyer',
		)
	})

	it('the list says what exists, what was edited and what is outdated', async () => {
		const ctx = await generated()
		const read = async () =>
			(await loader({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${ctx.organization.slug}/website/legal`,
					{},
					ctx.cookie,
				),
				params: { orgSlug: ctx.organization.slug },
				context: {},
			} as never)) as unknown as {
				pages: Array<{
					kind: string
					status: string
					edited: boolean
					outdated: boolean
				}>
			}
		let pages = Object.fromEntries((await read()).pages.map((p) => [p.kind, p]))
		expect(pages.privacy).toMatchObject({
			status: 'draft',
			edited: false,
			outdated: false,
		})
		expect(pages.terms).toMatchObject({ status: 'missing' })
		const page = await pageOf(ctx, 'privacy')
		const [first] = await sectionsOf(page.id)
		await db
			.update(WebsitePageSection)
			.set({ config: first!.config.replace('Who we are', 'Who we really are') })
			.where(eq(WebsitePageSection.id, first!.id))
		// Pretend the page was made from an older template.
		await db
			.update(WebsitePage)
			.set({ legalTemplateVersion: 0 })
			.where(eq(WebsitePage.id, page.id))
		pages = Object.fromEntries((await read()).pages.map((p) => [p.kind, p]))
		expect(pages.privacy).toMatchObject({ edited: true, outdated: true })
	})
})

describe('the accessibility statement (#260)', () => {
	it('is generated by the same generator, in each site language, naming phone and email', async () => {
		const ctx = await setup({ locales: ['en', 'ar', 'fr', 'de', 'es', 'zh'] })
		await saveContact(ctx)
		const result = await post(ctx, {
			intent: 'generate',
			kind: 'accessibility',
		})
		expect(result.body.created).toEqual(['accessibility'])
		const page = await pageOf(ctx, 'accessibility')
		expect(page.slug).toBe('accessibility')
		const sections = await sectionsOf(page.id)
		for (const locale of ['en', 'ar', 'fr', 'de', 'es', 'zh']) {
			const text = sections
				.map((s) => textOf(s.config, 'body', locale))
				.join('\n')
			expect(text).toContain('+1 555 0100')
			expect(text).toContain('hello@acme.example')
			expect(text).not.toMatch(/\{\w+\}/)
		}
		const english = sections
			.map((s) => textOf(s.config, 'body', 'en'))
			.join('\n')
		expect(english).toContain('WCAG) 2.2, level AA')
		// Editable like any page: edits are detected, not overwritten silently.
		const [first] = sections
		await db
			.update(WebsitePageSection)
			.set({ config: first!.config.replace('Our commitment', 'Our promise') })
			.where(eq(WebsitePageSection.id, first!.id))
		const plan = await post(ctx, {
			intent: 'preview-regenerate',
			kind: 'accessibility',
		})
		expect(plan.body.edited).toBe(true)
	})

	it('mentions embeds and a PDF menu automatically when the site has them', async () => {
		const ctx = await setup({ locales: ['en'] })
		await saveContact(ctx)
		const user = await insertTestUser()
		const [page] = await db
			.insert(WebsitePage)
			.values({
				organizationId: ctx.organization.id,
				createdById: user.id,
				title: 'Menu',
				slug: 'menu-page',
			})
			.returning({ id: WebsitePage.id })
		await db.insert(WebsitePageSection).values([
			{ pageId: page!.id, type: 'embed', position: 0, config: '{}' },
			{
				pageId: page!.id,
				type: 'content',
				position: 1,
				config: JSON.stringify({ ctaUrl: '/files/menu.pdf' }),
			},
		])
		await post(ctx, { intent: 'generate', kind: 'accessibility' })
		const text = (await sectionsOf((await pageOf(ctx, 'accessibility')).id))
			.map((s) => textOf(s.config, 'body', 'en'))
			.join('\n')
		expect(text).toContain('booking or video widgets')
		expect(text).toContain('menu is also offered as a PDF')
	})
})

describe('the cookie banner setting (#89)', () => {
	const readConsent = async (ctx: Ctx) =>
		(
			(await analyticsLoader({
				request: createAuthenticatedRequest(
					`http://localhost:3000/${ctx.organization.slug}/website/analytics`,
					{},
					ctx.cookie,
				),
				params: { orgSlug: ctx.organization.slug },
				context: {},
			} as never)) as unknown as {
				consent: {
					stored: string | null
					effective: string
					region: string
					hasTrackingTags: boolean
				}
			}
		).consent

	const save = async (ctx: Ctx, mode: string) => {
		const response = (await analyticsAction({
			request: createAuthenticatedRequest(
				`http://localhost:3000/${ctx.organization.slug}/website/analytics`,
				{
					method: 'POST',
					body: new URLSearchParams({ intent: 'update-consent-mode', mode }),
				},
				ctx.cookie,
			),
			params: { orgSlug: ctx.organization.slug },
			context: {},
		} as never)) as Response
		return {
			status: response.status,
			body: (await response.json()) as Record<string, any>,
		}
	}

	it('defaults to Required in the EU, UK and KSA and Notice only in the US', async () => {
		const us = await setup({ locales: ['en'] })
		await saveContact(us, { country: 'US' })
		expect(await readConsent(us)).toMatchObject({
			region: 'us',
			effective: 'notice',
		})
		const de = await setup({ locales: ['en'] })
		await saveContact(de, { country: 'DE' })
		expect(await readConsent(de)).toMatchObject({
			region: 'eu',
			effective: 'required',
		})
		const ksa = await setup({ locales: ['en'] })
		await db
			.update(Organization)
			.set({ dataRegion: 'ksa' })
			.where(eq(Organization.id, ksa.organization.id))
		expect(await readConsent(ksa)).toMatchObject({
			region: 'ksa',
			effective: 'required',
		})
	})

	it('the operator can choose, but Off is refused while a tracking tag is set', async () => {
		const ctx = await setup({ locales: ['en'] })
		await saveContact(ctx, { country: 'US' })
		expect((await save(ctx, 'required')).status).toBe(200)
		expect(await readConsent(ctx)).toMatchObject({
			stored: 'required',
			effective: 'required',
		})
		expect((await save(ctx, 'off')).status).toBe(200)
		expect((await readConsent(ctx)).effective).toBe('off')

		await db
			.update(Organization)
			.set({ googleAnalyticsId: 'G-ABC123' })
			.where(eq(Organization.id, ctx.organization.id))
		// A tag set while Off is in force makes the site Required instead.
		expect((await readConsent(ctx)).effective).toBe('required')
		const refused = await save(ctx, 'off')
		expect(refused.status).toBe(400)
		expect(refused.body.error).toBe('tags_need_consent')
		expect((await save(ctx, 'sideways')).status).toBe(400)
	})
})

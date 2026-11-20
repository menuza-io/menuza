import { createId } from '@paralleldrive/cuid2'
import { parseLocalizedString } from '@repo/common/site-locales'
import {
	db,
	eq,
	SiteExperiment,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { describe, expect, it } from 'vitest'
import { setupTestOrgWithUser } from '#tests/test-utils.ts'
import {
	applyExperiment,
	endExperiment,
	runningExperimentForPage,
	startExperiment,
	sweepExperiments,
	type ArmReader,
} from './experiments.server.ts'

const HERO = {
	heading: JSON.stringify({ en: 'Welcome', ar: 'أهلا' }),
	subheading: 'Fresh food',
	minHeight: 560,
}

async function setup(status: 'published' | 'draft' = 'published') {
	const { user, organization } = await setupTestOrgWithUser('admin')
	const pageId = createId()
	const sectionId = createId()
	await db.insert(WebsitePage).values({
		id: pageId,
		organizationId: organization.id,
		title: 'Home',
		slug: 'home',
		status,
		template: 'restaurant',
		isHomePage: false,
		publishedData: JSON.stringify([
			{
				id: sectionId,
				type: 'hero',
				position: 0,
				config: JSON.stringify(HERO),
			},
		]),
	})
	await db.insert(WebsitePageSection).values({
		id: sectionId,
		pageId,
		type: 'hero',
		position: 0,
		config: JSON.stringify({ ...HERO, heading: 'draft edit pending' }),
	})
	return {
		userId: user.id,
		organization: { id: organization.id, dataRegion: 'us' as string | null },
		pageId,
		sectionId,
	}
}

const edits = [{ path: 'heading', value: 'Order dinner tonight' }]
const NOW = new Date(Date.UTC(2026, 10, 20, 12))

describe('A/B tests (#338)', () => {
	it("starts a test of a published page's section and serves variant B", async () => {
		const ctx = await setup()
		const started = await startExperiment({
			...ctx,
			name: 'Headline',
			edits,
			locale: 'en',
			now: NOW,
		})
		expect(started.ok).toBe(true)
		const running = await runningExperimentForPage(
			ctx.organization.id,
			ctx.pageId,
			NOW,
		)
		expect(running?.sectionId).toBe(ctx.sectionId)
		const variant = running!.variantConfig as {
			heading: string
			minHeight: number
		}
		expect(parseLocalizedString(variant.heading).en).toBe(
			'Order dinner tonight',
		)
		expect(variant.minHeight).toBe(560)
	})

	it('refuses an unpublished page, a missing section, a no-op and a foreign path', async () => {
		const draft = await setup('draft')
		expect(
			await startExperiment({ ...draft, name: 'x', edits, locale: 'en' }),
		).toEqual({ ok: false, error: 'page_not_published' })
		const ctx = await setup()
		expect(
			await startExperiment({
				...ctx,
				sectionId: 'nope',
				name: 'x',
				edits,
				locale: 'en',
			}),
		).toEqual({ ok: false, error: 'section_not_found' })
		expect(
			await startExperiment({ ...ctx, name: 'x', edits: [], locale: 'en' }),
		).toEqual({ ok: false, error: 'no_change' })
		expect(
			await startExperiment({
				...ctx,
				name: 'x',
				edits: [{ path: 'minHeight', value: '1' }],
				locale: 'en',
			}),
		).toEqual({ ok: false, error: 'invalid_edit' })
		// Another organization's page is not found.
		const other = await setup()
		expect(
			await startExperiment({
				...ctx,
				pageId: other.pageId,
				sectionId: other.sectionId,
				name: 'x',
				edits,
				locale: 'en',
			}),
		).toEqual({ ok: false, error: 'page_not_published' })
	})

	it('refuses a section that is not a text block', async () => {
		const ctx = await setup()
		await db
			.update(WebsitePage)
			.set({
				publishedData: JSON.stringify([
					{
						id: ctx.sectionId,
						type: 'contact',
						position: 0,
						config: JSON.stringify({ heading: 'Hi' }),
					},
				]),
			})
			.where(eq(WebsitePage.id, ctx.pageId))
		expect(
			await startExperiment({
				...ctx,
				name: 'x',
				edits: [{ path: 'heading', value: 'Hello' }],
				locale: 'en',
			}),
		).toEqual({ ok: false, error: 'section_not_testable' })
	})

	it('runs one test per page', async () => {
		const ctx = await setup()
		expect(
			(await startExperiment({ ...ctx, name: 'one', edits, locale: 'en' })).ok,
		).toBe(true)
		expect(
			await startExperiment({ ...ctx, name: 'two', edits, locale: 'en' }),
		).toEqual({ ok: false, error: 'already_running' })
	})

	it('ends by itself after 60 days', async () => {
		const ctx = await setup()
		const started = await startExperiment({
			...ctx,
			name: 'x',
			edits,
			locale: 'en',
			now: NOW,
		})
		const later = new Date(NOW.getTime() + 61 * 86_400_000)
		expect(
			await runningExperimentForPage(ctx.organization.id, ctx.pageId, later),
		).toBeNull()
		const [row] = await db
			.select()
			.from(SiteExperiment)
			.where(eq(SiteExperiment.id, (started as { id: string }).id))
		expect(row).toMatchObject({ status: 'ended', endReason: 'expired' })
	})

	it('the sweep ends a test at the visitor cap and leaves a young one running', async () => {
		const ctx = await setup()
		const started = (await startExperiment({
			...ctx,
			name: 'x',
			edits,
			locale: 'en',
			now: NOW,
		})) as { id: string }
		const few: ArmReader = async () => ({
			a: { visits: 10, orders: 1 },
			b: { visits: 10, orders: 1 },
		})
		expect((await sweepExperiments(few, NOW)).ended).toBe(0)
		const many: ArmReader = async () => ({
			a: { visits: 30_000, orders: 1 },
			b: { visits: 30_000, orders: 1 },
		})
		expect((await sweepExperiments(many, NOW)).ended).toBeGreaterThanOrEqual(1)
		const [row] = await db
			.select()
			.from(SiteExperiment)
			.where(eq(SiteExperiment.id, started.id))
		expect(row).toMatchObject({ status: 'ended', endReason: 'visitor_cap' })
	})

	it('applying the winner replaces the original and ends the test, publishing nothing else', async () => {
		const ctx = await setup()
		const started = (await startExperiment({
			...ctx,
			name: 'x',
			edits,
			locale: 'en',
			now: NOW,
		})) as { id: string }
		const result = await applyExperiment({
			organization: ctx.organization,
			userId: ctx.userId,
			experimentId: started.id,
			arm: 'b',
			now: NOW,
		})
		expect(result).toEqual({ ok: true })
		const [page] = await db
			.select()
			.from(WebsitePage)
			.where(eq(WebsitePage.id, ctx.pageId))
		const live = JSON.parse(page!.publishedData!) as Array<{ config: string }>
		expect(
			parseLocalizedString(
				(JSON.parse(live[0]!.config) as { heading: string }).heading,
			).en,
		).toBe('Order dinner tonight')
		// The editor's working copy follows the winner.
		const [draft] = await db
			.select()
			.from(WebsitePageSection)
			.where(eq(WebsitePageSection.id, ctx.sectionId))
		expect(
			parseLocalizedString(
				(JSON.parse(draft!.config) as { heading: string }).heading,
			).en,
		).toBe('Order dinner tonight')
		const [row] = await db
			.select()
			.from(SiteExperiment)
			.where(eq(SiteExperiment.id, started.id))
		expect(row).toMatchObject({
			status: 'applied',
			winner: 'b',
			endReason: 'applied',
		})
		expect(
			await runningExperimentForPage(ctx.organization.id, ctx.pageId, NOW),
		).toBeNull()
		// Applying again does nothing.
		expect(
			await applyExperiment({
				organization: ctx.organization,
				userId: ctx.userId,
				experimentId: started.id,
				arm: 'b',
			}),
		).toEqual({ ok: false, error: 'not_running' })
	})

	it('choosing A ends the test and leaves the page alone', async () => {
		const ctx = await setup()
		const started = (await startExperiment({
			...ctx,
			name: 'x',
			edits,
			locale: 'en',
		})) as { id: string }
		await applyExperiment({
			organization: ctx.organization,
			userId: ctx.userId,
			experimentId: started.id,
			arm: 'a',
		})
		const [page] = await db
			.select()
			.from(WebsitePage)
			.where(eq(WebsitePage.id, ctx.pageId))
		const live = JSON.parse(page!.publishedData!) as Array<{ config: string }>
		expect(
			parseLocalizedString(
				(JSON.parse(live[0]!.config) as { heading: string }).heading,
			).en,
		).toBe('Welcome')
		const [row] = await db
			.select()
			.from(SiteExperiment)
			.where(eq(SiteExperiment.id, started.id))
		expect(row).toMatchObject({ status: 'applied', winner: 'a' })
	})

	it('a manual end keeps the original and another organization cannot end it', async () => {
		const ctx = await setup()
		const other = await setup()
		const started = (await startExperiment({
			...ctx,
			name: 'x',
			edits,
			locale: 'en',
		})) as { id: string }
		expect(
			await endExperiment({
				organizationId: other.organization.id,
				experimentId: started.id,
				reason: 'manual',
			}),
		).toBe(false)
		expect(
			await endExperiment({
				organizationId: ctx.organization.id,
				experimentId: started.id,
				reason: 'manual',
			}),
		).toBe(true)
	})
})

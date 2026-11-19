/**
 * Website, SEO, Keywords (#182): ten keywords per location, one primary,
 * duplicates refused; the weekly rank check stores a grid and its average,
 * skips (and reports) checks over the monthly budget, and the screen shows
 * the history. The rank provider is a test double.
 */
import {
	and,
	db,
	eq,
	OrganizationLocation,
	SeoKeyword,
	SeoRankCheck,
	SeoUsage,
} from '@repo/database'
import { RouterContextProvider } from 'react-router'
import { ENV } from 'varlock/env'
import { afterEach, describe, expect, it } from 'vitest'
import { action as jobAction } from '#app/routes/resources+/jobs.seo-rank-check.ts'
import {
	type RankQuery,
	runOrganizationRankChecks,
	setRankProvider,
} from '#app/utils/seo/rank-tracking.server.ts'
import {
	callAction,
	callLoader,
	setOrgFlag,
	setupSeoOrganization,
} from '#tests/seo-utils.ts'
import { action, loader } from './seo.keywords.tsx'

afterEach(() => setRankProvider(undefined))

async function setup(options: { coordinates?: boolean; flag?: boolean } = {}) {
	const ctx = await setupSeoOrganization()
	if (options.flag !== false) {
		await setOrgFlag(ctx.organization.id, 'seo.rank_tracking', true)
	}
	const [location] = await db
		.insert(OrganizationLocation)
		.values({
			organizationId: ctx.organization.id,
			name: 'Olaya',
			slug: 'olaya',
			timezone: 'Asia/Riyadh',
			address: JSON.stringify(
				options.coordinates === false
					? { city: 'Riyadh' }
					: { city: 'Riyadh', lat: 24.7, lng: 46.68 },
			),
		})
		.returning({ id: OrganizationLocation.id })
	return { ...ctx, locationId: location!.id }
}

const url = (slug: string) =>
	`http://localhost:3000/${slug}/website/seo/keywords`

async function add(
	ctx: Awaited<ReturnType<typeof setup>>,
	phrase: string,
	extra: Record<string, string> = {},
) {
	return callAction(action, {
		url: url(ctx.organization.slug),
		cookie: ctx.cookie,
		params: { orgSlug: ctx.organization.slug },
		fields: {
			intent: 'add-keyword',
			locationId: ctx.locationId,
			phrase,
			...extra,
		},
	})
}

async function keywords(organizationId: string) {
	return db
		.select()
		.from(SeoKeyword)
		.where(eq(SeoKeyword.organizationId, organizationId))
}

describe('keywords', () => {
	it('takes up to ten per location, the first primary, and refuses duplicates', async () => {
		const ctx = await setup()
		expect((await add(ctx, 'Shawarma Near Me')).status).toBe(200)
		const duplicate = await add(ctx, 'shawarma   near me')
		expect(duplicate.status).toBe(400)
		expect(await duplicate.json()).toMatchObject({ error: 'keyword_exists' })
		for (let i = 1; i < 10; i++) {
			expect((await add(ctx, `keyword number ${i}`)).status).toBe(200)
		}
		const eleventh = await add(ctx, 'one too many')
		expect(eleventh.status).toBe(400)
		expect(await eleventh.json()).toMatchObject({ error: 'too_many_keywords' })

		const rows = await keywords(ctx.organization.id)
		expect(rows).toHaveLength(10)
		expect(
			rows.filter((row) => row.isPrimary).map((row) => row.phrase),
		).toEqual(['shawarma near me'])
	})

	it('keeps exactly one primary and links a keyword to a page', async () => {
		const ctx = await setup()
		await add(ctx, 'lebanese restaurant riyadh')
		await add(ctx, 'مطعم لبناني الرياض')
		const [, second] = (await keywords(ctx.organization.id)).sort((a, b) =>
			a.createdAt < b.createdAt ? -1 : 1,
		)
		expect(second!.locale).toBe('ar')
		const primary = await callAction(action, {
			url: url(ctx.organization.slug),
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug },
			fields: { intent: 'set-primary', keywordId: second!.id },
		})
		expect(primary.status).toBe(200)
		const page = await callAction(action, {
			url: url(ctx.organization.slug),
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug },
			fields: {
				intent: 'set-page',
				keywordId: second!.id,
				pageRef: `location:${ctx.locationId}`,
			},
		})
		expect(page.status).toBe(200)
		const rows = await keywords(ctx.organization.id)
		expect(rows.filter((row) => row.isPrimary).map((row) => row.id)).toEqual([
			second!.id,
		])
		expect(rows.find((row) => row.id === second!.id)!.pageRef).toBe(
			`location:${ctx.locationId}`,
		)
	})

	it('is a 404 while seo.rank_tracking is off, and refuses another organization', async () => {
		const off = await setup({ flag: false })
		expect((await add(off, 'shawarma near me')).status).toBe(404)
		const ctx = await setup()
		const other = await setup()
		const forged = await callAction(action, {
			url: url(ctx.organization.slug),
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug },
			fields: {
				intent: 'add-keyword',
				locationId: other.locationId,
				phrase: 'not mine',
			},
		})
		expect(forged.status).toBe(404)
	})
})

describe('weekly rank check', () => {
	it('stores a grid of ranks and an average, and the screen shows history', async () => {
		const ctx = await setup()
		await add(ctx, 'shawarma near me')
		const queries: RankQuery[] = []
		setRankProvider({
			name: 'test',
			async checkGrid(query) {
				queries.push(query)
				// Found at rank 2 in the middle, not in the top 20 elsewhere.
				return query.points.map((_, index) =>
					index === 12 ? 2 : index < 12 ? 5 : null,
				)
			},
		})
		const first = new Date('2026-11-02T03:00:00Z')
		expect(
			await runOrganizationRankChecks(
				{ id: ctx.organization.id, name: 'Al Bait', customDomain: null },
				first,
			),
		).toMatchObject({ checked: 1 })
		expect(queries[0]!.points).toHaveLength(25)
		expect(queries[0]!.locale).toBe('en')
		// A day later it is not due; a week later it is.
		await runOrganizationRankChecks(
			{ id: ctx.organization.id, name: 'Al Bait', customDomain: null },
			new Date('2026-11-03T03:00:00Z'),
		)
		await runOrganizationRankChecks(
			{ id: ctx.organization.id, name: 'Al Bait', customDomain: null },
			new Date('2026-11-09T03:00:00Z'),
		)
		const checks = await db
			.select()
			.from(SeoRankCheck)
			.where(eq(SeoRankCheck.organizationId, ctx.organization.id))
		expect(checks).toHaveLength(2)
		const points = JSON.parse(checks[0]!.points) as Array<{
			rank: number | null
		}>
		expect(points).toHaveLength(25)
		expect(points[12]!.rank).toBe(2)
		expect(points[24]!.rank).toBeNull()
		// 12 x 5 + 2 + 12 x 21 (not found) over 25 points.
		expect(checks[0]!.averageRank).toBe(12.6)

		const data = (await callLoader(loader, {
			url: url(ctx.organization.slug),
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug },
		})) as Awaited<ReturnType<typeof loader>>
		const keyword = data.locations[0]!.keywords[0]!
		expect(keyword.history).toHaveLength(2)
		expect(keyword.history[0]).toMatchObject({
			status: 'ok',
			averageRank: 12.6,
			gridSize: 5,
		})
		expect(keyword.history[0]!.points).toHaveLength(25)
	})

	it('skips and reports a check when the monthly budget is used up', async () => {
		const ctx = await setup()
		await setOrgFlag(ctx.organization.id, 'seo.rank_budget', 1)
		await add(ctx, 'shawarma near me')
		await add(ctx, 'falafel riyadh')
		setRankProvider({
			name: 'test',
			checkGrid: async (q) => q.points.map(() => 3),
		})
		const outcome = await runOrganizationRankChecks(
			{ id: ctx.organization.id, name: 'Al Bait', customDomain: null },
			new Date('2026-11-02T03:00:00Z'),
		)
		expect(outcome).toMatchObject({ checked: 1, skipped_budget: 1 })
		const checks = await db
			.select({ status: SeoRankCheck.status, reason: SeoRankCheck.reason })
			.from(SeoRankCheck)
			.where(eq(SeoRankCheck.organizationId, ctx.organization.id))
		expect(checks).toEqual(
			expect.arrayContaining([
				{ status: 'ok', reason: null },
				{ status: 'skipped', reason: 'budget_exhausted' },
			]),
		)
		const [usage] = await db
			.select()
			.from(SeoUsage)
			.where(
				and(
					eq(SeoUsage.organizationId, ctx.organization.id),
					eq(SeoUsage.month, '2026-11'),
				),
			)
		expect(usage).toMatchObject({ checks: 1, skipped: 1 })
		const data = (await callLoader(loader, {
			url: url(ctx.organization.slug),
			cookie: ctx.cookie,
			params: { orgSlug: ctx.organization.slug },
		})) as Awaited<ReturnType<typeof loader>>
		expect(data.usage).toEqual({ used: 1, budget: 1 })
		expect(
			data.locations[0]!.keywords.flatMap((k) =>
				k.history.map((h) => h.reason),
			),
		).toContain('budget_exhausted')
	})

	it('skips a location without coordinates and never calls the provider for it', async () => {
		const ctx = await setup({ coordinates: false })
		await add(ctx, 'shawarma near me')
		setRankProvider({
			name: 'test',
			checkGrid: async () => {
				throw new Error('must not be called')
			},
		})
		const outcome = await runOrganizationRankChecks(
			{ id: ctx.organization.id, name: 'Al Bait', customDomain: null },
			new Date('2026-11-02T03:00:00Z'),
		)
		expect(outcome).toMatchObject({ checked: 0, skipped_coordinates: 1 })
	})

	it('runs from the jobs-cron route with the internal token only', async () => {
		const call = (authorized: boolean) => {
			const jobUrl = new URL(
				'http://localhost:3001/resources/jobs/seo-rank-check',
			)
			return jobAction({
				request: new Request(jobUrl, {
					method: 'POST',
					headers: authorized
						? { Authorization: `Bearer ${ENV.INTERNAL_COMMAND_TOKEN}` }
						: {},
				}),
				params: {},
				context: new RouterContextProvider(),
				url: jobUrl,
				pattern: '/resources/jobs/seo-rank-check',
			} as never) as Promise<Response>
		}
		await expect(call(false)).rejects.toMatchObject({ status: 401 })
		setRankProvider({
			name: 'test',
			checkGrid: async (q) => q.points.map(() => 1),
		})
		const response = await call(true)
		expect(response.status).toBe(200)
		expect(await response.json()).toMatchObject({ success: true })
	})
})

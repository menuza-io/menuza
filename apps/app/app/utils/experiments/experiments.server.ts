import { createId } from '@paralleldrive/cuid2'
import {
	EXPERIMENT_MAX_DAYS,
	experimentResult,
	experimentShouldEnd,
	type ExperimentResult,
} from '@repo/common/site-funnel'
import {
	and,
	db,
	eq,
	Organization,
	SiteExperiment,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { isLockedBlockType } from '#app/utils/website/block-types.ts'
import {
	insertVersionStatement,
	pruneVersionsStatement,
} from '#app/utils/website/versions.server.ts'
import {
	hashSections,
	parseSnapshotSections,
	summarizeSectionChange,
} from '#app/utils/website/versions.ts'
import { applyTextEdits, variantDiffers } from './section-texts.ts'

type Org = { id: string; dataRegion: string | null }

/**
 * Sections a test may target: text blocks with no script of their own, so
 * swapping variant B in needs nothing to be re-initialised (forms, booking,
 * rewards and the live menu blocks are out).
 */
export const TESTABLE_SECTION_TYPES = new Set([
	'hero',
	'content',
	'cta',
	'features',
	'cards',
	'testimonials',
	'faq',
	'gallery',
	'scrollingStrip',
	'reviews',
])

export type StartResult =
	| { ok: true; id: string }
	| {
			ok: false
			error:
				| 'page_not_published'
				| 'section_not_found'
				| 'section_not_testable'
				| 'invalid_edit'
				| 'no_change'
				| 'already_running'
	  }

/**
 * Starts a test of one section of a published page (#338): variant B is the
 * live section with some of its texts changed. One test runs per page; it ends
 * by itself after 60 days. Nothing about the page changes for visitors who see
 * A, which is the live section.
 */
export async function startExperiment(input: {
	organization: Org
	userId: string
	pageId: string
	sectionId: string
	name: string
	edits: ReadonlyArray<{ path: string; value: string }>
	locale: string
	now?: Date
}): Promise<StartResult> {
	const now = input.now ?? new Date()
	const [page] = await db
		.select({
			status: WebsitePage.status,
			publishedData: WebsitePage.publishedData,
		})
		.from(WebsitePage)
		.where(
			and(
				eq(WebsitePage.id, input.pageId),
				eq(WebsitePage.organizationId, input.organization.id),
			),
		)
		.limit(1)
	if (!page || page.status !== 'published' || !page.publishedData) {
		return { ok: false, error: 'page_not_published' }
	}
	const section = parseSnapshotSections(page.publishedData).find(
		(candidate) => candidate.id === input.sectionId,
	)
	if (!section) return { ok: false, error: 'section_not_found' }
	if (
		isLockedBlockType(section.type as never) ||
		!TESTABLE_SECTION_TYPES.has(section.type)
	) {
		return { ok: false, error: 'section_not_testable' }
	}
	let original: unknown
	try {
		original = JSON.parse(section.config)
	} catch {
		return { ok: false, error: 'section_not_testable' }
	}
	const variant = applyTextEdits(
		section.type,
		original,
		input.edits,
		input.locale,
	)
	if (!variant) return { ok: false, error: 'invalid_edit' }
	if (!variantDiffers(original, variant))
		return { ok: false, error: 'no_change' }
	const id = createId()
	try {
		await db.insert(SiteExperiment).values({
			id,
			organizationId: input.organization.id,
			pageId: input.pageId,
			sectionId: input.sectionId,
			name: input.name.trim().slice(0, 120) || 'Untitled test',
			status: 'running',
			variantConfig: JSON.stringify(variant),
			startedAt: now,
			expiresAt: new Date(now.getTime() + EXPERIMENT_MAX_DAYS * 86_400_000),
			createdById: input.userId,
		})
	} catch (error) {
		// The partial unique index: a test is already running on this page.
		const text = (value: unknown): string =>
			value instanceof Error
				? `${value.message} ${text((value as { cause?: unknown }).cause)}`
				: String(value ?? '')
		if (text(error).includes('UNIQUE')) {
			return { ok: false, error: 'already_running' }
		}
		throw error
	}
	return { ok: true, id }
}

export async function endExperiment(input: {
	organizationId: string
	experimentId: string
	reason: 'manual' | 'expired' | 'visitor_cap'
	winner?: 'a' | 'b' | null
	now?: Date
}): Promise<boolean> {
	const updated = await db
		.update(SiteExperiment)
		.set({
			status: 'ended',
			endedAt: input.now ?? new Date(),
			endReason: input.reason,
			winner: input.winner ?? null,
		})
		.where(
			and(
				eq(SiteExperiment.id, input.experimentId),
				eq(SiteExperiment.organizationId, input.organizationId),
				eq(SiteExperiment.status, 'running'),
			),
		)
		.returning({ id: SiteExperiment.id })
	return updated.length > 0
}

/**
 * Applies the chosen arm and ends the test (#338). Choosing B replaces the
 * original section: the live snapshot (with a new immutable version, like a
 * publish) and the editor's draft section both take variant B, and nothing
 * else on the page is published. Choosing A just ends the test. One atomic
 * batch; a test that already ended applies nothing.
 */
export async function applyExperiment(input: {
	organization: Org
	userId: string
	experimentId: string
	arm: 'a' | 'b'
	now?: Date
}): Promise<
	| { ok: true }
	| { ok: false; error: 'not_found' | 'not_running' | 'section_missing' }
> {
	const now = input.now ?? new Date()
	const [experiment] = await db
		.select()
		.from(SiteExperiment)
		.where(
			and(
				eq(SiteExperiment.id, input.experimentId),
				eq(SiteExperiment.organizationId, input.organization.id),
			),
		)
		.limit(1)
	if (!experiment) return { ok: false, error: 'not_found' }
	if (experiment.status !== 'running')
		return { ok: false, error: 'not_running' }

	const finish = db
		.update(SiteExperiment)
		.set({
			status: 'applied',
			endedAt: now,
			endReason: 'applied',
			winner: input.arm,
		})
		.where(
			and(
				eq(SiteExperiment.id, experiment.id),
				eq(SiteExperiment.status, 'running'),
			),
		)
	if (input.arm === 'a') {
		await finish
		return { ok: true }
	}

	const [page] = await db
		.select({
			organizationId: WebsitePage.organizationId,
			title: WebsitePage.title,
			slug: WebsitePage.slug,
			publishedData: WebsitePage.publishedData,
		})
		.from(WebsitePage)
		.where(eq(WebsitePage.id, experiment.pageId))
		.limit(1)
	if (!page?.publishedData) return { ok: false, error: 'section_missing' }
	const previous = parseSnapshotSections(page.publishedData)
	if (!previous.some((section) => section.id === experiment.sectionId)) {
		return { ok: false, error: 'section_missing' }
	}
	const next = previous.map((section) =>
		section.id === experiment.sectionId
			? { ...section, config: experiment.variantConfig }
			: section,
	)
	const snapshot = JSON.stringify(next)
	const { statement: version } = insertVersionStatement(db, {
		organizationId: page.organizationId,
		pageId: experiment.pageId,
		kind: 'page',
		title: page.title,
		slug: page.slug,
		snapshot,
		contentHash: await hashSections(next),
		summary: summarizeSectionChange(previous, next),
		publishedById: input.userId,
	})
	await db.batch([
		finish,
		db
			.update(WebsitePage)
			.set({ publishedData: snapshot })
			.where(eq(WebsitePage.id, experiment.pageId)),
		// The editor's working copy follows, so the next publish keeps the winner.
		db
			.update(WebsitePageSection)
			.set({ config: experiment.variantConfig })
			.where(eq(WebsitePageSection.id, experiment.sectionId)),
		version,
		pruneVersionsStatement(db, {
			organizationId: page.organizationId,
			kind: 'page',
			pageId: experiment.pageId,
		}),
	] as unknown as Parameters<typeof db.batch>[0])
	return { ok: true }
}

export type PublicExperiment = {
	id: string
	sectionId: string
	/** Variant B's section config, localized like the section itself. */
	variantConfig: unknown
}

/**
 * The running test of a page for the public site, or null. A test past its
 * 60 days is ended here too, so it stops even before the sweep runs.
 */
export async function runningExperimentForPage(
	organizationId: string,
	pageId: string,
	now = new Date(),
): Promise<PublicExperiment | null> {
	const [row] = await db
		.select()
		.from(SiteExperiment)
		.where(
			and(
				eq(SiteExperiment.organizationId, organizationId),
				eq(SiteExperiment.pageId, pageId),
				eq(SiteExperiment.status, 'running'),
			),
		)
		.limit(1)
	if (!row) return null
	if (
		experimentShouldEnd({
			expiresAt: row.expiresAt.getTime(),
			totalVisits: 0,
			now: now.getTime(),
		})
	) {
		await endExperiment({
			organizationId,
			experimentId: row.id,
			reason: 'expired',
			now,
		})
		return null
	}
	try {
		return {
			id: row.id,
			sectionId: row.sectionId,
			variantConfig: JSON.parse(row.variantConfig),
		}
	} catch {
		return null
	}
}

export type ArmReader = (
	organization: Org,
	experimentId: string,
	from: string,
) => Promise<{
	a: { visits: number; orders: number }
	b: { visits: number; orders: number }
} | null>

/** Visits and orders per arm for one test, or null when the region cannot say. */
export async function experimentResultFor(
	organization: Org,
	experiment: { id: string; startedAt: Date },
	read: ArmReader,
): Promise<ExperimentResult | null> {
	const counts = await read(
		organization,
		experiment.id,
		experiment.startedAt.toISOString().slice(0, 10),
	)
	return counts ? experimentResult(counts.a, counts.b) : null
}

/**
 * The sweep: ends every running test past its 60 days or at the visitor cap.
 * Returns how many it ended (counts only).
 */
export async function sweepExperiments(
	read: ArmReader,
	now = new Date(),
): Promise<{ ended: number; organizationIds: string[] }> {
	const running = await db
		.select({
			experiment: SiteExperiment,
			dataRegion: Organization.dataRegion,
		})
		.from(SiteExperiment)
		.innerJoin(Organization, eq(Organization.id, SiteExperiment.organizationId))
		.where(eq(SiteExperiment.status, 'running'))
		.limit(500)
	let ended = 0
	const organizationIds = new Set<string>()
	for (const { experiment, dataRegion } of running) {
		let reason = experimentShouldEnd({
			expiresAt: experiment.expiresAt.getTime(),
			totalVisits: 0,
			now: now.getTime(),
		})
		if (!reason) {
			const counts = await read(
				{ id: experiment.organizationId, dataRegion },
				experiment.id,
				experiment.startedAt.toISOString().slice(0, 10),
			)
			if (counts) {
				reason = experimentShouldEnd({
					expiresAt: experiment.expiresAt.getTime(),
					totalVisits: counts.a.visits + counts.b.visits,
					now: now.getTime(),
				})
			}
		}
		if (
			reason &&
			(await endExperiment({
				organizationId: experiment.organizationId,
				experimentId: experiment.id,
				reason,
				now,
			}))
		) {
			ended++
			organizationIds.add(experiment.organizationId)
		}
	}
	return { ended, organizationIds: [...organizationIds] }
}

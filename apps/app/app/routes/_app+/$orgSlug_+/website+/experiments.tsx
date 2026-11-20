import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import {
	EXPERIMENT_MIN_VISITS_PER_ARM,
	type ExperimentResult,
} from '@repo/common/site-funnel'
import { db, desc, eq, SiteExperiment, WebsitePage } from '@repo/database'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { useState } from 'react'
import {
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	useFetcher,
	useLoaderData,
} from 'react-router'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import {
	applyExperiment,
	endExperiment,
	experimentResultFor,
	startExperiment,
	TESTABLE_SECTION_TYPES,
} from '#app/utils/experiments/experiments.server.ts'
import { readArmCounts } from '#app/utils/experiments/region.server.ts'
import { sectionTestableTexts } from '#app/utils/experiments/section-texts.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { funnelEnabled } from '#app/utils/site-events/site-events.server.ts'
import { purgeOrganizationSiteCache } from '#app/utils/sites/kv-cache.server.ts'
import { parseSnapshotSections } from '#app/utils/website/versions.ts'

/**
 * Website, Experiments (#338): test two versions of the words of one section
 * of a published page. Visitors are split evenly and keep their version; the
 * result is orders per visit, with "not enough data" until each version has
 * seen 100 visits. A test ends after 60 days, at 50,000 visitors, or when you
 * apply a winner. Behind the `website.funnel` flag (the counts it uses).
 */

const startSchema = z.object({
	intent: z.literal('start'),
	pageId: z.string().min(1),
	sectionId: z.string().min(1),
	name: z.string().max(120),
	edits: z
		.array(z.object({ path: z.string().max(200), value: z.string().max(1000) }))
		.max(30),
})
const bodySchema = z.discriminatedUnion('intent', [
	startSchema,
	z.object({ intent: z.literal('end'), experimentId: z.string().min(1) }),
	z.object({
		intent: z.literal('apply'),
		experimentId: z.string().min(1),
		arm: z.enum(['a', 'b']),
	}),
])

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		dataRegion: true,
		siteDefaultLocale: true,
	})
	if (!(await funnelEnabled(organization.id))) {
		throw new Response('Not found', { status: 404 })
	}
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.READ_WEBSITE_ANY,
	)
	const defaultLocale = organization.siteDefaultLocale ?? 'en'
	const org = { id: organization.id, dataRegion: organization.dataRegion }
	const experiments = await db
		.select()
		.from(SiteExperiment)
		.where(eq(SiteExperiment.organizationId, organization.id))
		.orderBy(desc(SiteExperiment.startedAt))
		.limit(50)
	const pages = await db
		.select({
			id: WebsitePage.id,
			title: WebsitePage.title,
			slug: WebsitePage.slug,
			publishedData: WebsitePage.publishedData,
		})
		.from(WebsitePage)
		.where(eq(WebsitePage.organizationId, organization.id))
	const running = new Set(
		experiments.filter((e) => e.status === 'running').map((e) => e.pageId),
	)
	const names = new Map(pages.map((page) => [page.id, page.title]))
	const results = new Map<string, ExperimentResult | null>()
	for (const experiment of experiments) {
		results.set(
			experiment.id,
			await experimentResultFor(org, experiment, readArmCounts),
		)
	}
	return {
		experiments: experiments.map((experiment) => ({
			id: experiment.id,
			name: experiment.name,
			status: experiment.status,
			pageTitle: names.get(experiment.pageId) ?? '',
			startedAt: experiment.startedAt.toISOString(),
			expiresAt: experiment.expiresAt.toISOString(),
			endReason: experiment.endReason,
			winner: experiment.winner,
			result: results.get(experiment.id) ?? null,
		})),
		// Pages a test can start on: published, no test running, with a text block.
		candidates: pages
			.filter((page) => page.publishedData && !running.has(page.id))
			.map((page) => ({
				id: page.id,
				title: page.title,
				sections: parseSnapshotSections(page.publishedData)
					.filter((section) => TESTABLE_SECTION_TYPES.has(section.type))
					.flatMap((section) => {
						try {
							const texts = sectionTestableTexts(
								section.type,
								JSON.parse(section.config),
								defaultLocale,
							)
							return texts.length
								? [{ id: section.id ?? '', type: section.type, texts }]
								: []
						} catch {
							return []
						}
					})
					.filter((section) => section.id),
			}))
			.filter((page) => page.sections.length > 0),
		minVisits: EXPERIMENT_MIN_VISITS_PER_ARM,
	}
}

function fail(error: string, status = 422) {
	return Response.json({ error }, { status })
}

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		dataRegion: true,
		siteDefaultLocale: true,
	})
	if (!(await funnelEnabled(organization.id))) {
		throw new Response('Not found', { status: 404 })
	}
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.UPDATE_WEBSITE_ANY,
	)
	const parsed = bodySchema.safeParse(await request.json().catch(() => null))
	if (!parsed.success) return fail('invalid_request', 400)
	const org = { id: organization.id, dataRegion: organization.dataRegion }
	const body = parsed.data
	if (body.intent === 'start') {
		const result = await startExperiment({
			organization: org,
			userId,
			pageId: body.pageId,
			sectionId: body.sectionId,
			name: body.name,
			edits: body.edits,
			locale: organization.siteDefaultLocale ?? 'en',
		})
		if (!result.ok) return fail(result.error)
	} else if (body.intent === 'end') {
		const ended = await endExperiment({
			organizationId: organization.id,
			experimentId: body.experimentId,
			reason: 'manual',
		})
		if (!ended) return fail('not_running')
	} else {
		const result = await applyExperiment({
			organization: org,
			userId,
			experimentId: body.experimentId,
			arm: body.arm,
		})
		if (!result.ok) return fail(result.error)
	}
	// The page payload carries the running test: let the site see the change now.
	await purgeOrganizationSiteCache(organization.id)
	return { ok: true }
}

const pct = (value: number | null) =>
	value === null ? '—' : `${Math.round(value * 1000) / 10}%`

export default function WebsiteExperimentsRoute() {
	const { experiments, candidates, minVisits } = useLoaderData<typeof loader>()
	const fetcher = useFetcher<{ ok?: boolean; error?: string }>()
	const { _ } = useLingui()
	const [creating, setCreating] = useState(false)
	const [pageId, setPageId] = useState('')
	const [sectionId, setSectionId] = useState('')
	const [name, setName] = useState('')
	const [edits, setEdits] = useState<Record<string, string>>({})
	const page = candidates.find((candidate) => candidate.id === pageId)
	const section = page?.sections.find((candidate) => candidate.id === sectionId)
	const busy = fetcher.state !== 'idle'
	const errors: Record<string, string> = {
		already_running: _(msg`This page already has a test running.`),
		no_change: _(msg`Change at least one text so the two versions differ.`),
		page_not_published: _(msg`Publish the page first.`),
		invalid_edit: _(msg`That text cannot be changed in a test.`),
		section_not_testable: _(msg`That section cannot be tested.`),
		not_running: _(msg`This test has already ended.`),
	}
	const send = (body: unknown) =>
		void fetcher.submit(body as Record<string, never>, {
			method: 'post',
			encType: 'application/json',
		})
	const statusText = (value: ExperimentResult['status']) =>
		value === 'not_enough_data'
			? _(msg`Not enough data yet (each version needs ${minVisits} visits).`)
			: value === 'no_clear_winner'
				? _(msg`No clear winner yet.`)
				: value === 'a_wins'
					? _(msg`The original is ahead.`)
					: _(msg`Version B is ahead.`)

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<p className="text-muted-foreground max-w-xl text-sm">
					<Trans>
						Try two wordings of one section on a published page. Visitors are
						split evenly and keep their version. The winner is the one that gets
						more orders per visit.
					</Trans>
				</p>
				<Button
					onClick={() => setCreating((open) => !open)}
					disabled={candidates.length === 0}
				>
					<Trans>New test</Trans>
				</Button>
			</div>
			{fetcher.data?.error ? (
				<p role="alert" className="text-destructive text-sm">
					{errors[fetcher.data.error] ?? _(msg`Something went wrong.`)}
				</p>
			) : null}
			{creating ? (
				<section className="space-y-4 rounded-xl border p-4">
					<div className="space-y-2">
						<Label htmlFor="exp-name">
							<Trans>Name</Trans>
						</Label>
						<Input
							id="exp-name"
							value={name}
							maxLength={120}
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="space-y-2">
							<Label htmlFor="exp-page">
								<Trans>Page</Trans>
							</Label>
							<select
								id="exp-page"
								value={pageId}
								onChange={(e) => {
									setPageId(e.target.value)
									setSectionId('')
									setEdits({})
								}}
								className="border-input bg-background h-11 w-full rounded-md border px-3 text-base"
							>
								<option value="">—</option>
								{candidates.map((candidate) => (
									<option key={candidate.id} value={candidate.id}>
										{candidate.title}
									</option>
								))}
							</select>
						</div>
						<div className="space-y-2">
							<Label htmlFor="exp-section">
								<Trans>Section</Trans>
							</Label>
							<select
								id="exp-section"
								value={sectionId}
								onChange={(e) => {
									setSectionId(e.target.value)
									setEdits({})
								}}
								disabled={!page}
								className="border-input bg-background h-11 w-full rounded-md border px-3 text-base"
							>
								<option value="">—</option>
								{page?.sections.map((candidate, index) => (
									<option key={candidate.id} value={candidate.id}>
										{index + 1}. {candidate.type} —{' '}
										{candidate.texts[0]?.value.slice(0, 40)}
									</option>
								))}
							</select>
						</div>
					</div>
					{section ? (
						<div className="space-y-3">
							<p className="text-sm font-medium">
								<Trans>
									Version B wording (leave a text as it is to keep it)
								</Trans>
							</p>
							{section.texts.map((text) => (
								<div key={text.path} className="space-y-1">
									<Label
										htmlFor={`exp-${text.path}`}
										className="text-muted-foreground text-xs"
									>
										{text.value}
									</Label>
									<Input
										id={`exp-${text.path}`}
										value={edits[text.path] ?? text.value}
										maxLength={1000}
										onChange={(e) =>
											setEdits((current) => ({
												...current,
												[text.path]: e.target.value,
											}))
										}
									/>
								</div>
							))}
							<Button
								disabled={busy}
								onClick={() =>
									send({
										intent: 'start',
										pageId,
										sectionId,
										name,
										edits: section.texts
											.filter(
												(text) =>
													(edits[text.path] ?? text.value) !== text.value,
											)
											.map((text) => ({
												path: text.path,
												value: edits[text.path]!,
											})),
									})
								}
							>
								<Trans>Start test</Trans>
							</Button>
						</div>
					) : null}
				</section>
			) : null}
			{experiments.length === 0 ? (
				<EmptyState
					title={<Trans>No tests yet</Trans>}
					description={
						<Trans>
							Publish a page, then test a different headline or button wording.
						</Trans>
					}
				/>
			) : (
				<ul className="space-y-3">
					{experiments.map((experiment) => {
						const endsOn = new Date(experiment.expiresAt).toLocaleDateString()
						return (
							<li
								key={experiment.id}
								className="space-y-3 rounded-xl border p-4"
							>
								<div className="flex flex-wrap items-center justify-between gap-2">
									<div>
										<p className="font-medium">{experiment.name}</p>
										<p className="text-muted-foreground text-xs">
											{experiment.pageTitle} ·{' '}
											<Trans>ends {endsOn} at the latest</Trans>
										</p>
									</div>
									<Badge
										variant={
											experiment.status === 'running' ? 'default' : 'outline'
										}
									>
										{experiment.status === 'running' ? (
											<Trans>Running</Trans>
										) : experiment.status === 'applied' ? (
											<Trans>Applied</Trans>
										) : (
											<Trans>Ended</Trans>
										)}
									</Badge>
								</div>
								{experiment.result ? (
									<>
										<dl className="grid grid-cols-2 gap-3 text-sm">
											{(['a', 'b'] as const).map((arm) => (
												<div key={arm} className="rounded-md border p-3">
													<dt className="text-muted-foreground text-xs">
														{arm === 'a' ? (
															<Trans>Original</Trans>
														) : (
															<Trans>Version B</Trans>
														)}
													</dt>
													<dd className="tabular-nums">
														{experiment.result![arm].visits.toLocaleString()}{' '}
														<Trans>visits</Trans> ·{' '}
														{experiment.result![arm].orders.toLocaleString()}{' '}
														<Trans>orders</Trans> ·{' '}
														{pct(experiment.result![arm].rate)}
													</dd>
												</div>
											))}
										</dl>
										<p className="text-muted-foreground text-sm">
											{statusText(experiment.result.status)}
										</p>
									</>
								) : (
									<p className="text-muted-foreground text-sm">
										<Trans>The counts are not available right now.</Trans>
									</p>
								)}
								{experiment.status === 'running' ? (
									<div className="flex flex-wrap gap-2">
										<Button
											size="sm"
											disabled={busy}
											onClick={() =>
												send({
													intent: 'apply',
													experimentId: experiment.id,
													arm: 'b',
												})
											}
										>
											<Trans>Apply version B</Trans>
										</Button>
										<Button
											size="sm"
											variant="outline"
											disabled={busy}
											onClick={() =>
												send({
													intent: 'apply',
													experimentId: experiment.id,
													arm: 'a',
												})
											}
										>
											<Trans>Keep the original</Trans>
										</Button>
										<Button
											size="sm"
											variant="ghost"
											disabled={busy}
											onClick={() =>
												send({ intent: 'end', experimentId: experiment.id })
											}
										>
											<Trans>End without choosing</Trans>
										</Button>
									</div>
								) : null}
							</li>
						)
					})}
				</ul>
			)}
		</div>
	)
}

import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { userHasOrganizationPermission } from '@repo/auth'
import { and, asc, db, eq, OrganizationMenuCategory } from '@repo/database'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { Link, redirect, useActionData, useLoaderData } from 'react-router'
import { z } from 'zod'
import {
	RestyleRunStatus,
	RestyleTime,
} from '#app/components/media-library/restyle-run-status.tsx'
import {
	RestyleStartForm,
	type RestyleCategory,
} from '#app/components/media-library/restyle-start-form.tsx'
import { restaurantDishPhotoStudio } from '#app/utils/media/photo-studio-vertical.ts'
import {
	isMediaRestyleKillSwitchOn,
	requireMediaRestyleAccess,
} from '#app/utils/media/restyle/access.server.ts'
import { isMediaRestyleConfigured } from '#app/utils/media/restyle/adapter.server.ts'
import {
	cancelRestyleRun,
	listRestyleRuns,
	localizedName,
	previewRestyleRun,
	startRestyleRun,
} from '#app/utils/media/restyle/service.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { type Route } from './+types/media_.restyle'

/**
 * Media, Restyle menu (#146): `/<org>/media/restyle`. Start a run (one studio
 * style, optionally some categories), see the active run and past ones. The
 * review page of a run is `media_.restyle.$runId.tsx`.
 */

const STATUS_BY_ERROR: Record<string, number> = {
	restyle_in_progress: 409,
	restyle_paused: 503,
	not_configured: 503,
	too_many_photos: 422,
	nothing_to_restyle: 422,
	invalid_style: 400,
	invalid_categories: 400,
	not_found: 404,
}

const StartSchema = z.object({
	presetId: z.string().min(1).max(100),
	options: z.string().max(2_000).optional(),
	categoryIds: z.array(z.string().min(1).max(100)).max(60),
})

function parseOptions(raw: string | undefined) {
	if (!raw) return {}
	try {
		const parsed = z.record(z.string(), z.boolean()).safeParse(JSON.parse(raw))
		return parsed.success ? parsed.data : {}
	} catch {
		return {}
	}
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const { organization, userId } = await requireMediaRestyleAccess(
		request,
		params.orgSlug,
		'view',
	)
	const [list, preview, categoryRows, canStart] = await Promise.all([
		listRestyleRuns(organization.id),
		previewRestyleRun(organization.id, []),
		db
			.select({
				id: OrganizationMenuCategory.id,
				displayName: OrganizationMenuCategory.displayName,
				parentId: OrganizationMenuCategory.parentId,
			})
			.from(OrganizationMenuCategory)
			.where(and(eq(OrganizationMenuCategory.organizationId, organization.id)))
			.orderBy(
				asc(OrganizationMenuCategory.position),
				asc(OrganizationMenuCategory.displayName),
			),
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.CREATE_MEDIA_STUDIO_ANY,
		),
	])
	const categories: RestyleCategory[] = categoryRows.map((row) => ({
		id: row.id,
		name: localizedName(row.displayName),
		parentId: row.parentId,
	}))
	return {
		orgSlug: organization.slug,
		...list,
		categories,
		preview: preview.ok
			? {
					withPhoto: preview.withPhoto,
					withoutPhoto: preview.withoutPhoto,
					tooMany: preview.tooMany,
					maxPhotos: preview.maxPhotos,
				}
			: { withPhoto: 0, withoutPhoto: 0, tooMany: false, maxPhotos: 200 },
		canStart,
		killed: isMediaRestyleKillSwitchOn(),
		configured: isMediaRestyleConfigured(),
		activeRunId:
			list.runs.find(
				(run) =>
					run.status === 'pending' ||
					run.status === 'running' ||
					run.status === 'paused',
			)?.id ?? null,
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const { organization, userId } = await requireMediaRestyleAccess(
		request,
		params.orgSlug,
		'view',
	)
	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'preview') {
		const categoryIds = formData
			.getAll('categoryIds')
			.filter((value): value is string => typeof value === 'string')
		const preview = await previewRestyleRun(organization.id, categoryIds)
		if (!preview.ok) {
			return Response.json({ ok: false, error: preview.error }, { status: 400 })
		}
		return Response.json({
			ok: true,
			preview: {
				withPhoto: preview.withPhoto,
				withoutPhoto: preview.withoutPhoto,
				tooMany: preview.tooMany,
				maxPhotos: preview.maxPhotos,
			},
		})
	}

	if (intent === 'start') {
		// Starting spends model credits: it needs the studio permission too.
		await requireMediaRestyleAccess(request, params.orgSlug, 'start')
		const parsed = StartSchema.safeParse({
			presetId: formData.get('presetId'),
			options: formData.get('options') || undefined,
			categoryIds: formData
				.getAll('categoryIds')
				.filter((value): value is string => typeof value === 'string'),
		})
		if (!parsed.success) {
			return Response.json(
				{ ok: false, error: 'invalid_style' },
				{ status: 400 },
			)
		}
		const result = await startRestyleRun({
			organizationId: organization.id,
			userId,
			presetId: parsed.data.presetId,
			options: parseOptions(parsed.data.options),
			categoryIds: parsed.data.categoryIds,
		})
		if (!result.ok) {
			return Response.json(
				{ ok: false, error: result.error },
				{ status: STATUS_BY_ERROR[result.error] ?? 400 },
			)
		}
		return redirect(`/${organization.slug}/media/restyle/${result.runId}`)
	}

	if (intent === 'cancel') {
		const runId = formData.get('runId')
		if (typeof runId !== 'string' || !runId) {
			return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
		}
		const result = await cancelRestyleRun({
			organizationId: organization.id,
			runId,
		})
		if (!result.ok) {
			return Response.json(
				{ ok: false, error: result.error },
				{ status: STATUS_BY_ERROR[result.error] ?? 409 },
			)
		}
		return Response.json({ ok: true })
	}

	return Response.json({ ok: false, error: 'not_found' }, { status: 400 })
}

export default function MediaRestylePage() {
	const { _ } = useLingui()
	const data = useLoaderData<typeof loader>()
	const actionData = useActionData<typeof action>() as
		{ ok?: boolean; error?: string } | undefined
	const active = data.runs.find((run) => run.id === data.activeRunId)
	const past = data.runs.filter((run) => run.id !== data.activeRunId)
	const presetLabel = (id: string | null) => {
		const preset = restaurantDishPhotoStudio.presets.find((p) => p.id === id)
		return preset ? _(preset.label) : _(msg`Custom style`)
	}

	const activeStyle = presetLabel(active?.presetId ?? null)
	const budget = data.budget
	let disabledReason: string | undefined
	if (!data.canStart) {
		disabledReason = _(
			msg`You need permission to use the photo studio to start a restyle.`,
		)
	} else if (data.killed) {
		disabledReason = _(
			msg`Restyling is paused right now. You can still review drafts you already have.`,
		)
	} else if (!data.configured) {
		disabledReason = _(msg`The photo studio is not set up yet.`)
	}

	return (
		<main className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 md:px-8 md:py-8">
			<PageHeader
				title={<Trans>Restyle menu</Trans>}
				description={
					<Trans>
						Give every dish photo one consistent look. Menuza makes a new
						version of each dish's main photo as a draft. Nothing goes live
						until you choose it.
					</Trans>
				}
				actions={
					<Button
						variant="outline"
						render={<Link to={`/${data.orgSlug}/media`} />}
					>
						<Icon name="arrow-left" aria-hidden />
						<Trans>Media library</Trans>
					</Button>
				}
			/>

			{active ? (
				<section className="bg-card space-y-3 rounded-xl border p-4">
					<h2 className="text-lg font-semibold">
						<Trans>A restyle is running</Trans>
					</h2>
					<p className="text-muted-foreground text-sm">
						<Trans>Style: {activeStyle}</Trans>
					</p>
					<RestyleRunStatus run={active} />
					<Button
						render={<Link to={`/${data.orgSlug}/media/restyle/${active.id}`} />}
					>
						<Trans>Open this run</Trans>
					</Button>
				</section>
			) : (
				<RestyleStartForm
					categories={data.categories}
					initialPreview={data.preview}
					disabled={Boolean(disabledReason)}
					disabledReason={disabledReason}
					error={actionData?.ok === false ? actionData.error : null}
				/>
			)}

			{!active ? (
				<p className="text-muted-foreground text-sm">
					<Trans>
						Each day Menuza restyles up to {budget} photos for your restaurant.
						A bigger run pauses and goes on the next day.
					</Trans>
				</p>
			) : null}

			{past.length > 0 ? (
				<section className="space-y-3" aria-labelledby="restyle-past">
					<h2 id="restyle-past" className="text-lg font-semibold">
						<Trans>Earlier runs</Trans>
					</h2>
					<ul className="divide-y rounded-xl border">
						{past.map((run) => {
							const toReview = run.toReview
							return (
								<li
									key={run.id}
									className="flex flex-wrap items-center justify-between gap-3 p-3"
								>
									<div className="space-y-1">
										<p className="text-sm font-medium">
											{presetLabel(run.presetId)}
										</p>
										<p className="text-muted-foreground text-xs">
											<RestyleTime iso={run.createdAt} />
										</p>
										<RestyleRunStatus run={run} />
									</div>
									<Button
										variant="outline"
										size="sm"
										render={
											<Link to={`/${data.orgSlug}/media/restyle/${run.id}`} />
										}
									>
										{run.toReview > 0 ? (
											<Trans>Review ({toReview})</Trans>
										) : (
											<Trans>Open</Trans>
										)}
									</Button>
								</li>
							)
						})}
					</ul>
				</section>
			) : null}
		</main>
	)
}

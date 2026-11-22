import { Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { userHasOrganizationPermission } from '@repo/auth'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { Link, useLoaderData } from 'react-router'
import { z } from 'zod'
import { RestyleReview } from '#app/components/media-library/restyle-review.tsx'
import { restaurantDishPhotoStudio } from '#app/utils/media/photo-studio-vertical.ts'
import {
	isMediaRestyleKillSwitchOn,
	requireMediaRestyleAccess,
} from '#app/utils/media/restyle/access.server.ts'
import {
	keepRestyleOriginal,
	retryRestyleItem,
	switchBackRestyleItem,
	applyAllRestyleDrafts,
	applyRestyleDraft,
} from '#app/utils/media/restyle/decisions.server.ts'
import {
	cancelRestyleRun,
	getRestyleRun,
} from '#app/utils/media/restyle/service.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { type Route } from './+types/media_.restyle.$runId'

/**
 * The review page of one restyle run (#146): `/<org>/media/restyle/<runId>`.
 * The original next to the draft for every dish; Use new, Keep original, Try
 * again, Use all remaining and Switch back. A run of another organization is
 * a 404. Reviewing and using drafts keeps working while the node kill switch
 * is on; making new drafts does not.
 */

const STATUS_BY_ERROR: Record<string, number> = {
	not_found: 404,
	photo_changed: 409,
	draft_changed: 409,
	draft_missing: 409,
	already_decided: 409,
	not_used: 409,
	switch_back_unavailable: 409,
	restyle_in_progress: 409,
	run_cancelled: 409,
	not_retryable: 409,
	restyle_paused: 503,
	not_configured: 503,
}

const ItemSchema = z.object({
	itemRowId: z.string().min(1).max(100),
	draftKey: z.string().max(500).optional(),
})

function failure(error: string) {
	return Response.json(
		{ ok: false, error },
		{ status: STATUS_BY_ERROR[error] ?? 400 },
	)
}

export async function loader({ request, params }: Route.LoaderArgs) {
	const { organization, userId } = await requireMediaRestyleAccess(
		request,
		params.orgSlug,
		'view',
	)
	const detail = await getRestyleRun(organization.id, params.runId)
	if (!detail) throw new Response('Not Found', { status: 404 })
	const [canApply, canStart] = await Promise.all([
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.UPDATE_MENU_ANY,
		),
		userHasOrganizationPermission(
			userId,
			organization.id,
			ORG_PERMISSIONS.CREATE_MEDIA_STUDIO_ANY,
		),
	])
	return {
		orgSlug: organization.slug,
		...detail,
		canApply,
		canStart,
		killed: isMediaRestyleKillSwitchOn(),
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
	const runId = params.runId
	const actor = {
		organization: { id: organization.id, slug: organization.slug },
		userId,
		request,
	}

	if (intent === 'cancel') {
		const result = await cancelRestyleRun({
			organizationId: organization.id,
			runId,
		})
		return result.ok ? Response.json({ ok: true }) : failure(result.error)
	}

	if (intent === 'keep') {
		const item = ItemSchema.safeParse({
			itemRowId: formData.get('itemRowId'),
		})
		if (!item.success) return failure('not_found')
		const result = await keepRestyleOriginal({
			organizationId: organization.id,
			runId,
			itemRowId: item.data.itemRowId,
		})
		return result.ok ? Response.json({ ok: true }) : failure(result.error)
	}

	if (intent === 'retry') {
		// A new draft spends model credits: it needs the studio permission.
		await requireMediaRestyleAccess(request, params.orgSlug, 'start')
		const item = ItemSchema.safeParse({
			itemRowId: formData.get('itemRowId'),
		})
		if (!item.success) return failure('not_found')
		const result = await retryRestyleItem({
			organizationId: organization.id,
			runId,
			itemRowId: item.data.itemRowId,
		})
		return result.ok ? Response.json({ ok: true }) : failure(result.error)
	}

	if (intent === 'use' || intent === 'switchBack' || intent === 'useAll') {
		// These change what a dish shows: they need to edit the menu.
		await requireMediaRestyleAccess(request, params.orgSlug, 'apply')
		if (intent === 'useAll') {
			const result = await applyAllRestyleDrafts({ ...actor, runId, limit: 60 })
			return result.ok ? Response.json(result) : failure(result.error)
		}
		const item = ItemSchema.safeParse({
			itemRowId: formData.get('itemRowId'),
			draftKey: formData.get('draftKey') || undefined,
		})
		if (!item.success) return failure('not_found')
		if (intent === 'use') {
			const result = await applyRestyleDraft({
				...actor,
				runId,
				itemRowId: item.data.itemRowId,
				draftKey: item.data.draftKey,
			})
			return result.ok ? Response.json({ ok: true }) : failure(result.error)
		}
		const result = await switchBackRestyleItem({
			...actor,
			runId,
			itemRowId: item.data.itemRowId,
		})
		return result.ok ? Response.json({ ok: true }) : failure(result.error)
	}

	return failure('not_found')
}

export default function MediaRestyleRunPage() {
	const { _ } = useLingui()
	const data = useLoaderData<typeof loader>()
	const preset = restaurantDishPhotoStudio.presets.find(
		(candidate) => candidate.id === data.run.presetId,
	)
	const styleLabel = preset ? _(preset.label) : ''
	return (
		<main className="mx-auto w-full max-w-7xl space-y-8 px-4 py-6 md:px-8 md:py-8">
			<PageHeader
				title={<Trans>Restyle menu: review</Trans>}
				description={
					preset ? (
						<Trans>
							Style: {styleLabel}. Your live photos only change when you choose
							a new one.
						</Trans>
					) : (
						<Trans>
							Your live photos only change when you choose a new one.
						</Trans>
					)
				}
				actions={
					<Button
						variant="outline"
						render={<Link to={`/${data.orgSlug}/media/restyle`} />}
					>
						<Icon name="arrow-left" aria-hidden />
						<Trans>All restyle runs</Trans>
					</Button>
				}
			/>
			<RestyleReview
				run={{ ...data.run, toReview: 0 }}
				items={data.items}
				canApply={data.canApply}
				canStart={data.canStart}
				killed={data.killed}
			/>
		</main>
	)
}

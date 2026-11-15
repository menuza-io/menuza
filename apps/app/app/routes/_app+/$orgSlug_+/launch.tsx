import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { requireUserId } from '@repo/auth'
import { PageHeader } from '@repo/ui/page-header'
import { WorkspacePage } from '@repo/ui/workspace'
import { data, redirect } from 'react-router'
import { homeLocationStorageKey } from '#app/components/dashboard/use-home-location.ts'
import { LaunchChecklistView } from '#app/components/launch/launch-checklist.tsx'
import { loadPermissionChecker } from '#app/utils/dashboards/attention.server.ts'
import {
	isLaunchChecklistOn,
	loadLaunchChecklist,
	markGuestsOffered,
	setPayAtPickupOnly,
} from '#app/utils/launch/launch.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ORG_PERMISSIONS } from '#app/utils/organization/permissions.server.ts'
import { type Route } from './+types/launch.ts'

/**
 * The restaurant launch checklist, one per location (`launch.checklist`).
 * Viewing needs membership; skipping an optional step and choosing pay at
 * pickup need `update:settings:any`; "Tell your guests" needs campaign edit
 * access and only opens a draft.
 */
export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	if (!(await isLaunchChecklistOn(organization.id))) {
		throw data({ error: 'Not found' }, { status: 404 })
	}
	const [checklist, has] = await Promise.all([
		loadLaunchChecklist({ organizationId: organization.id, userId }),
		loadPermissionChecker(userId, organization.id),
	])
	if (!checklist) throw data({ error: 'Not found' }, { status: 404 })
	return {
		organization,
		checklist,
		locationStorageKey: homeLocationStorageKey(userId, organization.id),
		canSkip: has(ORG_PERMISSIONS.UPDATE_SETTINGS_ANY),
		canChoosePayAtPickup: has(ORG_PERMISSIONS.UPDATE_SETTINGS_ANY),
		canTellGuests: has(ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY),
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	if (!(await isLaunchChecklistOn(organization.id))) {
		throw data({ error: 'Not found' }, { status: 404 })
	}
	const has = await loadPermissionChecker(userId, organization.id)
	const intent = (await request.formData()).get('intent')
	if (intent === 'pay-at-pickup-only') {
		if (!has(ORG_PERMISSIONS.UPDATE_SETTINGS_ANY)) {
			return data({ ok: false, error: 'forbidden' }, { status: 403 })
		}
		await setPayAtPickupOnly(organization.id, true)
		return { ok: true }
	}
	if (intent === 'tell-guests') {
		if (!has(ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY)) {
			return data({ ok: false, error: 'forbidden' }, { status: 403 })
		}
		// Offered once on the home page; the launch page keeps the button.
		await markGuestsOffered(organization.id)
		return redirect(
			`/${organization.slug}/marketing/campaigns/new?template=launch`,
		)
	}
	return data({ ok: false, error: 'invalid_request' }, { status: 400 })
}

export default function LaunchPage({ loaderData }: Route.ComponentProps) {
	const { _ } = useLingui()
	const {
		organization,
		checklist,
		locationStorageKey,
		canSkip,
		canChoosePayAtPickup,
		canTellGuests,
	} = loaderData
	return (
		<WorkspacePage>
			<PageHeader
				title={_(msg`Launch checklist`)}
				description={_(
					msg`Everything each location needs before guests can order online.`,
				)}
			/>
			<LaunchChecklistView
				checklist={checklist}
				orgSlug={organization.slug}
				organizationId={organization.id}
				locationStorageKey={locationStorageKey}
				canSkip={canSkip}
				canChoosePayAtPickup={canChoosePayAtPickup}
				canTellGuests={canTellGuests}
			/>
		</WorkspacePage>
	)
}

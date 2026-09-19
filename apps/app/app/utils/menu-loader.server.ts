import { getUserId } from '@repo/auth'
import { type LoaderFunctionArgs } from 'react-router'

import { resolveMenuLocationId } from '#app/utils/menu-location.server.ts'
import {
	MENU_READ_PERMISSION,
	MENU_WRITE_PERMISSION,
} from '#app/utils/menu-permissions.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ensureDefaultOrganizationLocation } from '#app/utils/organization/locations.server.ts'
import {
	requireUserWithOrganizationPermission,
	userHasOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
export async function loadMenuOperatorContext(
	request: Request,
	orgSlug: string | undefined,
) {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		name: true,
		slug: true,
		hasProvisionedDb: true,
		dataRegion: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		MENU_READ_PERMISSION,
	)

	await ensureDefaultOrganizationLocation({
		organizationId: organization.id,
		name: `${organization.name} — Main`,
	})

	const { menuLocationId, operatorContext, selectedBranchId } =
		await resolveMenuLocationId(request, organization.id)

	const userId = await getUserId(request)
	const canEditMenu = userId
		? await userHasOrganizationPermission(
				userId,
				organization.id,
				MENU_WRITE_PERMISSION,
			)
		: false

	const catalogReady =
		organization.hasProvisionedDb &&
		organization.dataRegion === 'us' &&
		Boolean(menuLocationId)

	return {
		organization,
		menuLocationId,
		operatorContext,
		selectedBranchId,
		canEditMenu,
		catalogReady,
	}
}

export function menuCatalogUnavailableMessage(organization: {
	slug: string
	hasProvisionedDb: boolean
	dataRegion: string | null
}) {
	if (!organization.hasProvisionedDb || organization.dataRegion !== 'us') {
		return {
			title: 'Publish your restaurant site first',
			description:
				'Menu catalog is available after your site is published with a US data region.',
		}
	}
	return {
		title: 'No location configured',
		description: 'Add a restaurant location before editing the menu.',
	}
}

export async function loadMenuOperatorContextFromArgs(
	args: LoaderFunctionArgs,
) {
	return loadMenuOperatorContext(args.request, args.params.orgSlug)
}

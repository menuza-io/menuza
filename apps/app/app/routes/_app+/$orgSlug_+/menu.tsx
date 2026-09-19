import { parseWithZod } from '@conform-to/zod'
import {
	getUserId,
	requireUserId,
	userHasOrganizationPermission,
} from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import { type ActionFunctionArgs, type LoaderFunctionArgs } from 'react-router'
import { z } from 'zod'

import { resolveMenuLocationId } from '#app/utils/menu-location.server.ts'
import {
	MENU_READ_PERMISSION,
	MENU_WRITE_PERMISSION,
} from '#app/utils/menu-permissions.server.ts'
import {
	createMenuCategory,
	createMenuItem,
	listMenuForLocation,
	menuCategorySchema,
	menuItemSchema,
} from '#app/utils/menu.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { ensureDefaultOrganizationLocation } from '#app/utils/organization/locations.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

import MenuBuilderPage from './menu-builder-ui.tsx'

export { MenuBuilderPage as default }

const MenuActionSchema = z.object({
	intent: z.enum(['create-category', 'create-item']),
	name: z.string().optional(),
	categoryId: z.string().optional(),
	priceCents: z.coerce.number().optional(),
})

export async function loader({ request, params }: LoaderFunctionArgs) {
	const organization = await requireUserOrganization(request, params.orgSlug, {
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

	const menu =
		organization.hasProvisionedDb &&
		organization.dataRegion === 'us' &&
		menuLocationId
			? await listMenuForLocation(organization.id, menuLocationId)
			: { categories: [] }

	const userId = await getUserId(request)
	const canEditMenu = userId
		? await userHasOrganizationPermission(
				userId,
				organization.id,
				MENU_WRITE_PERMISSION,
			)
		: false

	return {
		organization,
		menuLocationId,
		operatorContext,
		selectedBranchId,
		menu,
		canEditMenu,
	}
}

export async function action({ request, params }: ActionFunctionArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		hasProvisionedDb: true,
		dataRegion: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		MENU_WRITE_PERMISSION,
	)

	if (!organization.hasProvisionedDb || organization.dataRegion !== 'us') {
		return redirectWithToast(`/${organization.slug}/menu`, {
			type: 'error',
			title: 'Publish your restaurant site first',
			description: '',
		})
	}

	const formData = await request.formData()
	const submission = parseWithZod(formData, { schema: MenuActionSchema })
	if (submission.status !== 'success') {
		return submission.reply()
	}

	const { menuLocationId } = await resolveMenuLocationId(
		request,
		organization.id,
	)
	if (!menuLocationId) {
		return redirectWithToast(`/${organization.slug}/menu`, {
			type: 'error',
			title: 'No location configured',
			description: '',
		})
	}

	if (submission.value.intent === 'create-category') {
		await createMenuCategory(
			organization.id,
			menuLocationId,
			menuCategorySchema.parse({ name: submission.value.name }),
		)
		return redirectWithToast(`/${organization.slug}/menu`, {
			type: 'success',
			title: 'Category added',
			description: '',
		})
	}

	await createMenuItem(
		organization.id,
		menuLocationId,
		menuItemSchema.parse({
			categoryId: submission.value.categoryId,
			name: submission.value.name,
			priceCents: submission.value.priceCents,
		}),
	)
	return redirectWithToast(`/${organization.slug}/menu`, {
		type: 'success',
		title: 'Menu item added',
		description: '',
	})
}

import { type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'

import { loadMenuOperatorContext } from '#app/utils/menu-loader.server.ts'
import {
	reorderCategories,
	reorderItemsInCategory,
	reorderMenuCategories,
	reorderModifierOptions,
} from '#app/utils/menu-catalog.server.ts'
import { MENU_WRITE_PERMISSION } from '#app/utils/menu-permissions.server.ts'
import { requireUserWithOrganizationPermission } from '#app/utils/organization/permissions.server.ts'

const ReorderSchema = z.object({
	intent: z.enum([
		'reorder-categories',
		'reorder-menu-categories',
		'reorder-items',
		'reorder-modifier-options',
	]),
	orderedIds: z.string().min(2),
	menuId: z.string().optional(),
	categoryId: z.string().optional(),
	modifierSetId: z.string().optional(),
})

export async function action(args: ActionFunctionArgs) {
	const ctx = await loadMenuOperatorContext(args.request, args.params.orgSlug)
	const { organization, menuLocationId, catalogReady } = ctx
	if (!catalogReady || !menuLocationId) {
		return new Response('Catalog not ready', { status: 400 })
	}

	await requireUserWithOrganizationPermission(
		args.request,
		organization.id,
		MENU_WRITE_PERMISSION,
	)

	const formData = await args.request.formData()
	const parsed = ReorderSchema.safeParse({
		intent: formData.get('intent'),
		orderedIds: formData.get('orderedIds'),
		menuId: formData.get('menuId')?.toString(),
		categoryId: formData.get('categoryId')?.toString(),
		modifierSetId: formData.get('modifierSetId')?.toString(),
	})
	if (!parsed.success) {
		return new Response('Invalid reorder payload', { status: 400 })
	}

	let orderedIds: string[]
	try {
		orderedIds = z
			.array(z.string().min(1))
			.parse(JSON.parse(parsed.data.orderedIds))
	} catch {
		return new Response('Invalid orderedIds', { status: 400 })
	}

	const orgId = organization.id
	const locationId = menuLocationId

	switch (parsed.data.intent) {
		case 'reorder-categories':
			await reorderCategories(orgId, locationId, orderedIds)
			break
		case 'reorder-menu-categories':
			if (!parsed.data.menuId) {
				return new Response('menuId required', { status: 400 })
			}
			await reorderMenuCategories(
				orgId,
				locationId,
				parsed.data.menuId,
				orderedIds,
			)
			break
		case 'reorder-items':
			if (!parsed.data.categoryId) {
				return new Response('categoryId required', { status: 400 })
			}
			await reorderItemsInCategory(
				orgId,
				locationId,
				parsed.data.categoryId,
				orderedIds,
			)
			break
		case 'reorder-modifier-options':
			if (!parsed.data.modifierSetId) {
				return new Response('modifierSetId required', { status: 400 })
			}
			await reorderModifierOptions(
				orgId,
				locationId,
				parsed.data.modifierSetId,
				orderedIds,
			)
			break
		default:
			return new Response('Unknown intent', { status: 400 })
	}

	return { ok: true }
}

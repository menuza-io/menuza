import { z } from 'zod'
import { parseSiteLocalesConfig } from '@repo/common/site-locales'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	CopyOverridesError,
	duplicateCategory,
	duplicateItem,
	duplicateMenu,
	duplicateModifierGroup,
	copyLocationOverrides,
} from './duplicate.server.ts'

const DuplicateEntitySchema = z.discriminatedUnion('entityType', [
	z.object({
		entityType: z.literal('menu'),
		entityId: z.string().min(1),
		copyCategories: z.boolean().default(false),
	}),
	z.object({
		entityType: z.literal('category'),
		entityId: z.string().min(1),
	}),
	z.object({
		entityType: z.literal('item'),
		entityId: z.string().min(1),
		copyModifierGroups: z.boolean().default(false),
	}),
	z.object({
		entityType: z.literal('modifier_group'),
		entityId: z.string().min(1),
	}),
])

export const CopyOverridesSchema = z.object({
	sourceLocationId: z.string().min(1),
	targetLocationIds: z.array(z.string().min(1)).min(1).max(50),
	replace: z.boolean().default(false),
})

export async function handleMenuDuplicate(request: Request, orgSlug: string) {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
		siteDefaultLocale: true,
		siteLocales: true,
	})
	await requireMenuWrite(request, organization.id)

	let body: unknown
	try {
		body = await request.json()
	} catch {
		return Response.json({ error: 'invalid_json' }, { status: 400 })
	}
	const parsed = DuplicateEntitySchema.safeParse(body)
	if (!parsed.success) {
		return Response.json({ error: 'invalid_body' }, { status: 400 })
	}

	const { defaultLocale } = parseSiteLocalesConfig(
		organization.siteLocales,
		organization.siteDefaultLocale,
	)

	try {
		switch (parsed.data.entityType) {
			case 'menu': {
				const result = await duplicateMenu({
					organizationId: organization.id,
					organizationSlug: organization.slug,
					menuId: parsed.data.entityId,
					copyCategories: parsed.data.copyCategories,
					defaultLocale,
				})
				return Response.json({ ok: true, ...result })
			}
			case 'category': {
				const result = await duplicateCategory({
					organizationId: organization.id,
					organizationSlug: organization.slug,
					categoryId: parsed.data.entityId,
					defaultLocale,
				})
				return Response.json({ ok: true, ...result })
			}
			case 'item': {
				const result = await duplicateItem({
					organizationId: organization.id,
					organizationSlug: organization.slug,
					itemId: parsed.data.entityId,
					copyModifierGroups: parsed.data.copyModifierGroups,
					defaultLocale,
				})
				return Response.json({ ok: true, ...result })
			}
			case 'modifier_group': {
				const result = await duplicateModifierGroup({
					organizationId: organization.id,
					organizationSlug: organization.slug,
					modifierGroupId: parsed.data.entityId,
					defaultLocale,
				})
				return Response.json({ ok: true, ...result })
			}
		}
	} catch (error) {
		if (error instanceof CopyOverridesError) {
			return Response.json({ error: error.code }, { status: 400 })
		}
		throw error
	}
}

export async function handleCopyLocationOverrides(
	request: Request,
	orgSlug: string,
) {
	const organization = await requireUserOrganization(request, orgSlug, {
		id: true,
		slug: true,
	})
	await requireMenuWrite(request, organization.id)

	let body: unknown
	try {
		body = await request.json()
	} catch {
		return Response.json({ error: 'invalid_json' }, { status: 400 })
	}
	const parsed = CopyOverridesSchema.safeParse(body)
	if (!parsed.success) {
		return Response.json({ error: 'invalid_body' }, { status: 400 })
	}

	try {
		const result = await copyLocationOverrides({
			organizationId: organization.id,
			organizationSlug: organization.slug,
			sourceLocationId: parsed.data.sourceLocationId,
			targetLocationIds: parsed.data.targetLocationIds,
			replace: parsed.data.replace,
		})
		return Response.json({ ok: true, ...result })
	} catch (error) {
		if (error instanceof CopyOverridesError) {
			const status = error.code === 'source_in_targets' ? 400 : 404
			return Response.json({ error: error.code }, { status })
		}
		throw error
	}
}

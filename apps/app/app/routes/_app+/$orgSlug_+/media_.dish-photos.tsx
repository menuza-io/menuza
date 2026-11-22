import { requireUserId, userHasOrganizationPermission } from '@repo/auth'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { BulkDishPhotos } from '#app/components/media-library/bulk-dish-photos.tsx'
import {
	applyBulkPhotos,
	applyInputSchema,
	proposeBulkPhotos,
	proposeInputSchema,
} from '#app/utils/media/bulk/bulk.server.ts'
import { getDishPhotoVision } from '#app/utils/media/bulk/vision.server.ts'
import { requireMenuWrite } from '#app/utils/menu/access.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'
import { type Route } from './+types/media_.dish-photos'

/**
 * Add dish photos in bulk (#316), Media, `/<org>/media/dish-photos`.
 *
 * - The photos are uploaded to the library one file per request through the
 *   existing library upload (see `media_.dish-photos_.upload.ts`).
 * - `propose` reads the uploaded photos and the menu and answers with matches.
 *   It never writes to a dish.
 * - `apply` attaches the pairs the operator confirmed, all in one step.
 *   Permission: media (`propose`), media and menu (`apply`).
 */

export async function loader({ request, params }: Route.LoaderArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
	})
	await requireUserWithOrganizationPermission(
		request,
		organization.id!,
		ORG_PERMISSIONS.UPDATE_MEDIA_ANY,
	)
	const canApply = await userHasOrganizationPermission(
		userId,
		organization.id!,
		ORG_PERMISSIONS.UPDATE_MENU_ANY,
	)
	return {
		organization: { slug: organization.slug!, name: organization.name! },
		canApply,
	}
}

function fail(
	status: number,
	error: string,
	extra: Record<string, unknown> = {},
) {
	return Response.json({ ok: false, error, ...extra }, { status })
}

function parseJsonField(formData: FormData, name: string): unknown {
	const raw = formData.get(name)
	if (typeof raw !== 'string' || raw.length > 200_000) return undefined
	try {
		return JSON.parse(raw)
	} catch {
		return undefined
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		siteLocales: true,
		siteDefaultLocale: true,
	})
	const organizationId = organization.id!
	// Both steps work on photos in the shared library.
	await requireUserWithOrganizationPermission(
		request,
		organizationId,
		ORG_PERMISSIONS.UPDATE_MEDIA_ANY,
	)

	const formData = await request.formData()
	const intent = formData.get('intent')

	if (intent === 'propose') {
		const parsed = proposeInputSchema.safeParse({
			assetIds: parseJsonField(formData, 'assetIds'),
			hashes: parseJsonField(formData, 'hashes'),
		})
		if (!parsed.success) return fail(400, 'invalid')
		const result = await proposeBulkPhotos({
			organization: {
				id: organizationId,
				siteLocales: organization.siteLocales,
				siteDefaultLocale: organization.siteDefaultLocale,
			},
			assetIds: parsed.data.assetIds,
			hashes: parsed.data.hashes,
			vision: getDishPhotoVision(),
		})
		return Response.json(result)
	}

	if (intent === 'apply') {
		// Attaching a photo to a dish is a menu change: the dish form's own
		// permission and rate limit apply on top of the media permission.
		await requireMenuWrite(request, organizationId)
		const parsed = applyInputSchema.safeParse({
			pairs: parseJsonField(formData, 'pairs'),
		})
		if (!parsed.success) return fail(400, 'invalid')
		const result = await applyBulkPhotos({
			organization: { id: organizationId, slug: organization.slug! },
			userId,
			request,
			pairs: parsed.data.pairs,
		})
		if (!result.ok) {
			return fail(result.status, result.error, {
				itemId: result.itemId,
				assetId: result.assetId,
			})
		}
		return Response.json(result)
	}

	return fail(400, 'invalid')
}

export default function MediaDishPhotosRoute({
	loaderData,
}: Route.ComponentProps) {
	return (
		<BulkDishPhotos
			orgSlug={loaderData.organization.slug}
			canApply={loaderData.canApply}
		/>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}

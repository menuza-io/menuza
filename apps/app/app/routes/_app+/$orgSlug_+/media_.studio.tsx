import { parseFormData } from '@mjackson/form-data-parser'
import { type ImageInput } from '@repo/ai/server'
import { requireUserId } from '@repo/auth'
import { and, db, eq, OrganizationMediaAsset } from '@repo/database'
import { z } from 'zod'
import { photoStudioVertical } from '#app/utils/media/photo-studio-vertical.ts'
import {
	PHOTO_STUDIO_ASPECT_RATIOS,
	PHOTO_STUDIO_INSTRUCTIONS_MAX,
	type PhotoStudioStyle,
} from '#app/utils/media/photo-studio.ts'
import {
	generatePhotoStudioImage,
	PHOTO_STUDIO_MAX_INPUT_BYTES,
	PhotoStudioInputError,
	readStoredMediaImage,
	toModelImage,
} from '#app/utils/media/photo-studio.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import { type Route } from './+types/media_.studio'

const GenerateSchema = z.object({
	assetId: z.string().min(1),
	styleType: z.enum(['preset', 'reference']),
	presetId: z.string().max(100).optional(),
	options: z
		.string()
		.max(2_000)
		.optional()
		.transform((value, ctx) => {
			if (!value) return {}
			try {
				const parsed: unknown = JSON.parse(value)
				return z.record(z.string(), z.boolean()).parse(parsed)
			} catch {
				ctx.addIssue({ code: 'custom', message: 'Invalid options.' })
				return z.NEVER
			}
		}),
	instructions: z.string().max(PHOTO_STUDIO_INSTRUCTIONS_MAX).optional(),
	aspectRatio: z.enum(PHOTO_STUDIO_ASPECT_RATIOS),
})

function fileOrNull(value: FormDataEntryValue | null) {
	return value instanceof File && value.size > 0 ? value : null
}

const ERROR_STATUS = {
	not_configured: 503,
	rate_limited: 429,
	unavailable: 502,
	unsupported_image: 400,
} as const

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})

	let formData: FormData
	try {
		formData = await parseFormData(request, {
			maxFileSize: PHOTO_STUDIO_MAX_INPUT_BYTES,
		})
	} catch {
		return Response.json(
			{ ok: false, error: 'unsupported_image' },
			{ status: 400 },
		)
	}

	const parsed = GenerateSchema.safeParse({
		assetId: formData.get('assetId'),
		styleType: formData.get('styleType'),
		presetId: formData.get('presetId') || undefined,
		options: formData.get('options') || undefined,
		instructions: formData.get('instructions') || undefined,
		aspectRatio: formData.get('aspectRatio'),
	})
	if (!parsed.success) {
		return Response.json({ ok: false, error: 'invalid' }, { status: 400 })
	}
	const input = parsed.data

	let style: PhotoStudioStyle
	if (input.styleType === 'preset') {
		const preset = photoStudioVertical.presets.find(
			(p) => p.id === input.presetId,
		)
		if (!preset) {
			return Response.json({ ok: false, error: 'invalid' }, { status: 400 })
		}
		style = { type: 'preset', preset }
	} else {
		style = { type: 'reference' }
	}

	const [asset] = await db
		.select({
			objectKey: OrganizationMediaAsset.objectKey,
			storageScope: OrganizationMediaAsset.storageScope,
			organizationId: OrganizationMediaAsset.organizationId,
		})
		.from(OrganizationMediaAsset)
		.where(
			and(
				eq(OrganizationMediaAsset.id, input.assetId),
				eq(OrganizationMediaAsset.organizationId, organization.id),
			),
		)
		.limit(1)
	if (!asset) {
		return Response.json({ ok: false, error: 'not_found' }, { status: 404 })
	}

	const styleReferenceFile = fileOrNull(formData.get('styleReference'))
	const previousResultFile = fileOrNull(formData.get('previousResult'))
	if (style.type === 'reference' && !styleReferenceFile) {
		return Response.json({ ok: false, error: 'invalid' }, { status: 400 })
	}

	let images: [ImageInput, ImageInput | undefined, ImageInput | undefined]
	try {
		images = await Promise.all([
			readStoredMediaImage(asset),
			styleReferenceFile
				? styleReferenceFile.arrayBuffer().then(toModelImage)
				: undefined,
			previousResultFile
				? previousResultFile.arrayBuffer().then(toModelImage)
				: undefined,
		])
	} catch (error) {
		if (error instanceof PhotoStudioInputError) {
			return Response.json(
				{ ok: false, error: 'unsupported_image' },
				{ status: 400 },
			)
		}
		console.error('Photo studio could not read images:', error)
		return Response.json({ ok: false, error: 'unavailable' }, { status: 502 })
	}

	const [photo, styleReference, previousResult] = images
	const result = await generatePhotoStudioImage({
		organizationId: organization.id,
		userId,
		photo,
		style,
		styleReference,
		previousResult,
		options: input.options,
		instructions: input.instructions,
		aspectRatio: input.aspectRatio,
	})
	if (!result.ok) {
		return Response.json(result, { status: ERROR_STATUS[result.error] })
	}
	return Response.json(result)
}

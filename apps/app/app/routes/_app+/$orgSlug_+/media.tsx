import { msg, Plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { parseFormData } from '@mjackson/form-data-parser'
import { requireUserId } from '@repo/auth'
import {
	and,
	db,
	desc,
	eq,
	like,
	or,
	NoteComment,
	NoteCommentImage,
	Organization,
	OrganizationImage,
	OrganizationMediaAsset,
	OrganizationNote,
	OrganizationNoteUpload,
	WebsitePage,
	WebsitePageSection,
} from '@repo/database'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { Slider } from '@repo/ui/slider'
import { Textarea } from '@repo/ui/textarea'
import { format, formatDistanceToNow } from 'date-fns'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Form, useFetcher } from 'react-router'
import { toast } from 'sonner'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	deleteOrganizationStorageObject,
	uploadOrganizationMediaFileOnly,
	uploadOrganizationMediaImage,
} from '#app/utils/storage.server.ts'
import { type Route } from './+types/media'

const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif',
])

const UploadSchema = z.object({
	intent: z.literal('upload'),
	imageFile: z
		.instanceof(File)
		.refine((file) => file.size > 0, 'Choose an image to upload.')
		.refine(
			(file) => file.size <= MAX_IMAGE_SIZE,
			'Images must be 10 MB or smaller.',
		)
		.refine(
			(file) => ALLOWED_IMAGE_TYPES.has(file.type),
			'Use a JPEG, PNG, GIF, WebP, or AVIF image.',
		),
})

const UpdateSchema = z.object({
	intent: z.literal('update'),
	id: z.string(),
	fileName: z.string().optional(),
	altText: z.string().optional(),
	caption: z.string().optional(),
})

const DeleteSchema = z.object({
	intent: z.literal('delete'),
	id: z.string(),
})

const ReplaceSchema = z.object({
	intent: z.literal('replace'),
	id: z.string(),
	imageFile: z
		.instanceof(File)
		.refine((file) => file.size > 0, 'Choose an image to replace with.')
		.refine(
			(file) => file.size <= MAX_IMAGE_SIZE,
			'Images must be 10 MB or smaller.',
		)
		.refine(
			(file) => ALLOWED_IMAGE_TYPES.has(file.type),
			'Use a JPEG, PNG, GIF, WebP, or AVIF image.',
		),
})

function getMediaUrl(id: string, updatedAt: Date) {
	return `/resources/images?mediaId=${encodeURIComponent(id)}&v=${updatedAt.getTime()}`
}

function serializeAsset(asset: typeof OrganizationMediaAsset.$inferSelect) {
	return {
		id: asset.id,
		objectKey: asset.objectKey,
		url: getMediaUrl(asset.id, asset.updatedAt),
		fileName: asset.fileName,
		mimeType: asset.mimeType,
		fileSize: asset.fileSize,
		width: asset.width,
		height: asset.height,
		altText: asset.altText,
		caption: asset.caption,
		source: asset.source,
		createdAt: asset.createdAt.toISOString(),
		updatedAt: asset.updatedAt.toISOString(),
	}
}

type SerializedMediaAsset = ReturnType<typeof serializeAsset>

export type MediaReferenceItem = {
	id: string
	type: 'note' | 'comment' | 'logo' | 'site-icon' | 'page' | 'source'
	title: string
	subtitle?: string
	url?: string
	createdAt?: string
}

type MediaActionData = {
	asset?: SerializedMediaAsset
	error?: string
	updated?: boolean
	replaced?: boolean
	deleted?: boolean
	deletedId?: string
	references?: MediaReferenceItem[]
}

function formatFileSize(bytes: number | null) {
	if (!bytes) return null
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function getSourceLabel(source: string) {
	switch (source) {
		case 'comment':
			return 'Comment'
		case 'note':
			return 'Note'
		case 'organization-logo':
			return 'Organization logo'
		case 'site-icon':
			return 'Site icon'
		case 'video-thumbnail':
			return 'Video thumbnail'
		case 'website-asset':
			return 'Website'
		case 'website-seo':
			return 'Website SEO'
		default:
			return 'Media library'
	}
}

async function hasMediaObjectReferences(
	organizationId: string,
	objectKey: string,
	assetId?: string,
) {
	const pageReferenceCondition = assetId
		? or(
				like(WebsitePageSection.config, `%${objectKey}%`),
				like(WebsitePageSection.config, `%${assetId}%`),
			)
		: like(WebsitePageSection.config, `%${objectKey}%`)
	const [asset, note, comment, logo, siteIcon, page] = await Promise.all([
		db
			.select({ id: OrganizationMediaAsset.id })
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, organizationId),
					eq(OrganizationMediaAsset.objectKey, objectKey),
				),
			)
			.limit(1),
		db
			.select({ id: OrganizationNoteUpload.id })
			.from(OrganizationNoteUpload)
			.innerJoin(
				OrganizationNote,
				eq(OrganizationNoteUpload.noteId, OrganizationNote.id),
			)
			.where(
				and(
					eq(OrganizationNote.organizationId, organizationId),
					eq(OrganizationNoteUpload.objectKey, objectKey),
				),
			)
			.limit(1),
		db
			.select({ id: NoteCommentImage.id })
			.from(NoteCommentImage)
			.innerJoin(NoteComment, eq(NoteCommentImage.commentId, NoteComment.id))
			.innerJoin(OrganizationNote, eq(NoteComment.noteId, OrganizationNote.id))
			.where(
				and(
					eq(OrganizationNote.organizationId, organizationId),
					eq(NoteCommentImage.objectKey, objectKey),
				),
			)
			.limit(1),
		db
			.select({ id: OrganizationImage.id })
			.from(OrganizationImage)
			.where(
				and(
					eq(OrganizationImage.organizationId, organizationId),
					eq(OrganizationImage.objectKey, objectKey),
				),
			)
			.limit(1),
		db
			.select({ id: Organization.id })
			.from(Organization)
			.where(
				and(
					eq(Organization.id, organizationId),
					eq(Organization.siteIconKey, objectKey),
				),
			)
			.limit(1),
		db
			.select({ id: WebsitePageSection.id })
			.from(WebsitePageSection)
			.innerJoin(WebsitePage, eq(WebsitePageSection.pageId, WebsitePage.id))
			.where(
				and(
					eq(WebsitePage.organizationId, organizationId),
					pageReferenceCondition,
				),
			)
			.limit(1),
	])

	return [asset, note, comment, logo, siteIcon, page].some(
		(reference) => reference.length > 0,
	)
}

async function deleteMediaObjectIfUnreferenced({
	organizationId,
	objectKey,
	storageScope,
	assetId,
}: {
	organizationId: string
	objectKey: string
	storageScope: string
	assetId?: string
}) {
	if (await hasMediaObjectReferences(organizationId, objectKey, assetId)) return

	try {
		await deleteOrganizationStorageObject(
			objectKey,
			organizationId,
			storageScope === 'platform' ? 'platform' : 'organization',
		)
	} catch (error) {
		console.error(
			`Failed to remove unreferenced media object ${objectKey}:`,
			error,
		)
	}
}

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
		name: true,
	})
	const search = new URL(request.url).searchParams.get('search')?.trim() ?? ''
	const normalizedSearch = search.slice(0, 100)

	const whereConditions = [
		eq(OrganizationMediaAsset.organizationId, organization.id),
	]
	if (normalizedSearch) {
		whereConditions.push(
			or(
				like(OrganizationMediaAsset.fileName, `%${normalizedSearch}%`),
				like(OrganizationMediaAsset.altText, `%${normalizedSearch}%`),
				like(OrganizationMediaAsset.caption, `%${normalizedSearch}%`),
				like(OrganizationMediaAsset.source, `%${normalizedSearch}%`),
			)!,
		)
	}

	const assets = await db
		.select()
		.from(OrganizationMediaAsset)
		.where(and(...whereConditions))
		.orderBy(desc(OrganizationMediaAsset.createdAt))
		.limit(200)

	return {
		organization,
		assets: assets.map(serializeAsset),
		search: normalizedSearch,
	}
}

export async function action({ request, params }: Route.ActionArgs) {
	const userId = await requireUserId(request)
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
		slug: true,
	})
	const formData = await parseFormData(request, { maxFileSize: MAX_IMAGE_SIZE })
	const intent = formData.get('intent')

	if (intent === 'update') {
		const result = UpdateSchema.safeParse({
			intent: 'update',
			id: formData.get('id'),
			fileName: formData.get('fileName'),
			altText: formData.get('altText'),
			caption: formData.get('caption'),
		})
		if (!result.success) {
			return Response.json(
				{ error: result.error.issues[0]?.message ?? 'Invalid update.' },
				{ status: 400 },
			)
		}
		const [updated] = await db
			.update(OrganizationMediaAsset)
			.set({
				fileName: result.data.fileName?.trim() || null,
				altText: result.data.altText?.trim() || null,
				caption: result.data.caption?.trim() || null,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(OrganizationMediaAsset.id, result.data.id),
					eq(OrganizationMediaAsset.organizationId, organization.id),
				),
			)
			.returning()
		if (!updated) {
			return Response.json({ error: 'Media not found.' }, { status: 404 })
		}
		return Response.json({ asset: serializeAsset(updated), updated: true })
	}

	if (intent === 'delete') {
		const result = DeleteSchema.safeParse({
			intent: 'delete',
			id: formData.get('id'),
		})
		if (!result.success) {
			return Response.json(
				{ error: result.error.issues[0]?.message ?? 'Invalid delete request.' },
				{ status: 400 },
			)
		}
		const [deleted] = await db
			.delete(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.id, result.data.id),
					eq(OrganizationMediaAsset.organizationId, organization.id),
				),
			)
			.returning({
				objectKey: OrganizationMediaAsset.objectKey,
				storageScope: OrganizationMediaAsset.storageScope,
			})
		if (!deleted) {
			return Response.json({ error: 'Media not found.' }, { status: 404 })
		}
		await deleteMediaObjectIfUnreferenced({
			organizationId: organization.id,
			objectKey: deleted.objectKey,
			storageScope: deleted.storageScope,
			assetId: result.data.id,
		})
		return Response.json({ deleted: true, deletedId: result.data.id })
	}

	if (intent === 'replace') {
		const result = ReplaceSchema.safeParse({
			intent: 'replace',
			id: formData.get('id'),
			imageFile: formData.get('imageFile'),
		})
		if (!result.success) {
			return Response.json(
				{
					error: result.error.issues[0]?.message ?? 'Invalid replacement file.',
				},
				{ status: 400 },
			)
		}
		const [existingAsset] = await db
			.select({
				objectKey: OrganizationMediaAsset.objectKey,
				storageScope: OrganizationMediaAsset.storageScope,
			})
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.id, result.data.id),
					eq(OrganizationMediaAsset.organizationId, organization.id),
				),
			)
			.limit(1)
		if (!existingAsset) {
			return Response.json({ error: 'Media not found.' }, { status: 404 })
		}

		let newObjectKey: string | undefined
		let replacementCommitted = false
		try {
			const uploaded = await uploadOrganizationMediaFileOnly(
				organization.id,
				result.data.imageFile,
			)
			newObjectKey = uploaded.key
			const [replaced] = await db
				.update(OrganizationMediaAsset)
				.set({
					objectKey: newObjectKey,
					storageScope: 'organization',
					mimeType: uploaded.mimeType,
					fileSize: uploaded.file.size,
					fileName: uploaded.file.name || null,
					width: uploaded.width,
					height: uploaded.height,
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(OrganizationMediaAsset.id, result.data.id),
						eq(OrganizationMediaAsset.organizationId, organization.id),
					),
				)
				.returning()
			if (!replaced) {
				await deleteOrganizationStorageObject(newObjectKey, organization.id)
				return Response.json({ error: 'Media not found.' }, { status: 404 })
			}
			replacementCommitted = true
			if (existingAsset.objectKey !== newObjectKey) {
				await deleteMediaObjectIfUnreferenced({
					organizationId: organization.id,
					objectKey: existingAsset.objectKey,
					storageScope: existingAsset.storageScope,
				})
			}
			return Response.json({ asset: serializeAsset(replaced), replaced: true })
		} catch (error) {
			if (newObjectKey && !replacementCommitted) {
				await deleteOrganizationStorageObject(newObjectKey, organization.id)
			}
			console.error('Failed to replace media asset:', error)
			return Response.json(
				{ error: 'The image could not be replaced. Please try again.' },
				{ status: 500 },
			)
		}
	}

	if (intent === 'get-references') {
		const assetId = formData.get('id')
		if (typeof assetId !== 'string' || !assetId) {
			return Response.json({ error: 'Asset ID required.' }, { status: 400 })
		}
		const [asset] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.id, assetId),
					eq(OrganizationMediaAsset.organizationId, organization.id),
				),
			)
			.limit(1)

		if (!asset) {
			return Response.json({ error: 'Media not found.' }, { status: 404 })
		}

		// 1. Notes
		const noteRefs = await db
			.select({
				id: OrganizationNote.id,
				title: OrganizationNote.title,
				createdAt: OrganizationNoteUpload.createdAt,
			})
			.from(OrganizationNoteUpload)
			.innerJoin(
				OrganizationNote,
				eq(OrganizationNoteUpload.noteId, OrganizationNote.id),
			)
			.where(
				and(
					eq(OrganizationNoteUpload.objectKey, asset.objectKey),
					eq(OrganizationNote.organizationId, organization.id),
				),
			)

		// 2. Comments
		const commentRefs = await db
			.select({
				commentId: NoteComment.id,
				content: NoteComment.content,
				noteId: OrganizationNote.id,
				noteTitle: OrganizationNote.title,
				createdAt: NoteCommentImage.createdAt,
			})
			.from(NoteCommentImage)
			.innerJoin(NoteComment, eq(NoteCommentImage.commentId, NoteComment.id))
			.innerJoin(OrganizationNote, eq(NoteComment.noteId, OrganizationNote.id))
			.where(
				and(
					eq(NoteCommentImage.objectKey, asset.objectKey),
					eq(OrganizationNote.organizationId, organization.id),
				),
			)

		// 3. Organization Logo
		const orgLogoRefs = await db
			.select({
				id: OrganizationImage.id,
				createdAt: OrganizationImage.createdAt,
			})
			.from(OrganizationImage)
			.where(
				and(
					eq(OrganizationImage.objectKey, asset.objectKey),
					eq(OrganizationImage.organizationId, organization.id),
				),
			)

		// 4. Site Icon
		const siteIconRefs = await db
			.select({
				id: Organization.id,
				name: Organization.name,
			})
			.from(Organization)
			.where(
				and(
					eq(Organization.id, organization.id),
					eq(Organization.siteIconKey, asset.objectKey),
				),
			)

		// 5. Website Pages
		const pageRefs = await db
			.select({
				pageId: WebsitePage.id,
				pageTitle: WebsitePage.title,
				pageSlug: WebsitePage.slug,
				sectionType: WebsitePageSection.type,
			})
			.from(WebsitePageSection)
			.innerJoin(WebsitePage, eq(WebsitePageSection.pageId, WebsitePage.id))
			.where(
				and(
					eq(WebsitePage.organizationId, organization.id),
					or(
						like(WebsitePageSection.config, `%${asset.objectKey}%`),
						like(WebsitePageSection.config, `%${asset.id}%`),
					),
				),
			)

		const references: MediaReferenceItem[] = []

		for (const note of noteRefs) {
			references.push({
				id: `note-${note.id}`,
				type: 'note',
				title: note.title || 'Untitled note',
				subtitle: 'Attached to organization note',
				url: `/${params.orgSlug}/notes/${note.id}`,
				createdAt: note.createdAt.toISOString(),
			})
		}

		for (const c of commentRefs) {
			references.push({
				id: `comment-${c.commentId}`,
				type: 'comment',
				title: `Comment on "${c.noteTitle || 'Untitled note'}"`,
				subtitle: c.content ? c.content.slice(0, 80) : undefined,
				url: `/${params.orgSlug}/notes/${c.noteId}`,
				createdAt: c.createdAt.toISOString(),
			})
		}

		for (const logo of orgLogoRefs) {
			references.push({
				id: `logo-${logo.id}`,
				type: 'logo',
				title: 'Organization Logo',
				subtitle: 'Current organization branding logo',
				url: `/${params.orgSlug}/settings/organization`,
				createdAt: logo.createdAt.toISOString(),
			})
		}

		for (const org of siteIconRefs) {
			references.push({
				id: `site-icon-${org.id}`,
				type: 'site-icon',
				title: 'Site Icon / Favicon',
				subtitle: 'Used as the published site icon',
				url: `/${params.orgSlug}/website`,
			})
		}

		const seenPages = new Set<string>()
		for (const p of pageRefs) {
			if (seenPages.has(p.pageId)) continue
			seenPages.add(p.pageId)
			references.push({
				id: `page-${p.pageId}`,
				type: 'page',
				title: `Website Page: ${p.pageTitle || p.pageSlug}`,
				subtitle: `Used in page section (${p.sectionType}) on /${p.pageSlug}`,
				url: `/${params.orgSlug}/website/pages/${p.pageId}`,
			})
		}

		if (references.length === 0 && asset.source && asset.source !== 'library') {
			references.push({
				id: 'source-origin',
				type: 'source',
				title: `Origin: ${getSourceLabel(asset.source)}`,
				subtitle: `Uploaded originally via ${getSourceLabel(asset.source)}.`,
			})
		}

		return Response.json({ references })
	}

	const result = UploadSchema.safeParse({
		intent: formData.get('intent'),
		imageFile: formData.get('imageFile'),
	})

	if (!result.success) {
		return Response.json(
			{ error: result.error.issues[0]?.message ?? 'Invalid upload.' },
			{ status: 400 },
		)
	}

	try {
		const objectKey = await uploadOrganizationMediaImage(
			organization.id,
			result.data.imageFile,
			userId,
		)
		const [asset] = await db
			.select()
			.from(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, organization.id),
					eq(OrganizationMediaAsset.objectKey, objectKey),
				),
			)
			.limit(1)

		if (!asset) throw new Error('Uploaded media could not be registered.')
		return Response.json({ asset: serializeAsset(asset) })
	} catch (error) {
		console.error('Failed to upload media library image:', error)
		return Response.json(
			{ error: 'The image could not be uploaded. Please try again.' },
			{ status: 500 },
		)
	}
}

export default function MediaLibraryRoute({
	loaderData,
}: Route.ComponentProps) {
	const { _ } = useLingui()
	const uploadFetcher = useFetcher<MediaActionData>()
	const detailsFetcher = useFetcher<MediaActionData>()
	const fileInputRef = useRef<HTMLInputElement>(null)
	const latestAssetId = useRef<string | null>(null)
	const [selectedAsset, setSelectedAsset] =
		useState<SerializedMediaAsset | null>(null)
	const { assets, search } = loaderData
	const isUploading = uploadFetcher.state !== 'idle'

	useEffect(() => {
		const asset = uploadFetcher.data?.asset
		if (!asset || latestAssetId.current === asset.id) return
		latestAssetId.current = asset.id
		toast.success(_(msg`Image added to your media library`))
	}, [_, uploadFetcher.data])

	useEffect(() => {
		if (detailsFetcher.data?.updated && detailsFetcher.data.asset) {
			toast.success(_(msg`Media details saved`))
			setSelectedAsset(detailsFetcher.data.asset)
		} else if (detailsFetcher.data?.replaced && detailsFetcher.data.asset) {
			toast.success(_(msg`Image replaced successfully`))
			setSelectedAsset(detailsFetcher.data.asset)
		} else if (detailsFetcher.data?.deleted) {
			toast.success(_(msg`Image removed from media library`))
			setSelectedAsset(null)
		} else if (detailsFetcher.data?.error) {
			toast.error(detailsFetcher.data.error)
		}
	}, [_, detailsFetcher.data])

	const handleUpdateAsset = useCallback(
		(data: {
			id: string
			fileName: string
			altText: string
			caption: string
		}) => {
			const formData = new FormData()
			formData.append('intent', 'update')
			formData.append('id', data.id)
			formData.append('fileName', data.fileName)
			formData.append('altText', data.altText)
			formData.append('caption', data.caption)
			void detailsFetcher.submit(formData, { method: 'POST' })
		},
		[detailsFetcher],
	)

	const handleDeleteAsset = useCallback(
		(id: string) => {
			if (
				!window.confirm(
					_(msg`Are you sure you want to remove this media asset?`),
				)
			)
				return
			const formData = new FormData()
			formData.append('intent', 'delete')
			formData.append('id', id)
			void detailsFetcher.submit(formData, { method: 'POST' })
		},
		[_, detailsFetcher],
	)

	const handleReplaceAsset = useCallback(
		(id: string, file: File) => {
			const formData = new FormData()
			formData.append('intent', 'replace')
			formData.append('id', id)
			formData.append('imageFile', file)
			void detailsFetcher.submit(formData, {
				method: 'POST',
				encType: 'multipart/form-data',
			})
		},
		[detailsFetcher],
	)

	const handleSaveCopy = useCallback(
		(file: File) => {
			const data = new FormData()
			data.append('intent', 'upload')
			data.append('imageFile', file)
			void uploadFetcher.submit(data, {
				method: 'POST',
				encType: 'multipart/form-data',
			})
		},
		[uploadFetcher],
	)

	return (
		<main className="mx-auto w-full max-w-7xl space-y-8 px-4 py-6 md:px-8 md:py-8">
			<PageHeader
				title={<Trans>Media library</Trans>}
				description={
					<Trans>
						Find and reuse images uploaded across notes, comments, your website,
						and organization settings.
					</Trans>
				}
				actions={
					<>
						<input
							ref={fileInputRef}
							type="file"
							accept="image/jpeg,image/png,image/gif,image/webp,image/avif"
							className="sr-only"
							onChange={(event) => {
								const file = event.currentTarget.files?.[0]
								if (!file) return
								const data = new FormData()
								data.append('intent', 'upload')
								data.append('imageFile', file)
								void uploadFetcher.submit(data, {
									method: 'POST',
									encType: 'multipart/form-data',
								})
								event.currentTarget.value = ''
							}}
						/>
						<Button
							type="button"
							disabled={isUploading}
							onClick={() => fileInputRef.current?.click()}
						>
							<Icon
								name={isUploading ? 'loader' : 'plus'}
								className={isUploading ? 'animate-spin' : undefined}
							/>
							{isUploading ? (
								<Trans>Uploading…</Trans>
							) : (
								<Trans>Upload image</Trans>
							)}
						</Button>
					</>
				}
			/>

			{uploadFetcher.data?.error ? (
				<p className="text-destructive text-sm" role="alert">
					{uploadFetcher.data.error}
				</p>
			) : null}

			<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
				<Form method="get" className="relative w-full sm:max-w-sm">
					<Icon
						name="search"
						className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
					/>
					<Input
						name="search"
						type="search"
						defaultValue={search}
						placeholder={_(msg`Search media`)}
						aria-label={_(msg`Search media library`)}
						className="pl-9"
					/>
				</Form>
				<p className="text-muted-foreground text-sm tabular-nums">
					<Plural value={assets.length} one="# image" other="# images" />
				</p>
			</div>

			{assets.length ? (
				<ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
					{assets.map((asset) => {
						const name =
							asset.altText || asset.fileName || _(msg`Untitled image`)
						const size = formatFileSize(asset.fileSize)
						return (
							<li
								key={asset.id}
								className="bg-background group hover:border-primary/50 focus-within:ring-primary/20 relative min-w-0 overflow-hidden rounded-xl border transition-colors focus-within:ring-2"
							>
								<button
									type="button"
									onClick={() => setSelectedAsset(asset)}
									className="absolute inset-0 z-0 cursor-pointer rounded-xl"
									aria-label={`Open details for ${name}`}
								/>
								<div className="bg-muted relative aspect-square overflow-hidden">
									<img
										src={asset.url}
										alt={asset.altText ?? ''}
										className="size-full object-cover motion-safe:transition-transform motion-safe:duration-300 motion-safe:group-hover:scale-[1.02]"
										loading="lazy"
										width={360}
										height={360}
									/>
									<div className="absolute inset-x-0 bottom-0 flex justify-end p-2 opacity-0 focus-within:opacity-100 motion-safe:transition-opacity motion-safe:group-hover:opacity-100">
										<Button
											type="button"
											variant="secondary"
											size="sm"
											className="relative z-10"
											onClick={(e) => {
												e.stopPropagation()
												void navigator.clipboard.writeText(
													new URL(asset.url, window.location.origin).href,
												)
												toast.success(_(msg`Image link copied`))
											}}
										>
											<Icon name="copy" />
											<Trans>Copy link</Trans>
										</Button>
									</div>
								</div>
								<div className="space-y-1 px-3 py-3">
									<p className="truncate text-sm font-medium" title={name}>
										{name}
									</p>
									<p className="text-muted-foreground truncate text-xs">
										{getSourceLabel(asset.source)}
										{size ? ` · ${size}` : ''}
									</p>
									<p className="text-muted-foreground text-xs">
										{formatDistanceToNow(new Date(asset.createdAt), {
											addSuffix: true,
										})}
									</p>
								</div>
							</li>
						)
					})}
				</ul>
			) : (
				<EmptyState
					title={
						search
							? _(msg`No matching images`)
							: _(msg`Your media library is empty`)
					}
					description={
						search
							? _(msg`Try a different search term.`)
							: _(
									msg`Upload an image here, or add one to a note, comment, website page, or your organization settings.`,
								)
					}
					icons={['image']}
				/>
			)}

			<MediaDetailsDialog
				asset={selectedAsset}
				onClose={() => setSelectedAsset(null)}
				onUpdate={handleUpdateAsset}
				onDelete={handleDeleteAsset}
				onReplace={handleReplaceAsset}
				onSaveCopy={handleSaveCopy}
				isUpdating={
					detailsFetcher.state !== 'idle' || uploadFetcher.state !== 'idle'
				}
			/>
		</main>
	)
}

function MediaDetailsDialog({
	asset,
	onClose,
	onUpdate,
	onDelete,
	onReplace,
	onSaveCopy,
	isUpdating,
}: {
	asset: SerializedMediaAsset | null
	onClose: () => void
	onUpdate: (data: {
		id: string
		fileName: string
		altText: string
		caption: string
	}) => void
	onDelete: (id: string) => void
	onReplace: (id: string, file: File) => void
	onSaveCopy: (file: File) => void
	isUpdating: boolean
}) {
	const { _ } = useLingui()
	const [isEditing, setIsEditing] = useState(false)
	const [fileName, setFileName] = useState('')
	const [altText, setAltText] = useState('')
	const [caption, setCaption] = useState('')
	const [dimensions, setDimensions] = useState<{
		width: number
		height: number
	} | null>(null)
	const replaceFileInputRef = useRef<HTMLInputElement>(null)

	// Image editing state
	const [rotation, setRotation] = useState<number>(0)
	const [flipH, setFlipH] = useState<boolean>(false)
	const [flipV, setFlipV] = useState<boolean>(false)
	const [brightness, setBrightness] = useState<number>(100)
	const [contrast, setContrast] = useState<number>(100)
	const [saturation, setSaturation] = useState<number>(100)
	const [grayscale, setGrayscale] = useState<number>(0)
	const [sepia, setSepia] = useState<number>(0)
	const [activePreset, setActivePreset] = useState<
		'normal' | 'bw' | 'vivid' | 'warm' | 'cool' | null
	>('normal')
	const [isExporting, setIsExporting] = useState<boolean>(false)

	// References fetcher for "Used in" section
	const referencesFetcher = useFetcher<MediaActionData>()
	const lastFetchedAssetId = useRef<string | null>(null)

	const resetEditor = useCallback(() => {
		setRotation(0)
		setFlipH(false)
		setFlipV(false)
		setBrightness(100)
		setContrast(100)
		setSaturation(100)
		setGrayscale(0)
		setSepia(0)
		setActivePreset('normal')
	}, [])

	useEffect(() => {
		if (asset) {
			setIsEditing(false)
			setFileName(asset.fileName ?? '')
			setAltText(asset.altText ?? '')
			setCaption(asset.caption ?? '')
			setDimensions(
				asset.width && asset.height
					? { width: asset.width, height: asset.height }
					: null,
			)
			resetEditor()
			lastFetchedAssetId.current = null
		}
	}, [asset, resetEditor])

	// Automatically fetch references when asset is opened
	useEffect(() => {
		if (asset && lastFetchedAssetId.current !== asset.id) {
			lastFetchedAssetId.current = asset.id
			const formData = new FormData()
			formData.set('intent', 'get-references')
			formData.set('id', asset.id)
			void referencesFetcher.submit(formData, { method: 'POST' })
		}
	}, [asset, referencesFetcher])

	if (!asset) return null

	const formatLabel = (asset.mimeType.split('/')[1] || 'IMAGE').toUpperCase()
	const formattedDate = format(
		new Date(asset.createdAt),
		'MMM d, yyyy, hh:mm a',
	)
	const sizeLabel = formatFileSize(asset.fileSize)

	// Canvas image export for transformations and filters
	async function exportTransformedImage(prefix = 'edited'): Promise<File> {
		return new Promise((resolve, reject) => {
			if (!asset) {
				reject(new Error('No active asset to export'))
				return
			}
			const img = new Image()
			img.crossOrigin = 'anonymous'
			img.onload = () => {
				const canvas = document.createElement('canvas')
				const isRotated90or270 = Math.abs(rotation % 180) === 90

				canvas.width = isRotated90or270 ? img.naturalHeight : img.naturalWidth
				canvas.height = isRotated90or270 ? img.naturalWidth : img.naturalHeight

				const ctx = canvas.getContext('2d')
				if (!ctx) {
					reject(new Error('Unable to create canvas context'))
					return
				}

				// Apply filter string matching live CSS filters
				ctx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%) grayscale(${grayscale}%) sepia(${sepia}%)`

				// Center translation for rotation and flip
				ctx.translate(canvas.width / 2, canvas.height / 2)
				ctx.rotate((rotation * Math.PI) / 180)
				ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1)

				ctx.drawImage(
					img,
					-img.naturalWidth / 2,
					-img.naturalHeight / 2,
					img.naturalWidth,
					img.naturalHeight,
				)

				const mime = ['image/png', 'image/webp', 'image/avif'].includes(
					asset.mimeType,
				)
					? 'image/png'
					: 'image/jpeg'
				const ext = mime === 'image/png' ? '.png' : '.jpg'

				canvas.toBlob(
					(blob) => {
						if (!blob) {
							reject(new Error('Unable to render image to blob'))
							return
						}
						const originalName =
							asset.fileName?.replace(/\.[^/.]+$/, '') || 'image'
						const file = new File([blob], `${prefix}-${originalName}${ext}`, {
							type: mime,
						})
						resolve(file)
					},
					mime,
					0.92,
				)
			}
			img.onerror = () =>
				reject(new Error('Failed to load image for rendering'))
			img.src = asset.url
		})
	}

	const handleSaveEditedImage = async () => {
		if (!asset) return
		try {
			setIsExporting(true)
			const file = await exportTransformedImage('edited')
			onReplace(asset.id, file)
			toast.success(_(msg`Saving edited image…`))
			setIsEditing(false)
		} catch (error) {
			console.error('Error saving edited image:', error)
			toast.error(_(msg`Failed to export edited image.`))
		} finally {
			setIsExporting(false)
		}
	}

	const handleSaveAsCopy = async () => {
		if (!asset) return
		try {
			setIsExporting(true)
			const file = await exportTransformedImage('copy')
			onSaveCopy(file)
			toast.success(_(msg`Saving as new copy…`))
			setIsEditing(false)
		} catch (error) {
			console.error('Error saving copy:', error)
			toast.error(_(msg`Failed to export image copy.`))
		} finally {
			setIsExporting(false)
		}
	}

	const applyPreset = (preset: 'normal' | 'bw' | 'vivid' | 'warm' | 'cool') => {
		setActivePreset(preset)
		switch (preset) {
			case 'normal':
				setBrightness(100)
				setContrast(100)
				setSaturation(100)
				setGrayscale(0)
				setSepia(0)
				break
			case 'bw':
				setBrightness(100)
				setContrast(120)
				setSaturation(0)
				setGrayscale(100)
				setSepia(0)
				break
			case 'vivid':
				setBrightness(105)
				setContrast(120)
				setSaturation(140)
				setGrayscale(0)
				setSepia(0)
				break
			case 'warm':
				setBrightness(105)
				setContrast(105)
				setSaturation(110)
				setGrayscale(0)
				setSepia(40)
				break
			case 'cool':
				setBrightness(100)
				setContrast(105)
				setSaturation(85)
				setGrayscale(0)
				setSepia(0)
				break
		}
	}

	const references = referencesFetcher.data?.references
	const referenceCount = references?.length ?? 0
	const isLoadingReferences = referencesFetcher.state !== 'idle'
	const sourceLabel = (() => {
		switch (asset.source) {
			case 'comment':
				return _(msg`Comment`)
			case 'note':
				return _(msg`Note`)
			case 'organization-logo':
				return _(msg`Organization logo`)
			case 'site-icon':
				return _(msg`Site icon`)
			case 'video-thumbnail':
				return _(msg`Video thumbnail`)
			case 'website-asset':
				return _(msg`Website`)
			case 'website-seo':
				return _(msg`Website SEO`)
			default:
				return _(msg`Main library`)
		}
	})()
	const presetLabels = {
		normal: _(msg`Normal`),
		bw: _(msg`B&W`),
		vivid: _(msg`Vivid`),
		warm: _(msg`Warm`),
		cool: _(msg`Cool`),
	} as const

	return (
		<Dialog open={Boolean(asset)} onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="flex max-h-[92vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl md:max-w-5xl">
				{!isEditing ? (
					<>
						{/* Details Header */}
						<div className="border-b px-6 py-4">
							<DialogHeader>
								<DialogTitle>
									<Trans>Media details</Trans>
								</DialogTitle>
								<DialogDescription className="truncate">
									{asset.fileName || asset.altText || _(msg`Untitled image`)}
								</DialogDescription>
							</DialogHeader>
						</div>

						{/* Details Body */}
						<div className="min-h-0 flex-1 overflow-y-auto">
							<div className="divide-border grid grid-cols-1 divide-y md:grid-cols-2 md:divide-x md:divide-y-0">
								{/* Left Column: Image preview, metadata, and link */}
								<div className="space-y-4 p-6">
									<div className="group/preview bg-muted/30 relative flex h-64 w-full items-center justify-center overflow-hidden rounded-lg border p-3 sm:h-72">
										<img
											src={asset.url}
											alt={altText || asset.altText || ''}
											onLoad={(e) =>
												setDimensions({
													width: e.currentTarget.naturalWidth,
													height: e.currentTarget.naturalHeight,
												})
											}
											className="max-h-full max-w-full rounded-md object-contain"
										/>
										<input
											ref={replaceFileInputRef}
											type="file"
											accept="image/jpeg,image/png,image/gif,image/webp,image/avif"
											className="sr-only"
											onChange={(e) => {
												const file = e.currentTarget.files?.[0]
												if (file) {
													onReplace(asset.id, file)
													e.currentTarget.value = ''
												}
											}}
										/>
										<Button
											type="button"
											variant="secondary"
											size="xs"
											disabled={isUpdating}
											onClick={() => replaceFileInputRef.current?.click()}
											className="absolute top-2.5 left-2.5 shadow-sm"
										>
											<Icon name="refresh-cw" className="size-3" />
											<Trans>Replace image</Trans>
										</Button>
										{asset.mimeType !== 'image/gif' ? (
											<Button
												type="button"
												variant="secondary"
												size="xs"
												onClick={() => setIsEditing(true)}
												className="absolute top-2.5 right-2.5 shadow-sm"
											>
												<Icon name="pencil" className="size-3" />
												<Trans>Edit image</Trans>
											</Button>
										) : null}
									</div>

									{/* Metadata Grid */}
									<div className="space-y-3 pt-1">
										<div className="text-muted-foreground grid grid-cols-2 gap-4 text-xs">
											<div className="flex items-center gap-2">
												<Icon name="database" className="size-3.5 shrink-0" />
												<span>
													<Trans>Size:</Trans>{' '}
													<strong className="text-foreground font-medium">
														{sizeLabel ?? '—'}
													</strong>
												</span>
											</div>
											<div className="flex items-center gap-2">
												<Icon name="width" className="size-3.5 shrink-0" />
												<span>
													<Trans>Dimensions:</Trans>{' '}
													<strong className="text-foreground font-medium">
														{dimensions
															? `${dimensions.width} × ${dimensions.height}`
															: '—'}
													</strong>
												</span>
											</div>
										</div>

										<div className="text-muted-foreground grid grid-cols-2 gap-4 text-xs">
											<div className="flex items-center gap-2">
												<Icon name="calendar" className="size-3.5 shrink-0" />
												<span>
													<Trans>Uploaded:</Trans>{' '}
													<strong className="text-foreground font-medium">
														{formattedDate}
													</strong>
												</span>
											</div>
											<div className="flex items-center gap-2">
												<Icon name="image" className="size-3.5 shrink-0" />
												<span>
													<Trans>Format:</Trans>{' '}
													<strong className="text-foreground font-medium">
														{formatLabel}
													</strong>
												</span>
											</div>
										</div>

										{/* URL Box with copy action */}
										<div className="flex items-center gap-2 pt-1">
											<div className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
												<Icon name="link-2" className="size-3.5" />
												<span>
													<Trans>URL:</Trans>
												</span>
											</div>
											<div className="bg-muted/40 flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-xs">
												<span className="text-foreground/80 truncate font-mono">
													{asset.url}
												</span>
												<Button
													type="button"
													variant="ghost"
													size="icon-xs"
													onClick={() => {
														void navigator.clipboard.writeText(
															new URL(asset.url, window.location.origin).href,
														)
														toast.success(_(msg`URL copied to clipboard`))
													}}
													aria-label={_(msg`Copy URL`)}
													className="text-muted-foreground hover:text-foreground shrink-0"
												>
													<Icon name="copy" className="size-3.5" />
												</Button>
											</div>
										</div>
									</div>
								</div>

								{/* Right Column: Edit inputs + Used in */}
								<div className="space-y-4 p-6">
									<div className="space-y-1.5">
										<div className="flex items-center gap-1.5">
											<Label htmlFor="media-filename">
												<Trans>Filename</Trans>
											</Label>
											<span title={_(msg`File name of the media asset`)}>
												<Icon
													name="help-circle"
													className="text-muted-foreground size-3.5 cursor-help"
												/>
											</span>
										</div>
										<Input
											id="media-filename"
											value={fileName}
											onChange={(e) => setFileName(e.target.value)}
											placeholder={_(msg`Filename`)}
										/>
									</div>

									<div className="space-y-1.5">
										<Label>
											<Trans>Location</Trans>
										</Label>
										<div className="bg-muted/30 text-foreground flex h-8 items-center justify-between rounded-lg border px-3 text-sm">
											<div className="flex items-center gap-2">
												<Icon
													name="image"
													className="text-muted-foreground size-4"
												/>
												<span className="font-medium">{sourceLabel}</span>
											</div>
											<Icon
												name="chevron-down"
												className="text-muted-foreground size-4"
											/>
										</div>
									</div>

									<div className="space-y-1.5">
										<div className="flex items-center gap-1.5">
											<Label htmlFor="media-alt">
												<Trans>Alt Text</Trans>
											</Label>
											<span
												title={_(msg`Describe this image for accessibility`)}
											>
												<Icon
													name="help-circle"
													className="text-muted-foreground size-3.5 cursor-help"
												/>
											</span>
										</div>
										<Textarea
											id="media-alt"
											value={altText}
											onChange={(e) => setAltText(e.target.value)}
											placeholder={_(
												msg`Describe this image for accessibility`,
											)}
											rows={2}
											className="resize-none"
										/>
									</div>

									<div className="space-y-1.5">
										<Label htmlFor="media-caption">
											<Trans>Caption</Trans>
										</Label>
										<Textarea
											id="media-caption"
											value={caption}
											onChange={(e) => setCaption(e.target.value)}
											placeholder={_(msg`Optional caption for display`)}
											rows={2}
											className="resize-none"
										/>
									</div>

									{/* Used in references */}
									<div className="space-y-1.5 pt-1">
										<div className="flex items-center justify-between">
											<Label className="text-xs font-medium">
												<Trans>Used in</Trans>
											</Label>
											{references && references.length > 0 ? (
												<Badge
													variant="secondary"
													className="px-1.5 py-0 text-[10px]"
												>
													<Plural
														value={referenceCount}
														one="# place"
														other="# places"
													/>
												</Badge>
											) : null}
										</div>
										{isLoadingReferences ? (
											<div className="bg-muted/20 text-muted-foreground flex items-center gap-2 rounded-lg border px-3 py-2 text-xs">
												<Icon
													name="refresh-cw"
													className="size-3.5 animate-spin"
												/>
												<span>
													<Trans>Checking references…</Trans>
												</span>
											</div>
										) : !references || references.length === 0 ? (
											<div className="bg-muted/20 text-muted-foreground rounded-lg border px-3 py-2 text-xs">
												<Trans>Not used in any notes, comments, or pages</Trans>
											</div>
										) : (
											<div className="max-h-36 space-y-1.5 overflow-y-auto pr-0.5">
												{references.map((ref) => {
													let iconName:
														| 'sticky-note'
														| 'message-circle'
														| 'image'
														| 'blocks'
														| 'link-2' = 'link-2'

													if (ref.type === 'note') {
														iconName = 'sticky-note'
													} else if (ref.type === 'comment') {
														iconName = 'message-circle'
													} else if (
														ref.type === 'logo' ||
														ref.type === 'site-icon'
													) {
														iconName = 'image'
													} else if (ref.type === 'page') {
														iconName = 'blocks'
													}

													return (
														<div
															key={ref.id}
															className="bg-muted/30 hover:bg-muted/50 flex items-center justify-between gap-2 rounded-lg border p-2 text-xs transition-colors"
														>
															<div className="flex min-w-0 items-center gap-2">
																<Icon
																	name={iconName}
																	className="text-muted-foreground size-3.5 shrink-0"
																/>
																<div className="min-w-0">
																	<p className="text-foreground truncate font-medium">
																		{ref.title}
																	</p>
																	{ref.subtitle ? (
																		<p className="text-muted-foreground truncate text-[11px]">
																			{ref.subtitle}
																		</p>
																	) : null}
																</div>
															</div>
															{ref.url ? (
																<Button
																	variant="ghost"
																	size="icon-xs"
																	render={
																		<a
																			href={ref.url}
																			target="_blank"
																			rel="noreferrer"
																		/>
																	}
																	aria-label={_(msg`Open reference`)}
																	className="shrink-0"
																>
																	<Icon name="arrow-right" className="size-3" />
																</Button>
															) : null}
														</div>
													)
												})}
											</div>
										)}
									</div>
								</div>
							</div>
						</div>

						{/* Details Footer */}
						<DialogFooter className="m-0 sm:items-center sm:justify-between">
							<Button
								type="button"
								variant="destructive"
								size="sm"
								disabled={isUpdating}
								onClick={() => onDelete(asset.id)}
							>
								<Icon name="trash-2" className="size-4" />
								<span>
									<Trans>Delete</Trans>
								</span>
							</Button>

							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={isUpdating}
									onClick={onClose}
								>
									<Trans>Cancel</Trans>
								</Button>
								<Button
									type="button"
									variant="default"
									size="sm"
									disabled={isUpdating}
									onClick={() =>
										onUpdate({
											id: asset.id,
											fileName,
											altText,
											caption,
										})
									}
								>
									{isUpdating ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
								</Button>
							</div>
						</DialogFooter>
					</>
				) : (
					<>
						{/* Editor Header */}
						<div className="border-b px-6 py-4">
							<DialogHeader>
								<DialogTitle>
									<Trans>Edit image</Trans>
								</DialogTitle>
								<DialogDescription className="truncate">
									{asset.fileName || asset.altText || _(msg`Untitled image`)}
								</DialogDescription>
							</DialogHeader>
						</div>

						{/* Editor Body */}
						<div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
							{/* Editor Toolbar */}
							<div className="flex flex-wrap items-center justify-between gap-4 py-1">
								{/* Left: Transform */}
								<div className="flex items-center gap-3">
									<span className="text-muted-foreground text-xs font-medium">
										<Trans>Transform</Trans>
									</span>
									<div className="flex items-center gap-1">
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="text-muted-foreground hover:text-foreground size-7 rounded-md"
											onClick={() => setRotation((r) => (r - 90 + 360) % 360)}
											aria-label={_(msg`Rotate left`)}
										>
											<svg
												className="size-4 -scale-x-100"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
												<path d="M3 3v5h5" />
											</svg>
										</Button>
										<Button
											type="button"
											variant="ghost"
											size="icon-sm"
											className="text-muted-foreground hover:text-foreground size-7 rounded-md"
											onClick={() => setRotation((r) => (r + 90) % 360)}
											aria-label={_(msg`Rotate right`)}
										>
											<svg
												className="size-4"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
												<path d="M3 3v5h5" />
											</svg>
										</Button>
										<Button
											type="button"
											variant={flipH ? 'secondary' : 'ghost'}
											size="icon-sm"
											className={cn(
												'size-7 rounded-md',
												flipH
													? 'text-foreground'
													: 'text-muted-foreground hover:text-foreground',
											)}
											onClick={() => setFlipH((f) => !f)}
											aria-label={_(msg`Flip horizontally`)}
										>
											<svg
												className="size-4"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="m3 7 5 5-5 5V7" />
												<path d="m21 7-5 5 5 5V7" />
												<path d="M12 20v2" />
												<path d="M12 14v2" />
												<path d="M12 8v2" />
												<path d="M12 2v2" />
											</svg>
										</Button>
										<Button
											type="button"
											variant={flipV ? 'secondary' : 'ghost'}
											size="icon-sm"
											className={cn(
												'size-7 rounded-md',
												flipV
													? 'text-foreground'
													: 'text-muted-foreground hover:text-foreground',
											)}
											onClick={() => setFlipV((f) => !f)}
											aria-label={_(msg`Flip vertically`)}
										>
											<svg
												className="size-4"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="m17 3-5 5-5-5h10" />
												<path d="m17 21-5-5-5 5h10" />
												<path d="M4 12H2" />
												<path d="M10 12H8" />
												<path d="M16 12h-2" />
												<path d="M22 12h-2" />
											</svg>
										</Button>
									</div>
								</div>

								{/* Right: Presets */}
								<div className="flex items-center gap-2">
									<span className="text-muted-foreground text-xs font-medium">
										<Trans>Presets</Trans>
									</span>
									<div className="flex items-center gap-1">
										{(['normal', 'bw', 'vivid', 'warm', 'cool'] as const).map(
											(preset) => {
												const isActive = activePreset === preset
												const label = presetLabels[preset]
												return (
													<Button
														key={preset}
														type="button"
														variant={isActive ? 'default' : 'ghost'}
														size="sm"
														onClick={() => applyPreset(preset)}
														className={cn(
															'h-7 rounded-lg px-3 text-xs font-medium transition-colors',
															isActive
																? 'bg-foreground text-background hover:bg-foreground/90 shadow-xs'
																: 'text-muted-foreground hover:text-foreground',
														)}
													>
														{label}
													</Button>
												)
											},
										)}
										<Button
											type="button"
											variant="ghost"
											size="sm"
											onClick={resetEditor}
											className="text-destructive/80 hover:text-destructive hover:bg-destructive/10 h-7 rounded-lg px-2.5 text-xs font-medium transition-colors"
										>
											<Trans>Reset</Trans>
										</Button>
									</div>
								</div>
							</div>

							{/* Live Image Canvas Preview */}
							<div className="bg-muted/30 relative flex h-72 w-full items-center justify-center overflow-hidden rounded-lg border p-4 sm:h-80">
								<img
									src={asset.url}
									alt={_(msg`Editor preview`)}
									style={{
										transform: `rotate(${rotation}deg) scaleX(${flipH ? -1 : 1}) scaleY(${flipV ? -1 : 1})`,
										// eslint-disable-next-line shadcn/no-inline-styles -- Dynamic canvas editor filter values
										filter: `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%) grayscale(${grayscale}%) sepia(${sepia}%)`,
										transition: 'transform 0.2s ease, filter 0.2s ease',
									}}
									className="pointer-events-none max-h-full max-w-full rounded-md object-contain shadow-sm select-none"
								/>
							</div>

							{/* Adjustment Sliders Grid */}
							<div className="bg-muted/30 grid grid-cols-1 gap-4 rounded-lg border p-4 sm:grid-cols-2 md:grid-cols-4">
								<div className="space-y-1.5">
									<div className="text-foreground flex justify-between text-xs">
										<Label className="text-xs font-normal">
											<Trans>Brightness</Trans>
										</Label>
										<span className="text-muted-foreground font-mono">
											{brightness}%
										</span>
									</div>
									<Slider
										variant="pill"
										min={50}
										max={150}
										value={brightness}
										onValueChange={(val) => {
											setActivePreset(null)
											setBrightness(typeof val === 'number' ? val : val[0])
										}}
										aria-label={_(msg`Brightness`)}
									/>
								</div>

								<div className="space-y-1.5">
									<div className="text-foreground flex justify-between text-xs">
										<Label className="text-xs font-normal">
											<Trans>Contrast</Trans>
										</Label>
										<span className="text-muted-foreground font-mono">
											{contrast}%
										</span>
									</div>
									<Slider
										variant="pill"
										min={50}
										max={150}
										value={contrast}
										onValueChange={(val) => {
											setActivePreset(null)
											setContrast(typeof val === 'number' ? val : val[0])
										}}
										aria-label={_(msg`Contrast`)}
									/>
								</div>

								<div className="space-y-1.5">
									<div className="text-foreground flex justify-between text-xs">
										<Label className="text-xs font-normal">
											<Trans>Saturation</Trans>
										</Label>
										<span className="text-muted-foreground font-mono">
											{saturation}%
										</span>
									</div>
									<Slider
										variant="pill"
										min={0}
										max={200}
										value={saturation}
										onValueChange={(val) => {
											setActivePreset(null)
											setSaturation(typeof val === 'number' ? val : val[0])
										}}
										aria-label={_(msg`Saturation`)}
									/>
								</div>

								<div className="space-y-1.5">
									<div className="text-foreground flex justify-between text-xs">
										<Label className="text-xs font-normal">
											<Trans>Grayscale</Trans>
										</Label>
										<span className="text-muted-foreground font-mono">
											{grayscale}%
										</span>
									</div>
									<Slider
										variant="pill"
										min={0}
										max={100}
										value={grayscale}
										onValueChange={(val) => {
											setActivePreset(null)
											setGrayscale(typeof val === 'number' ? val : val[0])
										}}
										aria-label={_(msg`Grayscale`)}
									/>
								</div>
							</div>
						</div>

						{/* Editor Footer */}
						<DialogFooter className="m-0 sm:items-center sm:justify-between">
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={isExporting}
								onClick={() => {
									resetEditor()
									setIsEditing(false)
								}}
							>
								<Icon name="arrow-left" className="size-4" />
								<span>
									<Trans>Back to details</Trans>
								</span>
							</Button>

							<div className="flex items-center gap-2">
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={isExporting}
									onClick={resetEditor}
								>
									<Trans>Reset adjustments</Trans>
								</Button>
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={isExporting}
									onClick={handleSaveAsCopy}
								>
									<Icon name="copy" className="size-3.5" />
									<span>
										{isExporting ? (
											<Trans>Processing…</Trans>
										) : (
											<Trans>Save as copy</Trans>
										)}
									</span>
								</Button>
								<Button
									type="button"
									variant="default"
									size="sm"
									disabled={isExporting}
									onClick={handleSaveEditedImage}
								>
									<Icon name="check" className="size-3.5" />
									<span>
										{isExporting ? (
											<Trans>Applying…</Trans>
										) : (
											<Trans>Save changes</Trans>
										)}
									</span>
								</Button>
							</div>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}

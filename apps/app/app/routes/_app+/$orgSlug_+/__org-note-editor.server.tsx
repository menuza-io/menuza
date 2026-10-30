import { parseWithZod } from '@conform-to/zod/v4'
import { parseFormData } from '@mjackson/form-data-parser'
import { createId as cuid } from '@paralleldrive/cuid2'
import { logNoteActivity } from '@repo/audit'
import { requireUserId } from '@repo/auth'
import { markStepCompleted } from '@repo/common/onboarding'
import {
	and,
	db,
	eq,
	notInArray,
	Organization,
	OrganizationNote,
	OrganizationNoteUpload,
	UserOrganization,
} from '@repo/database'
import { noteHooks } from '@repo/integrations'
import { data, redirect, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import { sanitizeNoteContent } from '#app/utils/content-sanitization.server.ts'
import { invalidateNoteFavoritesCaches } from '#app/utils/note-favorites.server.ts'
import { processNoteMediaUploads } from '#app/utils/note-media-pipeline.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'
import { MAX_UPLOAD_SIZE, OrgNoteEditorSchema } from './__org-note-editor'

export async function action({ request, params }: ActionFunctionArgs) {
	const userId = await requireUserId(request)
	const orgSlug = params.orgSlug
	if (!orgSlug)
		throw new Response('Organization slug is required', { status: 400 })

	// Find organization ID - ensure user is an active member
	const [organization] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.innerJoin(
			UserOrganization,
			and(
				eq(UserOrganization.organizationId, Organization.id),
				eq(UserOrganization.userId, userId),
				eq(UserOrganization.active, true),
			),
		)
		.where(and(eq(Organization.slug, orgSlug), eq(Organization.active, true)))
		.limit(1)

	if (!organization) {
		throw new Response('Organization not found or you do not have access', {
			status: 404,
		})
	}

	const formData = await parseFormData(request, {
		maxFileSize: MAX_UPLOAD_SIZE * 10, // Allow larger files for videos
	})

	const rawId = formData.get('id')
	const targetId =
		typeof rawId === 'string' && rawId.trim() !== '' ? rawId.trim() : undefined

	if (targetId) {
		const [existingNoteForAuth] = await db
			.select({
				id: OrganizationNote.id,
				createdById: OrganizationNote.createdById,
			})
			.from(OrganizationNote)
			.where(
				and(
					eq(OrganizationNote.id, targetId),
					eq(OrganizationNote.organizationId, organization.id),
				),
			)
			.limit(1)

		if (!existingNoteForAuth) {
			throw new Response('Note not found', { status: 404 })
		}

		if (existingNoteForAuth.createdById === userId) {
			await requireUserWithOrganizationPermission(
				request,
				organization.id,
				ORG_PERMISSIONS.UPDATE_NOTE_OWN,
			)
		} else {
			await requireUserWithOrganizationPermission(
				request,
				organization.id,
				ORG_PERMISSIONS.UPDATE_NOTE_ANY,
			)
		}
	} else {
		await requireUserWithOrganizationPermission(
			request,
			organization.id,
			ORG_PERMISSIONS.CREATE_NOTE_OWN,
		)
	}

	const submission = await parseWithZod(formData, {
		schema: OrgNoteEditorSchema.superRefine(async (data, ctx) => {
			if (!data.id) return

			const [note] = await db
				.select({ id: OrganizationNote.id })
				.from(OrganizationNote)
				.where(
					and(
						eq(OrganizationNote.id, data.id),
						eq(OrganizationNote.organizationId, organization.id),
					),
				)
				.limit(1)
			if (!note) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					message: 'Note not found',
				})
			}
		}).transform(async ({ images = [], media = [], ...data }) => {
			const noteId = data.id ?? cuid()

			const { uploadUpdates, newUploads } = await processNoteMediaUploads(
				userId,
				noteId,
				organization.id,
				images,
				media,
			)

			return {
				...data,
				id: noteId,
				uploadUpdates,
				newUploads,
			}
		}),
		async: true,
	})

	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const {
		id: noteId,
		title,
		content,
		priority,
		tags,
		uploadUpdates = [],
		newUploads = [],
		actionType,
	} = submission.value

	// SECURITY: Sanitize note content to prevent XSS attacks
	const sanitizedContent = sanitizeNoteContent(content)

	// Process tags - convert comma-separated string to JSON array
	const processedTags = tags
		? JSON.stringify(
				tags
					.split(',')
					.map((tag) => tag.trim())
					.filter((tag) => tag.length > 0),
			)
		: null

	// Process priority - convert empty string to null and validate
	const processedPriority =
		priority &&
		priority !== '' &&
		['low', 'medium', 'high', 'urgent', 'no-priority'].includes(priority)
			? priority
			: null

	// Check if this is a new note or an update
	const [existingNote] = await db
		.select({
			id: OrganizationNote.id,
			title: OrganizationNote.title,
			content: OrganizationNote.content,
			priority: OrganizationNote.priority,
			tags: OrganizationNote.tags,
		})
		.from(OrganizationNote)
		.where(
			and(
				eq(OrganizationNote.id, noteId),
				eq(OrganizationNote.organizationId, organization.id),
			),
		)
		.limit(1)

	const isNewNote = !existingNote
	let beforeSnapshot:
		| {
				title: string
				content: string
				priority: string | null
				tags: string | null
		  }
		| undefined

	if (!isNewNote && existingNote) {
		beforeSnapshot = {
			title: existingNote.title,
			content: existingNote.content,
			priority: existingNote.priority,
			tags: existingNote.tags,
		}
	}

	const updatedNote = await db.transaction(async (tx) => {
		const noteValues = {
			title,
			content: sanitizedContent,
			priority: processedPriority,
			tags: processedTags,
		}
		const [updated] = isNewNote
			? await tx
					.insert(OrganizationNote)
					.values({
						id: noteId,
						...noteValues,
						organizationId: organization.id,
						createdById: userId,
					})
					.returning({ id: OrganizationNote.id })
			: await tx
					.update(OrganizationNote)
					.set(
						actionType === 'inline-edit'
							? { title, content: sanitizedContent }
							: noteValues,
					)
					.where(eq(OrganizationNote.id, noteId))
					.returning({ id: OrganizationNote.id })
		if (!updated) throw new Error('Failed to save note')

		if (!isNewNote && actionType !== 'inline-edit') {
			const retainedIds = uploadUpdates
				.map((upload) => upload.id)
				.filter((id): id is string => Boolean(id))
			if (retainedIds.length > 0) {
				await tx
					.delete(OrganizationNoteUpload)
					.where(
						and(
							eq(OrganizationNoteUpload.noteId, noteId),
							notInArray(OrganizationNoteUpload.id, retainedIds),
						),
					)
			} else {
				await tx
					.delete(OrganizationNoteUpload)
					.where(eq(OrganizationNoteUpload.noteId, noteId))
			}
			for (const upload of uploadUpdates) {
				if (upload.id) {
					await tx
						.update(OrganizationNoteUpload)
						.set({
							...upload,
							id: upload.objectKey ? cuid() : upload.id,
						})
						.where(
							and(
								eq(OrganizationNoteUpload.id, upload.id),
								eq(OrganizationNoteUpload.noteId, noteId),
							),
						)
				}
			}
		}
		if (newUploads.length > 0) {
			await tx
				.insert(OrganizationNoteUpload)
				.values(newUploads.map((upload) => ({ ...upload, noteId })))
		}
		return updated
	})

	// Log activity
	if (isNewNote) {
		await logNoteActivity({
			noteId: updatedNote.id,
			userId,
			action: 'created',
			metadata: { title, hasUploads: newUploads.length > 0 },
		})

		// Track onboarding step completion for creating first note
		try {
			await markStepCompleted(userId, organization.id, 'create_first_note', {
				completedVia: 'note_creation',
				noteId: updatedNote.id,
				noteTitle: title,
			})
		} catch (error) {
			// Don't fail the note creation if onboarding tracking fails
			console.error('Failed to track note creation onboarding step:', error)
		}
	} else if (beforeSnapshot) {
		// Determine what changed
		const titleChanged = beforeSnapshot.title !== title
		const contentChanged = beforeSnapshot.content !== content
		const priorityChanged = beforeSnapshot.priority !== processedPriority
		const tagsChanged = beforeSnapshot.tags !== processedTags

		// The sidebar favorites show the title from a cached list.
		if (titleChanged) {
			await invalidateNoteFavoritesCaches(updatedNote.id)
		}

		await logNoteActivity({
			noteId: updatedNote.id,
			userId,
			action: 'updated',
			metadata: {
				titleChanged,
				contentChanged,
				priorityChanged,
				tagsChanged,
				hasUploadUpdates: uploadUpdates.length > 0 || newUploads.length > 0,
			},
		})
	}

	// Trigger integration hooks
	if (isNewNote) {
		await noteHooks.afterNoteCreated(updatedNote.id, userId)
	} else {
		await noteHooks.afterNoteUpdated(updatedNote.id, userId, beforeSnapshot)
	}

	if (actionType === 'inline-edit') {
		return data({ result: submission.reply() }, { status: 200 })
	}

	return redirect(`/${orgSlug}/notes/${updatedNote.id}`)
}

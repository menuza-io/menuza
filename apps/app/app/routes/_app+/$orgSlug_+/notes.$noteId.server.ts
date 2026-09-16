import { parseWithZod } from '@conform-to/zod'
import { invariantResponse } from '@epic-web/invariant'
import { createId } from '@paralleldrive/cuid2'
import { logNoteActivity } from '@repo/audit'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '@repo/auth'
import { redirectWithToast } from '@repo/common/toast'
import {
	and,
	db,
	eq,
	inArray,
	Organization,
	OrganizationMediaAsset,
	OrganizationNote,
	OrganizationNoteFavorite,
	Integration,
	NoteAccess,
	NoteComment,
	NoteCommentImage,
	NoteIntegrationConnection,
	User,
	UserOrganization,
} from '@repo/database'
import { noteHooks, integrationManager } from '@repo/integrations'
import { data, type ActionFunctionArgs } from 'react-router'
import { z } from 'zod'
import {
	sanitizeCommentContent,
	sanitizeTextContent,
} from '#app/utils/content-sanitization.server.ts'
import {
	notifyCommentMentions,
	notifyNoteOwner,
} from '#app/utils/notifications.server.ts'
import {
	DeleteFormSchema,
	ConnectNoteSchema,
	DisconnectNoteSchema,
	GetChannelsSchema,
	ShareNoteSchema,
	AddNoteAccessSchema,
	RemoveNoteAccessSchema,
	BatchUpdateNoteAccessSchema,
	AddCommentSchema,
	DeleteCommentSchema,
	EditCommentSchema,
	ToggleFavoriteSchema,
} from './notes.$noteId'

export interface IntentContext extends ActionFunctionArgs {
	formData: FormData
	userId: string
}

const MAX_COMMENT_IMAGES = 10
const MAX_COMMENT_IMAGE_SIZE = 3 * 1024 * 1024
const COMMENT_IMAGE_TYPES = new Set([
	'image/jpeg',
	'image/png',
	'image/gif',
	'image/webp',
	'image/avif',
])

const CommentAttachmentCountsSchema = z
	.object({
		imageCount: z.coerce.number().int().min(0).max(MAX_COMMENT_IMAGES),
		libraryAssetCount: z.coerce.number().int().min(0).max(MAX_COMMENT_IMAGES),
	})
	.refine(
		({ imageCount, libraryAssetCount }) =>
			imageCount + libraryAssetCount <= MAX_COMMENT_IMAGES,
	)

const CommentImageSchema = z
	.instanceof(File)
	.refine((file) => file.size > 0 && file.size <= MAX_COMMENT_IMAGE_SIZE)
	.refine((file) => COMMENT_IMAGE_TYPES.has(file.type))

/**
 * Deletes the storage objects uploaded for a comment that could not be saved,
 * together with the media rows registered for them. Called when creating the
 * comment fails after one or more uploads succeeded, so a failed comment never
 * leaves orphaned objects or library entries behind.
 */
async function removeUploadedCommentImages(
	objectKeys: string[],
	organizationId: string,
) {
	if (objectKeys.length === 0) return

	try {
		await db
			.delete(OrganizationMediaAsset)
			.where(
				and(
					eq(OrganizationMediaAsset.organizationId, organizationId),
					inArray(OrganizationMediaAsset.objectKey, objectKeys),
				),
			)
	} catch (error) {
		console.error(
			'Failed to remove media rows for a failed comment upload:',
			error,
		)
	}

	const { deleteOrganizationStorageObject } =
		await import('#app/utils/storage.server.ts')
	for (const objectKey of objectKeys) {
		try {
			await deleteOrganizationStorageObject(objectKey, organizationId)
		} catch (error) {
			console.error(
				`Failed to clean up uploaded comment image ${objectKey}:`,
				error,
			)
		}
	}
}

export async function userHasOrgAccess(userId: string, organizationId: string) {
	await requireUserWithOrganizationPermission(
		userId,
		organizationId,
		ORG_PERMISSIONS.READ_NOTE_OWN,
	)
}

export async function handleDeleteNoteIntent({
	formData,
	userId,
}: IntentContext) {
	const submission = parseWithZod(formData, { schema: DeleteFormSchema })
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { noteId } = submission.value
	const [note] = await db
		.select({
			id: OrganizationNote.id,
			title: OrganizationNote.title,
			organizationId: OrganizationNote.organizationId,
			createdById: OrganizationNote.createdById,
			organizationSlug: Organization.slug,
		})
		.from(OrganizationNote)
		.innerJoin(
			Organization,
			eq(OrganizationNote.organizationId, Organization.id),
		)
		.where(eq(OrganizationNote.id, noteId))
		.limit(1)
	invariantResponse(note, 'Not found', { status: 404 })

	let canDelete = false
	try {
		await requireUserWithOrganizationPermission(
			userId,
			note.organizationId,
			ORG_PERMISSIONS.DELETE_NOTE_ANY,
		)
		canDelete = true
	} catch {
		if (note.createdById === userId) {
			try {
				await requireUserWithOrganizationPermission(
					userId,
					note.organizationId,
					ORG_PERMISSIONS.DELETE_NOTE_OWN,
				)
				canDelete = true
			} catch {
				// No permissions
			}
		}
	}

	if (!canDelete) {
		throw new Response('Not authorized - insufficient delete permissions', {
			status: 403,
		})
	}

	await logNoteActivity({
		noteId: note.id,
		userId,
		action: 'deleted',
		metadata: { title: note.title || 'Untitled' },
	})

	await noteHooks.beforeNoteDeleted(note.id, userId)
	await db.delete(OrganizationNote).where(eq(OrganizationNote.id, note.id))

	return redirectWithToast(`/${note.organizationSlug}/notes`, {
		type: 'success',
		title: 'Success',
		description: 'The note has been deleted.',
	})
}

export async function handleConnectChannelIntent({
	formData,
	userId,
}: IntentContext) {
	const submission = parseWithZod(formData, { schema: ConnectNoteSchema })
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { noteId, integrationId, channelId } = submission.value
	const [note] = await db
		.select({ organizationId: OrganizationNote.organizationId })
		.from(OrganizationNote)
		.where(eq(OrganizationNote.id, noteId))
		.limit(1)
	invariantResponse(note, 'Note not found', { status: 404 })
	await userHasOrgAccess(userId, note.organizationId)

	try {
		await integrationManager.connectNoteToChannel({
			noteId,
			integrationId,
			externalId: channelId,
		})

		await logNoteActivity({
			noteId,
			userId,
			action: 'integration_connected',
			integrationId,
			metadata: { externalId: channelId },
		})

		return data({ result: { status: 'success' } })
	} catch {
		return data(
			{
				result: { status: 'error', error: 'Failed to connect note to channel' },
			},
			{ status: 500 },
		)
	}
}

export async function handleDisconnectChannelIntent({
	formData,
	userId,
}: IntentContext) {
	const submission = parseWithZod(formData, { schema: DisconnectNoteSchema })
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { connectionId } = submission.value
	const [connection] = await db
		.select({ organizationId: OrganizationNote.organizationId })
		.from(NoteIntegrationConnection)
		.innerJoin(
			OrganizationNote,
			eq(NoteIntegrationConnection.noteId, OrganizationNote.id),
		)
		.where(eq(NoteIntegrationConnection.id, connectionId))
		.limit(1)
	invariantResponse(connection, 'Connection not found', { status: 404 })
	await userHasOrgAccess(userId, connection.organizationId)

	try {
		const [connectionDetails] = await db
			.select({
				noteId: NoteIntegrationConnection.noteId,
				externalId: NoteIntegrationConnection.externalId,
				integrationId: Integration.id,
				providerName: Integration.providerName,
			})
			.from(NoteIntegrationConnection)
			.innerJoin(
				Integration,
				eq(NoteIntegrationConnection.integrationId, Integration.id),
			)
			.where(eq(NoteIntegrationConnection.id, connectionId))
			.limit(1)

		await integrationManager.disconnectNoteFromChannel(connectionId)

		if (connectionDetails) {
			await logNoteActivity({
				noteId: connectionDetails.noteId,
				userId,
				action: 'integration_disconnected',
				integrationId: connectionDetails.integrationId,
				metadata: {
					externalId: connectionDetails.externalId,
					providerName: connectionDetails.providerName,
				},
			})
		}

		return data({ result: { status: 'success' } })
	} catch {
		return data(
			{
				result: {
					status: 'error',
					error: 'Failed to disconnect note from channel',
				},
			},
			{ status: 500 },
		)
	}
}

export async function handleGetChannelsIntent({
	formData,
	userId,
}: IntentContext) {
	const submission = parseWithZod(formData, { schema: GetChannelsSchema })
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { integrationId } = submission.value
	try {
		const integration = await integrationManager.getIntegration(integrationId)
		if (!integration) {
			return data({ error: 'Integration not found' }, { status: 404 })
		}

		await userHasOrgAccess(userId, integration.organizationId)
		const channels =
			await integrationManager.getAvailableChannels(integrationId)
		return data({ channels })
	} catch (error) {
		return data({
			channels: [],
			error:
				error instanceof Error ? error.message : 'Failed to fetch channels',
		})
	}
}

export async function handleUpdateSharingIntent({
	formData,
	userId,
}: IntentContext) {
	const submission = parseWithZod(formData, { schema: ShareNoteSchema })
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { noteId, isPublic } = submission.value
	const [note] = await db
		.select({
			organizationId: OrganizationNote.organizationId,
			createdById: OrganizationNote.createdById,
		})
		.from(OrganizationNote)
		.where(eq(OrganizationNote.id, noteId))
		.limit(1)
	invariantResponse(note, 'Note not found', { status: 404 })
	await userHasOrgAccess(userId, note.organizationId)

	if (note.createdById !== userId) {
		throw new Response('Not authorized', { status: 403 })
	}

	try {
		await db
			.update(OrganizationNote)
			.set({ isPublic })
			.where(eq(OrganizationNote.id, noteId))

		if (isPublic) {
			await db.delete(NoteAccess).where(eq(NoteAccess.noteId, noteId))
		}

		await logNoteActivity({
			noteId,
			userId,
			action: 'sharing_changed',
			metadata: { isPublic },
		})

		return data({ result: { status: 'success' } })
	} catch {
		return data(
			{ result: { status: 'error', error: 'Failed to update note sharing' } },
			{ status: 500 },
		)
	}
}

export async function handleAddAccessIntent({
	formData,
	userId,
}: IntentContext) {
	const submission = parseWithZod(formData, { schema: AddNoteAccessSchema })
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { noteId, userId: targetUserId } = submission.value
	const [note] = await db
		.select({
			organizationId: OrganizationNote.organizationId,
			createdById: OrganizationNote.createdById,
		})
		.from(OrganizationNote)
		.where(eq(OrganizationNote.id, noteId))
		.limit(1)
	invariantResponse(note, 'Note not found', { status: 404 })
	await userHasOrgAccess(userId, note.organizationId)

	if (note.createdById !== userId) {
		throw new Response('Not authorized', { status: 403 })
	}

	const [targetUserInOrg] = await db
		.select({ userId: UserOrganization.userId })
		.from(UserOrganization)
		.where(
			and(
				eq(UserOrganization.userId, targetUserId),
				eq(UserOrganization.organizationId, note.organizationId),
				eq(UserOrganization.active, true),
			),
		)
		.limit(1)

	if (!targetUserInOrg) {
		return data(
			{
				result: {
					status: 'error',
					error: 'User is not a member of this organization',
				},
			},
			{ status: 400 },
		)
	}

	try {
		await db
			.insert(NoteAccess)
			.values({ noteId, userId: targetUserId })
			.onConflictDoNothing()

		await logNoteActivity({
			noteId,
			userId,
			action: 'access_granted',
			targetUserId,
		})

		return data({ result: { status: 'success' } })
	} catch {
		return data(
			{ result: { status: 'error', error: 'Failed to add note access' } },
			{ status: 500 },
		)
	}
}

export async function handleRemoveAccessIntent({
	formData,
	userId,
}: IntentContext) {
	const submission = parseWithZod(formData, { schema: RemoveNoteAccessSchema })
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { noteId, userId: targetUserId } = submission.value
	const [note] = await db
		.select({
			organizationId: OrganizationNote.organizationId,
			createdById: OrganizationNote.createdById,
		})
		.from(OrganizationNote)
		.where(eq(OrganizationNote.id, noteId))
		.limit(1)
	invariantResponse(note, 'Note not found', { status: 404 })
	await userHasOrgAccess(userId, note.organizationId)

	if (note.createdById !== userId) {
		throw new Response('Not authorized', { status: 403 })
	}

	try {
		await db
			.delete(NoteAccess)
			.where(
				and(eq(NoteAccess.noteId, noteId), eq(NoteAccess.userId, targetUserId)),
			)

		await logNoteActivity({
			noteId,
			userId,
			action: 'access_revoked',
			targetUserId,
		})

		return data({ result: { status: 'success' } })
	} catch {
		return data(
			{ result: { status: 'error', error: 'Failed to remove note access' } },
			{ status: 500 },
		)
	}
}

export async function handleBatchUpdateAccessIntent({
	formData,
	userId,
}: IntentContext) {
	const usersToAdd = formData.getAll('usersToAdd') as string[]
	const usersToRemove = formData.getAll('usersToRemove') as string[]

	const parsedData = {
		intent: formData.get('intent') as 'batch-update-note-access',
		noteId: formData.get('noteId') as string,
		isPublic: formData.get('isPublic') as string,
		usersToAdd,
		usersToRemove,
	}

	const validationResult = BatchUpdateNoteAccessSchema.safeParse(parsedData)
	if (!validationResult.success) {
		return data(
			{ result: { status: 'error', error: 'Invalid form data' } },
			{ status: 400 },
		)
	}

	const {
		noteId,
		isPublic,
		usersToAdd: validUsersToAdd,
		usersToRemove: validUsersToRemove,
	} = validationResult.data

	const [note] = await db
		.select({
			organizationId: OrganizationNote.organizationId,
			createdById: OrganizationNote.createdById,
			isPublic: OrganizationNote.isPublic,
		})
		.from(OrganizationNote)
		.where(eq(OrganizationNote.id, noteId))
		.limit(1)
	invariantResponse(note, 'Note not found', { status: 404 })
	await userHasOrgAccess(userId, note.organizationId)

	if (note.createdById !== userId) {
		throw new Response('Not authorized', { status: 403 })
	}

	let confirmedUserIdsToAdd: string[] = []
	if (validUsersToAdd.length > 0 && !isPublic) {
		const orgMembers = await db
			.select({ userId: UserOrganization.userId })
			.from(UserOrganization)
			.where(
				and(
					inArray(UserOrganization.userId, validUsersToAdd),
					eq(UserOrganization.organizationId, note.organizationId),
					eq(UserOrganization.active, true),
				),
			)
		confirmedUserIdsToAdd = orgMembers.map((member) => member.userId)
		const invalidUsers = validUsersToAdd.filter(
			(id) => !confirmedUserIdsToAdd.includes(id),
		)
		if (invalidUsers.length > 0) {
			return data(
				{
					result: {
						status: 'error',
						error: `Some users are not members of this organization: ${invalidUsers.join(', ')}`,
					},
				},
				{ status: 400 },
			)
		}
	}

	try {
		let sharingChanged = false
		await db.transaction(async (tx) => {
			if (isPublic !== note.isPublic) {
				await tx
					.update(OrganizationNote)
					.set({ isPublic })
					.where(eq(OrganizationNote.id, noteId))
				sharingChanged = true
				if (isPublic) {
					await tx.delete(NoteAccess).where(eq(NoteAccess.noteId, noteId))
					return
				}
			}

			if (validUsersToRemove.length > 0) {
				await tx
					.delete(NoteAccess)
					.where(
						and(
							eq(NoteAccess.noteId, noteId),
							inArray(NoteAccess.userId, validUsersToRemove),
						),
					)
				for (const targetUserId of validUsersToRemove) {
					await logNoteActivity({
						noteId,
						userId,
						action: 'access_revoked',
						targetUserId,
					})
				}
			}

			if (confirmedUserIdsToAdd.length > 0 && !isPublic) {
				for (const targetUserId of confirmedUserIdsToAdd) {
					await tx
						.insert(NoteAccess)
						.values({ noteId, userId: targetUserId })
						.onConflictDoNothing()
					await logNoteActivity({
						noteId,
						userId,
						action: 'access_granted',
						targetUserId,
					})
				}
			}
		})

		if (sharingChanged) {
			await logNoteActivity({
				noteId,
				userId,
				action: 'sharing_changed',
				metadata: { isPublic },
			})
		}

		return data({ result: { status: 'success' } })
	} catch (error) {
		return data(
			{
				result: {
					status: 'error',
					error:
						error instanceof Error
							? error.message
							: 'Failed to update note access',
				},
			},
			{ status: 500 },
		)
	}
}

export async function handleAddCommentIntent({
	formData,
	userId,
}: IntentContext) {
	const submission = parseWithZod(formData, { schema: AddCommentSchema })
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { noteId, content, parentId } = submission.value
	const noteRow = await db.query.OrganizationNote.findFirst({
		columns: { organizationId: true, isPublic: true, createdById: true },
		with: { noteAccess: { columns: { userId: true } } },
		where: (note, { eq }) => eq(note.id, noteId),
	})
	const note = noteRow
	invariantResponse(note, 'Note not found', { status: 404 })

	await requireUserWithOrganizationPermission(
		userId,
		note.organizationId,
		ORG_PERMISSIONS.CREATE_NOTE_OWN,
	)

	if (!note.isPublic) {
		try {
			await requireUserWithOrganizationPermission(
				userId,
				note.organizationId,
				ORG_PERMISSIONS.READ_NOTE_ANY,
			)
		} catch {
			const hasPersonalAccess =
				note.createdById === userId ||
				note.noteAccess.some((access) => access.userId === userId)

			if (!hasPersonalAccess) {
				throw new Response('Not authorized - cannot comment on this note', {
					status: 403,
				})
			}
		}
	}

	if (parentId) {
		const [parentComment] = await db
			.select({ id: NoteComment.id })
			.from(NoteComment)
			.where(and(eq(NoteComment.id, parentId), eq(NoteComment.noteId, noteId)))
			.limit(1)
		if (!parentComment) {
			return data(
				{ result: { status: 'error', error: 'Parent comment not found' } },
				{ status: 404 },
			)
		}
	}

	const attachmentCounts = CommentAttachmentCountsSchema.safeParse({
		imageCount: formData.get('imageCount') ?? 0,
		libraryAssetCount: formData.get('libraryAssetCount') ?? 0,
	})
	if (!attachmentCounts.success) {
		return data(
			{
				result: submission.reply({
					fieldErrors: {
						imageCount: [
							'Invalid image count. Maximum 10 images allowed in total.',
						],
					},
				}),
			},
			{ status: 400 },
		)
	}
	const { imageCount, libraryAssetCount } = attachmentCounts.data

	const imageFiles: File[] = []
	for (let i = 0; i < imageCount; i++) {
		const image = CommentImageSchema.safeParse(formData.get(`image-${i}`))
		if (!image.success) {
			return data(
				{
					result: submission.reply({
						fieldErrors: {
							imageCount: ['One or more attached images are invalid.'],
						},
					}),
				},
				{ status: 400 },
			)
		}
		imageFiles.push(image.data)
	}

	const libraryAssetIds: string[] = []
	for (let i = 0; i < libraryAssetCount; i++) {
		const id = formData.get(`libraryAssetId-${i}`)
		if (typeof id !== 'string' || !id) {
			return data(
				{
					result: submission.reply({
						fieldErrors: {
							libraryAssetCount: ['One or more library assets are invalid.'],
						},
					}),
				},
				{ status: 400 },
			)
		}
		libraryAssetIds.push(id)
	}

	const uniqueLibraryAssetIds = [...new Set(libraryAssetIds)]
	const libraryAssets = uniqueLibraryAssetIds.length
		? await db
				.select({
					id: OrganizationMediaAsset.id,
					objectKey: OrganizationMediaAsset.objectKey,
					altText: OrganizationMediaAsset.altText,
				})
				.from(OrganizationMediaAsset)
				.where(
					and(
						inArray(OrganizationMediaAsset.id, uniqueLibraryAssetIds),
						eq(OrganizationMediaAsset.organizationId, note.organizationId),
					),
				)
		: []

	if (libraryAssets.length !== uniqueLibraryAssetIds.length) {
		return data(
			{
				result: submission.reply({
					fieldErrors: {
						libraryAssetCount: ['One or more library assets are unavailable.'],
					},
				}),
			},
			{ status: 400 },
		)
	}

	const sanitizedContent = sanitizeCommentContent(content)
	const hasTextContent = sanitizeTextContent(sanitizedContent).trim().length > 0
	if (
		!hasTextContent &&
		imageFiles.length === 0 &&
		libraryAssets.length === 0
	) {
		return data(
			{
				result: submission.reply({
					fieldErrors: {
						content: ['Add a comment or attach at least one image.'],
					},
				}),
			},
			{ status: 400 },
		)
	}

	try {
		// Uploads happen before the transaction so the SQLite write lock is not
		// held while we talk to storage. Every object we upload (and the media
		// row registered for it) is tracked so it can be cleaned up when a later
		// step fails.
		const commentId = createId()
		const uploadedObjectKeys: string[] = []
		const uploadedImages: Array<{
			commentId: string
			objectKey: string
			altText: string | null
		}> = []

		if (imageFiles.length > 0) {
			const { uploadCommentImage } =
				await import('#app/utils/storage.server.ts')
			for (const imageFile of imageFiles) {
				const objectKey = await uploadCommentImage(
					userId,
					commentId,
					imageFile,
					note.organizationId,
				)
				uploadedObjectKeys.push(objectKey)
				uploadedImages.push({ commentId, objectKey, altText: null })
			}
		}

		try {
			await db.transaction(async (tx) => {
				await tx.insert(NoteComment).values({
					id: commentId,
					content: sanitizedContent,
					noteId,
					userId,
					parentId,
				})

				if (uploadedImages.length > 0) {
					await tx.insert(NoteCommentImage).values(uploadedImages)
				}

				if (libraryAssets.length > 0) {
					await tx.insert(NoteCommentImage).values(
						libraryAssets.map((asset) => ({
							commentId,
							objectKey: asset.objectKey,
							altText: asset.altText,
						})),
					)
				}
			})
		} catch (error) {
			await removeUploadedCommentImages(uploadedObjectKeys, note.organizationId)
			throw error
		}

		await logNoteActivity({
			noteId,
			userId,
			action: 'comment_added',
			commentId,
			metadata: {
				parentId,
				hasImages: imageFiles.length > 0 || libraryAssets.length > 0,
			},
		})

		const [commenter, noteWithTitle, organization] = await Promise.all([
			db
				.select({ name: User.name, username: User.username })
				.from(User)
				.where(eq(User.id, userId))
				.limit(1)
				.then((rows) => rows[0]),
			db
				.select({
					title: OrganizationNote.title,
					createdById: OrganizationNote.createdById,
				})
				.from(OrganizationNote)
				.where(eq(OrganizationNote.id, noteId))
				.limit(1)
				.then((rows) => rows[0]),
			db
				.select({ slug: Organization.slug })
				.from(Organization)
				.where(eq(Organization.id, note.organizationId))
				.limit(1)
				.then((rows) => rows[0]),
		])

		if (commenter && noteWithTitle && organization) {
			const commenterName = commenter.name || commenter.username
			const noteTitle = noteWithTitle.title || 'Untitled Note'

			await notifyCommentMentions({
				commentContent: sanitizedContent,
				commentId,
				noteId,
				noteTitle,
				noteOwnerId: noteWithTitle.createdById,
				commenterUserId: userId,
				commenterName,
				organizationId: note.organizationId,
				organizationSlug: organization.slug,
			})

			await notifyNoteOwner({
				noteId,
				noteTitle,
				noteOwnerId: noteWithTitle.createdById,
				commentId,
				commenterUserId: userId,
				commenterName,
				commentContent: sanitizedContent,
				organizationId: note.organizationId,
				organizationSlug: organization.slug,
			})
		}

		return data({ result: { status: 'success' } })
	} catch {
		return data(
			{ result: { status: 'error', error: 'Failed to add comment' } },
			{ status: 500 },
		)
	}
}

export async function handleEditCommentIntent({
	formData,
	userId,
}: IntentContext) {
	const submission = parseWithZod(formData, { schema: EditCommentSchema })
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { commentId, content } = submission.value
	const [comment] = await db
		.select({
			userId: NoteComment.userId,
			noteId: NoteComment.noteId,
			organizationId: OrganizationNote.organizationId,
		})
		.from(NoteComment)
		.innerJoin(OrganizationNote, eq(NoteComment.noteId, OrganizationNote.id))
		.where(eq(NoteComment.id, commentId))
		.limit(1)
	invariantResponse(comment, 'Comment not found', { status: 404 })
	await userHasOrgAccess(userId, comment.organizationId)

	if (comment.userId !== userId) {
		throw new Response('Not authorized', { status: 403 })
	}

	try {
		const sanitizedContent = sanitizeCommentContent(content)
		await db
			.update(NoteComment)
			.set({ content: sanitizedContent })
			.where(eq(NoteComment.id, commentId))

		return data({ result: { status: 'success' } })
	} catch {
		return data(
			{ result: { status: 'error', error: 'Failed to update comment' } },
			{ status: 500 },
		)
	}
}

export async function handleDeleteCommentIntent({
	formData,
	userId,
}: IntentContext) {
	const submission = parseWithZod(formData, { schema: DeleteCommentSchema })
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { commentId } = submission.value
	const [comment] = await db
		.select({
			userId: NoteComment.userId,
			organizationId: OrganizationNote.organizationId,
		})
		.from(NoteComment)
		.innerJoin(OrganizationNote, eq(NoteComment.noteId, OrganizationNote.id))
		.where(eq(NoteComment.id, commentId))
		.limit(1)
	invariantResponse(comment, 'Comment not found', { status: 404 })
	await userHasOrgAccess(userId, comment.organizationId)

	if (comment.userId !== userId) {
		throw new Response('Not authorized', { status: 403 })
	}

	try {
		const [commentToDelete] = await db
			.select({ noteId: NoteComment.noteId })
			.from(NoteComment)
			.where(eq(NoteComment.id, commentId))
			.limit(1)

		await db.delete(NoteComment).where(eq(NoteComment.id, commentId))

		if (commentToDelete) {
			await logNoteActivity({
				noteId: commentToDelete.noteId,
				userId,
				action: 'comment_deleted',
				commentId,
			})
		}

		return data({ result: { status: 'success' } })
	} catch {
		return data(
			{ result: { status: 'error', error: 'Failed to delete comment' } },
			{ status: 500 },
		)
	}
}

export async function handleToggleFavoriteIntent({
	formData,
	userId,
}: IntentContext) {
	const submission = parseWithZod(formData, { schema: ToggleFavoriteSchema })
	if (submission.status !== 'success') {
		return data(
			{ result: submission.reply() },
			{ status: submission.status === 'error' ? 400 : 200 },
		)
	}

	const { noteId } = submission.value
	const note = await db.query.OrganizationNote.findFirst({
		columns: { organizationId: true, isPublic: true, createdById: true },
		with: { noteAccess: { columns: { userId: true } } },
		where: (record, { eq }) => eq(record.id, noteId),
	})
	invariantResponse(note, 'Note not found', { status: 404 })

	await requireUserWithOrganizationPermission(
		userId,
		note.organizationId,
		ORG_PERMISSIONS.READ_NOTE_OWN,
	)

	if (!note.isPublic) {
		try {
			await requireUserWithOrganizationPermission(
				userId,
				note.organizationId,
				ORG_PERMISSIONS.READ_NOTE_ANY,
			)
		} catch {
			const hasPersonalAccess =
				note.createdById === userId ||
				note.noteAccess.some((access) => access.userId === userId)

			if (!hasPersonalAccess) {
				throw new Response('Not authorized - cannot favorite this note', {
					status: 403,
				})
			}
		}
	}

	try {
		const [existingFavorite] = await db
			.select({ id: OrganizationNoteFavorite.id })
			.from(OrganizationNoteFavorite)
			.where(
				and(
					eq(OrganizationNoteFavorite.userId, userId),
					eq(OrganizationNoteFavorite.noteId, noteId),
				),
			)
			.limit(1)

		if (existingFavorite) {
			await db
				.delete(OrganizationNoteFavorite)
				.where(eq(OrganizationNoteFavorite.id, existingFavorite.id))
		} else {
			await db.insert(OrganizationNoteFavorite).values({ userId, noteId })
		}

		return data({ result: { status: 'success' } })
	} catch {
		return data(
			{ result: { status: 'error', error: 'Failed to toggle favorite' } },
			{ status: 500 },
		)
	}
}

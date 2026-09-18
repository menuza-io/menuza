import { invariant } from '@epic-web/invariant'
import {
	and,
	db,
	eq,
	Notification,
	NotificationPreference,
	User,
	UserOrganization,
} from '@repo/database'
import { sendEmail, MentionEmail, CommentEmail } from '@repo/email'
import { extractMentions, resolveMentionsToUserIds } from '@repo/notifications'

import { sanitizeTextContent } from '#app/utils/content-sanitization.server.ts'

const appUrl = process.env.BASE_URL
invariant(appUrl, 'BASE_URL is required')

interface NotifyCommentMentionsParams {
	commentContent: string
	commentId: string
	noteId: string
	noteTitle: string
	noteOwnerId: string
	commenterUserId: string
	commenterName: string
	organizationId: string
	organizationSlug: string
}

interface NotifyNoteOwnerParams {
	noteId: string
	noteTitle: string
	noteOwnerId: string
	commentId: string
	commenterUserId: string
	commenterName: string
	commentContent: string
	organizationId: string
	organizationSlug: string
}

/**
 * Sends notifications to users mentioned in a comment
 */
export async function notifyCommentMentions({
	commentContent,
	commentId,
	noteId,
	noteTitle,
	noteOwnerId,
	commenterUserId,
	commenterName,
	organizationId,
	organizationSlug,
}: NotifyCommentMentionsParams) {
	try {
		// Extract mentions from comment content
		const mentions = extractMentions(commentContent)

		if (mentions.length === 0) {
			return
		}

		// Get organization members to resolve mentions
		const organizationMembers = await db
			.select({
				userId: UserOrganization.userId,
				user: {
					id: User.id,
					name: User.name,
					username: User.username,
					email: User.email,
				},
			})
			.from(UserOrganization)
			.innerJoin(User, eq(UserOrganization.userId, User.id))
			.where(
				and(
					eq(UserOrganization.organizationId, organizationId),
					eq(UserOrganization.active, true),
				),
			)

		// Resolve mentions to user IDs
		const mentionedUserIds = await resolveMentionsToUserIds(
			mentions,
			organizationMembers,
		)

		// Filter out the commenter (don't notify yourself) and note owner
		const filteredUserIds = mentionedUserIds.filter(
			(id) => id !== commenterUserId && id !== noteOwnerId,
		)

		if (filteredUserIds.length === 0) {
			return
		}

		const safeCommenterName = sanitizeTextContent(commenterName)
		const noteUrl = `${appUrl}/${organizationSlug}/notes/${noteId}`

		for (const userId of filteredUserIds) {
			const user = organizationMembers.find(
				(member) => member.user.id === userId,
			)?.user
			if (!user) continue

			const payload = {
				noteId,
				commentId,
				noteTitle,
				commenterName: safeCommenterName,
				commentContent,
				organizationSlug,
				noteUrl,
			}

			// Check preferences
			const [preference] = await db
				.select()
				.from(NotificationPreference)
				.where(
					and(
						eq(NotificationPreference.userId, userId),
						eq(NotificationPreference.organizationId, organizationId),
						eq(NotificationPreference.workflow, 'comment-mention-workflow'),
					),
				)
				.limit(1)

			const inAppEnabled = preference?.inApp ?? true
			const emailEnabled = preference?.email ?? true

			if (inAppEnabled) {
				// 1. Save notification to DB using upsert to enforce uniqueness
				await db
					.insert(Notification)
					.values({
						userId,
						organizationId,
						type: 'mention',
						entityId: commentId,
						payload: JSON.stringify(payload),
					})
					.onConflictDoUpdate({
						target: [
							Notification.userId,
							Notification.organizationId,
							Notification.type,
							Notification.entityId,
						],
						set: {
							payload: JSON.stringify(payload),
							isRead: false,
							isSeen: false,
							updatedAt: new Date(),
						},
					})

				// Broadcast event logic moved to database polling in stream.tsx
			}

			if (emailEnabled) {
				// 2. Send email reliably
				try {
					const res = await sendEmail({
						to: user.email,
						subject: `${safeCommenterName} mentioned you in a comment`,
						react: MentionEmail(payload),
					})
					if (res.status === 'error') {
						console.error('Failed to send mention email:', res.error)
					}
				} catch (err) {
					console.error('Failed to send mention email:', err)
				}
			}
		}
	} catch (error) {
		console.error('Error sending mention notifications:', error)
	}
}

/**
 * Sends notification to note owner when someone comments on their note
 */
export async function notifyNoteOwner({
	noteId,
	noteTitle,
	noteOwnerId,
	commentId,
	commenterUserId,
	commenterName,
	commentContent,
	organizationId,
	organizationSlug,
}: NotifyNoteOwnerParams) {
	try {
		// Don't notify if the commenter is the note owner
		if (commenterUserId === noteOwnerId) {
			return
		}

		// Get note owner's email
		const [noteOwner] = await db
			.select({ email: User.email })
			.from(User)
			.where(eq(User.id, noteOwnerId))
			.limit(1)

		if (!noteOwner) {
			console.error('Note owner not found:', noteOwnerId)
			return
		}

		const safeCommenterName = sanitizeTextContent(commenterName)
		const noteUrl = `${appUrl}/${organizationSlug}/notes/${noteId}`

		const payload = {
			noteId,
			commentId,
			noteTitle,
			commenterName: safeCommenterName,
			commentContent,
			organizationSlug,
			noteUrl,
		}

		// Check preferences
		const [preference] = await db
			.select()
			.from(NotificationPreference)
			.where(
				and(
					eq(NotificationPreference.userId, noteOwnerId),
					eq(NotificationPreference.organizationId, organizationId),
					eq(NotificationPreference.workflow, 'note-comment-workflow'),
				),
			)
			.limit(1)

		const inAppEnabled = preference?.inApp ?? true
		const emailEnabled = preference?.email ?? true

		if (inAppEnabled) {
			// 1. Save notification to DB using upsert to enforce uniqueness
			await db
				.insert(Notification)
				.values({
					userId: noteOwnerId,
					organizationId,
					type: 'comment',
					entityId: commentId,
					payload: JSON.stringify(payload),
				})
				.onConflictDoUpdate({
					target: [
						Notification.userId,
						Notification.organizationId,
						Notification.type,
						Notification.entityId,
					],
					set: {
						payload: JSON.stringify(payload),
						isRead: false,
						isSeen: false,
						updatedAt: new Date(),
					},
				})

			// Broadcast event logic moved to database polling in stream.tsx
		}

		if (emailEnabled) {
			// 2. Send email reliably
			try {
				const res = await sendEmail({
					to: noteOwner.email,
					subject: `New comment on "${noteTitle}"`,
					react: CommentEmail(payload),
				})
				if (res.status === 'error') {
					console.error('Failed to send comment email:', res.error)
				}
			} catch (err) {
				console.error('Failed to send comment email:', err)
			}
		}
	} catch (error) {
		console.error('Error sending note owner notification:', error)
	}
}

import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { useRevalidator } from 'react-router'
import CommentInput, { type MentionUser } from './comment-input'
import { CommentItem } from './comment-item'

interface CommentUser {
	id: string
	name: string | null
	username: string
	image?: { objectKey: string } | null
}

interface Comment {
	id: string
	content: string
	createdAt: string
	user: CommentUser
	replies: Comment[]
	images?: Array<{
		id: string
		altText: string | null
		objectKey: string
	}>
}

interface CommentsSectionProps {
	noteId: string
	comments: Comment[]
	currentUserId: string
	users: MentionUser[]
	organizationId: string
	orgSlug?: string
}

export function CommentsSection({
	noteId,
	comments,
	currentUserId,
	users,
	organizationId,
	orgSlug,
}: CommentsSectionProps) {
	const { _ } = useLingui()
	const [newComment] = useState('')
	const [isSubmitting, setIsSubmitting] = useState(false)
	const [replyingToId, setReplyingToId] = useState<string | null>(null)
	const [editingCommentId, setEditingCommentId] = useState<string | null>(null)
	const revalidator = useRevalidator()

	const submitComment = async (
		content: string,
		images: File[] | undefined,
		parentId?: string,
		libraryAssetIds?: string[],
	) => {
		const formData = new FormData()
		formData.append('intent', 'add-comment')
		formData.append('noteId', noteId)
		formData.append('content', content)

		if (parentId) {
			formData.append('parentId', parentId)
		}

		if (images && images.length > 0) {
			images.forEach((image, index) => {
				formData.append(`image-${index}`, image)
			})
			formData.append('imageCount', images.length.toString())
		}

		if (libraryAssetIds && libraryAssetIds.length > 0) {
			libraryAssetIds.forEach((id, index) => {
				formData.append(`libraryAssetId-${index}`, id)
			})
			formData.append('libraryAssetCount', libraryAssetIds.length.toString())
		}

		try {
			const response = await fetch(window.location.pathname, {
				method: 'POST',
				body: formData,
			})

			if (response.ok) {
				setReplyingToId(null)
				void revalidator.revalidate()
			} else {
				const errorText = await response.text()
				const action = parentId ? 'Reply' : 'Comment'
				console.error(`${action} failed:`, errorText)
			}
		} catch (error) {
			const action = parentId ? 'adding reply' : 'adding comment'
			console.error(`Error ${action}:`, error)
		}
	}

	const handleAddComment = async (
		content: string,
		images?: File[],
		libraryAssetIds?: string[],
	) => {
		setIsSubmitting(true)
		try {
			await submitComment(content, images, undefined, libraryAssetIds)
		} finally {
			setIsSubmitting(false)
		}
	}

	const handleReply = async (
		parentId: string,
		content: string,
		images?: File[],
		libraryAssetIds?: string[],
	) => {
		await submitComment(content, images, parentId, libraryAssetIds)
	}

	const handleReplyTo = (commentId: string) => {
		setEditingCommentId(null)
		setReplyingToId(commentId)
	}

	const handleEditTo = (commentId: string) => {
		setReplyingToId(null)
		setEditingCommentId(commentId)
	}

	const handleEdit = async (commentId: string, content: string) => {
		const formData = new FormData()
		formData.append('intent', 'edit-comment')
		formData.append('commentId', commentId)
		formData.append('content', content)

		try {
			const response = await fetch(window.location.pathname, {
				method: 'POST',
				body: formData,
			})

			if (response.ok) {
				setEditingCommentId(null)
				void revalidator.revalidate()
			} else {
				const errorText = await response.text()
				console.error('Edit failed:', errorText)
			}
		} catch (error) {
			console.error('Error editing comment:', error)
		}
	}

	const handleDelete = async (commentId: string) => {
		const formData = new FormData()
		formData.append('intent', 'delete-comment')
		formData.append('commentId', commentId)

		try {
			const response = await fetch(window.location.pathname, {
				method: 'POST',
				body: formData,
			})

			if (response.ok) {
				if (replyingToId === commentId) {
					setReplyingToId(null)
				}
				if (editingCommentId === commentId) {
					setEditingCommentId(null)
				}
				void revalidator.revalidate()
			} else {
				const errorText = await response.text()
				console.error('Delete failed:', errorText)
			}
		} catch (error) {
			console.error('Error deleting comment:', error)
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<CommentInput
				users={users}
				onSubmit={handleAddComment}
				value={newComment}
				disabled={isSubmitting}
				placeholder={_(msg`Add a comment...`)}
				orgSlug={orgSlug}
			/>

			{comments.length > 0 ? (
				<div>
					{comments.map((comment) => (
						<CommentItem
							key={comment.id}
							comment={comment}
							currentUserId={currentUserId}
							users={users}
							replyingToId={replyingToId}
							editingCommentId={editingCommentId}
							onReplyTo={handleReplyTo}
							onCancelReply={() => setReplyingToId(null)}
							onEditTo={handleEditTo}
							onCancelEdit={() => setEditingCommentId(null)}
							onReply={handleReply}
							onEdit={handleEdit}
							onDelete={handleDelete}
							organizationId={organizationId}
							orgSlug={orgSlug}
						/>
					))}
				</div>
			) : (
				<div className="flex flex-col items-center py-10 text-center">
					<div className="bg-muted/50 mb-4 flex size-14 items-center justify-center rounded-full">
						<Icon
							name="message-square"
							className="text-muted-foreground size-7"
						/>
					</div>
					<p className="text-foreground mb-1 text-sm font-medium">
						<Trans>No comments yet</Trans>
					</p>
					<p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
						<Trans>Start the conversation by adding the first comment.</Trans>
					</p>
				</div>
			)}
		</div>
	)
}

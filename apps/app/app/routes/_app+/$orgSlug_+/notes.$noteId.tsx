import { getFormProps, useForm } from '@conform-to/react'
import { invariantResponse } from '@epic-web/invariant'
import { Trans, t, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getNoteActivityLogs } from '@repo/audit'
import { requireUserId } from '@repo/auth'
import { getNoteImgSrc, getUserImgSrc, useIsPending } from '@repo/common'
import { and, db, eq, OrganizationNoteFavorite } from '@repo/database'
import { integrationManager } from '@repo/integrations'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import {
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@repo/ui/sheet'
import { StatusButton } from '@repo/ui/status-button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@repo/ui/tabs'
import { formatDistanceToNow } from 'date-fns'
import { Img } from 'openimg/react'
import {
	useRef,
	useEffect,
	useState,
	lazy,
	Suspense,
	Component,
	useMemo,
} from 'react'
import {
	Form,
	Link,
	useFetcher,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
	data,
} from 'react-router'
import sanitizeHtml from 'sanitize-html'
import { ENV } from 'varlock/env'
import { z } from 'zod'

// Simple error boundary for lazy-loaded components
class LazyLoadErrorBoundary extends Component<
	{ children: React.ReactNode; fallback: React.ReactNode },
	{ hasError: boolean }
> {
	constructor(props: { children: React.ReactNode; fallback: React.ReactNode }) {
		super(props)
		this.state = { hasError: false }
	}

	static getDerivedStateFromError() {
		return { hasError: true }
	}

	render() {
		if (this.state.hasError) {
			return this.props.fallback
		}
		return this.props.children
	}
}

// Lazy load AIChat component for better performance
const AIChat = lazy(() =>
	import('@repo/ai').then((module) => ({
		default: module.AIChat,
	})),
)
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ErrorList } from '#app/components/forms.tsx'
import { ActivityLog } from '#app/components/note/activity-log.tsx'
import { CommentsSection } from '#app/components/note/comments-section.tsx'
import { IntegrationControls } from '#app/components/note/integration-controls.tsx'
import { ShareNoteButton } from '#app/components/note/share-note-button.tsx'
import {
	CanEditNote,
	CanDeleteNote,
} from '#app/components/permissions/permission-guard.tsx'
import { VideoPoster } from '#app/components/ui/video-poster.tsx'

import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
	getUserOrganizationPermissionsForClient,
} from '#app/utils/organization/permissions.server.ts'

// Enforce rel="noopener noreferrer" for all target="_blank" links
const transformTargetBlankLinks = {
	a: (tagName: string, attribs: Record<string, string>) => {
		if (attribs.target === '_blank') {
			const rel = (attribs.rel || '').split(/\s+/).filter(Boolean)
			if (!rel.includes('noopener')) rel.push('noopener')
			if (!rel.includes('noreferrer')) rel.push('noreferrer')
			attribs.rel = rel.join(' ')
		}
		return { tagName, attribs }
	},
}

// Comment shapes returned by the note loader query
type CommentWithUser = {
	id: string
	content: string
	createdAt: Date
	parentId: string | null
	user: {
		id: string
		name: string | null
		username: string
		image: { objectKey: string } | null
	}
	images: {
		id: string
		altText: string | null
		objectKey: string
	}[]
	replies?: CommentWithReplies[]
}

type CommentWithReplies = CommentWithUser & {
	replies: CommentWithReplies[]
}

// Serialized comment type (what the client receives after loader serialization)
type SerializedComment = Omit<CommentWithReplies, 'createdAt' | 'replies'> & {
	createdAt: string
	replies: SerializedComment[]
}

export async function loader({ params, request }: LoaderFunctionArgs) {
	const userId = await requireUserId(request)
	const noteId = params.noteId
	invariantResponse(noteId, 'Note ID is required', { status: 400 })

	const noteRow = await db.query.OrganizationNote.findFirst({
		columns: {
			id: true,
			title: true,
			content: true,
			createdById: true,
			organizationId: true,
			updatedAt: true,
			isPublic: true,
		},
		with: {
			organizationNoteUploads: {
				columns: {
					type: true,
					altText: true,
					objectKey: true,
				},
			},
			organization: { columns: { slug: true, id: true } },
			noteAccess: {
				columns: { id: true },
				with: { user: { columns: { id: true, name: true, username: true } } },
			},
		},
		where: (note, { eq }) => eq(note.id, noteId),
	})
	const note = noteRow
		? { ...noteRow, uploads: noteRow.organizationNoteUploads }
		: null

	invariantResponse(note, 'Not found', { status: 404 })

	// Check if user has permission to read notes in this organization
	// This will automatically verify organization access and specific permissions
	await requireUserWithOrganizationPermission(
		request,
		note.organizationId,
		ORG_PERMISSIONS.READ_NOTE_OWN, // Users need at least read access to own notes
	)

	// Enhanced permission-based access check for private notes
	if (!note.isPublic) {
		try {
			// Try to get READ_NOTE_ORG permission (can read all org notes)
			await requireUserWithOrganizationPermission(
				request,
				note.organizationId,
				ORG_PERMISSIONS.READ_NOTE_ANY,
			)
			// If we reach here, user can read all organization notes
		} catch {
			// User doesn't have org-wide read access, check for personal access
			const hasPersonalAccess =
				note.createdById === userId ||
				note.noteAccess.some((access) => access.user.id === userId)

			if (!hasPersonalAccess) {
				throw new Response('Not authorized - insufficient note permissions', {
					status: 403,
				})
			}
		}
	}

	const date = new Date(note.updatedAt)
	const timeAgo = formatDistanceToNow(date)

	// Get organization members for sharing
	const organizationMembers = await db.query.UserOrganization.findMany({
		columns: { userId: true },
		with: { user: { columns: { id: true, name: true, username: true } } },
		where: (membership, { and, eq }) =>
			and(
				eq(membership.organizationId, note.organizationId),
				eq(membership.active, true),
			),
	})

	// Get integration data for this note
	const [connections, availableIntegrations, comments] = await Promise.all([
		integrationManager.getNoteConnections(note.id),
		integrationManager.getOrganizationIntegrations(note.organizationId),
		// Get comments for this note (limited to 50 for initial load, implement load more in UI)
		db.query.NoteComment.findMany({
			with: {
				user: {
					columns: { id: true, name: true, username: true },
					with: { image: { columns: { objectKey: true } } },
				},
				images: { columns: { id: true, altText: true, objectKey: true } },
			},
			where: (comment, { eq }) => eq(comment.noteId, note.id),
			orderBy: (comment, { desc }) => [desc(comment.createdAt)],
			limit: 50,
		}),
	])

	// Organize comments into a tree structure
	const organizeComments = (comments: CommentWithUser[]) => {
		const commentMap = new Map<string, CommentWithReplies>()
		const rootComments: CommentWithReplies[] = []

		// First pass: create map of all comments
		comments.forEach((comment) => {
			commentMap.set(comment.id, { ...comment, replies: [] })
		})

		// Second pass: organize into tree structure
		comments.forEach((comment) => {
			if (comment.parentId) {
				const parent = commentMap.get(comment.parentId)
				if (parent) {
					parent.replies.push(commentMap.get(comment.id)!)
				}
			} else {
				rootComments.push(commentMap.get(comment.id)!)
			}
		})

		return rootComments
	}

	// Serialize comments for client (convert Date to string)
	const serializeComment = (
		comment: CommentWithReplies,
	): SerializedComment => ({
		...comment,
		createdAt: comment.createdAt.toISOString(),
		replies: comment.replies.map(serializeComment),
	})

	const organizedComments = organizeComments(comments).map(serializeComment)

	// Get recent activity logs for this note (attach user avatar URL)
	const activityLogs = (await getNoteActivityLogs(note.id, 20)).map((log) => ({
		...log,
		user: {
			...log.user,
			image: log.user.image?.objectKey
				? getUserImgSrc(log.user.image.objectKey)
				: null,
		},
	}))

	// Check if current user has favorited this note
	const [isFavorited] = await db
		.select({ id: OrganizationNoteFavorite.id })
		.from(OrganizationNoteFavorite)
		.where(
			and(
				eq(OrganizationNoteFavorite.userId, userId),
				eq(OrganizationNoteFavorite.noteId, note.id),
			),
		)
		.limit(1)

	// Get user permissions for client-side permission checks
	const userPermissions = await getUserOrganizationPermissionsForClient(
		userId,
		note.organizationId,
	)

	return {
		note,
		timeAgo,
		currentUserId: userId,
		isFavorited: !!isFavorited,
		organizationMembers,
		comments: organizedComments,
		activityLogs,
		connections: connections.map((conn) => ({
			id: conn.id,
			externalId: conn.externalId,
			config: conn.config ? JSON.parse(conn.config as string) : {},
			integration: {
				id: conn.integration.id,
				providerName: conn.integration.providerName,
				providerType: conn.integration.providerType,
				isActive: conn.integration.isActive,
			},
		})),
		availableIntegrations: availableIntegrations.map((int) => ({
			id: int.id,
			providerName: int.providerName,
			providerType: int.providerType,
			isActive: int.isActive,
		})),
		userPermissions,
		mediaTransformBaseUrl: ENV.MEDIA_TRANSFORM_BASE_URL?.trim() || null,
	}
}

export const DeleteFormSchema = z.object({
	intent: z.literal('delete-note'),
	noteId: z.string(),
})

export const ConnectNoteSchema = z.object({
	intent: z.literal('connect-note-to-channel'),
	noteId: z.string(),
	integrationId: z.string(),
	channelId: z.string(),
})

export const DisconnectNoteSchema = z.object({
	intent: z.literal('disconnect-note-from-channel'),
	connectionId: z.string(),
})

export const GetChannelsSchema = z.object({
	intent: z.literal('get-integration-channels'),
	integrationId: z.string(),
})

export const ShareNoteSchema = z.object({
	intent: z.literal('update-note-sharing'),
	noteId: z.string(),
	isPublic: z.preprocess((val) => val === 'true', z.boolean()),
})

export const AddNoteAccessSchema = z.object({
	intent: z.literal('add-note-access'),
	noteId: z.string(),
	userId: z.string(),
})

export const RemoveNoteAccessSchema = z.object({
	intent: z.literal('remove-note-access'),
	noteId: z.string(),
	userId: z.string(),
})

export const BatchUpdateNoteAccessSchema = z.object({
	intent: z.literal('batch-update-note-access'),
	noteId: z.string(),
	isPublic: z.preprocess((val) => val === 'true', z.boolean()),
	usersToAdd: z.array(z.string()).default([]),
	usersToRemove: z.array(z.string()).default([]),
})

export const AddCommentSchema = z.object({
	intent: z.literal('add-comment'),
	noteId: z.string(),
	content: z.string().min(1, 'Comment content cannot be empty'),
	parentId: z.string().optional(),
})

export const DeleteCommentSchema = z.object({
	intent: z.literal('delete-comment'),
	commentId: z.string(),
})

export const EditCommentSchema = z.object({
	intent: z.literal('edit-comment'),
	commentId: z.string(),
	content: z.string().min(1, 'Comment content cannot be empty'),
})

export const ToggleFavoriteSchema = z.object({
	intent: z.literal('toggle-favorite'),
	noteId: z.string(),
})

export async function action(args: ActionFunctionArgs) {
	const userId = await requireUserId(args.request)

	const contentType = args.request.headers.get('content-type')
	let formData: FormData

	if (contentType?.includes('multipart/form-data')) {
		const { parseFormData } = await import('@mjackson/form-data-parser')
		formData = await parseFormData(args.request, {
			maxFileSize: 1024 * 1024 * 3, // 3MB max per image
		})
	} else {
		formData = await args.request.formData()
	}

	const intent = formData.get('intent')
	const ctx = { ...args, formData, userId }

	const {
		handleDeleteNoteIntent,
		handleConnectChannelIntent,
		handleDisconnectChannelIntent,
		handleGetChannelsIntent,
		handleUpdateSharingIntent,
		handleAddAccessIntent,
		handleRemoveAccessIntent,
		handleBatchUpdateAccessIntent,
		handleAddCommentIntent,
		handleDeleteCommentIntent,
		handleEditCommentIntent,
		handleToggleFavoriteIntent,
	} = await import('./notes.$noteId.server')

	switch (intent) {
		case 'delete-note':
			return handleDeleteNoteIntent(ctx)
		case 'connect-note-to-channel':
			return handleConnectChannelIntent(ctx)
		case 'disconnect-note-from-channel':
			return handleDisconnectChannelIntent(ctx)
		case 'get-integration-channels':
			return handleGetChannelsIntent(ctx)
		case 'update-note-sharing':
			return handleUpdateSharingIntent(ctx)
		case 'add-note-access':
			return handleAddAccessIntent(ctx)
		case 'remove-note-access':
			return handleRemoveAccessIntent(ctx)
		case 'batch-update-note-access':
			return handleBatchUpdateAccessIntent(ctx)
		case 'add-comment':
			return handleAddCommentIntent(ctx)
		case 'delete-comment':
			return handleDeleteCommentIntent(ctx)
		case 'edit-comment':
			return handleEditCommentIntent(ctx)
		case 'toggle-favorite':
			return handleToggleFavoriteIntent(ctx)
		default:
			return data(
				{ result: { status: 'error', error: 'Invalid intent' } },
				{ status: 400 },
			)
	}
}

type NoteLoaderData = {
	note: {
		id: string
		title: string
		content: string
		createdById: string
		isPublic: boolean
		uploads: {
			type: string
			altText: string | null
			objectKey: string
		}[]
		organization: { slug: string; id: string }
		noteAccess: Array<{
			id: string
			user: {
				id: string
				name: string | null
				username: string
			}
		}>
	}
	timeAgo: string
	currentUserId: string
	isFavorited: boolean
	organizationMembers: Array<{
		userId: string
		user: {
			id: string
			name: string | null
			username: string
		}
	}>
	comments: Array<{
		id: string
		content: string
		createdAt: string
		user: {
			id: string
			name: string | null
			username: string
		}
		replies: CommentWithReplies[]
		images?: Array<{
			id: string
			altText: string | null
			objectKey: string
		}>
	}>
	activityLogs: Array<{
		id: string
		action: string
		metadata: string | null
		createdAt: Date
		user: {
			id: string
			name: string | null
			username: string
		}
		targetUser?: {
			id: string
			name: string | null
			username: string
		} | null
		integration?: {
			id: string
			providerName: string
			providerType: string
		} | null
	}>
	connections: Array<{
		id: string
		externalId: string
		config: Record<string, unknown>
		integration: {
			id: string
			providerName: string
			providerType: string
			isActive: boolean
		}
	}>
	availableIntegrations: Array<{
		id: string
		providerName: string
		providerType: string
		isActive: boolean
	}>
	userPermissions: {
		userId: string
		organizationId: string
		organizationRole: {
			id: string
			name: string
			level: number
			permissions: Array<{
				id: string
				action: string
				entity: string
				access: string
				description: string
			}>
		}
	} | null
	mediaTransformBaseUrl: string | null
}

export default function NoteRoute() {
	const { _ } = useLingui()
	const {
		note,
		timeAgo,
		currentUserId,
		isFavorited,
		organizationMembers,
		comments,
		activityLogs,
		connections,
		availableIntegrations,
		mediaTransformBaseUrl,
	} = useLoaderData() as NoteLoaderData

	// Add ref for auto-focusing
	const sectionRef = useRef<HTMLElement>(null)
	const [activeTab, setActiveTab] = useState('overview')

	// Focus the section when the note ID changes
	useEffect(() => {
		if (sectionRef.current) {
			sectionRef.current.focus()
		}
	}, [note.id])

	// Convert organization members to mention users format
	const mentionUsers = organizationMembers.map((member) => ({
		id: member.user.id,
		name: member.user.name || member.user.username,
		email: member.user.username, // Using username as email placeholder
	}))

	const sanitizedNoteContent = useMemo(() => {
		return sanitizeHtml(note.content, {
			allowedTags: [
				'p',
				'br',
				'strong',
				'b',
				'em',
				'i',
				'u',
				'a',
				'span',
				'ul',
				'ol',
				'li',
				'h1',
				'h2',
				'h3',
				'h4',
				'h5',
				'h6',
				'blockquote',
				'code',
				'pre',
				'div',
			],
			allowedAttributes: {
				'*': ['class', 'data-mention-id', 'data-id', 'data-type'],
				a: ['href', 'target', 'rel'],
			},
			transformTags: transformTargetBlankLinks,
			allowedSchemes: [
				'http',
				'https',
				'mailto',
				'tel',
				'callto',
				'sms',
				'cid',
				'xmpp',
			],
		})
	}, [note.content])

	const noteTabContentClassName =
		'min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 [scrollbar-gutter:stable]'

	const tabLabels = {
		overview: _(t`Overview`),
		comments: _(t`Comments`),
		activity: _(t`Activity`),
		aiAssistant: _(t`AI Assistant`),
	} as const

	return (
		<>
			<SheetHeader className="border-b pb-4">
				<SheetTitle
					id="note-title"
					className="pr-8 text-left text-lg leading-snug font-semibold"
				>
					{note.title || <Trans>Untitled Note</Trans>}
				</SheetTitle>
				<SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span className="inline-flex items-center gap-1.5">
						<Icon name="clock" className="size-3.5 shrink-0" />
						<Trans>Updated {timeAgo} ago</Trans>
					</span>
					{!note.isPublic && (
						<>
							<span aria-hidden="true">·</span>
							<span className="inline-flex items-center gap-1.5">
								<Icon name="lock" className="size-3.5 shrink-0" />
								<Trans>Private</Trans>
							</span>
						</>
					)}
				</SheetDescription>
			</SheetHeader>

			<section
				ref={sectionRef}
				className="flex min-h-0 flex-1 flex-col"
				aria-labelledby="note-title"
				tabIndex={-1}
			>
				<Tabs
					value={activeTab}
					onValueChange={setActiveTab}
					className="flex min-h-0 flex-1 flex-col gap-0"
				>
					<div className="border-b px-4">
						<TabsList variant="line" className="h-10 w-full bg-transparent p-0">
							<TabsTrigger
								value="overview"
								aria-label={tabLabels.overview}
								className="flex-1 gap-2"
							>
								<Icon name="file-text" className="size-4" />
								<span className="hidden sm:inline">{tabLabels.overview}</span>
							</TabsTrigger>
							<TabsTrigger
								value="comments"
								aria-label={tabLabels.comments}
								className="flex-1 gap-2"
							>
								<Icon name="message-square" className="size-4" />
								<span className="hidden sm:inline">{tabLabels.comments}</span>
								{comments.length > 0 && (
									<span className="bg-muted text-muted-foreground rounded-full px-1.5 py-0.5 text-xs tabular-nums">
										{comments.length}
									</span>
								)}
							</TabsTrigger>
							<TabsTrigger
								value="activity"
								aria-label={tabLabels.activity}
								className="flex-1 gap-2"
							>
								<Icon name="logs" className="size-4" />
								<span className="hidden sm:inline">{tabLabels.activity}</span>
							</TabsTrigger>
							<TabsTrigger
								value="ai-assistant"
								aria-label={tabLabels.aiAssistant}
								className="flex-1 gap-2"
							>
								<Icon name="sparkles" className="size-4" />
								<span className="hidden sm:inline">
									{tabLabels.aiAssistant}
								</span>
							</TabsTrigger>
						</TabsList>
					</div>

					<TabsContent value="overview" className={noteTabContentClassName}>
						<div className="mx-auto flex w-full max-w-prose flex-col gap-6">
							{note.uploads.length > 0 && (
								<ul className="flex flex-wrap gap-3">
									{note.uploads
										.filter((upload) => upload.type === 'image')
										.map((image) => (
											<li key={image.objectKey}>
												<a
													href={getNoteImgSrc(
														image.objectKey,
														note.organization.id,
													)}
													className="ring-border hover:ring-foreground/20 focus-visible:ring-ring block overflow-hidden rounded-lg ring-1 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none motion-safe:transition-shadow"
												>
													<Img
														src={getNoteImgSrc(
															image.objectKey,
															note.organization.id,
														)}
														alt={image.altText ?? ''}
														className="size-28 object-cover sm:size-32"
														width={512}
														height={512}
													/>
												</a>
											</li>
										))}
									{note.uploads
										.filter((upload) => upload.type === 'video')
										.map((video) => (
											<li key={video.objectKey}>
												<div className="ring-border relative size-28 overflow-hidden rounded-lg ring-1 sm:size-32">
													<VideoPoster
														objectKey={video.objectKey}
														organizationId={note.organization.id}
														mediaTransformBaseUrl={mediaTransformBaseUrl}
														alt={video.altText ?? 'Video thumbnail'}
														className="size-28 sm:size-32"
														width={512}
														height={512}
													/>
													<div className="pointer-events-none absolute inset-0 flex items-center justify-center">
														<div className="rounded-full bg-black/50 p-2">
															<Icon
																name="arrow-right"
																className="size-4 text-white"
															/>
														</div>
													</div>
												</div>
											</li>
										))}
								</ul>
							)}

							{sanitizedNoteContent.trim() ? (
								<div className="prose prose-neutral dark:prose-invert selection:bg-primary/20 prose-p:my-3 prose-p:leading-relaxed prose-headings:mb-3 prose-headings:mt-6 prose-headings:scroll-mt-20 prose-li:my-1 prose-a:underline-offset-4 max-w-none">
									<div
										className="text-base leading-relaxed"
										dangerouslySetInnerHTML={{ __html: sanitizedNoteContent }}
									/>
								</div>
							) : note.uploads.length === 0 ? (
								<div className="flex flex-col items-center py-10 text-center">
									<div className="bg-muted/50 mb-4 flex size-14 items-center justify-center rounded-full">
										<Icon
											name="file-text"
											className="text-muted-foreground size-7"
										/>
									</div>
									<p className="text-foreground mb-1 text-sm font-medium">
										<Trans>No content yet</Trans>
									</p>
									<p className="text-muted-foreground mb-5 max-w-xs text-sm leading-relaxed">
										<Trans>
											Add notes, links, or media to capture what matters.
										</Trans>
									</p>
									<CanEditNote
										noteOwnerId={note.createdById}
										currentUserId={currentUserId}
									>
										<Button
											variant="outline"
											size="sm"
											render={<Link to="edit" />}
										>
											<Icon name="pencil" className="size-4">
												<Trans>Edit note</Trans>
											</Icon>
										</Button>
									</CanEditNote>
								</div>
							) : null}
						</div>
					</TabsContent>

					<TabsContent value="comments" className={noteTabContentClassName}>
						<div className="mx-auto w-full max-w-prose">
							<CommentsSection
								noteId={note.id}
								// SerializedComment is compatible with Comment interface
								comments={comments as any}
								currentUserId={currentUserId}
								users={mentionUsers}
								organizationId={note.organization.id}
								orgSlug={note.organization.slug}
							/>
						</div>
					</TabsContent>

					<TabsContent value="activity" className={noteTabContentClassName}>
						<div className="mx-auto w-full max-w-prose">
							<ActivityLog activityLogs={activityLogs} />
						</div>
					</TabsContent>

					<TabsContent
						value="ai-assistant"
						className="min-h-0 flex-1 overflow-hidden"
					>
						<LazyLoadErrorBoundary
							fallback={
								<div className="flex h-full items-center justify-center p-6">
									<div className="space-y-3 text-center">
										<p className="text-muted-foreground text-sm">
											<Trans>Failed to load AI Assistant</Trans>
										</p>
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() => window.location.reload()}
										>
											<Trans>Reload page</Trans>
										</Button>
									</div>
								</div>
							}
						>
							<Suspense
								fallback={
									<div className="flex h-full flex-col items-center justify-center gap-3 p-6">
										<div className="bg-muted flex size-10 items-center justify-center rounded-full">
											<Icon
												name="sparkles"
												className="text-muted-foreground size-5 motion-safe:animate-pulse"
											/>
										</div>
										<p className="text-muted-foreground text-sm">
											<Trans>Loading AI Assistant...</Trans>
										</p>
									</div>
								}
							>
								<AIChat noteId={note.id} />
							</Suspense>
						</LazyLoadErrorBoundary>
					</TabsContent>
				</Tabs>

				<NoteSheetActions
					note={note}
					currentUserId={currentUserId}
					isFavorited={isFavorited}
					organizationMembers={organizationMembers}
					connections={connections}
					availableIntegrations={availableIntegrations}
				/>
			</section>
		</>
	)
}

function NoteSheetActions({
	note,
	currentUserId,
	isFavorited,
	organizationMembers,
	connections,
	availableIntegrations,
}: {
	note: NoteLoaderData['note']
	currentUserId: string
	isFavorited: boolean
	organizationMembers: NoteLoaderData['organizationMembers']
	connections: NoteLoaderData['connections']
	availableIntegrations: NoteLoaderData['availableIntegrations']
}) {
	const { _ } = useLingui()
	const [shareOpen, setShareOpen] = useState(false)
	const [integrationsOpen, setIntegrationsOpen] = useState(false)
	const [deleteOpen, setDeleteOpen] = useState(false)
	const favoriteFetcher = useFetcher()
	const deleteFetcher = useFetcher()

	const hasIntegrations =
		availableIntegrations.length > 0 || connections.length > 0

	const isFavoritePending =
		favoriteFetcher.state !== 'idle' &&
		favoriteFetcher.formData?.get('intent') === 'toggle-favorite'

	const isDeletePending =
		deleteFetcher.state !== 'idle' &&
		deleteFetcher.formData?.get('intent') === 'delete-note'

	return (
		<>
			<SheetFooter className="shrink-0 border-t sm:flex-row sm:justify-end">
				<div className="flex w-full items-center justify-end gap-2">
					<CanEditNote
						noteOwnerId={note.createdById}
						currentUserId={currentUserId}
					>
						<Button variant="default" size="sm" render={<Link to="edit" />}>
							<Icon name="pencil" className="size-4">
								<Trans>Edit</Trans>
							</Icon>
						</Button>
					</CanEditNote>
					<DropdownMenu>
						<DropdownMenuTrigger
							render={
								<Button
									variant="outline"
									size="sm"
									aria-label={_(msg`Note actions`)}
								>
									<Icon name="ellipsis" className="size-4" />
								</Button>
							}
						/>
						<DropdownMenuContent align="end" className="w-48">
							<DropdownMenuItem
								disabled={isFavoritePending}
								onClick={() => {
									const formData = new FormData()
									formData.append('intent', 'toggle-favorite')
									formData.append('noteId', note.id)
									void favoriteFetcher.submit(formData, { method: 'POST' })
								}}
							>
								<Icon
									name={isFavorited ? 'star-off' : 'star'}
									className="mr-2 size-4"
								/>
								{isFavorited ? <Trans>Unstar</Trans> : <Trans>Star</Trans>}
							</DropdownMenuItem>
							<DropdownMenuItem onClick={() => setShareOpen(true)}>
								<Icon name="share-2" className="mr-2 size-4" />
								<Trans>Share</Trans>
							</DropdownMenuItem>
							{hasIntegrations ? (
								<DropdownMenuItem onClick={() => setIntegrationsOpen(true)}>
									<Icon name="link-2" className="mr-2 size-4" />
									<Trans>Integrations</Trans>
									{connections.length > 0 ? (
										<span className="text-muted-foreground ml-auto text-xs tabular-nums">
											{connections.length}
										</span>
									) : null}
								</DropdownMenuItem>
							) : null}
							<CanDeleteNote
								noteOwnerId={note.createdById}
								currentUserId={currentUserId}
							>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									onClick={() => setDeleteOpen(true)}
								>
									<Icon name="trash-2" className="mr-2 size-4" />
									<Trans>Delete</Trans>
								</DropdownMenuItem>
							</CanDeleteNote>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</SheetFooter>

			<ShareNoteButton
				showTrigger={false}
				open={shareOpen}
				onOpenChange={setShareOpen}
				noteId={note.id}
				isPublic={note.isPublic}
				noteAccess={note.noteAccess}
				organizationMembers={organizationMembers}
			/>
			{hasIntegrations ? (
				<IntegrationControls
					showTrigger={false}
					open={integrationsOpen}
					onOpenChange={setIntegrationsOpen}
					noteId={note.id}
					connections={connections}
					availableIntegrations={availableIntegrations}
				/>
			) : null}
			<CanDeleteNote
				noteOwnerId={note.createdById}
				currentUserId={currentUserId}
			>
				<AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>
								<Trans>Delete note?</Trans>
							</AlertDialogTitle>
							<AlertDialogDescription>
								<Trans>
									This action cannot be undone. The note and its comments will
									be permanently removed.
								</Trans>
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel disabled={isDeletePending}>
								<Trans>Cancel</Trans>
							</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								disabled={isDeletePending}
								onClick={() => {
									const formData = new FormData()
									formData.append('intent', 'delete-note')
									formData.append('noteId', note.id)
									void deleteFetcher.submit(formData, { method: 'POST' })
								}}
							>
								<Trans>Delete</Trans>
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			</CanDeleteNote>
		</>
	)
}

export function FavoriteButton({
	noteId,
	isFavorited,
}: {
	noteId: string
	isFavorited: boolean
}) {
	const isPending = useIsPending()
	const [form] = useForm({
		id: 'toggle-favorite',
	})

	return (
		<Form method="POST" {...getFormProps(form)}>
			<input type="hidden" name="noteId" value={noteId} />
			<StatusButton
				type="submit"
				name="intent"
				value="toggle-favorite"
				variant="outline"
				size="sm"
				status={isPending ? 'pending' : (form.status ?? 'idle')}
				disabled={isPending}
				className="min-[525px]:max-md:aspect-square min-[525px]:max-md:px-0"
			>
				<Icon name={isFavorited ? 'star-off' : 'star'} className="size-4">
					<span className="max-md:hidden">
						{isFavorited ? 'Unstar' : 'Star'}
					</span>
				</Icon>
			</StatusButton>
			<ErrorList errors={form.errors} id={form.errorId} />
		</Form>
	)
}

export function DeleteNote({ id }: { id: string }) {
	const isPending = useIsPending()
	const [form] = useForm({
		id: 'delete-note',
	})

	return (
		<Form method="POST" {...getFormProps(form)}>
			<input type="hidden" name="noteId" value={id} />
			<StatusButton
				type="submit"
				name="intent"
				value="delete-note"
				variant="destructive"
				size="sm"
				status={isPending ? 'pending' : (form.status ?? 'idle')}
				disabled={isPending}
			>
				<Icon name="trash-2" className="size-4">
					<span className="max-md:hidden">Delete</span>
				</Icon>
			</StatusButton>
			<ErrorList errors={form.errors} id={form.errorId} />
		</Form>
	)
}

export function ErrorBoundary() {
	return (
		<GeneralErrorBoundary
			statusHandlers={{
				403: () => (
					<p>
						<Trans>You do not have permission to view this note</Trans>
					</p>
				),
				404: ({ params }) => {
					const noteId = params.noteId
					return (
						<p>
							<Trans>No note with the id "{noteId}" exists</Trans>
						</p>
					)
				},
			}}
		/>
	)
}

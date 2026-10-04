import { Trans, msg, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type ChatChannelSummary,
	type ChatMessage,
	type ChatSearchHit,
} from '@repo/common/chat'
import { cn } from '@repo/ui'
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
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from '@repo/ui/empty'
import { Icon } from '@repo/ui/icon'
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from '@repo/ui/input-group'
import { Spinner } from '@repo/ui/spinner'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
	Link,
	useNavigate,
	useRevalidator,
	useSearchParams,
} from 'react-router'
import { toast } from 'sonner'
import { useChat } from '#app/hooks/use-chat.ts'
import { typingUserIds } from '#app/modules/chat/chat-state.ts'
import { ChatComposeDialog } from './chat-compose-dialog.tsx'
import { ChatComposer } from './chat-composer.tsx'
import { ChatGroupSettingsDialog } from './chat-group-settings-dialog.tsx'
import { Composer, MessageItem } from './chat-message.tsx'

const GROUP_GAP_MS = 5 * 60 * 1000
const STICK_THRESHOLD_PX = 80

export function ChatView({
	orgSlug,
	channels,
	activeChannelId,
	canManage,
	canCreateGroup,
	members,
	groupMemberIds,
}: {
	orgSlug: string
	channels: ChatChannelSummary[]
	activeChannelId: string | null
	canManage: boolean
	canCreateGroup: boolean
	members: { id: string; label: string }[]
	groupMemberIds: Record<string, string[]>
}) {
	const { _, i18n } = useLingui()
	const revalidator = useRevalidator()
	const navigate = useNavigate()
	const [searchParams] = useSearchParams()
	const active = channels.find((channel) => channel.id === activeChannelId)
	const channelIds = channels.map((channel) => channel.id)
	const chat = useChat({
		orgSlug,
		channelIds,
		activeChannel: active?.id ?? null,
		enabled: channels.length > 0,
		onChannelsChanged: () => {
			void revalidator.revalidate()
		},
	})
	const { state } = chat
	const connected = state.connection === 'open'
	const view = active ? state.channels[active.id] : undefined

	const [historyError, setHistoryError] = useState<string | null>(null)
	const [loadingOlder, setLoadingOlder] = useState(false)
	const [loadingEarlierReplies, setLoadingEarlierReplies] = useState(false)
	const [thread, setThread] = useState<{
		channel: string
		parent: number
	} | null>(null)
	const [pendingDelete, setPendingDelete] = useState<ChatMessage | null>(null)
	const [composing, setComposing] = useState(false)
	const [groupSettings, setGroupSettings] = useState(false)
	const [searchQuery, setSearchQuery] = useState('')
	const [searchResults, setSearchResults] = useState<ChatSearchHit[] | null>(
		null,
	)
	const [searching, setSearching] = useState(false)
	const teamChannels = channels.filter((channel) => channel.kind === 'channel')
	const directMessages = channels.filter((channel) => channel.kind === 'dm')
	const groupChats = channels.filter((channel) => channel.kind === 'group')

	// Desktop: default to the first channel when the URL has no ?channel=.
	useEffect(() => {
		if (searchParams.get('channel')) return
		const first = channels[0]
		if (!first) return
		if (window.matchMedia('(max-width: 767px)').matches) return
		void navigate(
			{ search: `?channel=${encodeURIComponent(first.id)}` },
			{ replace: true },
		)
	}, [channels, navigate, searchParams])

	// ── history ────────────────────────────────────────────────────────────
	const activeId = active?.id
	const loaded = view?.loaded ?? false
	const { loadHistory } = chat
	const fetchHistory = useCallback(() => {
		if (!activeId) return
		setHistoryError(null)
		loadHistory(activeId).catch((cause: unknown) =>
			setHistoryError(
				cause instanceof Error
					? cause.message
					: _(msg`Could not load messages.`),
			),
		)
	}, [activeId, loadHistory, _])
	useEffect(() => {
		if (connected && activeId && !loaded) fetchHistory()
	}, [connected, activeId, loaded, fetchHistory])

	// Leaving a channel closes its thread.
	useEffect(() => {
		setThread((current) =>
			current && current.channel !== activeId ? null : current,
		)
	}, [activeId])

	// ── scrolling ──────────────────────────────────────────────────────────
	const scroller = useRef<HTMLDivElement>(null)
	const stuckToBottom = useRef(true)
	const lastMessageId = view?.messages.at(-1)?.id
	const lastMessageMine = view?.messages.at(-1)?.author === state.me?.id
	useEffect(() => {
		stuckToBottom.current = true
	}, [activeId])
	useEffect(() => {
		const element = scroller.current
		if (!element) return
		if (stuckToBottom.current || lastMessageMine) {
			element.scrollTop = element.scrollHeight
		}
	}, [lastMessageId, lastMessageMine, activeId, loaded])

	async function loadOlder() {
		const first = view?.messages[0]
		const element = scroller.current
		if (!active || !first || !element || loadingOlder) return
		setLoadingOlder(true)
		const previousHeight = element.scrollHeight
		try {
			await loadHistory(active.id, first.id)
			requestAnimationFrame(() => {
				element.scrollTop += element.scrollHeight - previousHeight
			})
		} catch (cause) {
			toast.error(
				cause instanceof Error
					? cause.message
					: _(msg`Could not load messages.`),
			)
		} finally {
			setLoadingOlder(false)
		}
	}

	// ── typing indicator ───────────────────────────────────────────────────
	const [now, setNow] = useState(() => Date.now())
	const hasTyping = view ? Object.keys(view.typing).length > 0 : false
	useEffect(() => {
		if (!hasTyping) return
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(timer)
	}, [hasTyping, view?.typing])
	const typingNames = typingUserIds(view, now).map(
		(id) => state.people[id]?.name ?? _(msg`Someone`),
	)
	const firstTypingName = typingNames[0] ?? ''
	const activeName = active?.name ?? ''
	const threadLoadedReplies = thread
		? (state.threads[thread.parent] ?? []).length
		: 0
	const threadMore = thread ? (state.threadMore[thread.parent] ?? false) : false

	// ── actions ────────────────────────────────────────────────────────────
	const fail = (cause: unknown) =>
		toast.error(
			cause instanceof Error ? cause.message : _(msg`Something went wrong.`),
		)
	const onReact = (message: ChatMessage, emoji: string) => {
		chat.react(message.id, emoji).catch(fail)
	}
	const onEdit = async (message: ChatMessage, body: string) => {
		await chat.edit(message.id, body)
	}
	const openThread = (message: ChatMessage) => {
		setThread({ channel: message.channel, parent: message.id })
		chat.openThread(message.channel, message.id).catch(fail)
	}

	if (channels.length === 0) {
		return (
			<Empty className="flex-1">
				<EmptyHeader>
					<EmptyTitle>
						<Trans>No channels yet</Trans>
					</EmptyTitle>
					<EmptyDescription>
						{canManage ? (
							<Trans>
								Create a channel to start talking with your team. You can limit
								a channel to certain roles or people.
							</Trans>
						) : (
							<Trans>
								You don't have access to any channels yet. Ask an admin to add
								you to one.
							</Trans>
						)}
					</EmptyDescription>
				</EmptyHeader>
				{canManage ? (
					<EmptyContent>
						<Button render={<Link to={`/${orgSlug}/settings/chat`} />}>
							<Trans>Create a channel</Trans>
						</Button>
					</EmptyContent>
				) : null}
			</Empty>
		)
	}

	const threadParent = thread
		? state.channels[thread.channel]?.messages.find(
				(message) => message.id === thread.parent,
			)
		: undefined
	const threadReplies = thread ? (state.threads[thread.parent] ?? []) : []
	// The parent's server-side count covers replies that are not loaded yet.
	const threadTotalReplies = Math.max(
		threadParent?.replyCount ?? 0,
		threadLoadedReplies,
	)

	async function loadEarlierReplies() {
		const first = threadReplies[0]
		if (!thread || !first || loadingEarlierReplies) return
		setLoadingEarlierReplies(true)
		try {
			await chat.openThread(thread.channel, thread.parent, first.id)
		} catch (cause) {
			toast.error(
				cause instanceof Error
					? cause.message
					: _(msg`Could not load replies.`),
			)
		} finally {
			setLoadingEarlierReplies(false)
		}
	}
	const messages = view?.messages ?? []

	function channelLink(channel: ChatChannelSummary) {
		const unread = state.channels[channel.id]?.unread ?? 0
		const isActive = channel.id === activeChannelId
		const iconName =
			channel.kind === 'dm'
				? 'user'
				: channel.kind === 'group'
					? 'users'
					: channel.access === 'restricted'
						? 'lock'
						: 'message-square'
		return (
			<Link
				key={channel.id}
				to={{ search: `?channel=${channel.id}` }}
				replace
				aria-current={isActive ? 'page' : undefined}
				onClick={() => setThread(null)}
				className={cn(
					'hover:bg-muted focus-visible:ring-ring flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm outline-none focus-visible:ring-2',
					isActive && 'bg-accent text-accent-foreground font-medium',
					!isActive && unread > 0 && 'font-semibold',
				)}
			>
				<Icon name={iconName} className="text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate">{channel.name}</span>
				{unread > 0 && !isActive ? (
					<Badge>
						<span aria-hidden>{unread > 99 ? '99+' : unread}</span>
						<span className="sr-only">{_(msg`${unread} unread`)}</span>
					</Badge>
				) : null}
			</Link>
		)
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col md:flex-row">
			<nav
				aria-label={_(msg`Channels`)}
				className={cn(
					'bg-muted/20 flex min-h-0 flex-col gap-0.5 overflow-y-auto border-b p-2',
					active ? 'max-md:hidden' : 'max-md:min-h-0 max-md:flex-1',
					'md:w-64 md:shrink-0 md:border-e md:border-b-0',
				)}
			>
				<form
					className="mb-3 w-full"
					onSubmit={(event) => {
						event.preventDefault()
						const query = searchQuery.trim()
						if (!query) {
							setSearchResults(null)
							return
						}
						setSearching(true)
						void chat
							.search(query)
							.then((data) => setSearchResults(data.results))
							.catch(fail)
							.finally(() => setSearching(false))
					}}
				>
					<InputGroup>
						<InputGroupAddon align="inline-start">
							{searching ? (
								<Spinner className="size-4" />
							) : (
								<Icon name="search" aria-hidden />
							)}
						</InputGroupAddon>
						<InputGroupInput
							value={searchQuery}
							onChange={(event) => {
								const next = event.target.value
								setSearchQuery(next)
								if (!next.trim()) setSearchResults(null)
							}}
							placeholder={_(msg`Search messages`)}
							aria-label={_(msg`Search messages`)}
							disabled={searching}
						/>
						{searchQuery.trim() ? (
							<InputGroupAddon align="inline-end">
								<InputGroupButton
									type="button"
									size="icon-xs"
									aria-label={_(msg`Clear search`)}
									onClick={() => {
										setSearchQuery('')
										setSearchResults(null)
									}}
								>
									<Icon name="x" />
								</InputGroupButton>
							</InputGroupAddon>
						) : null}
					</InputGroup>
				</form>
				{searchResults !== null ? (
					<div className="mb-3 w-full">
						<p className="text-muted-foreground px-3 py-1 text-xs font-medium">
							<Trans>Search results</Trans>
						</p>
						{searchResults.length === 0 ? (
							<p className="text-muted-foreground px-3 py-2 text-xs">
								<Trans>No messages matched your search.</Trans>
							</p>
						) : (
							searchResults.map((hit) => {
								const channel = channels.find((c) => c.id === hit.channel)
								return (
									<Link
										key={hit.id}
										to={{ search: `?channel=${hit.channel}` }}
										replace
										className="hover:bg-muted focus-visible:ring-ring block rounded-md px-3 py-2 text-xs outline-none focus-visible:ring-2"
										onClick={() => setSearchResults(null)}
									>
										<span className="font-medium">
											{channel?.name ?? hit.channel}
										</span>
										<span className="text-muted-foreground block truncate">
											{hit.body}
										</span>
									</Link>
								)
							})
						)}
					</div>
				) : null}
				<Button
					type="button"
					variant="outline"
					size="sm"
					className="mb-3 w-full justify-start"
					onClick={() => setComposing(true)}
				>
					<Icon name="plus" />
					<Trans>New message</Trans>
				</Button>
				{[
					{ title: _(msg`Channels`), items: teamChannels },
					{ title: _(msg`Direct messages`), items: directMessages },
					{ title: _(msg`Groups`), items: groupChats },
				]
					.filter((section) => section.items.length > 0)
					.map((section) => (
						<div key={section.title} className="mb-3 w-full">
							<p className="text-muted-foreground px-3 py-1.5 text-xs font-medium">
								{section.title}
							</p>
							<div className="flex flex-col gap-0.5">
								{section.items.map((channel) => channelLink(channel))}
							</div>
						</div>
					))}
				{canManage ? (
					<Link
						to={`/${orgSlug}/settings/chat`}
						className="text-muted-foreground hover:text-foreground focus-visible:ring-ring mt-auto flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm outline-none focus-visible:ring-2"
					>
						<Icon name="settings" />
						<Trans>Manage channels</Trans>
					</Link>
				) : null}
			</nav>

			{composing ? (
				<ChatComposeDialog
					members={members.filter((member) => member.id !== state.me?.id)}
					canCreateGroup={canCreateGroup}
					onClose={() => setComposing(false)}
					onCreated={() => revalidator.revalidate()}
				/>
			) : null}
			{groupSettings && active?.kind === 'group' ? (
				<ChatGroupSettingsDialog
					channelId={active.id}
					channelName={active.name}
					createdById={active.createdById}
					meId={state.me?.id ?? ''}
					showHistoryToNewMembers={active.showHistoryToNewMembers ?? false}
					members={members}
					rosterIds={groupMemberIds[active.id] ?? []}
					onClose={() => setGroupSettings(false)}
					onUpdated={() => revalidator.revalidate()}
				/>
			) : null}

			<section
				className={cn(
					'flex min-h-0 min-w-0 flex-1 flex-col',
					active ? 'max-md:min-h-0 max-md:flex-1' : 'max-md:hidden',
				)}
			>
				{active ? (
					<header className="flex items-start gap-2 border-b px-3 py-2.5 sm:px-4 sm:py-3">
						<Button
							variant="ghost"
							size="icon-sm"
							className="mt-0.5 shrink-0 md:hidden"
							aria-label={_(msg`Back to channels`)}
							render={
								<Link
									to={{ search: '' }}
									replace
									onClick={() => setThread(null)}
								/>
							}
						>
							<Icon name="arrow-left" />
						</Button>
						<Icon
							name={
								active.kind === 'dm'
									? 'user'
									: active.kind === 'group'
										? 'users'
										: active.access === 'restricted'
											? 'lock'
											: 'message-square'
							}
							className="text-muted-foreground mt-0.5 hidden shrink-0 md:inline-flex"
						/>
						<div className="min-w-0 flex-1">
							<h2 className="truncate text-sm font-semibold">{active.name}</h2>
							{active.description ? (
								<p className="text-muted-foreground line-clamp-2 text-xs">
									{active.description}
								</p>
							) : null}
						</div>
						{active.kind === 'group' ? (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								className="shrink-0"
								aria-label={_(msg`Group settings`)}
								onClick={() => setGroupSettings(true)}
							>
								<Icon name="settings" />
							</Button>
						) : null}
					</header>
				) : null}

				<ConnectionBanner status={state.connection} />

				<div
					ref={scroller}
					role="log"
					aria-live="polite"
					aria-label={_(msg`Messages`)}
					className="min-h-0 flex-1 overflow-y-auto py-2"
					onScroll={(event) => {
						const element = event.currentTarget
						stuckToBottom.current =
							element.scrollHeight - element.scrollTop - element.clientHeight <
							STICK_THRESHOLD_PX
					}}
				>
					{!active ? (
						<div className="flex min-h-48 flex-1 flex-col items-center justify-center p-6 text-center">
							<EmptyHeader>
								<EmptyMedia variant="icon">
									<Icon name="message-square" />
								</EmptyMedia>
								<EmptyTitle>
									<Trans>Pick a conversation</Trans>
								</EmptyTitle>
								<EmptyDescription>
									<Trans>
										Choose a channel, group, or direct message from the list.
									</Trans>
								</EmptyDescription>
							</EmptyHeader>
						</div>
					) : historyError ? (
						<div className="flex flex-col items-start gap-2 p-6">
							<p className="text-destructive text-sm">{historyError}</p>
							<Button variant="outline" size="sm" onClick={fetchHistory}>
								<Trans>Try again</Trans>
							</Button>
						</div>
					) : !loaded ? (
						<div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
							<Spinner />
							<Trans>Loading messages…</Trans>
						</div>
					) : (
						<>
							{view?.hasMore ? (
								<div className="flex justify-center py-2">
									<Button
										variant="outline"
										size="sm"
										disabled={loadingOlder}
										onClick={() => void loadOlder()}
									>
										{loadingOlder ? <Spinner /> : null}
										<Trans>Load older messages</Trans>
									</Button>
								</div>
							) : null}
							{messages.length === 0 ? (
								<div className="flex flex-col items-center justify-center py-12 text-center">
									<EmptyHeader>
										<EmptyTitle>
											<Trans>No messages yet</Trans>
										</EmptyTitle>
										<EmptyDescription>
											<Trans>
												Send the first message — your team will see it here.
											</Trans>
										</EmptyDescription>
									</EmptyHeader>
								</div>
							) : null}
							{messages.map((message, index) => {
								const previous = messages[index - 1]
								const showHeader =
									!previous ||
									previous.deleted ||
									previous.author !== message.author ||
									message.createdAt - previous.createdAt > GROUP_GAP_MS
								return (
									<MessageItem
										key={message.id}
										message={message}
										people={state.people}
										meId={state.me?.id ?? ''}
										canModerate={state.me?.canModerate ?? false}
										online={state.online}
										locale={i18n.locale}
										showHeader={showHeader}
										onReact={onReact}
										onReply={openThread}
										onEdit={onEdit}
										onDelete={setPendingDelete}
									/>
								)
							})}
						</>
					)}
				</div>

				{active ? (
					<div className="border-t p-2 sm:p-3">
						<p
							className="text-muted-foreground mb-2 h-4 text-xs"
							aria-live="polite"
						>
							{typingNames.length === 0
								? null
								: typingNames.length === 1
									? _(msg`${firstTypingName} is typing…`)
									: _(msg`Several people are typing…`)}
						</p>
						<ChatComposer
							orgSlug={orgSlug}
							members={members}
							placeholder={_(msg`Message #${activeName}`)}
							disabled={!connected}
							onTyping={() => chat.typing(active.id)}
							onSend={async (body, attachmentKeys) => {
								await chat.send(active.id, body, undefined, attachmentKeys)
							}}
						/>
					</div>
				) : null}
			</section>

			{thread ? (
				<aside
					aria-label={_(msg`Thread`)}
					className="bg-background md:bg-muted/10 fixed inset-0 z-50 flex min-h-0 flex-col md:static md:z-auto md:w-96 md:shrink-0 md:border-s md:border-t-0"
				>
					<header className="flex items-center justify-between border-b px-3 py-2.5 sm:px-4">
						<h2 className="text-sm font-semibold">
							<Trans>Thread</Trans>
						</h2>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={_(msg`Close thread`)}
							onClick={() => setThread(null)}
						>
							<Icon name="x" />
						</Button>
					</header>
					<div className="min-h-0 flex-1 overflow-y-auto py-2">
						{threadParent ? (
							<MessageItem
								message={threadParent}
								people={state.people}
								meId={state.me?.id ?? ''}
								canModerate={state.me?.canModerate ?? false}
								online={state.online}
								locale={i18n.locale}
								showHeader
								inThread
								onReact={onReact}
								onEdit={onEdit}
								onDelete={setPendingDelete}
							/>
						) : null}
						<div className="text-muted-foreground px-4 py-2 text-xs">
							{_(
								plural(threadTotalReplies, {
									one: '# reply',
									other: '# replies',
								}),
							)}
						</div>
						{threadMore ? (
							<div className="flex justify-center pb-2">
								<Button
									variant="outline"
									size="sm"
									disabled={loadingEarlierReplies}
									onClick={() => void loadEarlierReplies()}
								>
									{loadingEarlierReplies ? <Spinner /> : null}
									<Trans>Load earlier replies</Trans>
								</Button>
							</div>
						) : null}
						{threadReplies.map((reply, index) => {
							const previous = threadReplies[index - 1]
							return (
								<MessageItem
									key={reply.id}
									message={reply}
									people={state.people}
									meId={state.me?.id ?? ''}
									canModerate={state.me?.canModerate ?? false}
									online={state.online}
									locale={i18n.locale}
									showHeader={
										!previous ||
										previous.author !== reply.author ||
										reply.createdAt - previous.createdAt > GROUP_GAP_MS
									}
									inThread
									onReact={onReact}
									onEdit={onEdit}
									onDelete={setPendingDelete}
								/>
							)
						})}
					</div>
					<div className="border-t p-2 sm:p-3">
						<Composer
							placeholder={_(msg`Reply…`)}
							disabled={!connected || !threadParent || threadParent.deleted}
							onSend={async (body) => {
								await chat.send(thread.channel, body, thread.parent)
							}}
						/>
					</div>
				</aside>
			) : null}

			<DeleteMessageDialog
				message={pendingDelete}
				onClose={() => setPendingDelete(null)}
				onConfirm={(message) => {
					setPendingDelete(null)
					chat.remove(message.id).catch(fail)
				}}
			/>
		</div>
	)
}

function ConnectionBanner({
	status,
}: {
	status: 'connecting' | 'open' | 'reconnecting' | 'forbidden'
}) {
	if (status === 'open') return null
	return (
		<div
			role="status"
			aria-live="polite"
			className={cn(
				'flex items-center gap-2 border-b px-4 py-2 text-xs',
				status === 'forbidden'
					? 'bg-destructive/10 text-destructive'
					: 'bg-muted text-muted-foreground',
			)}
		>
			{status !== 'forbidden' ? (
				<Spinner className="size-3.5 shrink-0" />
			) : null}
			{status === 'forbidden' ? (
				<Trans>
					You no longer have access to this chat. Reload the page to check your
					channels.
				</Trans>
			) : status === 'reconnecting' ? (
				<Trans>Connection lost. Reconnecting…</Trans>
			) : (
				<Trans>Connecting to team chat…</Trans>
			)}
		</div>
	)
}

function DeleteMessageDialog({
	message,
	onClose,
	onConfirm,
}: {
	message: ChatMessage | null
	onClose(): void
	onConfirm(message: ChatMessage): void
}) {
	return (
		<AlertDialog
			open={message !== null}
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						<Trans>Delete message?</Trans>
					</AlertDialogTitle>
					<AlertDialogDescription>
						<Trans>
							This removes the message for everyone in the channel. This can't
							be undone.
						</Trans>
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogCancel>
						<Trans>Cancel</Trans>
					</AlertDialogCancel>
					<AlertDialogAction
						variant="destructive"
						onClick={() => {
							if (message) onConfirm(message)
						}}
					>
						<Trans>Delete</Trans>
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	)
}

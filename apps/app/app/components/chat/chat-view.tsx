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
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
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
import { MessageItem, PersonAvatar } from './chat-message.tsx'
import { isSameMessageDay, showMessageHeader } from './chat-presentation.ts'

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
	const threadTrigger = useRef<HTMLElement | null>(null)
	const threadClose = useRef<HTMLButtonElement>(null)
	const [pendingDelete, setPendingDelete] = useState<ChatMessage | null>(null)
	const [composing, setComposing] = useState(false)
	const [groupSettings, setGroupSettings] = useState(false)
	const [searchQuery, setSearchQuery] = useState('')
	const [searchResults, setSearchResults] = useState<ChatSearchHit[] | null>(
		null,
	)
	const [searching, setSearching] = useState(false)
	const [awayFromLatest, setAwayFromLatest] = useState(false)
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

	useEffect(() => {
		if (thread) {
			threadClose.current?.focus({ preventScroll: true })
		} else {
			const trigger = threadTrigger.current
			threadTrigger.current = null
			if (trigger?.isConnected) trigger.focus({ preventScroll: true })
		}
	}, [thread])

	// ── scrolling ──────────────────────────────────────────────────────────
	const scroller = useRef<HTMLDivElement>(null)
	const messageContent = useRef<HTMLDivElement>(null)
	const stuckToBottom = useRef(true)
	const lastMessageId = view?.messages.at(-1)?.id
	const lastMessageMine = view?.messages.at(-1)?.author === state.me?.id
	useEffect(() => {
		stuckToBottom.current = true
		setAwayFromLatest(false)
	}, [activeId])
	useEffect(() => {
		const element = scroller.current
		if (!element) return
		if (stuckToBottom.current || lastMessageMine) {
			stuckToBottom.current = true
			element.scrollTop = element.scrollHeight
			setAwayFromLatest(false)
		}
	}, [lastMessageId, lastMessageMine, activeId, loaded])

	useEffect(() => {
		const element = scroller.current
		const content = messageContent.current
		if (!element || !content) return
		const observer = new ResizeObserver(() => {
			if (stuckToBottom.current && element.clientHeight > 0) {
				element.scrollTop = element.scrollHeight
			}
		})
		observer.observe(element)
		observer.observe(content)
		return () => observer.disconnect()
	}, [activeId, loaded])

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
	const composerPlaceholder =
		active?.kind === 'channel'
			? _(msg`Message #${activeName}`)
			: _(msg`Message ${activeName}`)
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
		threadTrigger.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null
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
					'hover:bg-muted focus-visible:ring-ring flex min-h-8 shrink-0 items-center gap-2 rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset pointer-coarse:min-h-11',
					isActive && 'bg-accent text-accent-foreground font-semibold',
					!isActive && unread > 0 && 'font-semibold',
				)}
			>
				{channel.kind === 'dm' ? (
					<PersonAvatar
						person={
							state.people[channel.peerUserId ?? ''] ?? {
								id: channel.peerUserId ?? channel.id,
								name: channel.name,
								image: null,
							}
						}
						size="sm"
						online={state.online.includes(channel.peerUserId ?? '')}
					/>
				) : (
					<Icon
						name={iconName}
						size="sm"
						className={cn(
							'shrink-0',
							isActive ? 'text-foreground' : 'text-muted-foreground',
						)}
					/>
				)}
				<span className="min-w-0 flex-1 truncate" title={channel.name}>
					{channel.name}
				</span>
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
		<div className="bg-background flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden md:flex-row">
			<h1 className="sr-only">
				<Trans>Team chat</Trans>
			</h1>
			<nav
				aria-label={_(msg`Channels`)}
				className={cn(
					'bg-muted/20 flex min-h-0 flex-col overflow-y-auto border-b p-3',
					active ? 'max-md:hidden' : 'max-md:min-h-0 max-md:flex-1',
					'md:w-60 md:shrink-0 md:border-e md:border-b-0 xl:w-64',
				)}
			>
				<form
					className="mb-3 w-full shrink-0"
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
					className="mb-5 w-full justify-start"
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
						<div key={section.title} className="mb-5 w-full">
							<p className="text-muted-foreground mb-1 flex items-center justify-between gap-2 px-2 py-1 text-xs font-medium">
								{section.title}
								<span
									className="text-muted-foreground tabular-nums"
									aria-hidden
								>
									{section.items.length}
								</span>
							</p>
							<div className="flex flex-col gap-0.5">
								{section.items.map((channel) => channelLink(channel))}
							</div>
						</div>
					))}
				{canManage ? (
					<Link
						to={`/${orgSlug}/settings/chat`}
						className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring mt-auto flex min-h-8 shrink-0 items-center gap-2 rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset pointer-coarse:min-h-11"
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
				aria-label={active?.name ?? _(msg`Conversation`)}
				className={cn(
					'flex min-h-0 min-w-0 flex-1 flex-col',
					active ? 'max-md:min-h-0 max-md:flex-1' : 'max-md:hidden',
					thread && 'max-xl:hidden',
				)}
			>
				{active ? (
					<header className="flex min-h-14 shrink-0 items-center gap-3 border-b px-3 py-2 sm:px-3">
						<Button
							variant="ghost"
							size="icon-sm"
							className="shrink-0 md:hidden"
							aria-label={_(msg`Back to channels`)}
							render={
								<Link
									to={{ search: '' }}
									replace
									onClick={() => setThread(null)}
								/>
							}
						>
							<Icon name="arrow-left" className="rtl:rotate-180" />
						</Button>
						{active.kind === 'dm' ? (
							<PersonAvatar
								person={
									state.people[active.peerUserId ?? ''] ?? {
										id: active.peerUserId ?? active.id,
										name: active.name,
										image: null,
									}
								}
								online={state.online.includes(active.peerUserId ?? '')}
							/>
						) : (
							<span className="bg-muted text-muted-foreground hidden size-8 shrink-0 items-center justify-center rounded-lg md:inline-flex">
								<Icon
									name={
										active.kind === 'group'
											? 'users'
											: active.access === 'restricted'
												? 'lock'
												: 'message-square'
									}
									size="sm"
								/>
							</span>
						)}
						<div className="min-w-0 flex-1">
							<h2
								className="truncate text-sm font-semibold"
								title={active.name}
							>
								{active.name}
							</h2>
							{active.description ? (
								<p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
									{active.description}
								</p>
							) : (
								<p className="text-muted-foreground mt-0.5 text-xs">
									{active.kind === 'dm' ? (
										state.online.includes(active.peerUserId ?? '') ? (
											<Trans>Online</Trans>
										) : (
											<Trans>Direct message</Trans>
										)
									) : active.kind === 'group' ? (
										<Trans>Group conversation</Trans>
									) : active.access === 'restricted' ? (
										<Trans>Restricted channel</Trans>
									) : (
										<Trans>Team channel</Trans>
									)}
								</p>
							)}
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

				<div className="relative flex min-h-0 flex-1 flex-col">
					<div
						ref={scroller}
						role="log"
						aria-live="polite"
						aria-label={_(msg`Messages`)}
						aria-busy={Boolean(active && !loaded && !historyError)}
						className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain py-4"
						onScroll={(event) => {
							const element = event.currentTarget
							stuckToBottom.current =
								element.scrollHeight -
									element.scrollTop -
									element.clientHeight <
								STICK_THRESHOLD_PX
							setAwayFromLatest(!stuckToBottom.current)
						}}
					>
						{!active ? (
							<div className="flex h-full min-h-48 flex-col items-center justify-center p-6 text-center">
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
							<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
								<p role="alert" className="text-destructive text-sm">
									{historyError}
								</p>
								<Button variant="outline" size="sm" onClick={fetchHistory}>
									<Trans>Try again</Trans>
								</Button>
							</div>
						) : !loaded ? (
							<div className="text-muted-foreground flex h-full items-center justify-center gap-2 p-6 text-sm">
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
									<div className="flex h-full flex-col items-center justify-center px-6 py-12 text-center">
										<EmptyHeader>
											<EmptyMedia variant="icon">
												<Icon name="message-square" />
											</EmptyMedia>
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
								<div ref={messageContent}>
									{messages.map((message, index) => {
										const previous = messages[index - 1]
										return (
											<Fragment key={message.id}>
												{!previous ||
												!isSameMessageDay(
													previous.createdAt,
													message.createdAt,
												) ? (
													<MessageDay
														timestamp={message.createdAt}
														locale={i18n.locale}
													/>
												) : null}
												<MessageItem
													orgSlug={orgSlug}
													members={members}
													message={message}
													people={state.people}
													meId={state.me?.id ?? ''}
													canModerate={state.me?.canModerate ?? false}
													online={state.online}
													locale={i18n.locale}
													showHeader={showMessageHeader(message, previous)}
													onReact={onReact}
													onReply={openThread}
													onEdit={onEdit}
													onDelete={setPendingDelete}
												/>
											</Fragment>
										)
									})}
								</div>
							</>
						)}
					</div>
					{awayFromLatest ? (
						<div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-4">
							<Button
								variant="secondary"
								size="sm"
								className="pointer-events-auto shadow-sm"
								onClick={() => {
									const element = scroller.current
									if (element) element.scrollTop = element.scrollHeight
									stuckToBottom.current = true
									setAwayFromLatest(false)
								}}
							>
								<Icon name="chevron-down" />
								<Trans>Back to latest</Trans>
							</Button>
						</div>
					) : null}
				</div>

				{active ? (
					<div className="shrink-0 px-4 pt-1 pb-4 sm:px-6 sm:pb-2">
						<p
							className="text-muted-foreground mb-2 min-h-4 px-1 text-xs"
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
							placeholder={composerPlaceholder}
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
					className="bg-background flex min-h-0 min-w-0 flex-1 flex-col xl:w-80 xl:flex-none xl:border-s 2xl:w-96"
				>
					<header className="flex min-h-14 shrink-0 items-center justify-between gap-3 border-b px-4 py-2 sm:px-5">
						<div className="min-w-0">
							<h2 className="text-sm font-semibold">
								<Trans>Thread</Trans>
							</h2>
							<p className="text-muted-foreground mt-0.5 truncate text-xs">
								{activeName}
							</p>
						</div>
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={_(msg`Close thread`)}
							ref={threadClose}
							onClick={() => setThread(null)}
						>
							<Icon name="x" />
						</Button>
					</header>
					<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain py-4">
						{threadParent ? (
							<MessageItem
								orgSlug={orgSlug}
								members={members}
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
						<div className="text-muted-foreground mx-4 my-4 flex items-center gap-3 text-xs sm:mx-6">
							{_(
								plural(threadTotalReplies, {
									one: '# reply',
									other: '# replies',
								}),
							)}
							<span className="bg-border h-px flex-1" />
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
									orgSlug={orgSlug}
									members={members}
									message={reply}
									people={state.people}
									meId={state.me?.id ?? ''}
									canModerate={state.me?.canModerate ?? false}
									online={state.online}
									locale={i18n.locale}
									showHeader={showMessageHeader(reply, previous)}
									inThread
									onReact={onReact}
									onEdit={onEdit}
									onDelete={setPendingDelete}
								/>
							)
						})}
					</div>
					<div className="shrink-0 p-4 pb-2">
						<ChatComposer
							orgSlug={orgSlug}
							members={members}
							placeholder={_(msg`Reply…`)}
							disabled={!connected || !threadParent || threadParent.deleted}
							onSend={async (body, attachmentKeys) => {
								await chat.send(
									thread.channel,
									body,
									thread.parent,
									attachmentKeys,
								)
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

function MessageDay({
	timestamp,
	locale,
}: {
	timestamp: number
	locale: string
}) {
	const { _ } = useLingui()
	const today = new Date()
	const yesterday = new Date(today)
	yesterday.setDate(today.getDate() - 1)
	const label = isSameMessageDay(timestamp, today.getTime())
		? _(msg`Today`)
		: isSameMessageDay(timestamp, yesterday.getTime())
			? _(msg`Yesterday`)
			: new Intl.DateTimeFormat(locale, {
					weekday: 'long',
					month: 'short',
					day: 'numeric',
					...(new Date(timestamp).getFullYear() !== today.getFullYear()
						? { year: 'numeric' }
						: {}),
				}).format(timestamp)
	return (
		<div className="mx-4 flex items-center gap-3 py-3 sm:mx-6">
			<span className="bg-border h-px flex-1" />
			<time
				dateTime={new Date(timestamp).toISOString()}
				className="text-muted-foreground shrink-0 text-xs font-medium"
			>
				{label}
			</time>
			<span className="bg-border h-px flex-1" />
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

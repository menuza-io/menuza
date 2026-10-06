import { Trans, msg, plural } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	CHAT_LIMITS,
	type ChatMessage,
	type ChatPerson,
} from '@repo/common/chat'
import { cn } from '@repo/ui'
import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/avatar'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import {
	Popover,
	PopoverContent,
	PopoverTitle,
	PopoverTrigger,
} from '@repo/ui/popover'
import { useState } from 'react'
import { ChatComposer, type ChatComposerMember } from './chat-composer.tsx'
import { ChatMessageMarkdown } from './chat-message-markdown.tsx'

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🙏'] as const

function initials(name: string) {
	return (
		name
			.split(/\s+/u)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase())
			.join('') || '?'
	)
}

export function PersonAvatar({
	person,
	online,
	size = 'default',
}: {
	person: ChatPerson | undefined
	online?: boolean
	size?: 'default' | 'sm' | 'lg'
}) {
	const name = person?.name ?? '?'
	return (
		<span className="relative inline-flex shrink-0">
			<Avatar size={size}>
				{person?.image ? <AvatarImage src={person.image} alt="" /> : null}
				<AvatarFallback className="text-foreground/80">
					{initials(name)}
				</AvatarFallback>
			</Avatar>
			{online ? (
				<span
					aria-hidden
					className="bg-primary ring-background absolute end-0 bottom-0 size-2 rounded-full ring-2"
				/>
			) : null}
		</span>
	)
}

export function formatMessageTime(timestamp: number, locale: string) {
	const date = new Date(timestamp)
	const sameDay = date.toDateString() === new Date().toDateString()
	return new Intl.DateTimeFormat(locale, {
		hour: 'numeric',
		minute: '2-digit',
		...(sameDay ? {} : { month: 'short', day: 'numeric' }),
	}).format(date)
}

function MessageBody({ message }: { message: ChatMessage }) {
	const { _ } = useLingui()
	const [expanded, setExpanded] = useState(false)
	const limit = CHAT_LIMITS.collapseBodyAt
	const plainLength = message.body.length
	const needsCollapse = !message.deleted && plainLength > limit
	const body =
		needsCollapse && !expanded
			? `${message.body.slice(0, limit)}…`
			: message.body

	return (
		<div className="text-sm leading-relaxed break-words">
			<ChatMessageMarkdown
				body={body}
				attachments={
					needsCollapse && !expanded ? [] : (message.attachments ?? [])
				}
			/>
			{needsCollapse ? (
				<Button
					type="button"
					variant="link"
					size="sm"
					className="text-foreground h-auto p-0 text-xs"
					onClick={() => setExpanded((value) => !value)}
				>
					{expanded ? <Trans>Show less</Trans> : <Trans>Show more</Trans>}
				</Button>
			) : null}
			{message.editedAt ? (
				<span className="text-muted-foreground ms-1 text-xs">
					{_(msg`(edited)`)}
				</span>
			) : null}
		</div>
	)
}

export type MessageItemProps = {
	orgSlug: string
	members: ChatComposerMember[]
	message: ChatMessage
	people: Record<string, ChatPerson>
	meId: string
	canModerate: boolean
	online: string[]
	locale: string
	/** Show the avatar and name line (first message of a run by one author). */
	showHeader: boolean
	/** Hide thread controls inside the thread panel. */
	inThread?: boolean
	onReact(message: ChatMessage, emoji: string): void
	onReply?(message: ChatMessage): void
	onEdit(message: ChatMessage, body: string): Promise<void>
	onDelete(message: ChatMessage): void
}

export function MessageItem({
	orgSlug,
	members,
	message,
	people,
	meId,
	canModerate,
	online,
	locale,
	showHeader,
	inThread = false,
	onReact,
	onReply,
	onEdit,
	onDelete,
}: MessageItemProps) {
	const { _ } = useLingui()
	const [editing, setEditing] = useState(false)
	const [pickerOpen, setPickerOpen] = useState(false)
	const [actionsOpen, setActionsOpen] = useState(false)
	const author = people[message.author]
	const mine = message.author === meId
	const replyCount = message.replyCount
	const replyCountLabel = _(
		plural(replyCount, { one: '# reply', other: '# replies' }),
	)

	if (message.deleted) {
		return (
			<div className="text-muted-foreground px-4 py-2 ps-16 text-sm italic sm:px-6 sm:ps-18">
				<Trans>This message was deleted.</Trans>
				{!inThread && message.replyCount > 0 ? (
					<Button
						variant="link"
						size="sm"
						className="ms-2 h-auto p-0"
						onClick={() => onReply?.(message)}
					>
						{replyCountLabel}
					</Button>
				) : null}
			</div>
		)
	}

	return (
		<article
			className={cn(
				'group hover:bg-muted/40 focus-within:bg-muted/40 relative flex gap-3 px-4 py-1.5 pe-12 sm:px-6 sm:pe-14',
				showHeader && 'mt-3 pt-2',
			)}
		>
			<div className="w-8 shrink-0">
				{showHeader ? (
					<PersonAvatar
						person={author}
						online={online.includes(message.author)}
					/>
				) : null}
			</div>
			<div className="min-w-0 flex-1">
				{showHeader ? (
					<div className="mb-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
						<span className="min-w-0 truncate text-sm font-semibold">
							{author?.name ?? _(msg`Former member`)}
						</span>
						<time
							className="text-muted-foreground shrink-0 text-xs tabular-nums"
							dateTime={new Date(message.createdAt).toISOString()}
						>
							{formatMessageTime(message.createdAt, locale)}
						</time>
					</div>
				) : null}

				{editing ? (
					<ChatComposer
						orgSlug={orgSlug}
						members={members}
						placeholder={_(msg`Edit message`)}
						initialValue={message.body}
						submitLabel={_(msg`Save`)}
						autoFocus
						onCancel={() => setEditing(false)}
						onSend={async (body) => {
							await onEdit(message, body)
							setEditing(false)
						}}
					/>
				) : (
					<MessageBody message={message} />
				)}

				{message.reactions.length > 0 ? (
					<div className="mt-2 flex flex-wrap gap-1.5">
						{message.reactions.map((reaction) => {
							const reacted = reaction.userIds.includes(meId)
							return (
								<Button
									key={reaction.emoji}
									type="button"
									size="sm"
									variant={reacted ? 'secondary' : 'outline'}
									className={cn(
										'gap-1.5 rounded-md px-2 text-xs',
										reacted &&
											'border-primary/30 bg-primary/10 text-foreground',
									)}
									aria-pressed={reacted}
									aria-label={`${reaction.emoji} ${reaction.userIds.length}`}
									onClick={() => onReact(message, reaction.emoji)}
								>
									<span>{reaction.emoji}</span>
									<span>{reaction.userIds.length}</span>
								</Button>
							)
						})}
					</div>
				) : null}

				{!inThread && message.replyCount > 0 ? (
					<Button
						variant="ghost"
						size="sm"
						className="mt-2 gap-1.5 px-2 text-xs"
						onClick={() => onReply?.(message)}
					>
						<Icon name="message-square" />
						{replyCountLabel}
						<Icon name="chevron-right" className="rtl:rotate-180" />
					</Button>
				) : null}
			</div>

			{!editing ? (
				<div
					className={cn(
						'bg-background absolute end-2 top-1 flex items-center gap-1 rounded-lg md:pointer-events-none md:end-4 md:-top-2 md:border md:p-1 md:opacity-0 md:group-focus-within:pointer-events-auto md:group-focus-within:opacity-100 md:group-hover:pointer-events-auto md:group-hover:opacity-100',
						(pickerOpen || actionsOpen) &&
							'md:pointer-events-auto md:opacity-100',
					)}
				>
					<Popover open={pickerOpen} onOpenChange={setPickerOpen}>
						<PopoverTrigger
							render={<Button variant="ghost" size="icon-sm" />}
							aria-label={_(msg`Add reaction`)}
							className="max-md:hidden"
						>
							<Icon name="smile" />
						</PopoverTrigger>
						<PopoverContent align="end" className="w-auto">
							<PopoverTitle className="sr-only">
								<Trans>Add reaction</Trans>
							</PopoverTitle>
							<div className="flex gap-1">
								{QUICK_REACTIONS.map((emoji) => (
									<Button
										key={emoji}
										type="button"
										variant="ghost"
										size="icon"
										aria-label={_(msg`React with ${emoji}`)}
										onClick={() => {
											setPickerOpen(false)
											onReact(message, emoji)
										}}
									>
										{emoji}
									</Button>
								))}
							</div>
						</PopoverContent>
					</Popover>
					{!inThread && onReply ? (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="max-md:hidden"
							aria-label={_(msg`Reply in thread`)}
							onClick={() => onReply(message)}
						>
							<Icon name="message-square" />
						</Button>
					) : null}
					<DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
						<DropdownMenuTrigger
							render={<Button variant="ghost" size="icon-sm" />}
							aria-label={_(msg`Message actions`)}
						>
							<Icon name="more-horizontal" />
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-44">
							<DropdownMenuSub>
								<DropdownMenuSubTrigger>
									<Icon name="smile" />
									<Trans>Add reaction</Trans>
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent className="grid grid-cols-3 gap-1">
									{QUICK_REACTIONS.map((emoji) => (
										<DropdownMenuItem
											key={emoji}
											className="size-10 justify-center p-0 text-xl"
											aria-label={_(msg`React with ${emoji}`)}
											onClick={() => onReact(message, emoji)}
										>
											<span aria-hidden>{emoji}</span>
										</DropdownMenuItem>
									))}
								</DropdownMenuSubContent>
							</DropdownMenuSub>
							{!inThread && onReply ? (
								<DropdownMenuItem onClick={() => onReply(message)}>
									<Icon name="message-square" />
									<Trans>Reply in thread</Trans>
								</DropdownMenuItem>
							) : null}
							{mine ? (
								<DropdownMenuItem onClick={() => setEditing(true)}>
									<Icon name="pencil" />
									<Trans>Edit message</Trans>
								</DropdownMenuItem>
							) : null}
							{mine || canModerate ? (
								<>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										variant="destructive"
										onClick={() => onDelete(message)}
									>
										<Icon name="trash-2" />
										<Trans>Delete message</Trans>
									</DropdownMenuItem>
								</>
							) : null}
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			) : null}
		</article>
	)
}

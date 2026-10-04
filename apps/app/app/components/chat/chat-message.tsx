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
import { Icon } from '@repo/ui/icon'
import { Textarea } from '@repo/ui/textarea'
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
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
				<AvatarFallback>{initials(name)}</AvatarFallback>
			</Avatar>
			{online ? (
				<span
					aria-hidden
					className="bg-primary ring-background absolute right-0 bottom-0 size-2 rounded-full ring-2"
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
		<div className="text-sm break-words">
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
					className="h-auto p-0 text-xs"
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
	const author = people[message.author]
	const mine = message.author === meId
	const replyCount = message.replyCount
	const replyCountLabel = _(
		plural(replyCount, { one: '# reply', other: '# replies' }),
	)

	if (message.deleted) {
		return (
			<div className="text-muted-foreground px-4 py-1 ps-14 text-sm italic">
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
		<div
			className={cn(
				'group hover:bg-muted/50 relative flex gap-2 px-3 py-1 sm:gap-3 sm:px-4',
				showHeader && 'pt-3',
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
					<div className="flex items-baseline gap-2">
						<span className="text-sm font-semibold">
							{author?.name ?? _(msg`Former member`)}
						</span>
						<time
							className="text-muted-foreground text-xs"
							dateTime={new Date(message.createdAt).toISOString()}
						>
							{formatMessageTime(message.createdAt, locale)}
						</time>
					</div>
				) : null}

				{editing ? (
					<Composer
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
					<div className="mt-1 flex flex-wrap gap-1">
						{message.reactions.map((reaction) => {
							const reacted = reaction.userIds.includes(meId)
							return (
								<Button
									key={reaction.emoji}
									type="button"
									size="sm"
									variant={reacted ? 'secondary' : 'outline'}
									className="h-6 gap-1 rounded-full px-2 text-xs"
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
						variant="link"
						size="sm"
						className="mt-1 h-auto p-0 text-xs"
						onClick={() => onReply?.(message)}
					>
						{replyCountLabel}
					</Button>
				) : null}
			</div>

			{!editing ? (
				<div className="bg-background relative end-auto top-auto mt-1 flex w-fit max-w-full flex-wrap items-center rounded-md border p-0.5 shadow-xs md:absolute md:end-4 md:-top-3 md:mt-0 md:hidden md:group-focus-within:flex md:group-hover:flex">
					{pickerOpen ? (
						QUICK_REACTIONS.map((emoji) => (
							<Button
								key={emoji}
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={_(msg`React with ${emoji}`)}
								onClick={() => {
									setPickerOpen(false)
									onReact(message, emoji)
								}}
							>
								{emoji}
							</Button>
						))
					) : (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={_(msg`Add reaction`)}
							onClick={() => setPickerOpen(true)}
						>
							<Icon name="smile" />
						</Button>
					)}
					{!inThread && onReply ? (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={_(msg`Reply in thread`)}
							onClick={() => onReply(message)}
						>
							<Icon name="message-square" />
						</Button>
					) : null}
					{mine ? (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={_(msg`Edit message`)}
							onClick={() => setEditing(true)}
						>
							<Icon name="pencil" />
						</Button>
					) : null}
					{mine || canModerate ? (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={_(msg`Delete message`)}
							onClick={() => onDelete(message)}
						>
							<Icon name="trash-2" />
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	)
}

export function Composer({
	placeholder,
	initialValue = '',
	submitLabel,
	autoFocus,
	disabled,
	onSend,
	onTyping,
	onCancel,
}: {
	placeholder?: string
	initialValue?: string
	submitLabel?: string
	autoFocus?: boolean
	disabled?: boolean
	onSend(body: string): Promise<void>
	onTyping?(): void
	onCancel?(): void
}) {
	const { _ } = useLingui()
	const [value, setValue] = useState(initialValue)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const textarea = useRef<HTMLTextAreaElement>(null)
	const trimmed = value.trim()

	async function submit(event?: FormEvent) {
		event?.preventDefault()
		if (!trimmed || pending || disabled) return
		setPending(true)
		setError(null)
		try {
			await onSend(trimmed)
			// Only clear after the server accepted it, so a failure keeps the draft.
			if (!onCancel) setValue('')
			textarea.current?.focus()
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: _(msg`Could not send message.`),
			)
		} finally {
			setPending(false)
		}
	}

	function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (
			event.key === 'Enter' &&
			!event.shiftKey &&
			!event.nativeEvent.isComposing
		) {
			event.preventDefault()
			void submit()
		}
		if (event.key === 'Escape' && onCancel) onCancel()
	}

	return (
		<form onSubmit={submit} className="flex flex-col gap-1">
			<div className="flex items-end gap-2">
				<Textarea
					ref={textarea}
					value={value}
					autoFocus={autoFocus}
					rows={1}
					maxLength={CHAT_LIMITS.bodyMax}
					placeholder={placeholder}
					aria-label={placeholder ?? _(msg`Message`)}
					className="max-h-40 min-h-9 resize-none"
					disabled={disabled}
					onKeyDown={onKeyDown}
					onChange={(event) => {
						setValue(event.target.value)
						if (event.target.value) onTyping?.()
					}}
				/>
				{onCancel ? (
					<Button type="button" variant="ghost" size="sm" onClick={onCancel}>
						<Trans>Cancel</Trans>
					</Button>
				) : null}
				<Button
					type="submit"
					size={onCancel ? 'sm' : 'icon'}
					disabled={!trimmed || pending || disabled}
					aria-label={submitLabel ?? _(msg`Send message`)}
				>
					{onCancel ? submitLabel : <Icon name="send" />}
				</Button>
			</div>
			{error ? (
				<p role="alert" className="text-destructive text-xs">
					{error}
				</p>
			) : null}
		</form>
	)
}

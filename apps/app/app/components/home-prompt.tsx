import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { ChatAttachmentList } from '@repo/ai/chat-attachment-list'
import {
	ACCEPTED_IMAGE_TYPES,
	MAX_ATTACHMENTS,
} from '@repo/ai/chat-attachments'
import { useChatAttachments } from '@repo/ai/use-chat-attachments'
import { cn } from '@repo/ui'
import {
	FluidHoverScope,
	useFluidHoverItemRef,
} from '@repo/ui/fluid-hover-scope'
import { Icon, type IconName } from '@repo/ui/icon'
import { spring } from '@repo/ui/springs'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useId, useRef, useState } from 'react'
import { useRouteLoaderData } from 'react-router'
import { useAIPanel } from '#app/components/ai/ai-panel-context.tsx'
import { type loader as rootLoader } from '#app/root.tsx'

/**
 * The home page prompt. One bar that rotates through things the assistant can
 * do; clicking it lists them, and sending a question opens the assistant full
 * screen and asks it.
 */

const SUGGESTIONS = [
	{
		id: 'landing-page',
		icon: 'globe',
		title: msg`Build a landing page`,
		prompt: msg`Create a landing page for my business with a hero, a few feature sections, an FAQ, and a contact section.`,
	},
	{
		id: 'notes',
		icon: 'file-text',
		title: msg`Summarize my notes`,
		prompt: msg`Summarize my most recent notes and list the action items I should follow up on.`,
	},
	{
		id: 'reports',
		icon: 'trending-up',
		title: msg`Open my reports`,
		prompt: msg`Take me to my reports and walk me through what to look at first.`,
	},
	{
		id: 'email',
		icon: 'mail',
		title: msg`Plan a customer email`,
		prompt: msg`Help me plan a marketing email to my customers: suggest a subject line, an outline, and a call to action.`,
	},
	{
		id: 'team',
		icon: 'users',
		title: msg`Invite my team`,
		prompt: msg`Take me to the page where I can invite team members to my organization.`,
	},
	{
		id: 'get-started',
		icon: 'sparkles',
		title: msg`Get set up`,
		prompt: msg`Help me get started. What should I set up first for my organization?`,
	},
] as const satisfies readonly {
	id: string
	icon: IconName
	title: ReturnType<typeof msg>
	prompt: ReturnType<typeof msg>
}[]

// Recent questions are private to whoever typed them. localStorage is shared
// by every account on this browser, so the key carries the user's id, and a
// signed-out or unknown user keeps nothing.
const LEGACY_RECENT_KEY = 'home-prompt-recent'
const recentKey = (userId: string) => `${LEGACY_RECENT_KEY}:${userId}`
const MAX_RECENT = 5
const ROTATE_MS = 4000

function readRecent(userId: string | undefined): string[] {
	if (!userId) return []
	try {
		// An earlier version used one key for everyone; drop it.
		window.localStorage.removeItem(LEGACY_RECENT_KEY)
		const parsed: unknown = JSON.parse(
			window.localStorage.getItem(recentKey(userId)) ?? '[]',
		)
		return Array.isArray(parsed)
			? parsed.filter((item): item is string => typeof item === 'string')
			: []
	} catch {
		return []
	}
}

function writeRecent(userId: string | undefined, list: string[]) {
	if (!userId) return
	try {
		window.localStorage.setItem(recentKey(userId), JSON.stringify(list))
	} catch {
		// localStorage may be unavailable; recents just won't persist.
	}
}

type Tab = 'suggestions' | 'recent'

type Row = { id: string; icon: IconName; label: string; text: string }

export function HomePrompt({ className }: { className?: string }) {
	const { _ } = useLingui()
	const { ask } = useAIPanel()
	const listId = useId()
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const [value, setValue] = useState('')
	const [open, setOpen] = useState(false)
	const [tab, setTab] = useState<Tab>('suggestions')
	const [activeIndex, setActiveIndex] = useState(-1)
	const [headlineIndex, setHeadlineIndex] = useState(0)
	const [recent, setRecent] = useState<string[]>([])
	const userId = useRouteLoaderData<typeof rootLoader>('root')?.user?.id
	const {
		attachments,
		error: attachmentError,
		resizing,
		addFiles,
		remove: removeAttachment,
		clear: clearAttachments,
		onPaste,
	} = useChatAttachments()
	const [multiline, setMultiline] = useState(false)
	const [headlinePaused, setHeadlinePaused] = useState(false)
	const reduceMotion = useReducedMotion() ?? false
	const fileInputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		setRecent(readRecent(userId))
	}, [userId])

	// Rotate the headline only while the bar is idle. It also stops while the
	// pointer or keyboard is on it (so it never swaps out from under someone
	// about to click it) and for people who ask for reduced motion.
	const idle = !open && value === '' && !headlinePaused && !reduceMotion
	useEffect(() => {
		if (!idle) return
		const id = window.setInterval(
			() => setHeadlineIndex((index) => (index + 1) % SUGGESTIONS.length),
			ROTATE_MS,
		)
		return () => window.clearInterval(id)
	}, [idle])

	// Grow with the text, up to a few lines.
	useEffect(() => {
		const el = textareaRef.current
		if (!el) return
		el.style.height = 'auto'
		el.style.height = `${Math.min(el.scrollHeight, 160)}px`
		// More than one line: a full pill would turn into an oval.
		setMultiline(el.scrollHeight > 36)
	}, [value])

	const suggestionRows: Row[] = SUGGESTIONS.map((item) => ({
		id: item.id,
		icon: item.icon,
		label: _(item.title),
		text: _(item.prompt),
	}))
	const recentRows: Row[] = recent.map((text, index) => ({
		id: `recent-${index}`,
		icon: 'history',
		label: text,
		text,
	}))
	const rows = tab === 'suggestions' ? suggestionRows : recentRows
	const showMenu = open && value.trim() === ''
	const headline = SUGGESTIONS[headlineIndex] ?? SUGGESTIONS[0]

	const fill = (text: string) => {
		setValue(text)
		setOpen(false)
		setActiveIndex(-1)
		textareaRef.current?.focus()
	}

	const submit = () => {
		const text = value.trim()
		if (!text && attachments.length === 0) return
		// An image still being resized would be left out.
		if (resizing > 0) return
		if (text) {
			const next = [text, ...recent.filter((item) => item !== text)].slice(
				0,
				MAX_RECENT,
			)
			setRecent(next)
			writeRecent(userId, next)
		}
		const files = attachments
		setValue('')
		clearAttachments()
		setOpen(false)
		setActiveIndex(-1)
		textareaRef.current?.blur()
		ask(text, files)
	}

	const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		// Enter that commits an IME candidate must not send the half-typed text.
		if (event.nativeEvent.isComposing) return
		if (
			(event.key === 'ArrowDown' || event.key === 'ArrowUp') &&
			!open &&
			value.trim() === ''
		) {
			// Reopen the suggestions after Escape or a click away.
			event.preventDefault()
			setOpen(true)
			return
		}
		if (event.key === 'Escape') {
			setOpen(false)
			setActiveIndex(-1)
			return
		}
		if (showMenu && rows.length > 0) {
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault()
				const step = event.key === 'ArrowDown' ? 1 : -1
				setActiveIndex((index) =>
					index === -1
						? step === 1
							? 0
							: rows.length - 1
						: (index + step + rows.length) % rows.length,
				)
				return
			}
			if (event.key === 'Enter' && !event.shiftKey && activeIndex >= 0) {
				event.preventDefault()
				const row = rows[activeIndex]
				if (row) fill(row.text)
				return
			}
		}
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault()
			submit()
		}
	}

	const canSend =
		resizing === 0 && (value.trim().length > 0 || attachments.length > 0)

	return (
		<div
			role="group"
			aria-label={_(msg`Ask the assistant`)}
			className={cn('mx-auto flex w-full max-w-2xl flex-col gap-3', className)}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					setOpen(false)
					setActiveIndex(-1)
				}
			}}
		>
			<div
				className="relative flex h-8 items-center justify-center overflow-hidden"
				onMouseEnter={() => setHeadlinePaused(true)}
				onMouseLeave={() => setHeadlinePaused(false)}
				onFocus={() => setHeadlinePaused(true)}
				onBlur={() => setHeadlinePaused(false)}
			>
				<AnimatePresence mode="popLayout" initial={false}>
					<motion.button
						key={headline.id}
						type="button"
						onClick={() => fill(_(headline.prompt))}
						className="text-foreground hover:bg-accent focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-full p-1 pr-3.5 text-base font-medium transition-colors duration-80 outline-none focus-visible:ring-3"
						initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
						animate={{
							opacity: 1,
							y: 0,
							filter: 'blur(0px)',
							transition: spring.moderate,
						}}
						exit={{
							opacity: 0,
							y: -10,
							filter: 'blur(4px)',
							transition: spring.moderate.exit,
						}}
					>
						<span className="bg-foreground text-background flex size-6 items-center justify-center rounded-lg">
							<Icon name={headline.icon} className="size-3.5" />
						</span>
						{_(headline.title)}
					</motion.button>
				</AnimatePresence>
			</div>

			<div className="relative">
				<div
					className={cn(
						'bg-card focus-within:border-ring focus-within:ring-ring/50 border shadow-xs transition-[border-color,box-shadow] duration-160 focus-within:ring-3',
						multiline || attachments.length > 0 || attachmentError
							? 'rounded-3xl'
							: 'rounded-full',
					)}
				>
					<ChatAttachmentList
						className="flex flex-wrap gap-2 px-4 pt-3"
						attachments={attachments}
						onRemove={(id) => {
							removeAttachment(id)
							// Keep focus in the composer instead of dropping it to the page.
							textareaRef.current?.focus()
						}}
					/>
					{attachmentError ? (
						<p role="status" className="text-destructive px-4 pt-2 text-xs">
							{_(
								msg`Some images couldn't be added. Use PNG, JPEG, WebP or GIF under 10 MB, up to 4 per message.`,
							)}
						</p>
					) : null}
					<div className="flex items-start gap-1 py-2 pr-2 pl-2">
						<input
							ref={fileInputRef}
							type="file"
							accept={ACCEPTED_IMAGE_TYPES}
							multiple
							className="sr-only"
							tabIndex={-1}
							aria-hidden
							onChange={(event) => {
								const files = Array.from(event.currentTarget.files ?? [])
								event.currentTarget.value = ''
								if (files.length > 0) void addFiles(files)
							}}
						/>
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							disabled={attachments.length >= MAX_ATTACHMENTS}
							aria-label={_(msg`Attach an image`)}
							title={_(msg`Attach an image`)}
							className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 flex size-8 shrink-0 items-center justify-center rounded-full transition-colors duration-80 outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50"
						>
							<Icon name="image" className="size-4" />
						</button>
						<textarea
							ref={textareaRef}
							rows={1}
							value={value}
							placeholder={_(msg`Get something done`)}
							aria-label={_(msg`Ask the assistant`)}
							aria-controls={showMenu ? listId : undefined}
							className="placeholder:text-muted-foreground max-h-40 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-sm leading-5 outline-none"
							onChange={(event) => {
								setValue(event.target.value)
								setActiveIndex(-1)
							}}
							onFocus={() => setOpen(true)}
							onClick={() => setOpen(true)}
							onKeyDown={handleKeyDown}
							onPaste={onPaste}
						/>
						<AnimatePresence initial={false}>
							{canSend ? (
								<motion.button
									key="send"
									type="button"
									aria-label={_(msg`Send`)}
									onClick={submit}
									className="bg-foreground text-background focus-visible:ring-ring/50 flex size-8 shrink-0 items-center justify-center self-end rounded-full outline-none focus-visible:ring-3"
									initial={{ opacity: 0, scale: 0.6 }}
									animate={{
										opacity: 1,
										scale: 1,
										transition: spring.fast,
									}}
									exit={{
										opacity: 0,
										scale: 0.6,
										transition: spring.fast.exit,
									}}
									whileTap={{ scale: 0.94 }}
								>
									<Icon name="arrow-right" className="size-4 -rotate-90" />
								</motion.button>
							) : null}
						</AnimatePresence>
					</div>
				</div>

				<AnimatePresence>
					{showMenu ? (
						<motion.div
							key="menu"
							id={listId}
							className="bg-popover shadow-pop absolute inset-x-0 top-full z-30 mt-2 origin-top overflow-hidden rounded-2xl border p-1.5"
							initial={{ opacity: 0, y: -6 }}
							animate={{ opacity: 1, y: 0, transition: spring.moderate }}
							exit={{
								opacity: 0,
								y: -6,
								transition: spring.moderate.exit,
							}}
							// Keep focus in the textarea while the menu is used.
							onMouseDown={(event) => event.preventDefault()}
						>
							<div className="flex items-center gap-1 px-1 pb-1.5">
								{(['suggestions', 'recent'] as const).map((name) => (
									<button
										key={name}
										type="button"
										aria-pressed={tab === name}
										onClick={() => {
											setTab(name)
											setActiveIndex(-1)
										}}
										className={cn(
											'focus-visible:ring-ring/50 rounded-full px-3 py-1 text-[13px] font-medium transition-colors duration-80 outline-none focus-visible:ring-3',
											tab === name
												? 'bg-accent text-foreground'
												: 'text-muted-foreground hover:text-foreground',
										)}
									>
										{name === 'suggestions'
											? _(msg`Suggestions`)
											: _(msg`Recent`)}
									</button>
								))}
							</div>
							{rows.length === 0 ? (
								<p className="text-muted-foreground px-3 py-6 text-center text-sm">
									{_(msg`Questions you ask will show up here.`)}
								</p>
							) : (
								<FluidHoverScope
									key={tab}
									follow="data-active"
									onMouseLeave={() => setActiveIndex(-1)}
								>
									{rows.map((row, index) => (
										<SuggestionRow
											key={row.id}
											row={row}
											active={index === activeIndex}
											onActivate={() => setActiveIndex(index)}
											onSelect={() => fill(row.text)}
										/>
									))}
								</FluidHoverScope>
							)}
						</motion.div>
					) : null}
				</AnimatePresence>
			</div>
		</div>
	)
}

function SuggestionRow({
	row,
	active,
	onActivate,
	onSelect,
}: {
	row: Row
	active: boolean
	onActivate: () => void
	onSelect: () => void
}) {
	const item = useFluidHoverItemRef<HTMLButtonElement>()
	return (
		<button
			ref={item.ref}
			type="button"
			data-active={active}
			onMouseMove={onActivate}
			onFocus={onActivate}
			onClick={onSelect}
			className="text-foreground flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm outline-none"
		>
			<Icon name={row.icon} className="text-muted-foreground size-4 shrink-0" />
			<span className="min-w-0 flex-1 truncate">{row.label}</span>
			<Icon
				name="plus"
				className={cn(
					'text-muted-foreground size-4 shrink-0 transition-opacity duration-80',
					active ? 'opacity-100' : 'opacity-0',
				)}
			/>
		</button>
	)
}

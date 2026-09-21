'use client'

import { useChat, type UIMessage } from '@ai-sdk/react'
import { t } from '@lingui/core/macro'
import { useLingui } from '@lingui/react'
import { Trans } from '@lingui/react/macro'
import { cn } from '@repo/ui'
import {
	DefaultChatTransport,
	lastAssistantMessageIsCompleteWithToolCalls,
} from 'ai'
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Conversation,
	ConversationContent,
	ConversationScrollButton,
} from './ai-elements/conversation.js'
import { Loader } from './ai-elements/loader.js'
import { Message, MessageContent } from './ai-elements/message.js'
import { Response } from './ai-elements/response.js'
import { Suggestions, Suggestion } from './ai-elements/suggestion.js'
import { brand } from '@repo/config/brand'

export interface AIChatProps {
	/**
	 * Optional. When provided, the chat is scoped to that note: the route
	 * handler fetches note context, permissions are enforced, and the
	 * empty-state suggestions target that note. When omitted, the chat
	 * runs as a general (note-less) conversation.
	 */
	noteId?: string
	pageId?: string
	orgSlug?: string
	currentPath?: string
	routeParams?: Record<string, string>
	userName?: string
	greeting?: string
	subtitle?: string
	placeholder?: string
	initialSuggestions?: string[]
	className?: string
	onToolCall?: (options: { toolCall: any }) => any
	/**
	 * Maps tool inputs to human-readable destination labels for navigation cards.
	 */
	resolveDestinationLabel?: (
		toolName: string,
		input: Record<string, unknown>,
	) => string | undefined
	/**
	 * When set, chat messages are restored from and saved to sessionStorage
	 * so the conversation survives route changes and remounts.
	 */
	persistKey?: string
}

function loadPersistedMessages(storageKey: string): UIMessage[] | undefined {
	if (typeof window === 'undefined') return undefined
	try {
		const raw = window.sessionStorage.getItem(storageKey)
		if (!raw) return undefined
		const parsed = JSON.parse(raw)
		return Array.isArray(parsed) ? (parsed as UIMessage[]) : undefined
	} catch {
		return undefined
	}
}

function buildPersistStorageKey(persistKey: string) {
	return `ai-chat:${persistKey}`
}

function buildChatApiUrl({
	noteId,
	orgSlug,
}: {
	noteId?: string
	orgSlug?: string
}) {
	const params = new URLSearchParams()
	if (noteId) params.set('noteId', noteId)
	if (orgSlug) params.set('orgSlug', orgSlug)
	const query = params.toString()
	return query ? `/api/ai/chat?${query}` : '/api/ai/chat'
}

function resolveToolName(part: { toolName?: string; type?: string }) {
	return (
		part.toolName ||
		(typeof part.type === 'string' && part.type.startsWith('tool-')
			? part.type.replace(/^tool-/, '')
			: part.type) ||
		'action'
	)
}

function humanizeDestinationId(value: string) {
	return value
		.split(/[-_]/u)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
		.join(' ')
}

function resolveNavigationTitle(
	toolName: string,
	input: Record<string, unknown>,
	resolveDestinationLabel?: AIChatProps['resolveDestinationLabel'],
) {
	const resolved = resolveDestinationLabel?.(toolName, input)
	if (resolved) return resolved

	if (typeof input.title === 'string' && input.title.trim()) {
		return input.title.trim()
	}

	if (toolName === 'navigateToPage') {
		return 'the page editor'
	}

	const routeId =
		typeof input.routeId === 'string'
			? input.routeId
			: typeof input.pageId === 'string'
				? input.pageId
				: ''
	if (routeId) return humanizeDestinationId(routeId)

	return 'this page'
}

function useToolActivityLabel(toolName: string, isComplete: boolean) {
	const { _ } = useLingui()

	const labels: Record<string, { active: string; done: string }> = {
		getPageDetails: {
			active: _(t`Reading page details`),
			done: _(t`Read page details`),
		},
		createPage: {
			active: _(t`Creating page`),
			done: _(t`Created page`),
		},
		addSection: {
			active: _(t`Adding section`),
			done: _(t`Added section`),
		},
		updateSection: {
			active: _(t`Updating section`),
			done: _(t`Updated section`),
		},
		removeSection: {
			active: _(t`Removing section`),
			done: _(t`Removed section`),
		},
	}

	const label = labels[toolName]
	if (label) return isComplete ? label.done : label.active
	return isComplete ? _(t`Done`) : _(t`Working on it`)
}

function ActivityStatusRow({
	label,
	state,
	errorText,
	showDoneBadge = true,
}: {
	label: string
	state: string
	errorText?: string
	showDoneBadge?: boolean
}) {
	const isPending = state === 'input-available' || state === 'input-streaming'
	const isCompleted = state === 'output-available'
	const isError = state === 'output-error' || Boolean(errorText)

	return (
		<div
			className={cn(
				'border-border/60 bg-muted/30 my-2 flex items-center gap-2.5 rounded-lg border px-3 py-2',
				isError && 'border-destructive/30 bg-destructive/5',
			)}
		>
			{isPending ? (
				<Loader size={14} className="text-muted-foreground shrink-0" />
			) : isError ? (
				<Icon
					name="octagon-alert"
					className="text-destructive size-3.5 shrink-0"
				/>
			) : (
				<Icon name="check-circle" className="text-primary size-3.5 shrink-0" />
			)}
			<p
				className={cn(
					'min-w-0 flex-1 text-sm',
					isError ? 'text-destructive' : 'text-muted-foreground',
				)}
			>
				{isError
					? errorText || <Trans>Something went wrong. Try again.</Trans>
					: label}
			</p>
			{showDoneBadge && isCompleted && !isError ? (
				<Badge variant="secondary" className="shrink-0 text-[10px]">
					<Trans>Done</Trans>
				</Badge>
			) : null}
		</div>
	)
}

function NavigationConfirmCard({
	routeTitle,
	state,
	output,
	onConfirm,
	onCancel,
}: {
	routeTitle: string
	state: string
	output?: unknown
	onConfirm: () => void
	onCancel: () => void
}) {
	const { _ } = useLingui()
	const isCompleted = state === 'output-available'
	const isError = state === 'output-error'
	const outputText = typeof output === 'string' ? output : ''
	const wasDeclined =
		outputText.toLowerCase().includes('declined') ||
		outputText.toLowerCase().includes('cancelled')

	if (isCompleted && !isError) {
		return (
			<ActivityStatusRow
				label={
					wasDeclined
						? _(t`Stayed on current page`)
						: _(t`Opened ${routeTitle}`)
				}
				state={state}
				showDoneBadge={false}
			/>
		)
	}

	if (isError) {
		return (
			<ActivityStatusRow
				label={_(t`Couldn't open ${routeTitle}`)}
				state={state}
				errorText={_(t`Ask me to try again or choose a different destination.`)}
				showDoneBadge={false}
			/>
		)
	}

	return (
		<div className="border-border/60 bg-muted/20 my-2 space-y-3 rounded-lg border p-3">
			<div className="flex items-center gap-2.5">
				<Icon name="arrow-right" className="text-primary size-4 shrink-0" />
				<p className="text-foreground text-sm font-medium">
					<Trans>Open {routeTitle}?</Trans>
				</p>
			</div>
			<div className="flex gap-2">
				<Button
					type="button"
					size="sm"
					onClick={onConfirm}
					className="h-8 flex-1 text-xs font-medium"
				>
					<Trans>Go there</Trans>
				</Button>
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={onCancel}
					className="h-8 flex-1 text-xs font-medium"
				>
					<Trans>Not now</Trans>
				</Button>
			</div>
		</div>
	)
}

function ToolPartRenderer({
	part,
	onConfirmTool,
	onCancelTool,
	resolveDestinationLabel,
}: {
	part: any
	onConfirmTool?: (toolCallId: string, toolName: string, input: any) => void
	onCancelTool?: (toolCallId: string, toolName: string, input: any) => void
	resolveDestinationLabel?: AIChatProps['resolveDestinationLabel']
}) {
	const toolName = resolveToolName(part)
	const state =
		part.state || (part.output ? 'output-available' : 'input-available')
	const input = part.input || part.args || {}
	const isComplete = state === 'output-available'
	const activityLabel = useToolActivityLabel(toolName, isComplete)

	if (toolName === 'navigateToAppPage' || toolName === 'navigateToPage') {
		const title = resolveNavigationTitle(
			toolName,
			input,
			resolveDestinationLabel,
		)

		return (
			<NavigationConfirmCard
				routeTitle={title}
				state={state}
				output={part.output}
				onConfirm={() => onConfirmTool?.(part.toolCallId, toolName, input)}
				onCancel={() => onCancelTool?.(part.toolCallId, toolName, input)}
			/>
		)
	}

	return (
		<ActivityStatusRow
			label={activityLabel}
			state={state}
			errorText={part.errorText}
		/>
	)
}

// Message Content Component
function MessageContentRenderer({
	parts,
	isUser,
	onConfirmTool,
	onCancelTool,
	resolveDestinationLabel,
}: {
	parts: UIMessage['parts']
	isUser: boolean
	onConfirmTool?: (toolCallId: string, toolName: string, input: any) => void
	onCancelTool?: (toolCallId: string, toolName: string, input: any) => void
	resolveDestinationLabel?: AIChatProps['resolveDestinationLabel']
}) {
	if (isUser) {
		return (
			<div className="leading-relaxed break-words whitespace-pre-wrap">
				{parts.map((part, index) => {
					if (part.type === 'text') {
						return <span key={index}>{part.text}</span>
					}
					return null
				})}
			</div>
		)
	}

	// Use the Response component for AI messages with markdown support & tool parts
	return (
		<div className="space-y-2 leading-relaxed">
			{parts.map((part, index) => {
				if (part.type === 'text') {
					return <Response key={index}>{part.text}</Response>
				}

				// Render tool calls / invocations
				if (
					part.type === 'dynamic-tool' ||
					(typeof part.type === 'string' && part.type.startsWith('tool-'))
				) {
					return (
						<ToolPartRenderer
							key={index}
							part={part}
							onConfirmTool={onConfirmTool}
							onCancelTool={onCancelTool}
							resolveDestinationLabel={resolveDestinationLabel}
						/>
					)
				}

				return null
			})}
		</div>
	)
}

// Smart suggestions hook based on context and conversation state
function useSmartSuggestions(messages: UIMessage[], hasContent: boolean) {
	const { _ } = useLingui()

	return useMemo(() => {
		if (messages.length === 0) {
			// Initial suggestions when no conversation has started
			return hasContent
				? [
						_(t`Summarize this note`),
						_(t`What are the key points?`),
						_(t`Suggest improvements`),
						_(t`Create action items`),
						_(t`Find potential issues`),
					]
				: [
						_(t`What can you help me with?`),
						_(t`Take me to settings`),
						_(t`Help me get started`),
						_(t`Draft something for me`),
					]
		}

		const conversationContext = messages
			.slice(-3)
			.map((m) => {
				const textParts = m.parts.filter((p) => p.type === 'text')
				return textParts.map((p) => (p.type === 'text' ? p.text : '')).join(' ')
			})
			.join(' ')
			.toLowerCase()

		// Context-aware follow-up suggestions
		if (
			conversationContext.includes('summary') ||
			conversationContext.includes('summarize')
		) {
			return [
				_(t`Make it more detailed`),
				_(t`Create bullet points`),
				_(t`What's missing?`),
				_(t`Add next steps`),
			]
		}

		if (
			conversationContext.includes('action') ||
			conversationContext.includes('todo')
		) {
			return [
				_(t`Prioritize these tasks`),
				_(t`Set deadlines`),
				_(t`Assign responsibilities`),
				_(t`Break down complex tasks`),
			]
		}

		if (
			conversationContext.includes('improve') ||
			conversationContext.includes('better')
		) {
			return [
				_(t`Show specific examples`),
				_(t`What tools can help?`),
				_(t`Create a plan`),
				_(t`Identify risks`),
			]
		}

		// General follow-up suggestions
		return [
			_(t`Tell me more`),
			_(t`Give me examples`),
			_(t`What else should I know?`),
			_(t`How can I implement this?`),
		]
	}, [messages, _])
}

function IconArrowUp({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.25"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="m5 12 7-7 7 7" />
			<path d="M12 19V5" />
		</svg>
	)
}

function IconSquare({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<rect x="6" y="6" width="12" height="12" rx="2.5" />
		</svg>
	)
}

function IconRefresh({ className }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.75"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
			<path d="M21 3v5h-5" />
			<path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
			<path d="M3 21v-5h5" />
		</svg>
	)
}

export function AIChat({
	noteId,
	pageId,
	orgSlug,
	currentPath,
	routeParams,
	userName = brand.name,
	greeting,
	subtitle,
	placeholder,
	className,
	onToolCall,
	resolveDestinationLabel,
	persistKey,
}: AIChatProps) {
	const [input, setInput] = useState('')
	const textareaRef = useRef<HTMLTextAreaElement>(null)
	const pageIdRef = useRef(pageId)
	const currentPathRef = useRef(currentPath)
	const routeParamsRef = useRef(routeParams)
	const onToolCallRef = useRef(onToolCall)
	const addToolOutputRef = useRef<
		| null
		| ((args: { tool: string; toolCallId: string; output: unknown }) => void)
	>(null)
	const persistedMessages = useMemo(() => {
		if (!persistKey) return undefined
		return loadPersistedMessages(buildPersistStorageKey(persistKey))
	}, [persistKey])
	pageIdRef.current = pageId
	currentPathRef.current = currentPath
	routeParamsRef.current = routeParams
	onToolCallRef.current = onToolCall
	const { _ } = useLingui()
	const transport = useMemo(
		() =>
			new DefaultChatTransport({
				api: buildChatApiUrl({ noteId, orgSlug }),
				body: () => ({
					...(pageIdRef.current ? { pageId: pageIdRef.current } : {}),
					...(currentPathRef.current
						? { currentPath: currentPathRef.current }
						: {}),
					...(routeParamsRef.current &&
					Object.keys(routeParamsRef.current).length > 0
						? { params: routeParamsRef.current }
						: {}),
				}),
			}),
		[noteId, orgSlug],
	)
	const {
		messages,
		sendMessage,
		status,
		stop: stopGeneration,
		regenerate,
		addToolOutput,
	} = useChat({
		...(persistKey ? { id: persistKey, messages: persistedMessages } : {}),
		transport,
		onToolCall: ({ toolCall }) => {
			// Interactive navigation tools wait for user confirmation click
			if (
				toolCall.toolName === 'navigateToAppPage' ||
				toolCall.toolName === 'navigateToPage'
			) {
				return
			}
			const handler = onToolCallRef.current
			if (!handler) return
			void (async () => {
				const output = await handler({ toolCall })
				addToolOutputRef.current?.({
					tool: toolCall.toolName,
					toolCallId: toolCall.toolCallId,
					output: output ?? 'ok',
				})
			})()
		},
		sendAutomaticallyWhen: ({ messages }) =>
			lastAssistantMessageIsCompleteWithToolCalls({ messages }),
	})
	addToolOutputRef.current = addToolOutput

	useEffect(() => {
		if (!persistKey || typeof window === 'undefined') return
		try {
			window.sessionStorage.setItem(
				buildPersistStorageKey(persistKey),
				JSON.stringify(messages),
			)
		} catch {
			// sessionStorage may be unavailable; ignore.
		}
	}, [messages, persistKey])

	const smartSuggestions = useSmartSuggestions(messages, Boolean(noteId))
	const [showFollowUpSuggestions, setShowFollowUpSuggestions] = useState(true)

	// Update suggestions visibility based on input
	useEffect(() => {
		setShowFollowUpSuggestions(input.trim().length === 0)
	}, [input])

	// Auto resize textarea
	useEffect(() => {
		if (textareaRef.current) {
			textareaRef.current.style.height = 'auto'
			textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 160)}px`
		}
	}, [input])

	const handleSuggestionClick = (suggestion: string) => {
		setInput(suggestion)
		setShowFollowUpSuggestions(false)
		if (textareaRef.current) {
			textareaRef.current.focus()
			textareaRef.current.style.height = 'auto'
		}
	}

	const handleFormSubmit = (e: React.FormEvent) => {
		e.preventDefault()
		if (input.trim() && status === 'ready') {
			sendMessage({ text: input })
			setInput('')
			setShowFollowUpSuggestions(false)
			if (textareaRef.current) {
				textareaRef.current.style.height = 'auto'
			}
		}
	}

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			handleFormSubmit(e)
		}
	}

	const isStreaming = status === 'streaming'
	const isSubmitted = status === 'submitted'
	const isBusy = isStreaming || isSubmitted
	const canSend = !isBusy && input.trim().length > 0

	const isPersonalizedGreeting = userName !== brand.name
	const displayGreeting =
		greeting ||
		(isPersonalizedGreeting ? _(t`Hi, ${userName}`) : _(t`How can I help?`))
	const displaySubtitle =
		subtitle ||
		(noteId
			? _(t`Ask about this note, or tell me where you'd like to go.`)
			: _(t`Notes, navigation, and your site — just ask.`))
	const inputPlaceholder = placeholder || _(t`Ask anything…`)

	const lastMessage = messages[messages.length - 1]
	const lastIsAssistant = lastMessage?.role === 'assistant'
	const canRegenerate = !isBusy && lastIsAssistant

	const handleConfirmTool = useCallback(
		async (toolCallId: string, toolName: string, input: any) => {
			const handler = onToolCallRef.current
			if (handler) {
				const output = await handler({
					toolCall: {
						toolCallId,
						toolName,
						input,
						args: input,
					},
				})
				addToolOutputRef.current?.({
					tool: toolName,
					toolCallId,
					output: output ?? 'ok',
				})
			}
		},
		[],
	)

	const handleCancelTool = useCallback(
		(toolCallId: string, toolName: string, input: any) => {
			const target =
				input?.title || input?.routeId || input?.pageId || 'destination'
			addToolOutputRef.current?.({
				tool: toolName,
				toolCallId,
				output: `Navigation to ${target} was cancelled by user. Remained on current screen.`,
			})
		},
		[],
	)

	return (
		<div
			className={cn(
				'bg-background relative flex h-full flex-col overflow-hidden',
				className,
			)}
		>
			{/* Conversation or Empty State Area */}
			<div className="relative flex flex-1 overflow-hidden">
				{messages.length === 0 ? (
					<div className="relative flex h-full w-full flex-col items-center justify-center overflow-hidden px-6 py-10 text-center select-none">
						{/* Soft emerald halo behind the star. */}
						<div
							className="bg-primary/20 dark:bg-primary/15 pointer-events-none absolute top-1/2 left-1/2 size-[340px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl"
							aria-hidden="true"
						/>

						{/* 4-point star — the brand mark. */}
						<svg
							viewBox="0 0 64 64"
							fill="none"
							xmlns="http://www.w3.org/2000/svg"
							className="relative mb-6 size-20 drop-shadow-sm"
							aria-hidden="true"
						>
							<defs>
								<linearGradient
									id="ai-chat-star-gradient"
									x1="0%"
									y1="0%"
									x2="100%"
									y2="100%"
								>
									<stop offset="0%" stopColor="#34d399" />
									<stop offset="55%" stopColor="#10b981" />
									<stop offset="100%" stopColor="#0d9488" />
								</linearGradient>
							</defs>
							<path
								d="M32 4C32 19.464 19.464 32 4 32C19.464 32 32 44.536 32 60C32 44.536 44.536 32 60 32C44.536 32 32 19.464 32 4Z"
								fill="url(#ai-chat-star-gradient)"
							/>
						</svg>

						<h1 className="text-foreground text-lg tracking-tight text-balance sm:text-xl">
							{displayGreeting}
						</h1>
						<p className="text-muted-foreground mt-1.5 max-w-sm text-[0.9rem] text-balance">
							{displaySubtitle}
						</p>

						{/* Suggestion pills — soft, centered, floating. */}
						<div className="mt-8 flex w-full max-w-md flex-wrap items-center justify-center gap-2.5">
							{smartSuggestions.map((suggestion, index) => (
								<button
									key={index}
									type="button"
									onClick={() => handleSuggestionClick(suggestion)}
									className={cn(
										'cursor-pointer rounded-full px-4 py-2 text-[0.8125rem] font-medium',
										'bg-muted text-muted-foreground ring-border ring-1',
										'transition-all duration-150 ease-out',
										'hover:bg-accent hover:text-accent-foreground hover:ring-foreground/20',
										'active:scale-[0.97]',
										'focus-visible:ring-primary/40 focus-visible:ring-2 focus-visible:outline-none',
									)}
								>
									{suggestion}
								</button>
							))}
						</div>
					</div>
				) : (
					<Conversation className="flex-1">
						<ConversationContent className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-6 pb-4 sm:px-0">
							{messages.map((message) => (
								<Message key={message.id} from={message.role}>
									<MessageContent from={message.role}>
										<MessageContentRenderer
											parts={message.parts}
											isUser={message.role === 'user'}
											onConfirmTool={handleConfirmTool}
											onCancelTool={handleCancelTool}
											resolveDestinationLabel={resolveDestinationLabel}
										/>
									</MessageContent>
								</Message>
							))}
							{isBusy && (
								<Message from="assistant">
									<MessageContent>
										<div aria-live="polite" className="text-sm">
											<span className="shimmer text-muted-foreground">
												<Trans>One moment…</Trans>
											</span>
										</div>
									</MessageContent>
								</Message>
							)}
						</ConversationContent>
						<ConversationScrollButton className="border-border/80 bg-background/90 hover:border-primary/40 hover:text-primary shadow-sm backdrop-blur-sm" />
					</Conversation>
				)}
			</div>

			{/* Bottom Input Section */}
			<div className="border-border/70 shrink-0 border-t px-3 pt-3 pb-3 sm:px-4 sm:pb-4">
				<div className="mx-auto w-full max-w-3xl">
					{/* Follow-up suggestions if in active chat */}
					{messages.length > 0 &&
						showFollowUpSuggestions &&
						smartSuggestions.length > 0 && (
							<div className="-mx-1 mb-2.5">
								<Suggestions className="px-1">
									{smartSuggestions.map((suggestion, index) => (
										<Suggestion
											key={index}
											suggestion={suggestion}
											onClick={handleSuggestionClick}
											variant="outline"
											size="sm"
											className={cn(
												'border-border/70 bg-background/70 text-foreground/80 rounded-full text-xs',
												'transition-all duration-150',
												'hover:border-primary/40 hover:bg-primary/5 hover:text-foreground hover:-translate-y-px',
											)}
										/>
									))}
								</Suggestions>
							</div>
						)}

					<form
						onSubmit={handleFormSubmit}
						className={cn(
							'group/form relative flex flex-col',
							isBusy && 'opacity-95',
						)}
					>
						<textarea
							ref={textareaRef}
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={inputPlaceholder}
							rows={1}
							disabled={isBusy}
							aria-label={inputPlaceholder}
							className={cn(
								'text-foreground w-full resize-none bg-transparent px-1 pt-2 pb-1.5 text-[0.95rem] leading-relaxed',
								'placeholder:text-muted-foreground/70 focus:outline-none',
								'disabled:cursor-not-allowed disabled:opacity-60',
							)}
						/>

						<div className="flex items-center justify-end gap-0.5 pt-1">
							{canRegenerate ? (
								<button
									type="button"
									onClick={() => regenerate()}
									className={cn(
										'text-muted-foreground cursor-pointer rounded-lg p-2',
										'transition-colors duration-150',
										'hover:bg-muted hover:text-foreground',
										'focus-visible:ring-primary/30 focus-visible:ring-2 focus-visible:outline-none',
									)}
									title={_(t`Try another answer`)}
									aria-label={_(t`Try another answer`)}
								>
									<IconRefresh className="size-[18px]" />
								</button>
							) : null}

							<button
								type={isStreaming ? 'button' : 'submit'}
								onClick={isStreaming ? () => stopGeneration() : undefined}
								disabled={!isStreaming && !canSend}
								aria-label={isStreaming ? _(t`Stop`) : _(t`Send`)}
								className={cn(
									'ml-1 flex size-8 items-center justify-center rounded-full transition-all duration-150 ease-out',
									'focus-visible:ring-primary/40 focus-visible:ring-2 focus-visible:outline-none',
									isStreaming
										? 'bg-foreground text-background cursor-pointer hover:opacity-90 active:scale-95'
										: canSend
											? 'bg-foreground text-background cursor-pointer hover:opacity-90 active:scale-95'
											: 'bg-muted text-muted-foreground/50 cursor-not-allowed',
								)}
							>
								{isStreaming ? (
									<IconSquare className="size-3" />
								) : isSubmitted ? (
									<Loader size={14} />
								) : (
									<IconArrowUp className="size-4" />
								)}
							</button>
						</div>
					</form>
				</div>
			</div>
		</div>
	)
}

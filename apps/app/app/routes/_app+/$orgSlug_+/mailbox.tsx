import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router'
import { z } from 'zod'
import {
	mailboxListSchema,
	mailboxRecipient,
	mailboxReplyUrl,
	mailboxSender,
	type MailboxItem,
} from '@repo/common/mailbox'
import { pickLocalized } from '@repo/common/site-locales'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	InputGroup,
	InputGroupAddon,
	InputGroupInput,
	InputGroupTextarea,
} from '@repo/ui/input-group'
import { Label } from '@repo/ui/label'
import { ScrollArea } from '@repo/ui/scroll-area'
import { Skeleton } from '@repo/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { MailboxIcon } from '#app/components/icons/mailbox-icon.tsx'
import { ReviewsTab } from '#app/components/mailbox/reviews-tab.tsx'
import {
	notifyMailboxChanged,
	useMailboxClient,
} from '#app/hooks/use-mailbox.ts'
import {
	useConfirmBlocker,
	useDirtyBeforeUnload,
} from '#app/utils/navigation-guards.ts'

export { loader } from './mailbox-token.ts'

// Add future inbox sources here, with a corresponding content panel and API.
const MAILBOX_SOURCES = [
	{ id: 'forms', label: msg`Forms`, icon: 'file-text' },
	{ id: 'reviews', label: msg`Reviews`, icon: 'star' },
] as const
const PAGE_SIZE = 50

type ReplyDraft = { subject: string; message: string; notes: string }

export default function MailboxRoute() {
	const { orgSlug = '' } = useParams()
	const { _, i18n } = useLingui()
	const request = useMailboxClient(orgSlug)
	const [items, setItems] = useState<MailboxItem[]>([])
	const [selected, setSelected] = useState<MailboxItem | null>(null)
	const [total, setTotal] = useState(0)
	const [unreadCount, setUnreadCount] = useState(0)
	const [aiAvailable, setAIAvailable] = useState(false)
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [readError, setReadError] = useState<string | null>(null)
	const [readingId, setReadingId] = useState<string | null>(null)
	const readRequests = useRef(new Map<string, AbortController>())
	const [search, setSearch] = useState('')
	const [query, setQuery] = useState('')
	const [unreadOnly, setUnreadOnly] = useState(false)
	const [page, setPage] = useState(1)
	const [revision, setRevision] = useState(0)
	const [drafts, setDrafts] = useState<Record<string, ReplyDraft>>({})
	const [draftingId, setDraftingId] = useState<string | null>(null)
	const [draftErrors, setDraftErrors] = useState<Record<string, string>>({})
	const draftRequest = useRef<AbortController | null>(null)
	const localize = useCallback(
		(value: string) => pickLocalized(value, i18n.locale, 'en'),
		[i18n.locale],
	)
	const hasDrafts = Object.values(drafts).some((draft) =>
		Boolean(draft.message.trim()),
	)
	useDirtyBeforeUnload(hasDrafts)
	useConfirmBlocker(
		hasDrafts,
		_(msg`Leave the mailbox and discard your reply drafts?`),
	)

	useEffect(() => {
		const timer = window.setTimeout(() => {
			setQuery(search)
			setPage(1)
		}, 300)
		return () => window.clearTimeout(timer)
	}, [search])

	useEffect(() => {
		const controller = new AbortController()
		setLoading(true)
		setError(null)
		const params = new URLSearchParams({
			page: String(page),
			search: query,
			unread: String(unreadOnly),
		})
		void request(`/forms?${params}`, { signal: controller.signal })
			.then((payload) => {
				if (controller.signal.aborted) return
				const result = mailboxListSchema.parse(payload)
				setItems(result.items)
				setTotal(result.total)
				setUnreadCount(result.unreadCount)
				setAIAvailable(result.aiAvailable)
				if (page > 1 && result.items.length === 0) setPage(page - 1)
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted)
					setError(
						cause instanceof Error
							? cause.message
							: _(msg`Unable to load submissions. Try again.`),
					)
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false)
			})
		return () => controller.abort()
	}, [request, page, query, unreadOnly, revision, _])

	useEffect(() => {
		const refresh = () => setRevision((value) => value + 1)
		window.addEventListener('focus', refresh)
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') refresh()
		}, 60000)
		return () => {
			window.removeEventListener('focus', refresh)
			window.clearInterval(timer)
		}
	}, [])
	useEffect(
		() => () => {
			draftRequest.current?.abort()
			readRequests.current.forEach((controller) => controller.abort())
			readRequests.current.clear()
		},
		[],
	)

	const updateRead = async (item: MailboxItem, read: boolean) => {
		readRequests.current.get(item.id)?.abort()
		const controller = new AbortController()
		readRequests.current.set(item.id, controller)
		setReadingId(item.id)
		setReadError(null)
		try {
			await request(`/forms/${encodeURIComponent(item.id)}/read`, {
				method: 'PUT',
				body: JSON.stringify({ read }),
				signal: controller.signal,
			})
			if (controller.signal.aborted) return
			setSelected((current) =>
				current?.id === item.id ? { ...current, isRead: read } : current,
			)
			setItems((current) =>
				current.map((entry) =>
					entry.id === item.id ? { ...entry, isRead: read } : entry,
				),
			)
			setRevision((value) => value + 1)
			notifyMailboxChanged(orgSlug)
		} catch (cause) {
			if (!controller.signal.aborted)
				setReadError(
					cause instanceof Error
						? cause.message
						: _(msg`Could not update read status. Try again.`),
				)
		} finally {
			if (readRequests.current.get(item.id) === controller) {
				readRequests.current.delete(item.id)
				setReadingId((current) => (current === item.id ? null : current))
			}
		}
	}

	const select = (item: MailboxItem) => {
		setSelected(item)
		setReadError(null)
		if (!item.isRead) void updateRead(item, true)
	}
	const selectedDraft = selected
		? (drafts[selected.id] ?? {
				subject: `Re: ${localize(selected.formName)}`,
				message: '',
				notes: '',
			})
		: null
	const updateDraft = (patch: Partial<ReplyDraft>) => {
		if (!selected || !selectedDraft) return
		setDrafts((current) => ({
			...current,
			[selected.id]: { ...selectedDraft, ...patch },
		}))
	}
	const generateDraft = async () => {
		if (!selected || !selectedDraft || draftingId) return
		const item = selected
		const snapshot = selectedDraft
		const controller = new AbortController()
		draftRequest.current = controller
		setDraftingId(item.id)
		setDraftErrors((current) => ({ ...current, [item.id]: '' }))
		try {
			const { message } = z.object({ message: z.string() }).parse(
				await request(`/forms/${encodeURIComponent(item.id)}/draft`, {
					method: 'POST',
					body: JSON.stringify({ notes: snapshot.notes }),
					signal: controller.signal,
				}),
			)
			if (!controller.signal.aborted)
				setDrafts((current) => ({
					...current,
					[item.id]: { ...(current[item.id] ?? snapshot), message },
				}))
		} catch (cause) {
			if (!controller.signal.aborted)
				setDraftErrors((current) => ({
					...current,
					[item.id]:
						cause instanceof Error
							? cause.message
							: _(msg`Could not create a draft. Try again.`),
				}))
		} finally {
			if (!controller.signal.aborted) setDraftingId(null)
		}
	}
	const recipient = selected ? mailboxRecipient(selected) : null
	const replyUrl =
		recipient && selectedDraft
			? mailboxReplyUrl(recipient, selectedDraft.subject, selectedDraft.message)
			: null
	const date = (value: string | null, detailed = false) =>
		value
			? new Intl.DateTimeFormat(i18n.locale, {
					dateStyle: detailed ? 'long' : 'medium',
					...(detailed ? { timeStyle: 'short' as const } : {}),
				}).format(new Date(value))
			: '—'

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<Tabs
				defaultValue="forms"
				className="-mx-4 min-h-0 flex-1 gap-0 md:-mx-2"
			>
				<div className="border-b">
					<TabsList variant="line" aria-label={_(msg`Mailbox sources`)}>
						{MAILBOX_SOURCES.map((source) => (
							<TabsTrigger key={source.id} value={source.id}>
								<Icon name={source.icon} />
								{_(source.label)}
								{source.id === 'forms' && unreadCount > 0 ? (
									<Badge variant="secondary">{unreadCount}</Badge>
								) : null}
							</TabsTrigger>
						))}
					</TabsList>
				</div>
				<TabsContent value="forms" className="flex min-h-0 flex-1">
					<div className="bg-background flex min-h-0 flex-1 overflow-hidden">
						<section
							aria-label={_(msg`Form submissions`)}
							className={cn(
								'flex min-h-0 w-full shrink-0 flex-col border-e md:w-80 lg:w-96',
								selected && 'hidden md:flex',
							)}
						>
							<div className="space-y-3 border-b p-4">
								<Input
									aria-label={_(msg`Search submissions`)}
									placeholder={_(msg`Search submissions…`)}
									value={search}
									maxLength={200}
									onChange={(event) => setSearch(event.target.value)}
								/>
								<div className="flex items-center justify-between gap-2">
									<p className="text-muted-foreground text-xs tabular-nums">
										<Trans>{total} submissions</Trans>
									</p>
									<Button
										variant={unreadOnly ? 'secondary' : 'ghost'}
										size="xs"
										aria-pressed={unreadOnly}
										onClick={() => {
											setUnreadOnly(!unreadOnly)
											setPage(1)
										}}
									>
										<Trans>Unread only</Trans>
									</Button>
								</div>
							</div>
							<ScrollArea className="min-h-0 flex-1" aria-busy={loading}>
								{loading && items.length === 0 ? (
									<div
										className="space-y-6 p-5"
										role="status"
										aria-label={_(msg`Loading submissions`)}
									>
										{[0, 1, 2, 3].map((key) => (
											<div key={key} className="space-y-2">
												<Skeleton className="h-4 w-2/3" />
												<Skeleton className="h-3 w-full" />
												<Skeleton className="h-3 w-1/3" />
											</div>
										))}
									</div>
								) : error ? (
									<div className="space-y-3 p-6">
										<p role="alert" className="text-destructive text-sm">
											{error}
										</p>
										<Button
											variant="outline"
											size="sm"
											onClick={() => setRevision((value) => value + 1)}
										>
											<Trans>Try again</Trans>
										</Button>
									</div>
								) : items.length === 0 ? (
									<div className="flex flex-col items-center px-6 py-16 text-center">
										<MailboxIcon
											size={32}
											className="text-muted-foreground mb-4"
										/>
										<h2 className="font-medium">
											{query ? (
												<Trans>No matching submissions</Trans>
											) : unreadOnly ? (
												<Trans>You’re all caught up</Trans>
											) : (
												<Trans>No submissions yet</Trans>
											)}
										</h2>
										<p className="text-muted-foreground mt-2 text-sm">
											{query ? (
												<Trans>Try another name, email, or message.</Trans>
											) : unreadOnly ? (
												<Trans>New form submissions will appear here.</Trans>
											) : (
												<Trans>
													Responses to your website forms will arrive here.
												</Trans>
											)}
										</p>
									</div>
								) : (
									<ul className="divide-y">
										{items.map((item) => {
											const previewField = item.fields.find(
												(field) => field.type === 'textarea',
											)
											const preview = previewField
												? item.values[previewField.id]
												: Object.values(item.values).filter(Boolean).join(' · ')
											return (
												<li key={item.id}>
													<button
														type="button"
														className={cn(
															'hover:bg-muted/50 focus-visible:ring-ring w-full px-4 py-4 text-start focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
															selected?.id === item.id && 'bg-muted',
														)}
														aria-pressed={selected?.id === item.id}
														onClick={() => select(item)}
													>
														<div className="flex items-start justify-between gap-3">
															<span
																className={cn(
																	'min-w-0 truncate text-sm',
																	!item.isRead && 'font-semibold',
																)}
															>
																{mailboxSender(item) || _(msg`Website visitor`)}
															</span>
															<span className="text-muted-foreground shrink-0 text-xs tabular-nums">
																{date(item.createdAt)}
															</span>
														</div>
														<div className="mt-1 flex items-center gap-2">
															<span className="text-muted-foreground truncate text-xs">
																{localize(item.formName)}
															</span>
															{!item.isRead ? (
																<span
																	className="bg-primary size-1.5 shrink-0 rounded-full"
																	aria-label={_(msg`Unread`)}
																/>
															) : null}
														</div>
														<p className="text-muted-foreground mt-2 line-clamp-2 text-sm leading-relaxed">
															{preview || _(msg`View submission details`)}
														</p>
													</button>
												</li>
											)
										})}
									</ul>
								)}
							</ScrollArea>
							{total > PAGE_SIZE ? (
								<div className="flex items-center justify-between border-t p-3">
									<Button
										variant="ghost"
										size="sm"
										disabled={page === 1 || loading}
										onClick={() => setPage(page - 1)}
									>
										<Trans>Previous</Trans>
									</Button>
									<span className="text-muted-foreground text-xs tabular-nums">
										{page} / {Math.ceil(total / PAGE_SIZE)}
									</span>
									<Button
										variant="ghost"
										size="sm"
										disabled={page * PAGE_SIZE >= total || loading}
										onClick={() => setPage(page + 1)}
									>
										<Trans>Next</Trans>
									</Button>
								</div>
							) : null}
						</section>
						{selected ? (
							<section
								aria-label={_(msg`Submission details`)}
								className="flex min-h-0 min-w-0 flex-1 flex-col"
							>
								<header className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
									<div className="flex min-w-0 items-center gap-2">
										<Button
											variant="ghost"
											size="icon-sm"
											className="md:hidden"
											aria-label={_(msg`Back to submissions`)}
											onClick={() => setSelected(null)}
										>
											<Icon name="arrow-left" className="rtl:rotate-180" />
										</Button>
										<h2 className="truncate font-medium">
											{localize(selected.formName)}
										</h2>
									</div>
									<Button
										variant="ghost"
										size="sm"
										disabled={readingId === selected.id}
										onClick={() => void updateRead(selected, !selected.isRead)}
									>
										{selected.isRead ? (
											<Trans>Mark unread</Trans>
										) : (
											<Trans>Mark read</Trans>
										)}
									</Button>
								</header>
								<ScrollArea className="min-h-0 flex-1">
									<div className="px-5 py-6 md:px-7">
										{readError ? (
											<p role="alert" className="text-destructive mb-4 text-sm">
												{readError}
											</p>
										) : null}
										<div className="mb-7">
											<h3 className="text-lg font-semibold">
												{mailboxSender(selected) || _(msg`Website visitor`)}
											</h3>
											<p className="text-muted-foreground mt-1 text-xs">
												{date(selected.createdAt, true)}
											</p>
										</div>
										<dl className="space-y-5">
											{selected.fields
												.filter(
													(field) =>
														field.type !== 'heading' &&
														field.type !== 'paragraph',
												)
												.map((field) => (
													<div key={field.id}>
														<dt className="text-muted-foreground text-xs font-medium">
															{localize(field.label)}
														</dt>
														<dd className="mt-1.5 text-sm leading-relaxed break-words whitespace-pre-wrap">
															{selected.values[field.id] || '—'}
														</dd>
													</div>
												))}
										</dl>
									</div>
								</ScrollArea>
								<div className="bg-background max-h-2/3 shrink-0 overflow-y-auto px-4 py-3 md:px-7">
									{recipient && selectedDraft ? (
										<div className="space-y-2">
											<div className="text-muted-foreground flex items-center gap-2 text-xs">
												<Icon name="mail" className="size-3.5 shrink-0" />
												<p className="min-w-0 truncate">
													<Trans>To: {recipient}</Trans>
												</p>
											</div>
											<InputGroup>
												<InputGroupAddon
													align="block-start"
													className="border-b"
												>
													<div className="flex w-full items-baseline">
														<Label
															htmlFor="reply-subject"
															className="text-muted-foreground shrink-0 text-base font-normal md:text-sm"
														>
															<Trans>Subject</Trans>
														</Label>
														<InputGroupInput
															id="reply-subject"
															value={selectedDraft.subject}
															maxLength={200}
															onChange={(event) =>
																updateDraft({ subject: event.target.value })
															}
														/>
													</div>
												</InputGroupAddon>
												<Label htmlFor="reply-message" className="sr-only">
													<Trans>Message</Trans>
												</Label>
												<InputGroupTextarea
													id="reply-message"
													rows={2}
													className="max-h-40 resize-none"
													value={selectedDraft.message}
													maxLength={10000}
													disabled={draftingId === selected.id}
													placeholder={_(msg`Write your reply…`)}
													onChange={(event) =>
														updateDraft({ message: event.target.value })
													}
												/>
												<InputGroupAddon align="block-end">
													<Button
														variant="ghost"
														size="sm"
														disabled={
															!aiAvailable ||
															Boolean(draftingId) ||
															Boolean(selectedDraft.message.trim())
														}
														onClick={() => void generateDraft()}
													>
														<Icon name="sparkles" />
														{draftingId === selected.id ? (
															<Trans>Drafting…</Trans>
														) : (
															<Trans>Draft with AI</Trans>
														)}
													</Button>

													{selectedDraft.message ? (
														<Button
															variant="ghost"
															size="icon"
															aria-label={_(msg`Clear draft`)}
															title={_(msg`Clear draft`)}
															onClick={() => updateDraft({ message: '' })}
															disabled={draftingId === selected.id}
														>
															<Icon name="x" />
														</Button>
													) : null}
													<div className="ms-auto">
														<Button
															size="icon"
															aria-label={_(msg`Open in email app`)}
															title={_(msg`Open in email app`)}
															disabled={
																!selectedDraft.message.trim() ||
																!selectedDraft.subject.trim() ||
																draftingId === selected.id
															}
															onClick={() => {
																if (replyUrl) window.location.href = replyUrl
															}}
														>
															<Icon name="send" />
														</Button>
													</div>
												</InputGroupAddon>
											</InputGroup>
											{!aiAvailable ? (
												<p className="text-muted-foreground text-xs">
													<Trans>
														AI drafting hasn’t been enabled for this mailbox.
													</Trans>
												</p>
											) : (
												<details key={selected.id}>
													<summary className="text-muted-foreground cursor-pointer text-xs">
														<Trans>Notes for AI</Trans>
													</summary>
													<Label htmlFor="reply-notes" className="sr-only">
														<Trans>Notes for AI</Trans>
													</Label>
													<Input
														id="reply-notes"
														placeholder={_(
															msg`What should your reply include? (optional)`,
														)}
														value={selectedDraft.notes}
														maxLength={2000}
														onChange={(event) =>
															updateDraft({ notes: event.target.value })
														}
													/>
												</details>
											)}
											{draftErrors[selected.id] ? (
												<p role="alert" className="text-destructive text-xs">
													{draftErrors[selected.id]}
												</p>
											) : null}
										</div>
									) : (
										<p className="text-muted-foreground text-xs">
											<Trans>
												This submission doesn’t include an email address. You
												can review its details, but an email reply isn’t
												available.
											</Trans>
										</p>
									)}
								</div>
							</section>
						) : (
							<div className="hidden min-w-0 flex-1 flex-col items-center justify-center px-8 py-20 text-center md:flex">
								<MailboxIcon size={36} className="text-muted-foreground mb-5" />
								<h2 className="text-lg font-medium">
									<Trans>A place for every inquiry</Trans>
								</h2>
								<p className="text-muted-foreground mt-2 max-w-xs text-sm leading-relaxed">
									<Trans>
										Select a submission to read the details and start a reply.
									</Trans>
								</p>
							</div>
						)}
					</div>
				</TabsContent>
				<TabsContent value="reviews" className="flex min-h-0 flex-1">
					<ReviewsTab orgSlug={orgSlug} />
				</TabsContent>
			</Tabs>
		</div>
	)
}

import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	InputGroup,
	InputGroupAddon,
	InputGroupTextarea,
} from '@repo/ui/input-group'
import { Label } from '@repo/ui/label'
import { ScrollArea } from '@repo/ui/scroll-area'
import { Skeleton } from '@repo/ui/skeleton'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { MailboxIcon } from '#app/components/icons/mailbox-icon.tsx'
import { useMailboxClient } from '#app/hooks/use-mailbox.ts'
import {
	useConfirmBlocker,
	useDirtyBeforeUnload,
} from '#app/utils/navigation-guards.ts'

const reviewSchema = z.object({
	name: z.string(),
	provider: z
		.enum([
			'google-business-profile',
			'yelp',
			'tripadvisor',
			'deliveroo',
			'just-eat',
			'opentable',
		])
		.default('google-business-profile'),
	providerDisplayName: z.string().default('Google'),
	reviewer: z
		.object({
			displayName: z.string().optional(),
			profilePhotoUrl: z.string().optional(),
			isAnonymous: z.boolean().optional(),
		})
		.optional(),
	starRating: z.enum(['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE']).optional(),
	comment: z.string().optional(),
	createTime: z.string().optional(),
	updateTime: z.string().optional(),
	reviewReply: z
		.object({ comment: z.string(), updateTime: z.string().optional() })
		.optional(),
	locationId: z.string(),
	locationName: z.string(),
	externalUrl: z.string().optional(),
})

const responseSchema = z.object({
	reviews: z.array(reviewSchema),
	totalReviewCount: z.number(),
	nextPageTokens: z.record(z.string(), z.string().nullable()),
})

export type UnifiedReviewItem = z.infer<typeof reviewSchema>
type PageTokens = Record<string, string | null>

const PLATFORM_FILTERS = [
	{ id: 'all', label: msg`All`, icon: null },
	{
		id: 'google-business-profile',
		label: msg`Google`,
		icon: 'google' as const,
	},
	{ id: 'yelp', label: msg`Yelp`, icon: 'yelp' as const },
	{ id: 'tripadvisor', label: msg`TripAdvisor`, icon: 'tripadvisor' as const },
	{ id: 'deliveroo', label: msg`Deliveroo`, icon: 'deliveroo' as const },
	{ id: 'just-eat', label: msg`Just Eat`, icon: 'just-eat' as const },
	{ id: 'opentable', label: msg`OpenTable`, icon: 'opentable' as const },
] as const

function ratingValue(rating?: UnifiedReviewItem['starRating']) {
	return rating
		? ['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'].indexOf(rating) + 1
		: null
}

function getPlatformIcon(provider: string) {
	switch (provider) {
		case 'yelp':
			return 'yelp' as const
		case 'tripadvisor':
			return 'tripadvisor' as const
		case 'deliveroo':
			return 'deliveroo' as const
		case 'just-eat':
			return 'just-eat' as const
		case 'opentable':
			return 'opentable' as const
		case 'google-business-profile':
		default:
			return 'google' as const
	}
}

export function ReviewsTab({ orgSlug }: { orgSlug: string }) {
	const { _, i18n } = useLingui()
	const request = useMailboxClient(orgSlug)
	const [activePlatform, setActivePlatform] = useState<string>('all')
	const [reviews, setReviews] = useState<UnifiedReviewItem[]>([])
	const [totalReviewCount, setTotalReviewCount] = useState(0)
	const [nextPageTokens, setNextPageTokens] = useState<PageTokens>({})
	const [requestTokens, setRequestTokens] = useState<PageTokens>({})
	const [previousPages, setPreviousPages] = useState<PageTokens[]>([])
	const [selected, setSelected] = useState<UnifiedReviewItem | null>(null)
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const [notesByReview, setNotesByReview] = useState<Record<string, string>>({})
	const [aiAvailable, setAIAvailable] = useState(false)
	const [aiStatusLoading, setAIStatusLoading] = useState(true)
	const [drafting, setDrafting] = useState(false)
	const [draftError, setDraftError] = useState<string | null>(null)
	const [loading, setLoading] = useState(true)
	const [sending, setSending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const [sendError, setSendError] = useState<string | null>(null)
	const [revision, setRevision] = useState(0)
	const pageNumber = previousPages.length + 1
	const draft = selected ? (drafts[selected.name] ?? '') : ''
	const aiNotes = selected ? (notesByReview[selected.name] ?? '') : ''
	const hasDrafts =
		Object.values(drafts).some((value) => value.trim()) ||
		Object.values(notesByReview).some((value) => value.trim())
	const abortRef = useRef<AbortController | null>(null)
	const draftAbortRef = useRef<AbortController | null>(null)
	const localDate = useMemo(
		() => (value?: string) =>
			value
				? new Intl.DateTimeFormat(i18n.locale, {
						dateStyle: 'medium',
						timeStyle: 'short',
					}).format(new Date(value))
				: '—',
		[i18n.locale],
	)
	const selectedRating = selected ? ratingValue(selected.starRating) : null
	const selectedReplyDate = selected?.reviewReply
		? localDate(selected.reviewReply.updateTime)
		: null
	useDirtyBeforeUnload(hasDrafts)
	useConfirmBlocker(
		hasDrafts,
		_(msg`Leave the mailbox and discard your reply drafts?`),
	)

	useEffect(() => {
		const controller = new AbortController()
		setAIStatusLoading(true)
		void request('/ai/status', { signal: controller.signal })
			.then((payload) => {
				const result = z.object({ aiAvailable: z.boolean() }).parse(payload)
				if (!controller.signal.aborted) setAIAvailable(result.aiAvailable)
			})
			.catch(() => {
				if (!controller.signal.aborted) setAIAvailable(false)
			})
			.finally(() => {
				if (!controller.signal.aborted) setAIStatusLoading(false)
			})
		return () => controller.abort()
	}, [request])

	useEffect(() => {
		const controller = new AbortController()
		abortRef.current = controller
		setLoading(true)
		setError(null)
		const params = new URLSearchParams({
			orgSlug,
			pageTokens: JSON.stringify(requestTokens),
		})
		if (activePlatform !== 'all') {
			params.set('provider', activePlatform)
		}
		void fetch(`/resources/mailbox/reviews?${params}`, {
			signal: controller.signal,
		})
			.then(async (response) => {
				const payload: unknown = await response.json().catch(() => null)
				if (!response.ok) {
					const parsed = z.object({ error: z.string() }).safeParse(payload)
					throw new Error(
						parsed.success
							? parsed.data.error
							: _(msg`Unable to load reviews.`),
					)
				}
				return responseSchema.parse(payload)
			})
			.then((result) => {
				if (controller.signal.aborted) return
				setReviews(result.reviews)
				setTotalReviewCount(result.totalReviewCount)
				setNextPageTokens(result.nextPageTokens)
				setSelected((current) =>
					current
						? (result.reviews.find((review) => review.name === current.name) ??
							current)
						: null,
				)
			})
			.catch((cause: unknown) => {
				if (!controller.signal.aborted)
					setError(
						cause instanceof Error
							? cause.message
							: _(msg`Unable to load reviews.`),
					)
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false)
			})
		return () => controller.abort()
	}, [orgSlug, requestTokens, activePlatform, revision, _])

	useEffect(() => {
		const refresh = () => setRevision((value) => value + 1)
		window.addEventListener('focus', refresh)
		const timer = window.setInterval(() => {
			if (document.visibilityState === 'visible') refresh()
		}, 60000)
		return () => {
			window.removeEventListener('focus', refresh)
			window.clearInterval(timer)
			abortRef.current?.abort()
			draftAbortRef.current?.abort()
		}
	}, [])

	const generateDraft = async () => {
		if (!selected || !aiAvailable || drafting || sending || draft.trim()) return
		const review = selected
		const controller = new AbortController()
		draftAbortRef.current?.abort()
		draftAbortRef.current = controller
		setDrafting(true)
		setDraftError(null)
		try {
			const payload = await request('/reviews/draft', {
				method: 'POST',
				body: JSON.stringify({
					location: review.locationName,
					reviewer: review.reviewer?.displayName ?? '',
					starRating: review.starRating,
					review: review.comment ?? '',
					notes: notesByReview[review.name] ?? '',
					platform: review.providerDisplayName,
				}),
				signal: controller.signal,
			})
			const result = z.object({ reply: z.string().min(1) }).parse(payload)
			if (!controller.signal.aborted)
				setDrafts((current) => ({ ...current, [review.name]: result.reply }))
		} catch (cause) {
			if (!controller.signal.aborted)
				setDraftError(
					cause instanceof Error
						? cause.message
						: _(msg`Could not create a reply suggestion. Try again.`),
				)
		} finally {
			if (draftAbortRef.current === controller) {
				draftAbortRef.current = null
				setDrafting(false)
			}
		}
	}

	const postReply = async () => {
		if (!selected || !draft.trim() || sending) return
		setSending(true)
		setSendError(null)
		try {
			const response = await fetch('/resources/mailbox/reviews', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Accept: 'application/json',
				},
				body: JSON.stringify({
					orgSlug,
					locationId: selected.locationId,
					provider: selected.provider,
					reviewName: selected.name,
					comment: draft,
				}),
			})
			const payload: unknown = await response.json().catch(() => null)
			if (!response.ok) {
				const parsed = z.object({ error: z.string() }).safeParse(payload)
				throw new Error(
					parsed.success
						? parsed.data.error
						: _(msg`Could not post your reply.`),
				)
			}
			const reply = z
				.object({ comment: z.string(), updateTime: z.string().optional() })
				.parse(payload)
			setReviews((current) =>
				current.map((review) =>
					review.name === selected.name
						? { ...review, reviewReply: reply }
						: review,
				),
			)
			setSelected((current) =>
				current?.name === selected.name
					? { ...current, reviewReply: reply }
					: current,
			)
			setDrafts((current) => ({ ...current, [selected.name]: '' }))
			setRevision((value) => value + 1)
		} catch (cause) {
			setSendError(
				cause instanceof Error
					? cause.message
					: _(msg`Could not post your reply.`),
			)
		} finally {
			setSending(false)
		}
	}

	const hasMore = Object.values(nextPageTokens).some(Boolean)

	return (
		<div className="bg-background flex min-h-0 flex-1 overflow-hidden">
			<section
				aria-label={_(msg`Customer reviews`)}
				className={cn(
					'flex min-h-0 w-full shrink-0 flex-col border-e md:w-80 lg:w-96',
					selected && 'hidden md:flex',
				)}
			>
				{/* Header & Refresh */}
				<div className="flex items-center justify-between gap-3 border-b px-4 py-3">
					<p className="text-muted-foreground text-xs tabular-nums">
						{totalReviewCount} <Trans>reviews</Trans>
					</p>
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label={_(msg`Refresh reviews`)}
						onClick={() => setRevision((value) => value + 1)}
						disabled={loading}
					>
						<Icon name="refresh-cw" />
					</Button>
				</div>

				{/* Platform Filter Tabs */}
				<div className="flex scrollbar-none items-center gap-1 overflow-x-auto border-b px-3 py-2">
					{PLATFORM_FILTERS.map((filter) => {
						const isSelected = activePlatform === filter.id
						return (
							<button
								key={filter.id}
								type="button"
								onClick={() => {
									setActivePlatform(filter.id)
									setRequestTokens({})
									setPreviousPages([])
								}}
								className={cn(
									'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors',
									isSelected
										? 'bg-primary text-primary-foreground shadow-sm'
										: 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
								)}
							>
								{filter.icon ? (
									<Icon name={filter.icon} className="size-3" />
								) : null}
								{_(filter.label)}
							</button>
						)
					})}
				</div>

				{/* Review List */}
				<ScrollArea className="min-h-0 flex-1" aria-busy={loading}>
					{loading && reviews.length === 0 ? (
						<div
							className="space-y-6 p-5"
							role="status"
							aria-label={_(msg`Loading reviews`)}
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
					) : reviews.length === 0 ? (
						<div className="flex flex-col items-center px-6 py-16 text-center">
							<MailboxIcon size={32} className="text-muted-foreground mb-4" />
							<h2 className="font-medium">
								{totalReviewCount === 0 ? (
									<Trans>No reviews connected yet</Trans>
								) : (
									<Trans>No reviews found</Trans>
								)}
							</h2>
							<p className="text-muted-foreground mt-2 text-sm leading-relaxed">
								{totalReviewCount === 0 ? (
									<Trans>
										Connect Google, Yelp, TripAdvisor, Deliveroo, Just Eat, or
										OpenTable in Settings to view and reply to customer reviews
										here.
									</Trans>
								) : (
									<Trans>No reviews match the selected filter.</Trans>
								)}
							</p>
							{totalReviewCount === 0 ? (
								<Button
									render={<Link to={`/${orgSlug}/settings/integrations`} />}
									variant="outline"
									size="sm"
									className="mt-4"
								>
									<Trans>Manage integrations</Trans>
								</Button>
							) : null}
						</div>
					) : (
						<ul className="divide-y">
							{reviews.map((review) => {
								const rating = ratingValue(review.starRating)
								const author =
									review.reviewer?.displayName || _(msg`Anonymous diner`)
								const icon = getPlatformIcon(review.provider)
								return (
									<li key={review.name}>
										<button
											type="button"
											className={cn(
												'hover:bg-muted/50 focus-visible:ring-ring w-full px-4 py-4 text-start focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
												selected?.name === review.name && 'bg-muted',
											)}
											aria-pressed={selected?.name === review.name}
											onClick={() => {
												setSelected(review)
												setSendError(null)
											}}
										>
											<div className="flex items-start justify-between gap-2">
												<div className="flex min-w-0 items-center gap-1.5">
													<Icon name={icon} className="size-3.5 shrink-0" />
													<span className="min-w-0 truncate text-sm font-semibold">
														{author}
													</span>
												</div>
												<span className="text-muted-foreground shrink-0 text-xs tabular-nums">
													{localDate(review.updateTime ?? review.createTime)}
												</span>
											</div>
											<div className="mt-1 flex items-center gap-2">
												<Badge
													variant="secondary"
													className="gap-1 text-[10px]"
												>
													{rating ? (
														<Trans>{rating} / 5</Trans>
													) : (
														<Trans>Rated</Trans>
													)}
												</Badge>
												<span className="text-muted-foreground truncate text-xs">
													{review.locationName}
												</span>
												<span className="ms-auto shrink-0">
													{review.reviewReply ? (
														<Icon
															name="check-circle"
															className="text-muted-foreground size-4"
															aria-label={_(msg`Replied`)}
														/>
													) : (
														<span
															className="bg-primary block size-1.5 rounded-full"
															aria-label={_(msg`Needs reply`)}
														/>
													)}
												</span>
											</div>
											<p className="text-muted-foreground mt-2 line-clamp-2 text-sm leading-relaxed">
												{review.comment || _(msg`No written comment`)}
											</p>
										</button>
									</li>
								)
							})}
						</ul>
					)}
				</ScrollArea>

				{/* Pagination Controls */}
				{reviews.length > 0 ? (
					<div className="flex items-center justify-between border-t p-3">
						<Button
							variant="ghost"
							size="sm"
							disabled={previousPages.length === 0 || loading}
							onClick={() => {
								const previous = previousPages.at(-1) ?? {}
								setPreviousPages((current) => current.slice(0, -1))
								setRequestTokens(previous)
							}}
						>
							{_(msg`Newer`)}
						</Button>
						<span className="text-muted-foreground text-xs tabular-nums">
							<Trans>Page {pageNumber}</Trans>
						</span>
						<Button
							variant="ghost"
							size="sm"
							disabled={!hasMore || loading}
							onClick={() => {
								setPreviousPages((current) => [...current, requestTokens])
								setRequestTokens(nextPageTokens)
							}}
						>
							{_(msg`Older`)}
						</Button>
					</div>
				) : null}
			</section>

			{/* Review Details and Composer */}
			{selected ? (
				<section
					aria-label={_(msg`Review details`)}
					className="flex min-h-0 min-w-0 flex-1 flex-col"
				>
					<header className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
						<div className="flex min-w-0 items-center gap-2">
							<Button
								variant="ghost"
								size="icon-sm"
								className="md:hidden"
								aria-label={_(msg`Back to reviews`)}
								onClick={() => setSelected(null)}
							>
								<Icon name="arrow-left" className="rtl:rotate-180" />
							</Button>
							<Icon
								name={getPlatformIcon(selected.provider)}
								className="size-4 shrink-0"
							/>
							<span className="text-muted-foreground text-xs font-medium tracking-wider uppercase">
								{selected.providerDisplayName}
							</span>
							<span className="text-muted-foreground">·</span>
							<h2 className="truncate text-sm font-medium">
								{selected.locationName}
							</h2>
						</div>
						<div className="flex items-center gap-2">
							{selected.externalUrl ? (
								<Button
									variant="outline"
									size="sm"
									render={
										<a
											href={selected.externalUrl}
											target="_blank"
											rel="noopener noreferrer"
										/>
									}
								>
									<Icon name="external-link" />
									<Trans>Open on {selected.providerDisplayName}</Trans>
								</Button>
							) : null}
							<Button
								variant="ghost"
								size="sm"
								disabled={loading}
								onClick={() => setRevision((value) => value + 1)}
							>
								<Icon name="refresh-cw" />
								<Trans>Refresh</Trans>
							</Button>
						</div>
					</header>

					<ScrollArea className="min-h-0 flex-1">
						<div className="px-5 py-6 md:px-7">
							{sendError ? (
								<p role="alert" className="text-destructive mb-4 text-sm">
									{sendError}
								</p>
							) : null}
							<div className="mb-7">
								<h3 className="text-lg font-semibold">
									{selected.reviewer?.displayName || _(msg`Anonymous diner`)}
								</h3>
								<div className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
									<span>{localDate(selected.createTime)}</span>
									{selectedRating ? (
										<Badge variant="secondary">
											<Trans>{selectedRating} / 5 stars</Trans>
										</Badge>
									) : null}
								</div>
							</div>
							<div className="space-y-3">
								<h4 className="text-sm font-medium">
									<Trans>Review</Trans>
								</h4>
								<p className="text-sm leading-relaxed whitespace-pre-wrap">
									{selected.comment || _(msg`No written comment`)}
								</p>
							</div>
							{selected.reviewReply ? (
								<div className="mt-8 border-t pt-6">
									<h4 className="text-sm font-medium">
										<Trans>Your reply</Trans>
									</h4>
									<p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap">
										{selected.reviewReply.comment}
									</p>
									<p className="text-muted-foreground mt-2 text-xs">
										<Trans>Posted {selectedReplyDate}</Trans>
									</p>
								</div>
							) : null}
						</div>
					</ScrollArea>

					{/* Composer */}
					<div className="space-y-3 border-t p-4">
						{draftError ? (
							<p role="alert" className="text-destructive text-sm">
								{draftError}
							</p>
						) : null}
						<label htmlFor="review-reply-input" className="sr-only">
							<Trans>Reply to review</Trans>
						</label>
						<InputGroup>
							<InputGroupTextarea
								id="review-reply-input"
								placeholder={_(msg`Write a response to this review…`)}
								value={draft}
								maxLength={4096}
								onChange={(event) =>
									setDrafts((current) => ({
										...current,
										[selected.name]: event.target.value,
									}))
								}
								disabled={sending || drafting}
							/>
							<InputGroupAddon
								align="block-end"
								className="flex-wrap justify-between gap-1"
							>
								<Button
									variant="ghost"
									size="sm"
									disabled={
										aiStatusLoading ||
										!aiAvailable ||
										drafting ||
										sending ||
										Boolean(draft.trim())
									}
									onClick={() => void generateDraft()}
								>
									<Icon name="sparkles" />
									{drafting ? (
										<Trans>Drafting…</Trans>
									) : (
										<Trans>Draft with AI</Trans>
									)}
								</Button>
								{draft ? (
									<Button
										variant="ghost"
										size="icon"
										aria-label={_(msg`Clear draft`)}
										title={_(msg`Clear draft`)}
										disabled={sending || drafting}
										onClick={() => {
											setDraftError(null)
											setDrafts((current) => ({
												...current,
												[selected.name]: '',
											}))
										}}
									>
										<Icon name="x" />
									</Button>
								) : null}
								<span className="text-muted-foreground ms-auto text-xs tabular-nums">
									{draft.length} / 4096
								</span>
								<Button
									size="sm"
									onClick={() => void postReply()}
									disabled={!draft.trim() || sending}
								>
									{sending ? (
										<Trans>Saving…</Trans>
									) : selected.reviewReply ? (
										<Trans>Update reply</Trans>
									) : (
										<Trans>Post reply</Trans>
									)}
									<Icon name="send" />
								</Button>
							</InputGroupAddon>
						</InputGroup>
						{!aiStatusLoading && !aiAvailable ? (
							<p className="text-muted-foreground text-xs">
								<Trans>AI drafting hasn’t been enabled for this mailbox.</Trans>
							</p>
						) : (
							<details>
								<summary className="text-muted-foreground cursor-pointer text-xs">
									<Trans>Notes for AI</Trans>
								</summary>
								<Label htmlFor="review-ai-notes" className="sr-only">
									<Trans>Notes for AI</Trans>
								</Label>
								<InputGroup className="mt-2">
									<InputGroupTextarea
										id="review-ai-notes"
										rows={2}
										maxLength={2000}
										value={aiNotes}
										disabled={drafting || sending}
										onChange={(event) =>
											setNotesByReview((current) => ({
												...current,
												[selected.name]: event.target.value,
											}))
										}
										placeholder={_(
											msg`What should your reply include? (optional)`,
										)}
									/>
								</InputGroup>
							</details>
						)}
					</div>
				</section>
			) : (
				<div className="hidden min-w-0 flex-1 flex-col items-center justify-center px-8 py-20 text-center md:flex">
					<MailboxIcon size={36} className="text-muted-foreground mb-5" />
					<h2 className="text-lg font-medium">
						<Trans>Every review, in one place</Trans>
					</h2>
					<p className="text-muted-foreground mt-2 max-w-xs text-sm leading-relaxed">
						<Trans>Select a review to read it and post a reply.</Trans>
					</p>
				</div>
			)}
		</div>
	)
}

export const GoogleReviewsTab = ReviewsTab

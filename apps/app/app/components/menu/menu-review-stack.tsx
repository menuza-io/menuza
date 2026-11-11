import { Plural, Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	getSiteLocaleDirection,
	getSiteLocaleNativeLabel,
} from '@repo/common/site-locales'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Switch } from '@repo/ui/switch'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'
import { showUndoToast } from '#app/components/undo-toast.ts'
import {
	type MenuSuggestion,
	type MenuSuggestionBatch,
	type MenuTextChange,
} from '#app/utils/menu/menu-suggestions.ts'

/** Load the next batch when this few cards are left. */
const PREFETCH_AT = 2
/** The progress bar shows at most this many segments. */
const MAX_SEGMENTS = 12

type Availability = {
	availabilityStatus: string
	unavailableUntil: string | null
}

type Reply =
	| { ok: true; batch: MenuSuggestionBatch }
	| { ok: true; results: Array<{ itemId: string; previous: MenuTextChange[] }> }
	| { ok: true; previous: Availability & { updatedAt?: string } }
	| { ok: true; enabled: boolean }

class SuggestionRequestError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
	) {
		super(code)
	}
}

async function postSuggestions<T extends Reply>(
	orgSlug: string,
	body: Record<string, unknown>,
): Promise<T> {
	const response = await fetch(`/${orgSlug}/menu/suggestions`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	})
	const json = (await response.json().catch(() => null)) as
		(T & { ok: true }) | { ok: false; error?: string } | null
	if (!response.ok || !json || !json.ok) {
		throw new SuggestionRequestError(
			(json && !json.ok && json.error) || 'failed',
			response.status,
		)
	}
	return json
}

export type MenuReviewProps = {
	orgSlug: string
	open: boolean
	onOpenChange: (open: boolean) => void
	/** Languages other than the menu's own; empty hides the toggle. */
	translationLocales: string[]
	autoTranslate: boolean
	/** Called after the stack closed with at least one change saved. */
	onChanged?: () => void
}

function translationChanges(
	suggestion: Extract<MenuSuggestion, { kind: 'translation' }>,
): MenuTextChange[] {
	const changes: MenuTextChange[] = []
	if (suggestion.name) {
		changes.push({
			field: 'displayName',
			locale: suggestion.locale,
			value: suggestion.name,
		})
	}
	if (suggestion.description) {
		changes.push({
			field: 'description',
			locale: suggestion.locale,
			value: suggestion.description,
		})
	}
	return changes
}

/**
 * Review suggestions: one card at a time with Accept and Skip. Opening it is
 * what generates suggestions (about 10 per request). Accept saves through the
 * menu's update path and offers Undo; Skip records nothing.
 */
export function MenuReviewStack({
	orgSlug,
	open,
	onOpenChange,
	translationLocales,
	autoTranslate,
	onChanged,
}: MenuReviewProps) {
	const { _ } = useLingui()
	const [queue, setQueue] = useState<MenuSuggestion[]>([])
	const [seen, setSeen] = useState<string[]>([])
	const [total, setTotal] = useState<number | null>(null)
	const [remaining, setRemaining] = useState(0)
	const [reviewed, setReviewed] = useState(0)
	const [loading, setLoading] = useState(false)
	const [error, setError] = useState<'rate_limited' | 'failed' | null>(null)
	const [aiUnavailable, setAiUnavailable] = useState(false)
	const [busy, setBusy] = useState(false)
	const [confirmAll, setConfirmAll] = useState(false)
	const [autoOn, setAutoOn] = useState(autoTranslate)
	const changedRef = useRef(false)
	const cardRef = useRef<HTMLDivElement>(null)
	const requested = useRef(false)

	useEffect(() => setAutoOn(autoTranslate), [autoTranslate])

	const loadBatch = useCallback(
		async (seenIds: string[]) => {
			setLoading(true)
			setError(null)
			try {
				const reply = await postSuggestions<{
					ok: true
					batch: MenuSuggestionBatch
				}>(orgSlug, { intent: 'generate', seen: seenIds })
				const batch = reply.batch
				setQueue((current) => [
					...current,
					...batch.suggestions.filter(
						(suggestion) => !current.some((card) => card.id === suggestion.id),
					),
				])
				setSeen((current) => [...current, ...batch.considered])
				setRemaining(batch.remaining)
				setTotal((current) => current ?? batch.total)
				if (batch.aiUnavailable) setAiUnavailable(true)
			} catch (caught) {
				setError(
					caught instanceof SuggestionRequestError &&
						caught.code === 'rate_limited'
						? 'rate_limited'
						: 'failed',
				)
			} finally {
				setLoading(false)
			}
		},
		[orgSlug],
	)

	// Nothing is generated until the stack opens.
	useEffect(() => {
		if (!open || requested.current) return
		requested.current = true
		void loadBatch([])
	}, [open, loadBatch])

	// Fetch ahead while the last cards are on screen.
	useEffect(() => {
		if (!open || loading || error) return
		if (queue.length <= PREFETCH_AT && remaining > 0 && requested.current) {
			void loadBatch(seen)
		}
	}, [open, loading, error, queue.length, remaining, seen, loadBatch])

	const current = queue[0] ?? null
	const currentId = current?.id

	// Move focus to the next card so keyboard users stay in the stack.
	useEffect(() => {
		if (open && currentId) cardRef.current?.focus({ preventScroll: true })
	}, [open, currentId])

	function handleOpenChange(next: boolean) {
		onOpenChange(next)
		if (!next) {
			setConfirmAll(false)
			if (changedRef.current) {
				changedRef.current = false
				onChanged?.()
			}
		}
	}

	function advance(count = 1) {
		setQueue((cards) => cards.slice(count))
		setReviewed((value) => value + count)
	}

	/** Put a card back on top after its Undo. */
	function restore(suggestions: MenuSuggestion[]) {
		setQueue((cards) => [
			...suggestions,
			...cards.filter((card) => !suggestions.some((s) => s.id === card.id)),
		])
		setReviewed((value) => Math.max(0, value - suggestions.length))
	}

	const failedMessage = _(t`Couldn't undo. Reload the page and try again.`)

	async function run<T>(work: () => Promise<T>): Promise<T | null> {
		setBusy(true)
		try {
			const result = await work()
			changedRef.current = true
			return result
		} catch (caught) {
			toast.error(
				caught instanceof SuggestionRequestError && caught.status === 429
					? _(t`Too many changes at once. Wait a minute and try again.`)
					: _(t`Couldn't save that change. Try again.`),
			)
			return null
		} finally {
			setBusy(false)
		}
	}

	async function acceptText(
		suggestion: Extract<
			MenuSuggestion,
			{ kind: 'translation' | 'description' }
		>,
	) {
		const changes =
			suggestion.kind === 'translation'
				? translationChanges(suggestion)
				: [
						{
							field: 'description' as const,
							locale: suggestion.locale,
							value: suggestion.description,
						},
					]
		const reply = await run(() =>
			postSuggestions<{
				ok: true
				results: Array<{ itemId: string; previous: MenuTextChange[] }>
			}>(orgSlug, {
				intent: 'set-text',
				reason: suggestion.kind,
				itemId: suggestion.itemId,
				changes,
			}),
		)
		if (!reply) return
		advance()
		const previous = reply.results[0]?.previous ?? []
		const dishName = suggestion.dishName
		showUndoToast({
			message:
				suggestion.kind === 'translation'
					? _(t`Translation saved for ${dishName}`)
					: _(t`Description saved for ${dishName}`),
			undoLabel: _(t`Undo`),
			undoneMessage: _(t`Change undone`),
			failedMessage,
			onUndo: async () => {
				await postSuggestions(orgSlug, {
					intent: 'set-text',
					reason: 'undo',
					itemId: suggestion.itemId,
					changes: previous,
				})
				restore([suggestion])
			},
		})
	}

	async function acceptAllTranslations() {
		const translations = queue.filter(
			(card): card is Extract<MenuSuggestion, { kind: 'translation' }> =>
				card.kind === 'translation',
		)
		if (translations.length === 0) return
		setConfirmAll(false)
		const reply = await run(() =>
			postSuggestions<{
				ok: true
				results: Array<{ itemId: string; previous: MenuTextChange[] }>
			}>(orgSlug, {
				intent: 'set-text-bulk',
				reason: 'translation',
				entries: translations.map((card) => ({
					itemId: card.itemId,
					changes: translationChanges(card),
				})),
			}),
		)
		if (!reply) return
		const ids = new Set(translations.map((card) => card.id))
		setQueue((cards) => cards.filter((card) => !ids.has(card.id)))
		setReviewed((value) => value + translations.length)
		const count = translations.length
		showUndoToast({
			message: _(
				plural(count, {
					one: '# translation saved',
					other: '# translations saved',
				}),
			),
			undoLabel: _(t`Undo`),
			undoneMessage: _(t`Change undone`),
			failedMessage,
			onUndo: async () => {
				await postSuggestions(orgSlug, {
					intent: 'set-text-bulk',
					reason: 'undo',
					entries: reply.results.map((result) => ({
						itemId: result.itemId,
						changes: result.previous,
					})),
				})
				restore(translations)
			},
		})
	}

	async function setItemAvailability(
		suggestion: Extract<MenuSuggestion, { kind: 'long_unavailable' }>,
		target: 'available' | 'hidden',
	) {
		const reply = await run(() =>
			postSuggestions<{
				ok: true
				previous: Availability & { updatedAt: string }
			}>(orgSlug, {
				intent: 'set-item-availability',
				reason: target === 'hidden' ? 'hide' : 'make_available',
				itemId: suggestion.itemId,
				availability: { availabilityStatus: target, unavailableUntil: null },
			}),
		)
		if (!reply) return
		advance()
		const dishName = suggestion.dishName
		showUndoToast({
			message:
				target === 'hidden'
					? _(t`${dishName} is hidden from your menu`)
					: _(t`${dishName} is available again`),
			undoLabel: _(t`Undo`),
			undoneMessage: _(t`Change undone`),
			failedMessage,
			onUndo: async () => {
				await postSuggestions(orgSlug, {
					intent: 'set-item-availability',
					reason: 'undo',
					itemId: suggestion.itemId,
					availability: {
						availabilityStatus: reply.previous.availabilityStatus,
						unavailableUntil: reply.previous.unavailableUntil,
					},
					restoreUpdatedAt: reply.previous.updatedAt,
				})
				restore([suggestion])
			},
		})
	}

	async function hideCategory(
		suggestion: Extract<MenuSuggestion, { kind: 'empty_category' }>,
	) {
		const reply = await run(() =>
			postSuggestions<{ ok: true; previous: Availability }>(orgSlug, {
				intent: 'set-category-availability',
				reason: 'hide',
				categoryId: suggestion.categoryId,
				availability: { availabilityStatus: 'hidden', unavailableUntil: null },
			}),
		)
		if (!reply) return
		advance()
		const categoryName = suggestion.categoryName
		showUndoToast({
			message: _(t`${categoryName} is hidden from your menu`),
			undoLabel: _(t`Undo`),
			undoneMessage: _(t`Change undone`),
			failedMessage,
			onUndo: async () => {
				await postSuggestions(orgSlug, {
					intent: 'set-category-availability',
					reason: 'undo',
					categoryId: suggestion.categoryId,
					availability: reply.previous,
				})
				restore([suggestion])
			},
		})
	}

	async function toggleAutoTranslate(next: boolean) {
		setAutoOn(next)
		try {
			await postSuggestions(orgSlug, {
				intent: 'set-auto-translate',
				enabled: next,
			})
			changedRef.current = true
		} catch {
			setAutoOn(!next)
			toast.error(_(t`Couldn't save that setting. Try again.`))
		}
	}

	const pendingTranslations = queue.filter(
		(card) => card.kind === 'translation',
	).length
	const knownTotal = Math.max(total ?? 0, reviewed + queue.length)
	const finished =
		!loading &&
		!error &&
		total !== null &&
		queue.length === 0 &&
		remaining === 0

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="gap-5 sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Review suggestions</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Accept what looks right and skip the rest. Nothing changes until
							you accept.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{knownTotal > 0 ? (
					<ReviewProgress reviewed={reviewed} total={knownTotal} />
				) : null}

				<div aria-live="polite" className="sr-only">
					{current ? <SuggestionTitle suggestion={current} /> : null}
				</div>

				{error ? (
					<div className="flex flex-col items-start gap-3 rounded-xl border p-4">
						<p className="text-sm">
							{error === 'rate_limited' ? (
								<Trans>
									You've asked for a lot of suggestions this hour. Try again
									later.
								</Trans>
							) : (
								<Trans>Couldn't load suggestions.</Trans>
							)}
						</p>
						{error === 'failed' ? (
							<Button
								variant="outline"
								size="sm"
								onClick={() => void loadBatch(seen)}
							>
								<Trans>Try again</Trans>
							</Button>
						) : null}
					</div>
				) : current ? (
					<div className="relative pb-3">
						{/* The cards waiting behind this one. */}
						{queue.length > 2 ? (
							<div
								aria-hidden
								className="bg-card absolute inset-x-6 -bottom-1 h-8 rounded-xl border opacity-60"
							/>
						) : null}
						{queue.length > 1 ? (
							<div
								aria-hidden
								className="bg-card absolute inset-x-3 bottom-1 h-8 rounded-xl border opacity-80"
							/>
						) : null}
						<SuggestionCard
							key={current.id}
							ref={cardRef}
							suggestion={current}
							busy={busy}
							onSkip={() => advance()}
							onAcceptText={(suggestion) => void acceptText(suggestion)}
							onItemAvailability={(suggestion, target) =>
								void setItemAvailability(suggestion, target)
							}
							onHideCategory={(suggestion) => void hideCategory(suggestion)}
						/>
					</div>
				) : loading ? (
					<div className="space-y-3 rounded-xl border p-4" aria-busy>
						<span className="sr-only">
							<Trans>Preparing suggestions…</Trans>
						</span>
						<div className="flex items-center gap-3">
							<Skeleton className="size-12 rounded-lg" />
							<Skeleton className="h-4 w-40" />
						</div>
						<Skeleton className="h-16 w-full rounded-lg" />
						<Skeleton className="h-3 w-56" />
					</div>
				) : finished ? (
					<div className="flex flex-col items-center gap-2 rounded-xl border p-6 text-center">
						<Icon name="circle-check" className="text-success size-6" />
						<p className="text-sm font-medium">
							{reviewed > 0 ? (
								<Trans>All reviewed. Nice work.</Trans>
							) : (
								<Trans>Nothing to suggest right now.</Trans>
							)}
						</p>
						<Button
							variant="outline"
							size="sm"
							onClick={() => handleOpenChange(false)}
						>
							<Trans>Done</Trans>
						</Button>
					</div>
				) : null}

				{aiUnavailable && !error ? (
					<p className="text-muted-foreground text-xs">
						<Trans>
							Some suggestions couldn't be written right now, so they were left
							out.
						</Trans>
					</p>
				) : null}

				{pendingTranslations > 1 && !error ? (
					confirmAll ? (
						<div
							role="group"
							aria-label={_(t`Confirm accepting all translations`)}
							className="flex flex-col gap-3 rounded-xl border p-3"
						>
							<p className="text-sm">
								<Plural
									value={pendingTranslations}
									one="Save # translation without reviewing it? You can undo it right after."
									other="Save # translations without reviewing each one? You can undo them right after."
								/>
							</p>
							<div className="flex justify-end gap-2">
								<Button
									variant="outline"
									size="sm"
									onClick={() => setConfirmAll(false)}
								>
									<Trans>Cancel</Trans>
								</Button>
								<Button
									size="sm"
									disabled={busy}
									onClick={() => void acceptAllTranslations()}
								>
									<Plural
										value={pendingTranslations}
										one="Save # translation"
										other="Save # translations"
									/>
								</Button>
							</div>
						</div>
					) : (
						<Button
							variant="ghost"
							size="sm"
							className="self-start"
							disabled={busy}
							onClick={() => setConfirmAll(true)}
						>
							<Icon name="languages" className="size-4" />
							<Plural
								value={pendingTranslations}
								one="Accept # translation"
								other="Accept all # translations"
							/>
						</Button>
					)
				) : null}

				{translationLocales.length > 0 ? (
					<AutoTranslateRow
						checked={autoOn}
						onCheckedChange={(next) => void toggleAutoTranslate(next)}
						translationLocales={translationLocales}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	)
}

function ReviewProgress({
	reviewed,
	total,
}: {
	reviewed: number
	total: number
}) {
	const { _ } = useLingui()
	const segments = Math.max(1, Math.min(total, MAX_SEGMENTS))
	const filled =
		total === 0
			? 0
			: Math.min(segments, Math.round((reviewed / total) * segments))
	const shown = Math.min(reviewed, total)
	return (
		<div className="space-y-2">
			<p className="text-muted-foreground text-xs tabular-nums">
				<Trans>
					{shown} of {total} reviewed
				</Trans>
			</p>
			{/* A flex row follows the page direction, so it fills from the right in Arabic. */}
			<div
				role="progressbar"
				aria-label={_(t`Suggestions reviewed`)}
				aria-valuemin={0}
				aria-valuemax={total}
				aria-valuenow={shown}
				className="flex gap-1"
			>
				{Array.from({ length: segments }, (_unused, index) => (
					<span
						key={index}
						className={
							index < filled
								? 'bg-primary h-1.5 flex-1 rounded-full transition-colors duration-200 motion-reduce:transition-none'
								: 'bg-muted h-1.5 flex-1 rounded-full transition-colors duration-200 motion-reduce:transition-none'
						}
					/>
				))}
			</div>
		</div>
	)
}

function SuggestionTitle({ suggestion }: { suggestion: MenuSuggestion }) {
	return suggestion.kind === 'empty_category' ? (
		<>{suggestion.categoryName}</>
	) : (
		<>{suggestion.dishName}</>
	)
}

function SuggestionReason({ suggestion }: { suggestion: MenuSuggestion }) {
	switch (suggestion.kind) {
		case 'translation': {
			const language = getSiteLocaleNativeLabel(suggestion.sourceLocale)
			return (
				<Trans>
					Machine translation from {language}. Check it reads right.
				</Trans>
			)
		}
		case 'description': {
			const examples = suggestion.styleExamples
			return examples > 0 ? (
				<Plural
					value={examples}
					one="Same style as your other description"
					other="Same style as your other # descriptions"
				/>
			) : (
				<Trans>Written from the dish name, category and options.</Trans>
			)
		}
		case 'empty_category':
			return (
				<Trans>
					No dishes in this category. Hiding it keeps it off your menu; you can
					show it again from Categories.
				</Trans>
			)
		case 'long_unavailable': {
			const days = suggestion.days
			return (
				<Plural
					value={days}
					one="Unavailable for # day. Guests can't order it."
					other="Unavailable for # days. Guests can't order it."
				/>
			)
		}
	}
}

function SuggestedLabel({ suggestion }: { suggestion: MenuSuggestion }) {
	switch (suggestion.kind) {
		case 'translation': {
			const language = getSiteLocaleNativeLabel(suggestion.locale)
			return <Trans>Suggested translation ({language})</Trans>
		}
		case 'description':
			return <Trans>Suggested description</Trans>
		case 'empty_category':
			return <Trans>Suggested change</Trans>
		case 'long_unavailable':
			return <Trans>Suggested change</Trans>
	}
}

function SuggestedValue({ suggestion }: { suggestion: MenuSuggestion }) {
	switch (suggestion.kind) {
		case 'translation': {
			const dir = getSiteLocaleDirection(suggestion.locale)
			return (
				<div lang={suggestion.locale} dir={dir} className="space-y-1">
					{suggestion.name ? (
						<p className="font-medium">{suggestion.name}</p>
					) : null}
					{suggestion.description ? (
						<p className="text-muted-foreground">{suggestion.description}</p>
					) : null}
				</div>
			)
		}
		case 'description':
			return <p>{suggestion.description}</p>
		case 'empty_category':
			return (
				<p>
					<Trans>Hide this empty category from your menu</Trans>
				</p>
			)
		case 'long_unavailable':
			return (
				<p>
					<Trans>Make it available again, or hide it from your menu</Trans>
				</p>
			)
	}
}

function SuggestionCard({
	suggestion,
	busy,
	onSkip,
	onAcceptText,
	onItemAvailability,
	onHideCategory,
	ref,
}: {
	suggestion: MenuSuggestion
	busy: boolean
	onSkip: () => void
	onAcceptText: (
		suggestion: Extract<
			MenuSuggestion,
			{ kind: 'translation' | 'description' }
		>,
	) => void
	onItemAvailability: (
		suggestion: Extract<MenuSuggestion, { kind: 'long_unavailable' }>,
		target: 'available' | 'hidden',
	) => void
	onHideCategory: (
		suggestion: Extract<MenuSuggestion, { kind: 'empty_category' }>,
	) => void
	ref: React.Ref<HTMLDivElement>
}) {
	const titleId = useId()
	const imageUrl =
		suggestion.kind === 'empty_category' ? null : suggestion.imageUrl
	return (
		<div
			ref={ref}
			tabIndex={-1}
			role="group"
			aria-labelledby={titleId}
			className="bg-card animate-in fade-in-0 slide-in-from-bottom-2 relative space-y-4 rounded-xl border p-4 shadow-sm duration-200 outline-none focus-visible:ring-2 motion-reduce:animate-none"
		>
			<div className="flex items-center gap-3">
				<div className="bg-muted flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border">
					{imageUrl ? (
						<img src={imageUrl} alt="" className="size-full object-cover" />
					) : (
						<Icon
							name={suggestion.kind === 'empty_category' ? 'folder' : 'image'}
							className="text-muted-foreground size-5"
						/>
					)}
				</div>
				<h3 id={titleId} className="min-w-0 truncate text-base font-semibold">
					<SuggestionTitle suggestion={suggestion} />
				</h3>
			</div>

			<div className="bg-muted/60 space-y-1.5 rounded-lg p-3 text-sm">
				<p className="text-muted-foreground text-xs font-medium">
					<SuggestedLabel suggestion={suggestion} />
				</p>
				<SuggestedValue suggestion={suggestion} />
			</div>

			<p className="text-muted-foreground text-xs">
				<SuggestionReason suggestion={suggestion} />
			</p>

			<div className="flex flex-wrap justify-end gap-2">
				<Button variant="outline" disabled={busy} onClick={onSkip}>
					<Trans>Skip</Trans>
				</Button>
				{suggestion.kind === 'long_unavailable' ? (
					<>
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => onItemAvailability(suggestion, 'hidden')}
						>
							<Trans>Hide from menu</Trans>
						</Button>
						<Button
							disabled={busy}
							onClick={() => onItemAvailability(suggestion, 'available')}
						>
							<Trans>Make available</Trans>
						</Button>
					</>
				) : suggestion.kind === 'empty_category' ? (
					<Button disabled={busy} onClick={() => onHideCategory(suggestion)}>
						<Trans>Hide category</Trans>
					</Button>
				) : (
					<Button disabled={busy} onClick={() => onAcceptText(suggestion)}>
						<Trans>Accept</Trans>
					</Button>
				)}
			</div>
		</div>
	)
}

function AutoTranslateRow({
	checked,
	onCheckedChange,
	translationLocales,
}: {
	checked: boolean
	onCheckedChange: (checked: boolean) => void
	translationLocales: string[]
}) {
	const labelId = useId()
	const helpId = useId()
	const onlyArabic =
		translationLocales.length === 1 && translationLocales[0] === 'ar'
	return (
		<div className="flex items-start justify-between gap-4 border-t pt-4">
			<div className="min-w-0 space-y-0.5">
				<p id={labelId} className="text-sm font-medium">
					{onlyArabic ? (
						<Trans>Translate new dishes into Arabic automatically</Trans>
					) : (
						<Trans>
							Translate new dishes into your other languages automatically
						</Trans>
					)}
				</p>
				<p id={helpId} className="text-muted-foreground text-xs">
					<Trans>We only ask when we're unsure</Trans>
				</p>
			</div>
			<Switch
				checked={checked}
				onCheckedChange={onCheckedChange}
				aria-labelledby={labelId}
				aria-describedby={helpId}
			/>
		</div>
	)
}

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
	CAPITAL_STYLES,
	type MenuCard,
	type MenuCardApplyInput,
	type MenuCardUndo,
} from '#app/utils/menu/menu-cards.ts'
import {
	isMenuCard,
	type MenuSuggestion,
	type MenuSuggestionBatch,
	type MenuTextChange,
	type MenuTextSuggestion,
} from '#app/utils/menu/menu-suggestions.ts'
import {
	CardSkipMenu,
	MenuReviewCardRow,
	MenuReviewCardView,
	cardKindTitle,
	cardNeedsInput,
	cardNeedsOwnReview,
	initialCardOptionId,
	type CardSkipChoice,
} from './menu-review-card.tsx'

/** Load the next batch when this few cards are left. */
const PREFETCH_AT = 2
/** The progress bar shows at most this many segments. */
const MAX_SEGMENTS = 12
/** Cards one bulk request may carry (the route's limit). */
const CARDS_PER_REQUEST = 20

type Availability = {
	availabilityStatus: string
	unavailableUntil: string | null
}

type Reply =
	| { ok: true; batch: MenuSuggestionBatch }
	| { ok: true; results: Array<{ itemId: string; previous: MenuTextChange[] }> }
	| { ok: true; previous: Availability & { updatedAt?: string } }
	| { ok: true; enabled: boolean }
	| { ok: true; undo: MenuCardUndo }
	| { ok: true; results: CardResult[] }
	| { ok: true; stored?: boolean }

type CardResult = {
	id: string
	ok: boolean
	undo?: MenuCardUndo
	stored?: boolean
	error?: string
}

type BulkReport = {
	accepted: number
	changed: number
	refused: number
	/** Cards that were never confirmed saved because a request failed. */
	notApplied: number
}

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
	suggestion: Extract<MenuTextSuggestion, { kind: 'translation' }>,
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
	const [selecting, setSelecting] = useState(false)
	const [selectedIds, setSelectedIds] = useState<string[]>([])
	const [report, setReport] = useState<BulkReport | null>(null)
	const changedRef = useRef(false)
	const openRef = useRef(open)
	const onChangedRef = useRef(onChanged)
	const headingRef = useRef<HTMLHeadingElement>(null)
	const selectRef = useRef<HTMLDivElement>(null)
	const wasSelectMode = useRef(false)
	const cardRef = useRef<HTMLDivElement>(null)
	const requested = useRef(false)

	useEffect(() => setAutoOn(autoTranslate), [autoTranslate])
	useEffect(() => {
		openRef.current = open
		onChangedRef.current = onChanged
	})

	/** A change was saved: tell the page at once when the dialog is closed. */
	function markChanged() {
		changedRef.current = true
		if (!openRef.current) {
			changedRef.current = false
			onChangedRef.current?.()
		}
	}


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

	// Focus must not be left on a control that just disappeared.
	const menuCardCount = queue.filter(isMenuCard).length
	const selectMode = selecting && menuCardCount > 0
	useEffect(() => {
		if (!open || selectMode === wasSelectMode.current) return
		wasSelectMode.current = selectMode
		const target = selectMode
			? selectRef.current
			: (cardRef.current ?? headingRef.current)
		target?.focus({ preventScroll: true })
	}, [open, selectMode])

	function handleOpenChange(next: boolean) {
		onOpenChange(next)
		if (!next) {
			setConfirmAll(false)
			setSelecting(false)
			setSelectedIds([])
			setReport(null)
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
		// The Undo toast outlives the dialog, so refresh the page right away.
		if (suggestions.length > 0) onChangedRef.current?.()
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
			markChanged()
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
			MenuTextSuggestion,
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
			(card): card is Extract<MenuTextSuggestion, { kind: 'translation' }> =>
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
		suggestion: Extract<MenuTextSuggestion, { kind: 'long_unavailable' }>,
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
		suggestion: Extract<MenuTextSuggestion, { kind: 'empty_category' }>,
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

	// --- Review cards (#92 structure, #234 polish) ---------------------------

	function cardErrorMessage(caught: unknown): string {
		if (caught instanceof SuggestionRequestError) {
			if (caught.code === 'stale_suggestion') {
				return _(t`This changed since the suggestion was made`)
			}
			if (caught.code === 'pos_owned') {
				return _(
					t`Your POS manages this, so it can't be changed here. Change it in your POS.`,
				)
			}
			if (caught.status === 429) {
				return _(t`Too many changes at once. Wait a minute and try again.`)
			}
		}
		return _(t`Couldn't save that change. Try again.`)
	}

	/** Take cards off the stack without a trip back (accepted, skipped or gone). */
	function drop(ids: string[]) {
		if (ids.length === 0) return
		const set = new Set(ids)
		setQueue((cards) => cards.filter((card) => !set.has(card.id)))
		setReviewed((value) => value + ids.length)
		setSelectedIds((current) => current.filter((id) => !set.has(id)))
	}

	/** The owner picks the capitals style once; later cards reuse it. */
	async function rememberCapitalStyle(card: MenuCard, optionId?: string) {
		if (card.kind !== 'capitals') return
		const code = card.options?.find((option) => option.id === optionId)?.code
		if (!code || !(CAPITAL_STYLES as readonly string[]).includes(code)) return
		try {
			await postSuggestions(orgSlug, {
				intent: 'set-card-setting',
				setting: { key: 'capitalStyle', value: code },
			})
		} catch {
			// The fix is saved; the style is only a convenience.
		}
	}

	function applyInput(
		card: MenuCard,
		optionId?: string,
		input?: string,
	): MenuCardApplyInput {
		return {
			kind: card.kind,
			id: card.id,
			refs: card.refs,
			params: card.params,
			...(optionId ? { optionId } : {}),
			...(input ? { input } : {}),
		}
	}

	async function acceptCard(
		card: MenuCard,
		optionId: string | undefined,
		input: string | undefined,
	) {
		setBusy(true)
		try {
			const reply = await postSuggestions<{ ok: true; undo: MenuCardUndo }>(
				orgSlug,
				{ intent: 'apply-card', card: applyInput(card, optionId, input) },
			)
			markChanged()
			await rememberCapitalStyle(card, optionId)
			advance()
			const title = cardKindTitle(_, card.kind)
			showUndoToast({
				message: _(t`Saved: ${title}`),
				undoLabel: _(t`Undo`),
				undoneMessage: _(t`Change undone`),
				failedMessage,
				onUndo: async () => {
					await postSuggestions(orgSlug, {
						intent: 'undo-card',
						undo: reply.undo,
					})
					restore([card])
				},
			})
		} catch (caught) {
			toast.error(cardErrorMessage(caught))
			if (
				caught instanceof SuggestionRequestError &&
				caught.code === 'stale_suggestion'
			) {
				drop([card.id])
			}
		} finally {
			setBusy(false)
		}
	}

	async function skipCard(card: MenuCard, choice: CardSkipChoice) {
		if (choice === 'later') {
			advance()
			return
		}
		setBusy(true)
		try {
			await postSuggestions(orgSlug, {
				intent: 'skip-card',
				id: card.id,
				kind: card.kind,
				reason: choice,
			})
			advance()
			if (choice === 'not_a_problem') {
				showUndoToast({
					message: _(t`We won't suggest this again`),
					undoLabel: _(t`Undo`),
					undoneMessage: _(t`Suggestion is back`),
					failedMessage,
					onUndo: async () => {
						await postSuggestions(orgSlug, {
							intent: 'unskip-card',
							id: card.id,
							kind: card.kind,
						})
						restore([card])
					},
				})
			}
		} catch (caught) {
			toast.error(cardErrorMessage(caught))
		} finally {
			setBusy(false)
		}
	}

	/**
	 * Send cards in requests of CARDS_PER_REQUEST. Each answer is handled as it
	 * arrives, so a later failure never hides what an earlier request saved.
	 * Returns the cards whose request did not complete (all of them after the
	 * first failure) and the failure, if any.
	 */
	async function sendInChunks(
		cards: MenuCard[],
		send: (chunk: MenuCard[]) => Promise<CardResult[]>,
		onChunk: (chunk: MenuCard[], results: CardResult[]) => void,
	): Promise<{ unsent: MenuCard[]; failure: unknown }> {
		for (let start = 0; start < cards.length; start += CARDS_PER_REQUEST) {
			const chunk = cards.slice(start, start + CARDS_PER_REQUEST)
			try {
				onChunk(chunk, await send(chunk))
			} catch (failure) {
				return { unsent: cards.slice(start), failure }
			}
		}
		return { unsent: [], failure: null }
	}

	async function acceptSelected() {
		const cards = queue.filter(
			(card): card is MenuCard =>
				isMenuCard(card) &&
				selectedIds.includes(card.id) &&
				!cardNeedsOwnReview(card) &&
				!cardNeedsInput(card),
		)
		if (cards.length === 0) return
		setBusy(true)
		setReport(null)
		const accepted: MenuCard[] = []
		const undos = new Map<string, MenuCardUndo>()
		const changed: MenuCard[] = []
		let refused = 0
		let outcome: { unsent: MenuCard[]; failure: unknown } = {
			unsent: [],
			failure: null,
		}
		try {
			outcome = await sendInChunks(
				cards,
				async (chunk) => {
					const reply = await postSuggestions<{
						ok: true
						results: CardResult[]
					}>(orgSlug, {
						intent: 'apply-cards',
						cards: chunk.map((card) =>
							applyInput(card, initialCardOptionId(card)),
						),
					})
					return reply.results
				},
				(chunk, results) => {
					const byId = new Map(results.map((result) => [result.id, result]))
					const savedHere: MenuCard[] = []
					const staleHere: MenuCard[] = []
					for (const card of chunk) {
						const result = byId.get(card.id)
						if (result?.ok && result.undo) {
							savedHere.push(card)
							undos.set(card.id, result.undo)
						} else if (result?.error === 'stale_suggestion') {
							staleHere.push(card)
						} else {
							refused += 1
						}
					}
					if (savedHere.length > 0) markChanged()
					accepted.push(...savedHere)
					changed.push(...staleHere)
					drop([...savedHere, ...staleHere].map((card) => card.id))
				},
			)
		} finally {
			setBusy(false)
		}
		const capitals = accepted.find((card) => card.kind === 'capitals')
		if (capitals) {
			await rememberCapitalStyle(capitals, initialCardOptionId(capitals))
		}
		setReport({
			accepted: accepted.length,
			changed: changed.length,
			refused,
			notApplied: outcome.unsent.length,
		})
		if (outcome.failure) toast.error(cardErrorMessage(outcome.failure))
		if (accepted.length > 0) {
			const count = accepted.length
			const entries = accepted.map((card) => ({
				card,
				undo: undos.get(card.id)!,
			}))
			showUndoToast({
				message: _(
					plural(count, {
						one: '# change saved',
						other: '# changes saved',
					}),
				),
				undoLabel: _(t`Undo`),
				undoneMessage: _(t`Changes undone`),
				failedMessage,
				onUndo: async () => {
					const restored: MenuCard[] = []
					try {
						for (const entry of [...entries].reverse()) {
							await postSuggestions(orgSlug, {
								intent: 'undo-card',
								undo: entry.undo,
							})
							restored.push(entry.card)
						}
					} finally {
						restore(restored.reverse())
					}
				},
			})
		}
	}

	async function skipSelected(choice: CardSkipChoice) {
		if (choice === 'later') return
		const cards = queue.filter(
			(card): card is MenuCard =>
				isMenuCard(card) && selectedIds.includes(card.id),
		)
		if (cards.length === 0) return
		setBusy(true)
		setReport(null)
		const done: MenuCard[] = []
		let refused = 0
		let outcome: { unsent: MenuCard[]; failure: unknown } = {
			unsent: [],
			failure: null,
		}
		try {
			outcome = await sendInChunks(
				cards,
				async (chunk) => {
					const reply = await postSuggestions<{
						ok: true
						results: CardResult[]
					}>(orgSlug, {
						intent: 'skip-cards',
						cards: chunk.map((card) => ({
							id: card.id,
							kind: card.kind,
							reason: choice,
						})),
					})
					return reply.results
				},
				(chunk, results) => {
					const doneHere: MenuCard[] = []
					for (const card of chunk) {
						if (results.find((result) => result.id === card.id)?.ok) {
							doneHere.push(card)
						} else {
							refused += 1
						}
					}
					done.push(...doneHere)
					drop(doneHere.map((card) => card.id))
				},
			)
		} finally {
			setBusy(false)
		}
		if (outcome.failure) {
			toast.error(cardErrorMessage(outcome.failure))
		}
		if (outcome.failure || refused > 0) {
			setReport({
				accepted: 0,
				changed: 0,
				refused,
				notApplied: outcome.unsent.length,
			})
		}
		if (choice === 'not_a_problem' && done.length > 0) {
			showUndoToast({
				message: _(
					plural(done.length, {
						one: "# suggestion won't come back",
						other: "# suggestions won't come back",
					}),
				),
				undoLabel: _(t`Undo`),
				undoneMessage: _(t`Suggestions are back`),
				failedMessage,
				onUndo: async () => {
					const restored: MenuCard[] = []
					try {
						for (const card of done) {
							await postSuggestions(orgSlug, {
								intent: 'unskip-card',
								id: card.id,
								kind: card.kind,
							})
							restored.push(card)
						}
					} finally {
						restore(restored)
					}
				},
			})
		}
	}

	async function toggleAutoTranslate(next: boolean) {
		setAutoOn(next)
		try {
			await postSuggestions(orgSlug, {
				intent: 'set-auto-translate',
				enabled: next,
			})
			markChanged()
		} catch {
			setAutoOn(!next)
			toast.error(_(t`Couldn't save that setting. Try again.`))
		}
	}

	const menuCards = queue.filter(isMenuCard)
	const chosenCards = menuCards.filter((card) => selectedIds.includes(card.id))
	const needsInputChosen = chosenCards.some((card) => cardNeedsInput(card))
	const needsReviewChosen = chosenCards.some((card) =>
		cardNeedsOwnReview(card),
	)
	const bulkBlocked = needsInputChosen || needsReviewChosen
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
					<DialogTitle ref={headingRef} tabIndex={-1}>
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
				) : selectMode ? (
					<div className="space-y-3">
						<div className="flex flex-wrap items-center justify-between gap-2">
							<p className="text-sm tabular-nums">
								<Plural
									value={chosenCards.length}
									one="# suggestion selected"
									other="# suggestions selected"
								/>
							</p>
							<div className="flex gap-1">
								<Button
									variant="ghost"
									size="sm"
									onClick={() =>
										setSelectedIds(
											chosenCards.length === menuCards.length
												? []
												: menuCards.map((card) => card.id),
										)
									}
								>
									{chosenCards.length === menuCards.length ? (
										<Trans>Clear</Trans>
									) : (
										<Trans>Select all</Trans>
									)}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => {
										setSelecting(false)
										setSelectedIds([])
									}}
								>
									<Trans>Done selecting</Trans>
								</Button>
							</div>
						</div>
						<div
							ref={selectRef}
							tabIndex={-1}
							role="group"
							aria-label={_(t`Suggestions to select`)}
							className="max-h-72 space-y-2 overflow-y-auto outline-none focus-visible:ring-2"
						>
							{menuCards.map((card) => (
								<MenuReviewCardRow
									key={card.id}
									card={card}
									checked={selectedIds.includes(card.id)}
									onCheckedChange={(checked) =>
										setSelectedIds((ids) =>
											checked
												? [...ids, card.id]
												: ids.filter((id) => id !== card.id),
										)
									}
								/>
							))}
						</div>
						{needsInputChosen ? (
							<p className="text-muted-foreground text-xs">
								<Trans>
									Some selected suggestions need a value. Accept those on their
									own.
								</Trans>
							</p>
						) : null}
						{needsReviewChosen ? (
							<p className="text-muted-foreground text-xs">
								<Trans>
									Some selected suggestions merge dishes or add choices. Look at
									each one and accept it on its own.
								</Trans>
							</p>
						) : null}
						<div className="flex flex-wrap justify-end gap-2">
							<CardSkipMenu
								includeLater={false}
								label={_(t`Skip selected`)}
								disabled={busy || chosenCards.length === 0}
								onChoose={(choice) => void skipSelected(choice)}
							/>
							<Button
								disabled={busy || chosenCards.length === 0 || bulkBlocked}
								onClick={() => void acceptSelected()}
							>
								<Trans>Accept selected</Trans>
							</Button>
						</div>
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
						{isMenuCard(current) ? (
							<MenuReviewCardView
								key={current.id}
								ref={cardRef}
								card={current}
								busy={busy}
								onAccept={(optionId, input) =>
									void acceptCard(current, optionId, input)
								}
								onSkip={(choice) => void skipCard(current, choice)}
							/>
						) : (
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
						)}
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

				{/* One live region for the whole dialog: only its text changes. */}
				<div
					role="status"
					className={report ? 'space-y-0.5 text-sm' : 'sr-only'}
				>
					{report && report.accepted > 0 ? (
						<p>
							<Plural
								value={report.accepted}
								one="# suggestion accepted"
								other="# suggestions accepted"
							/>
						</p>
					) : null}
					{report && report.changed > 0 ? (
						<p className="text-muted-foreground">
							<Plural
								value={report.changed}
								one="# changed since it was suggested, so it was left out"
								other="# changed since they were suggested, so they were left out"
							/>
						</p>
					) : null}
					{report && report.refused > 0 ? (
						<p className="text-destructive">
							<Plural
								value={report.refused}
								one="# couldn't be saved"
								other="# couldn't be saved"
							/>
						</p>
					) : null}
					{report && report.notApplied > 0 ? (
						<p className="text-destructive">
							<Plural
								value={report.notApplied}
								one="# suggestion was not applied. Try again."
								other="# suggestions were not applied. Try again."
							/>
						</p>
					) : null}
				</div>

				{menuCards.length > 1 && !selectMode && !error ? (
					<Button
						variant="ghost"
						size="sm"
						className="self-start"
						disabled={busy}
						onClick={() => {
							setReport(null)
							setSelecting(true)
						}}
					>
						<Icon name="list" className="size-4" />
						<Trans>Select several</Trans>
					</Button>
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

function SuggestionTitle({ suggestion }: { suggestion: MenuTextSuggestion }) {
	return suggestion.kind === 'empty_category' ? (
		<>{suggestion.categoryName}</>
	) : (
		<>{suggestion.dishName}</>
	)
}

function SuggestionReason({ suggestion }: { suggestion: MenuTextSuggestion }) {
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

function SuggestedLabel({ suggestion }: { suggestion: MenuTextSuggestion }) {
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

function SuggestedValue({ suggestion }: { suggestion: MenuTextSuggestion }) {
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
	suggestion: MenuTextSuggestion
	busy: boolean
	onSkip: () => void
	onAcceptText: (
		suggestion: Extract<
			MenuTextSuggestion,
			{ kind: 'translation' | 'description' }
		>,
	) => void
	onItemAvailability: (
		suggestion: Extract<MenuTextSuggestion, { kind: 'long_unavailable' }>,
		target: 'available' | 'hidden',
	) => void
	onHideCategory: (
		suggestion: Extract<MenuTextSuggestion, { kind: 'empty_category' }>,
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

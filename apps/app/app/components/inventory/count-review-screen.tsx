import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	type ApproveCountResult,
	approveCountResultSchema,
	countReviewSchema,
	countSummarySchema,
} from '@repo/inventory'
import { Alert, AlertAction, AlertDescription } from '@repo/ui/alert'
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
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Field, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { Textarea } from '@repo/ui/textarea'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useId, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { CountStatusBadge } from '#app/components/inventory/count-status-badge.tsx'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { OperatorRequestError } from '#app/hooks/use-operator-client.ts'
import {
	approveBlockedReason,
	buildApprovePayload,
	canApproveCount,
	differenceDirection,
	groupReviewLines,
	type ReviewLine,
	summarizeFoodCost,
	type UncountedChoice,
	uncountedChoice,
} from '#app/utils/inventory/count-review.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import {
	inventoryCountPath,
	inventoryTabPath,
} from '#app/utils/inventory/nav.ts'

/**
 * Review of a sent count: only the rows that need a look. Items nobody
 * counted get "Same as before" or "None left"; items far from what was
 * expected show the figures and take a note; everything else is summarised
 * ("41 items match and need no review"). Approving needs the cost grant.
 */
export function CountReviewScreen({
	orgSlug,
	countId,
	canEdit,
	canSeeCost,
	search,
}: {
	orgSlug: string
	countId: string
	canEdit: boolean
	canSeeCost: boolean
	search: string
}) {
	const { t, i18n } = useLingui()
	const navigate = useNavigate()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const noteId = useId()

	const review = useInventoryQuery(
		`/counts/${encodeURIComponent(countId)}/review`,
		countReviewSchema,
	)
	const [uncounted, setUncounted] = useState<Record<string, UncountedChoice>>(
		{},
	)
	const [notes, setNotes] = useState<Record<string, string>>({})
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [busy, setBusy] = useState<'approve' | 'reopen' | 'cancel' | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [confirmApprove, setConfirmApprove] = useState(false)
	const [confirmCancel, setConfirmCancel] = useState(false)
	const [result, setResult] = useState<ApproveCountResult | null>(null)

	const access = { canEdit, canSeeCost }
	const countsHref = `${inventoryTabPath(orgSlug, 'counts')}${search}`
	const countHref = `${inventoryCountPath(orgSlug, countId)}${search}`

	if (review.error && !review.data) {
		const closed =
			review.error instanceof OperatorRequestError &&
			review.error.code === 'count_closed'
		return (
			<div className="mx-auto w-full max-w-5xl px-4 py-6">
				<Alert
					variant={closed ? 'default' : 'destructive'}
					data-testid="review-error"
				>
					<AlertDescription>
						{closed ? (
							<Trans>
								This count is already closed. You can find it in Counts.
							</Trans>
						) : (
							i18n._(inventoryErrorMessage(review.error))
						)}
					</AlertDescription>
					<AlertAction>
						{closed ? (
							<Button variant="outline" render={<Link to={countsHref} />}>
								<Trans>Back to counts</Trans>
							</Button>
						) : (
							<Button variant="outline" onClick={review.reload}>
								<Trans>Try again</Trans>
							</Button>
						)}
					</AlertAction>
				</Alert>
			</div>
		)
	}

	if (!review.data) {
		return (
			<div
				role="status"
				className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-6"
				data-testid="review-loading"
			>
				<span className="sr-only">
					<Trans>Loading the review</Trans>
				</span>
				<Skeleton className="h-8 w-1/2" />
				<Skeleton className="h-32 w-full rounded-xl" />
			</div>
		)
	}

	const data = review.data
	const { count } = data
	const grouped = groupReviewLines(data)
	const currency = data.currency ?? ''
	const showMoney = canSeeCost && data.differenceValueMinor !== undefined
	const blocked = approveBlockedReason({
		access,
		status: count.status,
		saving: busy !== null,
	})
	const manager = canApproveCount(access)
	const selected =
		grouped.bigDifferences.find((line) => line.itemId === selectedId) ??
		grouped.bigDifferences[0] ??
		null
	const title = count.listName ?? t`Full count`
	const money = (minor: number, code?: string) =>
		formatMoney(Math.abs(minor), code ?? currency, i18n.locale)

	const whatHappens = (name: string) => t`What happens to ${name}`
	const fmt = (line: ReviewLine, value: number) =>
		quantity.format(value, {
			baseUnit: line.baseUnit,
			countUnit: line.countUnit,
			units: line.units,
		})

	async function post<T>(
		action: 'approve' | 'reopen' | 'cancel',
		path: string,
		body: unknown,
		parse: (value: unknown) => T,
	): Promise<T | null> {
		setBusy(action)
		setError(null)
		try {
			const answer = parse(
				await request(path, { method: 'POST', body: JSON.stringify(body) }),
			)
			notifyChanged()
			return answer
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
			review.reload()
			return null
		} finally {
			setBusy(null)
		}
	}

	async function approve() {
		setConfirmApprove(false)
		const answer = await post(
			'approve',
			`/counts/${encodeURIComponent(countId)}/approve`,
			buildApprovePayload(data, { uncounted, notes }),
			(value) => approveCountResultSchema.parse(value),
		)
		if (answer) setResult(answer)
	}

	async function reopen() {
		const answer = await post(
			'reopen',
			`/counts/${encodeURIComponent(countId)}/reopen`,
			{ expectedVersion: count.version },
			(value) => countSummarySchema.parse(value),
		)
		if (answer) void navigate(countHref)
	}

	async function cancel() {
		setConfirmCancel(false)
		const answer = await post(
			'cancel',
			`/counts/${encodeURIComponent(countId)}/cancel`,
			{ expectedVersion: count.version },
			(value) => countSummarySchema.parse(value),
		)
		if (answer) {
			toast.success(t`Count cancelled. Nothing was changed.`)
			void navigate(countsHref)
		}
	}

	const needLook = grouped.notCounted.length + grouped.bigDifferences.length
	const net = data.differenceValueMinor
	const netText = net === undefined ? '' : money(net)

	return (
		<div className="flex flex-1 flex-col" data-testid="count-review">
			<header className="border-border bg-background/95 sticky top-0 z-20 w-full border-b backdrop-blur-sm">
				<div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5">
					<Button
						type="button"
						variant="secondary"
						size="icon-sm"
						render={<Link to={countsHref} />}
						aria-label={t`Back to counts`}
						className="size-8 shrink-0"
					>
						<Icon name="arrow-left" className="size-4 rtl:rotate-180" />
					</Button>
					<div className="flex min-w-0 flex-1 flex-col">
						<h1 className="truncate text-base font-medium tracking-tight wrap-anywhere">
							<Trans>Review: {title}</Trans>
						</h1>
						<span className="text-muted-foreground text-xs">
							<bdi dir="ltr">{count.businessDate}</bdi>
						</span>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<CountStatusBadge status={count.status} />
						{count.status === 'in_review' && canEdit ? (
							<>
								<Button
									type="button"
									variant="outline"
									disabled={busy !== null}
									onClick={() => void reopen()}
									data-testid="review-reopen"
								>
									<Trans>Reopen</Trans>
								</Button>
								<Button
									type="button"
									variant="outline"
									disabled={busy !== null}
									onClick={() => setConfirmCancel(true)}
									data-testid="review-cancel"
								>
									<Trans>Cancel count</Trans>
								</Button>
							</>
						) : null}
						{manager && count.status === 'in_review' ? (
							<Button
								type="button"
								disabled={blocked !== null}
								onClick={() => setConfirmApprove(true)}
								data-testid="review-approve"
							>
								{busy === 'approve' ? (
									<Icon name="loader" className="animate-spin" />
								) : null}
								<Trans>Approve count</Trans>
							</Button>
						) : null}
					</div>
				</div>
			</header>

			<div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-4">
				{error ? (
					<Alert variant="destructive" data-testid="review-save-error">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				{count.status === 'counting' ? (
					<Alert data-testid="review-still-counting">
						<AlertDescription>
							<Trans>
								This count is still being counted, so these figures can change.
							</Trans>
						</AlertDescription>
						<AlertAction>
							<Button variant="outline" render={<Link to={countHref} />}>
								<Trans>Back to counting</Trans>
							</Button>
						</AlertAction>
					</Alert>
				) : count.status === 'in_review' && !manager ? (
					<Alert data-testid="review-needs-manager">
						<AlertDescription>
							<Trans>
								A manager who can see costs approves this count. You can look at
								it here.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null}

				<div className="flex flex-col gap-1" data-testid="review-summary">
					<p className="text-sm">
						{needLook === 0 ? (
							<Trans>Nothing needs a look.</Trans>
						) : (
							<Plural
								value={needLook}
								one="# item needs a look."
								other="# items need a look."
							/>
						)}
					</p>
					{showMoney && net !== undefined ? (
						<p className="text-muted-foreground text-sm">
							{net === 0 ? (
								<Trans>Counted stock matches what you expected.</Trans>
							) : net < 0 ? (
								<Trans>
									About <bdi dir="ltr">{netText}</bdi> less than expected if you
									approve now.
								</Trans>
							) : (
								<Trans>
									About <bdi dir="ltr">{netText}</bdi> more than expected if you
									approve now.
								</Trans>
							)}
						</p>
					) : null}
				</div>

				{grouped.notCounted.length > 0 ? (
					<WorkspacePanel
						title={<Trans>Not counted</Trans>}
						description={
							<Trans>
								Nobody counted these. Choose what happens to each one.
							</Trans>
						}
						action={
							manager &&
							count.status === 'in_review' &&
							grouped.notCounted.length > 2 ? (
								<div className="flex flex-wrap gap-2">
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() =>
											setUncounted(
												Object.fromEntries(
													grouped.notCounted.map((line) => [
														line.itemId,
														'keep' as const,
													]),
												),
											)
										}
										data-testid="review-all-keep"
									>
										<Trans>All same as before</Trans>
									</Button>
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() =>
											setUncounted(
												Object.fromEntries(
													grouped.notCounted.map((line) => [
														line.itemId,
														'zero' as const,
													]),
												),
											)
										}
										data-testid="review-all-zero"
									>
										<Trans>All none left</Trans>
									</Button>
								</div>
							) : undefined
						}
					>
						<ul
							className="flex flex-col gap-2"
							data-testid="review-not-counted"
						>
							{grouped.notCounted.map((line) => {
								const expectedText = fmt(line, line.expected)
								return (
									<li
										key={line.itemId}
										className="bg-card flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between"
										data-testid={`review-uncounted-${line.itemId}`}
									>
										<div className="flex min-w-0 flex-col">
											<span className="font-medium wrap-anywhere">
												{line.name}
											</span>
											<span className="text-muted-foreground text-xs">
												<Trans>
													Expected <bdi dir="ltr">{expectedText}</bdi>
												</Trans>
											</span>
										</div>
										{manager && count.status === 'in_review' ? (
											<ToggleGroup
												aria-label={whatHappens(line.name)}
												variant="segmented"
												value={[uncountedChoice({ uncounted }, line.itemId)]}
												onValueChange={(next) => {
													const choice = next[0] as UncountedChoice | undefined
													if (choice) {
														setUncounted((current) => ({
															...current,
															[line.itemId]: choice,
														}))
													}
												}}
											>
												<ToggleGroupItem
													value="keep"
													className="h-11 md:h-7"
													data-testid={`review-keep-${line.itemId}`}
												>
													<Trans>Same as before</Trans>
												</ToggleGroupItem>
												<ToggleGroupItem
													value="zero"
													className="h-11 md:h-7"
													data-testid={`review-zero-${line.itemId}`}
												>
													<Trans>None left</Trans>
												</ToggleGroupItem>
											</ToggleGroup>
										) : null}
									</li>
								)
							})}
						</ul>
					</WorkspacePanel>
				) : null}

				{grouped.bigDifferences.length > 0 ? (
					<WorkspacePanel
						title={<Trans>Far from what you expected</Trans>}
						description={
							<Trans>
								Counted more than a fifth away from what you should have. Check
								these before you approve.
							</Trans>
						}
					>
						<div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
							<ul
								className="flex flex-col gap-2"
								data-testid="review-differences"
							>
								{grouped.bigDifferences.map((line) => {
									const direction = differenceDirection(line)
									const active = line.itemId === selected?.itemId
									return (
										<li key={line.itemId}>
											<button
												type="button"
												onClick={() => setSelectedId(line.itemId)}
												aria-pressed={active}
												className="bg-card hover:bg-muted/50 focus-visible:ring-ring/50 aria-pressed:border-primary flex min-h-11 w-full flex-col gap-0.5 rounded-xl border p-3 text-start outline-none focus-visible:ring-3"
												data-testid={`review-diff-${line.itemId}`}
											>
												<span className="font-medium wrap-anywhere">
													{line.name}
												</span>
												<span className="text-muted-foreground text-xs">
													{direction === 'none' ? null : (
														<DifferenceFigures
															line={line}
															fmt={fmt}
															money={money}
															showMoney={showMoney}
															compact
														/>
													)}
												</span>
											</button>
										</li>
									)
								})}
							</ul>

							{selected ? (
								<div
									className="bg-card flex flex-col gap-3 rounded-xl border p-4"
									data-testid="review-detail"
								>
									<h3 className="font-medium wrap-anywhere">{selected.name}</h3>
									<p className="text-sm" data-testid="review-detail-figures">
										<DifferenceFigures
											line={selected}
											fmt={fmt}
											money={money}
											showMoney={showMoney}
										/>
									</p>
									{selected.movements ? (
										<MovementsSince line={selected} fmt={fmt} />
									) : null}
									{manager && count.status === 'in_review' ? (
										<Field>
											<FieldLabel htmlFor={`${noteId}-${selected.itemId}`}>
												<Trans>Note</Trans>{' '}
												<span className="text-muted-foreground font-normal">
													<Trans>(optional)</Trans>
												</span>
											</FieldLabel>
											<Textarea
												id={`${noteId}-${selected.itemId}`}
												value={notes[selected.itemId] ?? ''}
												onChange={(event) =>
													setNotes((current) => ({
														...current,
														[selected.itemId]: event.target.value.replace(
															/[\r\n]+/g,
															' ',
														),
													}))
												}
												rows={2}
												maxLength={500}
												placeholder={t`For example: spilled a box, counted twice`}
												data-testid="review-note"
											/>
										</Field>
									) : null}
								</div>
							) : null}
						</div>
					</WorkspacePanel>
				) : null}

				<p
					className="text-muted-foreground text-sm"
					data-testid="review-matching"
				>
					<Plural
						value={grouped.matching}
						one="# item matches and needs no review."
						other="# items match and need no review."
					/>
				</p>
			</div>

			<AlertDialog open={confirmApprove} onOpenChange={setConfirmApprove}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Approve this count?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								Stock is set to what was counted and the count closes. This
								cannot be undone.
							</Trans>
							{showMoney && net !== undefined && net !== 0 ? (
								<>
									{' '}
									{net < 0 ? (
										<Trans>
											That is about <bdi dir="ltr">{netText}</bdi> less than you
											expected.
										</Trans>
									) : (
										<Trans>
											That is about <bdi dir="ltr">{netText}</bdi> more than you
											expected.
										</Trans>
									)}
								</>
							) : null}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Not yet</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => void approve()}
							data-testid="review-approve-confirm"
						>
							<Trans>Approve count</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Cancel this count?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								Nothing is changed in your stock. The entries are kept in the
								list of past counts.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep the count</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => void cancel()}
							data-testid="review-cancel-confirm"
						>
							<Trans>Cancel count</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<CompletionDialog
				result={result}
				onDone={() => void navigate(countsHref)}
			/>
		</div>
	)
}

function DifferenceFigures({
	line,
	fmt,
	money,
	showMoney,
	compact = false,
}: {
	line: ReviewLine
	fmt: (line: ReviewLine, value: number) => string
	money: (minor: number, code?: string) => string
	showMoney: boolean
	compact?: boolean
}) {
	const direction = differenceDirection(line)
	const expected = fmt(line, line.expected)
	const counted = line.counted === null ? '' : fmt(line, line.counted)
	const gap =
		line.difference === null ? '' : fmt(line, Math.abs(line.difference))
	const value =
		showMoney && line.differenceValueMinor !== undefined
			? money(line.differenceValueMinor, line.currency)
			: null
	const missing = direction === 'missing'
	return (
		<>
			{compact ? null : (
				<>
					<Trans>
						Expected <bdi dir="ltr">{expected}</bdi>
					</Trans>
					{' · '}
				</>
			)}
			{compact ? (
				missing ? (
					<Trans>
						<bdi dir="ltr">{gap}</bdi> missing
					</Trans>
				) : (
					<Trans>
						<bdi dir="ltr">{gap}</bdi> more than expected
					</Trans>
				)
			) : (
				<>
					<Trans>
						Counted <bdi dir="ltr">{counted}</bdi>
					</Trans>
					{' · '}
					{missing ? (
						<Trans>
							<bdi dir="ltr">{gap}</bdi> missing
						</Trans>
					) : (
						<Trans>
							<bdi dir="ltr">{gap}</bdi> more than expected
						</Trans>
					)}
				</>
			)}
			{value ? (
				<>
					{' · '}
					<bdi dir="ltr">{value}</bdi>
				</>
			) : null}
		</>
	)
}

/**
 * Why "expected" is what it is: what moved the item since the last approved
 * count. Quantities only; sales show as "used by sales" once recipes are on.
 */
function MovementsSince({
	line,
	fmt,
}: {
	line: ReviewLine
	fmt: (line: ReviewLine, value: number) => string
}) {
	const { t } = useLingui()
	const moved = line.movements
	if (!moved) return null
	const parts: { key: string; text: string }[] = []
	if (moved.delivered > 0) {
		const amount = fmt(line, moved.delivered)
		parts.push({
			key: 'delivered',
			text: t`${amount} delivered`,
		})
	}
	if (moved.used > 0) {
		const amount = fmt(line, moved.used)
		parts.push({ key: 'used', text: t`${amount} used by sales` })
	}
	if (moved.wasted > 0) {
		const amount = fmt(line, moved.wasted)
		parts.push({ key: 'wasted', text: t`${amount} wasted` })
	}
	if (moved.adjusted !== 0) {
		const amount = fmt(line, Math.abs(moved.adjusted))
		parts.push({
			key: 'adjusted',
			text:
				moved.adjusted > 0
					? t`${amount} added by adjustments`
					: t`${amount} removed by adjustments`,
		})
	}
	if (parts.length === 0) return null
	return (
		<p className="text-muted-foreground text-xs" data-testid="review-movements">
			{moved.since === null ? (
				<Trans>Since the first record:</Trans>
			) : (
				<Trans>Since the last count:</Trans>
			)}{' '}
			{parts.map((part, index) => (
				<span key={part.key}>
					{index > 0 ? ' · ' : null}
					<bdi dir="ltr">{part.text}</bdi>
				</span>
			))}
		</p>
	)
}

/** What approving did: items counted, the difference in money, and food cost for the period. */
function CompletionDialog({
	result,
	onDone,
}: {
	result: ApproveCountResult | null
	onDone: () => void
}) {
	const { i18n } = useLingui()
	const open = result !== null
	const foodCost = summarizeFoodCost(result?.foodCost)
	const difference = result?.differenceValueMinor
	const money = (minor: number) =>
		formatMoney(Math.abs(minor), result?.currency, i18n.locale)
	const percent = (bp: number) =>
		new Intl.NumberFormat(i18n.locale, {
			style: 'percent',
			maximumFractionDigits: 1,
		}).format(bp / 10_000)
	const differenceText = difference === undefined ? '' : money(difference)
	const foodBpText = foodCost?.kind === 'ready' ? percent(foodCost.bp) : ''
	const targetText =
		foodCost?.kind === 'ready' ? percent(foodCost.targetBp) : ''
	const counted = result?.count.itemsCounted ?? 0
	const total = result?.count.itemTotal ?? 0

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onDone()}>
			<DialogContent className="sm:max-w-md" data-testid="review-complete">
				<DialogHeader>
					<DialogTitle>
						<Trans>Count approved</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>Your stock now matches what was counted.</Trans>
					</DialogDescription>
				</DialogHeader>
				<dl className="flex flex-col gap-3 text-sm">
					<div className="flex items-baseline justify-between gap-3">
						<dt className="text-muted-foreground">
							<Trans>Items counted</Trans>
						</dt>
						<dd className="tabular-nums" data-testid="review-complete-counted">
							<Trans>
								<bdi dir="ltr">{counted}</bdi> of <bdi dir="ltr">{total}</bdi>
							</Trans>
						</dd>
					</div>
					<div className="flex items-baseline justify-between gap-3">
						<dt className="text-muted-foreground">
							<Trans>Items adjusted</Trans>
						</dt>
						<dd className="tabular-nums">
							<bdi dir="ltr">{result?.adjustedItems ?? 0}</bdi>
						</dd>
					</div>
					{difference !== undefined ? (
						<div className="flex items-baseline justify-between gap-3">
							<dt className="text-muted-foreground">
								<Trans>Difference</Trans>
							</dt>
							<dd
								className="tabular-nums"
								data-testid="review-complete-difference"
							>
								{difference === 0 ? (
									<Trans>None</Trans>
								) : difference < 0 ? (
									<Trans>
										<bdi dir="ltr">{differenceText}</bdi> missing
									</Trans>
								) : (
									<Trans>
										<bdi dir="ltr">{differenceText}</bdi> more than expected
									</Trans>
								)}
							</dd>
						</div>
					) : null}
					<div
						className="flex flex-col gap-1"
						data-testid="review-complete-food"
					>
						<dt className="text-muted-foreground">
							<Trans>Food cost</Trans>
						</dt>
						<dd>
							{foodCost?.kind === 'ready' ? (
								foodCost.overTarget ? (
									<Trans>
										<bdi dir="ltr" className="font-medium">
											{foodBpText}
										</bdi>{' '}
										since your last count, above your target of{' '}
										<bdi dir="ltr">{targetText}</bdi>.
									</Trans>
								) : (
									<Trans>
										<bdi dir="ltr" className="font-medium">
											{foodBpText}
										</bdi>{' '}
										since your last count, within your target of{' '}
										<bdi dir="ltr">{targetText}</bdi>.
									</Trans>
								)
							) : foodCost?.kind === 'no_sales' ? (
								<Trans>
									No sales were recorded between your last two counts, so food
									cost cannot be worked out yet.
								</Trans>
							) : (
								<Trans>
									Food cost needs two approved counts. Count again next time and
									it will show here.
								</Trans>
							)}
						</dd>
					</div>
				</dl>
				<DialogFooter>
					<Button onClick={onDone} data-testid="review-complete-done">
						<Trans>Done</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

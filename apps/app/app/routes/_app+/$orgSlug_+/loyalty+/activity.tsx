import { getFormProps, useForm } from '@conform-to/react'
import { parseWithZod } from '@conform-to/zod'
import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { isImpersonating } from '@repo/auth'
import {
	LOYALTY_PERMISSIONS,
	type LoyaltyOperatorLedgerEntry,
	type LoyaltyOperatorParkedSource,
	type LoyaltyOperatorPurchase,
	type LoyaltyOperatorRedemption,
} from '@repo/loyalty'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLoaderData } from 'react-router'
import { z } from 'zod'
import { EmptyState } from '#app/components/empty-state.tsx'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { ErrorList } from '#app/components/forms.tsx'
import { TextAreaField } from '#app/components/staff/controls.tsx'
import { useLoyaltyClient } from '#app/hooks/use-loyalty-client.ts'
import { useSettledFocus } from '#app/hooks/use-settled-focus.ts'
import { requireLoyaltyAccess } from '#app/utils/loyalty/access.server.ts'
import {
	afterFailedLoyaltySubmit,
	loyaltyKeyForSubmit,
	newLoyaltySubmitKey,
	type LoyaltyClient,
	type LoyaltySubmitKeyRef,
} from '#app/utils/loyalty/loyalty-client.ts'
import { loyaltyErrorMessage } from '#app/utils/loyalty/loyalty-errors.ts'
import {
	LOYALTY_CHANNEL_LABELS,
	LOYALTY_LEDGER_TYPE_LABELS,
	LOYALTY_PURCHASE_SOURCE_LABELS,
	LOYALTY_REVIEW_REASON_LABELS,
	loyaltyEnumLabel,
} from '#app/utils/loyalty/loyalty-labels.ts'
import {
	formatLoyaltyInstant,
	formatLoyaltyMoney,
	formatSignedPoints,
} from '#app/utils/loyalty/loyalty-view.ts'
import { LOYALTY_SECTION_REQUIREMENTS } from '#app/utils/loyalty/sections.ts'
import { customersHref } from '#app/utils/people/customers-link.ts'
import { type Route } from './+types/activity.ts'

const PAGE_SIZE = 50

export async function loader({ request, params }: Route.LoaderArgs) {
	const access = await requireLoyaltyAccess(request, params.orgSlug, {
		anyOf: LOYALTY_SECTION_REQUIREMENTS.activity.anyOf,
	})
	const impersonated = await isImpersonating(request)
	return {
		orgSlug: access.orgSlug,
		canReview:
			!impersonated &&
			access.grants.includes(LOYALTY_PERMISSIONS.UPDATE_LOYALTY_REDEMPTION),
	}
}

export default function LoyaltyActivityRoute() {
	const { i18n } = useLingui()
	const tx = useCallback((d: MessageDescriptor) => i18n._(d), [i18n])
	const { orgSlug, canReview } = useLoaderData<typeof loader>()
	const client = useLoyaltyClient()

	const [entries, setEntries] = useState<LoyaltyOperatorLedgerEntry[]>([])
	const [nextCursor, setNextCursor] = useState<string | null>(null)
	const [loading, setLoading] = useState(true)
	const [loadingMore, setLoadingMore] = useState(false)
	const [error, setError] = useState<string | null>(null)

	// Only the newest request may write: a slow first page must not replace
	// or extend what a later reload or "Load more" already put on screen.
	const requestId = useRef(0)

	const load = useCallback(
		async (cursor: string | null) => {
			const current = (requestId.current += 1)
			try {
				const page = await client.listActivity({
					cursor,
					limit: PAGE_SIZE,
				})
				if (current !== requestId.current) return
				setEntries((prev) =>
					cursor ? [...prev, ...page.entries] : page.entries,
				)
				setNextCursor(page.nextCursor)
				setError(null)
			} catch (err) {
				if (current !== requestId.current) return
				setError(
					loyaltyErrorMessage(err, tx, msg`The activity could not be loaded.`),
				)
			} finally {
				if (current === requestId.current) {
					setLoading(false)
					setLoadingMore(false)
				}
			}
		},
		[client, tx],
	)

	useEffect(() => {
		setLoading(true)
		void load(null)
	}, [load])

	return (
		<div className="flex flex-col gap-6" data-testid="loyalty-activity-page">
			{canReview ? <ReviewQueue client={client} /> : null}

			{error ? (
				<Alert variant="destructive" data-testid="loyalty-activity-error">
					<Icon name="alert-triangle" />
					<AlertDescription>
						<div className="flex flex-wrap items-center gap-3">
							{error}
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => {
									setLoading(true)
									void load(null)
								}}
							>
								<Trans>Try again</Trans>
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : null}

			{loading && entries.length === 0 && !error ? (
				<Frame data-testid="loyalty-activity-loading" aria-busy="true">
					<div role="status" className="divide-border flex flex-col divide-y">
						<span className="sr-only">
							<Trans>Loading activity…</Trans>
						</span>
						{[0, 1, 2, 3, 4].map((row) => (
							<div key={row} className="flex items-center gap-4 px-3 py-2.5">
								<Skeleton className="h-4 w-28" />
								<Skeleton className="h-4 w-48" />
								<Skeleton className="ms-auto h-4 w-12" />
							</div>
						))}
					</div>
				</Frame>
			) : null}

			{!loading && !error && entries.length === 0 ? (
				<div data-testid="loyalty-activity-empty">
					<EmptyState
						title={<Trans>No activity yet</Trans>}
						description={
							<Trans>
								Point movements appear here as customers earn and redeem.
							</Trans>
						}
						icons={['activity', 'star', 'users']}
					/>
				</div>
			) : null}

			{entries.length > 0 ? (
				<>
					<Frame data-testid="loyalty-activity-feed">
						<ul className="divide-border flex flex-col divide-y">
							{entries.map((entry) => (
								<li
									key={entry.id}
									className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
								>
									<div className="flex min-w-0 flex-col gap-0.5">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium">
												{loyaltyEnumLabel(
													tx,
													LOYALTY_LEDGER_TYPE_LABELS,
													entry.type,
												)}
											</span>
											{entry.channel ? (
												<Badge variant="outline">
													{loyaltyEnumLabel(
														tx,
														LOYALTY_CHANNEL_LABELS,
														entry.channel,
													)}
												</Badge>
											) : null}
										</div>
										<span className="text-muted-foreground text-xs wrap-anywhere">
											{[formatLoyaltyInstant(entry.at, i18n.locale), entry.note]
												.filter(Boolean)
												.join(' · ')}
										</span>
										{entry.customerId ? (
											<Link
												className="text-foreground focus-visible:ring-ring w-fit rounded-sm text-xs font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none"
												to={customersHref(orgSlug, {
													personKey: `c_${entry.customerId}`,
												})}
												data-testid="loyalty-activity-customer-link"
											>
												<Trans>View customer</Trans>
											</Link>
										) : (
											<span
												className="text-muted-foreground text-xs"
												data-testid="loyalty-activity-customer-erased"
											>
												<Trans>Customer erased</Trans>
											</span>
										)}
									</div>
									<bdi
										dir="ltr"
										className={
											entry.delta > 0
												? 'text-success shrink-0 font-medium tabular-nums'
												: 'shrink-0 font-medium tabular-nums'
										}
									>
										{formatSignedPoints(entry.delta, i18n.locale)}
									</bdi>
								</li>
							))}
						</ul>
					</Frame>
					{nextCursor ? (
						<div className="flex justify-center">
							<Button
								type="button"
								variant="outline"
								disabled={loadingMore}
								onClick={() => {
									setLoadingMore(true)
									void load(nextCursor)
								}}
								data-testid="loyalty-activity-load-more"
							>
								<Trans>Load more</Trans>
							</Button>
						</div>
					) : null}
				</>
			) : null}
		</div>
	)
}

type ReviewTarget =
	| { kind: 'redemption'; redemption: LoyaltyOperatorRedemption }
	| { kind: 'purchase'; purchase: LoyaltyOperatorPurchase }

const REVIEW_HEADING_ID = 'loyalty-review-heading'

function parkedKey(source: LoyaltyOperatorParkedSource): string {
	return `${source.sourceType}-${source.sourceId}`
}

function ReviewQueue({ client }: { client: LoyaltyClient }) {
	const { i18n } = useLingui()
	const tx = useCallback((d: MessageDescriptor) => i18n._(d), [i18n])
	const [redemptions, setRedemptions] = useState<LoyaltyOperatorRedemption[]>(
		[],
	)
	const [purchases, setPurchases] = useState<LoyaltyOperatorPurchase[]>([])
	const [parked, setParked] = useState<LoyaltyOperatorParkedSource[]>([])
	const [loading, setLoading] = useState(true)
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [retrying, setRetrying] = useState<string | null>(null)
	const [target, setTarget] = useState<ReviewTarget | null>(null)
	// A decided item leaves the queue, and its Review button with it.
	const { settle, finalFocus } = useSettledFocus(REVIEW_HEADING_ID)

	const load = useCallback(async () => {
		setLoading(true)
		setError(null)
		try {
			const queue = await client.getReview()
			setRedemptions(queue.redemptions)
			setPurchases(queue.purchases)
			setParked(queue.parked)
		} catch (err) {
			setError(
				loyaltyErrorMessage(
					err,
					tx,
					msg`The review queue could not be loaded.`,
				),
			)
		} finally {
			setLoading(false)
		}
	}, [client, tx])

	useEffect(() => {
		void load()
	}, [load])

	const retry = useCallback(
		async (source: LoyaltyOperatorParkedSource) => {
			setRetrying(parkedKey(source))
			setError(null)
			setNotice(null)
			try {
				const result = await client.requeue({
					type: source.sourceType,
					id: source.sourceId,
				})
				setNotice(
					tx(
						result.queued
							? msg`Queued again. If it still fails, it comes back here.`
							: msg`Nothing was left to update on that sale, so it was cleared.`,
					),
				)
				// The row leaves the queue, and its button with it.
				const heading = document.getElementById(REVIEW_HEADING_ID)
				if (heading) {
					if (!heading.hasAttribute('tabindex')) {
						heading.setAttribute('tabindex', '-1')
					}
					heading.focus()
				}
				await load()
			} catch (err) {
				setError(
					loyaltyErrorMessage(
						err,
						tx,
						msg`The sale could not be queued again.`,
					),
				)
			} finally {
				setRetrying(null)
			}
		},
		[client, load, tx],
	)

	const empty =
		!loading &&
		redemptions.length === 0 &&
		purchases.length === 0 &&
		parked.length === 0

	return (
		<Card data-testid="loyalty-review-queue">
			<CardHeader className="pb-2">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<div>
						<CardTitle as="h2" id={REVIEW_HEADING_ID} className="text-base">
							<Trans>Waiting for review</Trans>
						</CardTitle>
						<CardDescription>
							<Trans>
								Redemptions and sales that need an operator's decision before
								points move.
							</Trans>
						</CardDescription>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => void load()}
						disabled={loading}
						data-testid="loyalty-review-refresh"
					>
						<Icon name="refresh-cw" className="size-4" />
						<Trans>Refresh</Trans>
					</Button>
				</div>
			</CardHeader>
			<CardContent className="flex flex-col gap-2">
				{error ? (
					<Alert variant="destructive" data-testid="loyalty-review-error">
						<Icon name="alert-triangle" />
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				<p
					role="status"
					className={notice ? 'text-sm' : 'sr-only'}
					data-testid="loyalty-review-notice"
				>
					{notice}
				</p>

				{loading ? (
					<div role="status" data-testid="loyalty-review-loading">
						<span className="sr-only">
							<Trans>Loading the review queue…</Trans>
						</span>
						<Skeleton className="h-16 w-full" />
					</div>
				) : null}

				{empty && !error ? (
					<p
						className="text-muted-foreground py-4 text-center text-sm"
						data-testid="loyalty-review-empty"
					>
						<Trans>Nothing is waiting for review.</Trans>
					</p>
				) : null}

				{redemptions.map((redemption) => (
					<div
						key={redemption.id}
						className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
						data-testid={`loyalty-review-redemption-${redemption.id}`}
					>
						<div className="flex min-w-0 flex-col gap-1">
							<div className="flex flex-wrap items-center gap-2">
								<Badge variant="warning">
									<Trans>Redemption</Trans>
								</Badge>
								<span className="font-medium wrap-anywhere">
									{redemption.rewardName}
								</span>
							</div>
							<span className="text-muted-foreground text-xs">
								{[
									redemption.reviewReason
										? loyaltyEnumLabel(
												tx,
												LOYALTY_REVIEW_REASON_LABELS,
												redemption.reviewReason,
											)
										: null,
									formatLoyaltyInstant(redemption.updatedAt, i18n.locale),
								]
									.filter(Boolean)
									.join(' · ')}
							</span>
							<span className="text-muted-foreground text-xs">
								<Plural
									value={redemption.points}
									one="# point"
									other="# points"
								/>
								{' · '}
								<bdi>
									{formatLoyaltyMoney(
										redemption.discountMinor,
										redemption.currency,
										i18n.locale,
									)}
								</bdi>
							</span>
						</div>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => setTarget({ kind: 'redemption', redemption })}
							data-testid={`loyalty-review-open-redemption-${redemption.id}`}
						>
							<Trans>Review</Trans>
						</Button>
					</div>
				))}

				{purchases.map((purchase) => (
					<div
						key={purchase.id}
						className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
						data-testid={`loyalty-review-purchase-${purchase.id}`}
					>
						<div className="flex min-w-0 flex-col gap-1">
							<div className="flex flex-wrap items-center gap-2">
								<Badge variant="warning">
									<Trans>Sale</Trans>
								</Badge>
								<span className="font-medium">
									{loyaltyEnumLabel(
										tx,
										LOYALTY_PURCHASE_SOURCE_LABELS,
										purchase.sourceType,
									)}
								</span>
							</div>
							<span className="text-muted-foreground text-xs">
								{[
									purchase.reviewReason
										? loyaltyEnumLabel(
												tx,
												LOYALTY_REVIEW_REASON_LABELS,
												purchase.reviewReason,
											)
										: null,
									formatLoyaltyInstant(purchase.occurredAt, i18n.locale),
								]
									.filter(Boolean)
									.join(' · ')}
							</span>
							<bdi className="text-muted-foreground text-xs">
								{formatLoyaltyMoney(
									purchase.totalPaidMinor,
									purchase.currency,
									i18n.locale,
								)}
							</bdi>
						</div>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => setTarget({ kind: 'purchase', purchase })}
							data-testid={`loyalty-review-open-purchase-${purchase.id}`}
						>
							<Trans>Review</Trans>
						</Button>
					</div>
				))}

				{parked.map((source) => {
					const key = parkedKey(source)
					const lastError = source.lastError
					return (
						<div
							key={key}
							className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm"
							data-testid={`loyalty-review-parked-${key}`}
						>
							<div className="flex min-w-0 flex-col gap-1">
								<div className="flex flex-wrap items-center gap-2">
									<Badge variant="warning">
										<Trans>Not updated</Trans>
									</Badge>
									<span className="font-medium">
										{loyaltyEnumLabel(
											tx,
											LOYALTY_PURCHASE_SOURCE_LABELS,
											source.sourceType,
										)}
									</span>
								</div>
								<span className="text-muted-foreground text-xs">
									<Trans>
										Points for this sale could not be updated automatically.
									</Trans>
								</span>
								<span className="text-muted-foreground text-xs">
									<Plural
										value={source.attempts}
										one="# attempt failed"
										other="# attempts failed"
									/>
									{' · '}
									{formatLoyaltyInstant(source.parkedAt, i18n.locale)}
									{lastError ? (
										<>
											{' · '}
											<Trans>
												Error code: <bdi>{lastError}</bdi>
											</Trans>
										</>
									) : null}
								</span>
							</div>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => void retry(source)}
								disabled={retrying !== null}
								data-testid={`loyalty-review-retry-${key}`}
							>
								<Trans>Try again</Trans>
							</Button>
						</div>
					)
				})}
			</CardContent>

			{target ? (
				<ResolveDialog
					key={
						target.kind === 'redemption'
							? `redemption-${target.redemption.id}`
							: `purchase-${target.purchase.id}`
					}
					client={client}
					target={target}
					finalFocus={finalFocus}
					onClose={() => setTarget(null)}
					onResolved={() => {
						settle()
						setTarget(null)
						void load()
					}}
				/>
			) : null}
		</Card>
	)
}

function ResolveDialog({
	client,
	target,
	finalFocus,
	onClose,
	onResolved,
}: {
	client: LoyaltyClient
	target: ReviewTarget
	finalFocus: () => HTMLElement | boolean
	onClose: () => void
	onResolved: () => void
}) {
	const { t, i18n } = useLingui()
	const [submitting, setSubmitting] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const keyRef = useRef<LoyaltySubmitKeyRef | null>(null)
	if (!keyRef.current) {
		keyRef.current = { current: newLoyaltySubmitKey('resolve') }
	}

	const schema = useMemo(
		() =>
			z.object({
				note: z
					.string()
					.trim()
					.min(3, t`Add a short note explaining the decision.`)
					.max(280, t`Keep the note under 280 characters.`)
					.default(''),
			}),
		[t],
	)

	const [form, fields] = useForm({
		id: 'loyalty-resolve-form',
		defaultValue: { note: '' },
		onValidate({ formData }) {
			return parseWithZod(formData, { schema })
		},
		shouldValidate: 'onBlur',
		shouldRevalidate: 'onInput',
	})

	const decide = useCallback(
		(action: 'consume' | 'release' | 'award' | 'exclude') => {
			const formElement = document.getElementById(
				form.id,
			) as HTMLFormElement | null
			if (!formElement) return
			const submission = parseWithZod(new FormData(formElement), { schema })
			if (submission.status !== 'success') {
				// Shows the field errors without submitting.
				form.validate()
				return
			}
			const note = submission.value.note
			const ref = keyRef.current!
			setSubmitting(true)
			setError(null)
			const request: Promise<unknown> =
				target.kind === 'redemption'
					? client.resolveRedemption(
							target.redemption.id,
							{ action: action as 'consume' | 'release', note },
							loyaltyKeyForSubmit(ref, 'resolve', {
								kind: 'redemption',
								id: target.redemption.id,
								action,
								note,
							}),
						)
					: client.resolvePurchase(
							target.purchase.id,
							{ action: action as 'award' | 'exclude', note },
							loyaltyKeyForSubmit(ref, 'resolve', {
								kind: 'purchase',
								id: target.purchase.id,
								action,
								note,
							}),
						)
			request
				.then(() => {
					onResolved()
				})
				.catch((err: unknown) => {
					afterFailedLoyaltySubmit(ref, 'resolve', err)
					setError(
						loyaltyErrorMessage(
							err,
							(d) => i18n._(d),
							msg`The decision could not be saved.`,
						),
					)
				})
				.finally(() => {
					setSubmitting(false)
				})
		},
		[client, target, form, schema, i18n, onResolved],
	)

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				// Closing mid-request would read as a cancel, but the decision lands.
				if (!open && !submitting) onClose()
			}}
		>
			<DialogContent
				className="sm:max-w-md"
				finalFocus={finalFocus}
				data-testid="loyalty-resolve-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						{target.kind === 'redemption' ? (
							<Trans>Review redemption</Trans>
						) : (
							<Trans>Review sale</Trans>
						)}
					</DialogTitle>
					<DialogDescription>
						{target.kind === 'redemption' ? (
							<Trans>
								Consume confirms the discount was honored and the sale paid;
								release returns the points to the customer.
							</Trans>
						) : (
							<Trans>
								Award credits the points for the sale; exclude leaves the sale
								out of the program.
							</Trans>
						)}
					</DialogDescription>
				</DialogHeader>

				<form
					{...getFormProps(form)}
					className="flex flex-col gap-4"
					data-testid="loyalty-resolve-form"
				>
					{error ? (
						<Alert variant="destructive" data-testid="loyalty-resolve-error">
							<Icon name="alert-triangle" />
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}

					<TextAreaField
						label={<Trans>Note</Trans>}
						hint={t`Recorded on the audit log.`}
						id="loyalty-resolve-note"
						name={fields.note.name}
						defaultValue=""
						error={fields.note.errors?.[0] ?? null}
						rows={3}
						maxLength={280}
						data-testid="loyalty-resolve-note"
					/>

					<ErrorList id={form.errorId} errors={form.errors} />

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={onClose}
							disabled={submitting}
						>
							<Trans>Cancel</Trans>
						</Button>
						{target.kind === 'redemption' ? (
							<>
								<Button
									type="button"
									variant="outline"
									disabled={submitting}
									onClick={() => decide('release')}
									data-testid="loyalty-resolve-release"
								>
									<Trans>Release points</Trans>
								</Button>
								<Button
									type="button"
									disabled={submitting}
									onClick={() => decide('consume')}
									data-testid="loyalty-resolve-consume"
								>
									<Trans>Consume</Trans>
								</Button>
							</>
						) : (
							<>
								<Button
									type="button"
									variant="outline"
									disabled={submitting}
									onClick={() => decide('exclude')}
									data-testid="loyalty-resolve-exclude"
								>
									<Trans>Exclude</Trans>
								</Button>
								<Button
									type="button"
									disabled={submitting}
									onClick={() => decide('award')}
									data-testid="loyalty-resolve-award"
								>
									<Trans>Award points</Trans>
								</Button>
							</>
						)}
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}

import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	ORDER_PROBLEM_CREDIT_DEFAULT_DAYS,
	operatorOrderProblemListSchema,
	operatorOrderProblemSchema,
	type OperatorOrderProblem,
	type OrderProblemEntryKind,
	type OrderProblemKind,
} from '@repo/common/order-problems'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { z } from 'zod'
import { TextAreaField, TextField } from '#app/components/staff/controls.tsx'
import {
	type OperatorRequestInit,
	OperatorRequestError,
} from '#app/hooks/use-operator-client.ts'
import { minorToMajorText, parseMoneyToMinor } from '#app/utils/money-input.ts'
import { formatMoney, relativeTime } from '#app/utils/orders/order-model.ts'

type Request = (path: string, init?: OperatorRequestInit) => Promise<unknown>

const KIND_LABELS: Record<OrderProblemKind, ReturnType<typeof msg>> = {
	missing_item: msg`Missing item`,
	wrong_item: msg`Wrong item`,
	late: msg`Late`,
	quality: msg`Quality`,
	other: msg`Other`,
}

const ENTRY_LABELS: Record<OrderProblemEntryKind, ReturnType<typeof msg>> = {
	report: msg`Guest report`,
	addition: msg`Guest added`,
	reply: msg`Your reply`,
	refund: msg`You refunded`,
	credit: msg`You gave a credit`,
	close: msg`You closed it`,
}

const ERRORS: Record<string, ReturnType<typeof msg>> = {
	problem_already_answered: msg`Someone already answered this report.`,
	refund_forbidden: msg`You need the right to refund orders to refund an online payment.`,
	refund_not_allowed: msg`Nothing was paid for this order, so there is nothing to refund. Give a credit instead.`,
	refund_exceeds_payment: msg`That is more than is left to refund on this order.`,
	refund_pending: msg`Another refund of this order is still on its way. Try again when it is done.`,
	payment_disputed: msg`This order's payment is disputed, so it cannot be refunded now.`,
	loyalty_refund_forbidden: msg`Refunding this order also moves loyalty points, which needs the right to manage loyalty redemptions.`,
	credit_not_allowed: msg`A credit cannot be given for this order.`,
}

type Action = 'refund' | 'credit' | 'reply' | null

function ProblemCard({
	problem,
	canWrite,
	canRefund,
	request,
	orgSlug,
	onChanged,
	showOrderLink,
}: {
	problem: OperatorOrderProblem
	canWrite: boolean
	canRefund: boolean
	request: Request
	orgSlug: string
	onChanged: () => void
	showOrderLink: boolean
}) {
	const { _, i18n } = useLingui()
	const [action, setAction] = useState<Action>(null)
	const [amount, setAmount] = useState(
		minorToMajorText(problem.affectedCents, problem.currency),
	)
	const [days, setDays] = useState(String(ORDER_PROBLEM_CREDIT_DEFAULT_DAYS))
	const [message, setMessage] = useState('')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const money = (cents: number) =>
		formatMoney(cents, problem.currency, i18n.locale)
	const orderNumber = problem.orderNumber
	const refundedText = money(problem.refundCents ?? 0)
	const creditText = money(problem.creditCents ?? 0)
	const affectedText = money(problem.affectedCents)
	const open = problem.status === 'open'
	const online = problem.paymentMethod === 'online'
	const paid = problem.paymentStatus === 'paid'
	const mayRefund = paid && (!online || canRefund)

	async function send(body: Record<string, unknown>) {
		setBusy(true)
		setError(null)
		try {
			const answered = await request(`/problems/${problem.id}/answer`, {
				method: 'POST',
				body: JSON.stringify(body),
			})
			z.object({ problem: operatorOrderProblemSchema })
				.passthrough()
				.parse(answered)
			setAction(null)
			setMessage('')
			onChanged()
		} catch (caught) {
			const code =
				caught instanceof OperatorRequestError ? caught.code : 'request_failed'
			setError(
				ERRORS[code]
					? _(ERRORS[code])
					: caught instanceof OperatorRequestError
						? caught.message
						: _(msg`The answer could not be sent. Try again.`),
			)
			if (code === 'problem_already_answered') onChanged()
		} finally {
			setBusy(false)
		}
	}

	function amountCents(): number | null {
		const cents = parseMoneyToMinor(amount, { currency: problem.currency })
		return cents && cents > 0 ? cents : null
	}

	function submit() {
		const note = message.trim()
		const withMessage = note ? { message: note } : {}
		if (action === 'refund') {
			const cents = amountCents()
			if (!cents) return setError(_(msg`Enter an amount greater than zero.`))
			return void send({ action: 'refund', amountCents: cents, ...withMessage })
		}
		if (action === 'credit') {
			const cents = amountCents()
			const validDays = Number.parseInt(days, 10)
			if (!cents) return setError(_(msg`Enter an amount greater than zero.`))
			if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) {
				return setError(_(msg`Enter a number of days from 1 to 365.`))
			}
			return void send({
				action: 'credit',
				amountCents: cents,
				validDays,
				...withMessage,
			})
		}
		if (action === 'reply') {
			if (!note) return setError(_(msg`Write the reply first.`))
			return void send({ action: 'reply', message: note })
		}
	}

	return (
		<li
			className="space-y-3 rounded-lg border p-4"
			data-testid="problem-card"
			data-problem-id={problem.id}
		>
			<div className="flex flex-wrap items-center gap-2">
				{showOrderLink ? (
					<Link
						to={`/${orgSlug}/orders/${problem.orderId}`}
						className="font-medium underline-offset-4 hover:underline"
					>
						<Trans>Order {orderNumber}</Trans>
					</Link>
				) : null}
				<Badge variant="secondary">{_(KIND_LABELS[problem.kind])}</Badge>
				{open ? (
					<Badge variant={problem.unanswered ? 'destructive' : 'warning'}>
						{problem.unanswered ? (
							<Trans>Waiting over a day</Trans>
						) : (
							<Trans>Waiting for you</Trans>
						)}
					</Badge>
				) : (
					<Badge variant="success">
						{problem.resolution === 'refund' ? (
							<Trans>Refunded</Trans>
						) : problem.resolution === 'credit' ? (
							<Trans>Credit given</Trans>
						) : problem.resolution === 'reply' ? (
							<Trans>Replied</Trans>
						) : (
							<Trans>Closed</Trans>
						)}
					</Badge>
				)}
				<span className="text-muted-foreground text-xs">
					{problem.locationName} ·{' '}
					{relativeTime(new Date(problem.createdAt).toISOString(), i18n.locale)}
				</span>
			</div>

			{problem.items.length > 0 ? (
				<ul className="text-sm" data-testid="problem-items">
					{problem.items.map((item) => (
						<li key={item.lineIndex}>
							{item.quantity} × {item.name}{' '}
							<span className="text-muted-foreground">
								({money(item.amountCents)})
							</span>
						</li>
					))}
				</ul>
			) : null}

			{problem.note ? (
				<blockquote
					className="border-s-2 ps-3 text-sm whitespace-pre-wrap"
					data-testid="problem-note"
				>
					{problem.note}
				</blockquote>
			) : null}

			{problem.photoUrl ? (
				<a
					href={problem.photoUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="block w-fit"
					data-testid="problem-photo"
				>
					<img
						src={problem.photoUrl}
						alt={_(msg`Photo from the guest`)}
						className="max-h-48 rounded-md border"
						referrerPolicy="no-referrer"
					/>
				</a>
			) : problem.hasPhoto ? (
				<p className="text-muted-foreground text-xs">
					<Trans>
						The guest attached a photo that cannot be shown right now.
					</Trans>
				</p>
			) : null}

			{problem.entries.length > 1 ? (
				<ol className="space-y-1 text-sm" data-testid="problem-thread">
					{problem.entries.map((entry) => (
						<li key={entry.id}>
							<span className="text-muted-foreground">
								{_(ENTRY_LABELS[entry.kind])}
								{entry.body ? ': ' : ''}
							</span>
							{entry.body ? (
								<span className="whitespace-pre-wrap">{entry.body}</span>
							) : null}
						</li>
					))}
				</ol>
			) : null}

			{problem.refundCents != null ? (
				<p className="text-sm">
					<Trans>Refunded {refundedText}</Trans>
				</p>
			) : null}
			{problem.creditCents != null ? (
				<p className="text-sm">
					<Trans>Credit given: {creditText}</Trans>
				</p>
			) : null}

			{open && canWrite ? (
				<div className="space-y-3 border-t pt-3">
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant={action === 'refund' ? 'default' : 'outline'}
							disabled={busy || !mayRefund}
							onClick={() => {
								setAction('refund')
								setError(null)
							}}
							data-testid="problem-refund"
						>
							<Trans>Refund the affected items</Trans>
						</Button>
						<Button
							type="button"
							variant={action === 'credit' ? 'default' : 'outline'}
							disabled={busy}
							onClick={() => {
								setAction('credit')
								setError(null)
							}}
							data-testid="problem-credit"
						>
							<Trans>Give a credit</Trans>
						</Button>
						<Button
							type="button"
							variant={action === 'reply' ? 'default' : 'outline'}
							disabled={busy}
							onClick={() => {
								setAction('reply')
								setError(null)
							}}
							data-testid="problem-reply"
						>
							<Trans>Reply only</Trans>
						</Button>
						<Button
							type="button"
							variant="ghost"
							disabled={busy}
							onClick={() => void send({ action: 'close' })}
							data-testid="problem-close"
						>
							<Trans>Close</Trans>
						</Button>
					</div>
					{!paid ? (
						<p className="text-muted-foreground text-xs">
							<Trans>
								Nothing was paid for this order yet, so it cannot be refunded.
							</Trans>
						</p>
					) : online && !canRefund ? (
						<p className="text-muted-foreground text-xs">
							<Trans>
								Refunding an online payment needs the right to refund orders.
							</Trans>
						</p>
					) : null}

					{action ? (
						<div className="space-y-3">
							{action === 'refund' || action === 'credit' ? (
								<div className="flex flex-wrap gap-3">
									<TextField
										label={
											action === 'refund'
												? _(msg`Refund amount`)
												: _(msg`Credit amount`)
										}
										hint={_(msg`Items named: ${affectedText}`)}
										value={amount}
										inputMode="decimal"
										onChange={(event) => setAmount(event.target.value)}
										data-testid="problem-amount"
									/>
									{action === 'credit' ? (
										<TextField
											label={_(msg`Valid for (days)`)}
											value={days}
											inputMode="numeric"
											onChange={(event) => setDays(event.target.value)}
											data-testid="problem-days"
										/>
									) : null}
								</div>
							) : null}
							<TextAreaField
								label={
									action === 'reply'
										? _(msg`Your reply`)
										: _(msg`Message to the guest`)
								}
								optional={action !== 'reply'}
								value={message}
								maxLength={1000}
								onChange={(event) => setMessage(event.target.value)}
								data-testid="problem-message"
							/>
							<Button
								type="button"
								disabled={busy}
								onClick={submit}
								data-testid="problem-send"
							>
								{action === 'refund' ? (
									<Trans>Send refund</Trans>
								) : action === 'credit' ? (
									<Trans>Send credit</Trans>
								) : (
									<Trans>Send reply</Trans>
								)}
							</Button>
						</div>
					) : null}
					{error ? (
						<p role="alert" className="text-destructive text-sm">
							{error}
						</p>
					) : null}
				</div>
			) : null}
		</li>
	)
}

const REFRESH_MS = 30_000

/** Loads the reports (and refreshes them every 30 seconds while the page is open). */
function useProblems(
	request: Request,
	query: string,
): {
	data: z.infer<typeof operatorOrderProblemListSchema> | null
	error: string | null
	reload: () => void
} {
	const { _ } = useLingui()
	const [data, setData] = useState<z.infer<
		typeof operatorOrderProblemListSchema
	> | null>(null)
	const [error, setError] = useState<string | null>(null)
	const requestRef = useRef(request)
	requestRef.current = request
	const load = useCallback(
		async (signal?: AbortSignal) => {
			try {
				const raw = await requestRef.current(`/problems${query}`, {
					signal,
					readOnly: true,
				})
				setData(operatorOrderProblemListSchema.parse(raw))
				setError(null)
			} catch (caught) {
				if (signal?.aborted) return
				setError(
					caught instanceof OperatorRequestError
						? caught.message
						: _(msg`The reports could not be loaded.`),
				)
			}
		},
		[query, _],
	)
	useEffect(() => {
		const controller = new AbortController()
		void load(controller.signal)
		const timer = window.setInterval(
			() => void load(controller.signal),
			REFRESH_MS,
		)
		return () => {
			controller.abort()
			window.clearInterval(timer)
		}
	}, [load])
	return { data, error, reload: () => void load() }
}

/** App, Orders, Problems: the inbox of guest reports, with the one-tap answers (#191). */
export function ProblemsInbox({
	orgSlug,
	canWrite,
	canRefund,
	request,
}: {
	orgSlug: string
	canWrite: boolean
	canRefund: boolean
	request: Request
}) {
	const [view, setView] = useState<'open' | 'all'>('open')
	const { data, error, reload } = useProblems(
		request,
		view === 'open' ? '?status=open&limit=100' : '?status=all&limit=100',
	)
	return (
		<div className="space-y-4" data-testid="problems-inbox">
			<div className="flex gap-2" role="tablist">
				<Button
					type="button"
					role="tab"
					aria-selected={view === 'open'}
					variant={view === 'open' ? 'default' : 'ghost'}
					onClick={() => setView('open')}
				>
					<Trans>Waiting</Trans>
					{data ? ` (${data.counts.open})` : ''}
				</Button>
				<Button
					type="button"
					role="tab"
					aria-selected={view === 'all'}
					variant={view === 'all' ? 'default' : 'ghost'}
					onClick={() => setView('all')}
				>
					<Trans>All reports</Trans>
				</Button>
			</div>
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
			{!data && !error ? (
				<p role="status">
					<Trans>Loading reports…</Trans>
				</p>
			) : null}
			{data && data.problems.length === 0 ? (
				<div className="rounded-lg border p-8 text-center">
					<h3 className="font-medium">
						{view === 'open' ? (
							<Trans>Nothing is waiting for an answer</Trans>
						) : (
							<Trans>No reports yet</Trans>
						)}
					</h3>
					<p className="text-muted-foreground mt-2 text-sm">
						<Trans>
							When a guest reports a problem with an order, it appears here.
						</Trans>
					</p>
				</div>
			) : null}
			{data && data.problems.length > 0 ? (
				<ul className="space-y-3" data-testid="problems-list">
					{data.problems.map((problem) => (
						<ProblemCard
							key={problem.id}
							problem={problem}
							canWrite={canWrite}
							canRefund={canRefund}
							request={request}
							orgSlug={orgSlug}
							onChanged={reload}
							showOrderLink
						/>
					))}
				</ul>
			) : null}
		</div>
	)
}

/** The reports of one order, beside the order itself (renders nothing without any). */
export function OrderProblemsPanel({
	orgSlug,
	orderId,
	canWrite,
	canRefund,
	request,
	onChanged,
}: {
	orgSlug: string
	orderId: string
	canWrite: boolean
	canRefund: boolean
	request: Request
	/** The order may have changed (a refund was booked): load it again. */
	onChanged?: () => void
}) {
	const { data, reload } = useProblems(
		request,
		`?status=all&orderId=${encodeURIComponent(orderId)}`,
	)
	if (!data || data.problems.length === 0) return null
	return (
		<section className="space-y-3" data-testid="order-problems-panel">
			<h2 className="text-lg font-semibold">
				<Trans>Problem reports</Trans>
			</h2>
			<ul className="space-y-3">
				{data.problems.map((problem) => (
					<ProblemCard
						key={problem.id}
						problem={problem}
						canWrite={canWrite}
						canRefund={canRefund}
						request={request}
						orgSlug={orgSlug}
						onChanged={() => {
							reload()
							onChanged?.()
						}}
						showOrderLink={false}
					/>
				))}
			</ul>
		</section>
	)
}

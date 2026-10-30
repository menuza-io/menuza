import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { type LoyaltyMemberSummary } from '@repo/loyalty'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Skeleton } from '@repo/ui/skeleton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AdjustDialog } from '#app/components/loyalty/adjust-dialog.tsx'
import {
	LOYALTY_PURCHASES_HEADING_ID,
	LoyaltyEntriesList,
	LoyaltyPurchasesList,
	LoyaltyRedemptionsList,
} from '#app/components/loyalty/customer-loyalty-lists.tsx'
import { LoyaltyClientProvider } from '#app/components/loyalty/loyalty-client-provider.tsx'
import {
	RecordRefundDialog,
	useRefundResultMessage,
} from '#app/components/loyalty/record-refund-dialog.tsx'
import { useLoyaltyClient } from '#app/hooks/use-loyalty-client.ts'
import { useSettledFocus } from '#app/hooks/use-settled-focus.ts'
import { type LoyaltyCapabilities } from '#app/utils/loyalty/capabilities.ts'
import {
	afterFailedLoyaltySubmit,
	loyaltyKeyForSubmit,
	newLoyaltySubmitKey,
	type LoyaltyClient,
	type LoyaltyMemberDetail,
} from '#app/utils/loyalty/loyalty-client.ts'
import { loyaltyErrorMessage } from '#app/utils/loyalty/loyalty-errors.ts'
import {
	LOYALTY_MEMBER_STATUS_LABELS,
	loyaltyEnumLabel,
} from '#app/utils/loyalty/loyalty-labels.ts'

type PanelState =
	| { kind: 'loading' }
	| { kind: 'failed'; message: string }
	| { kind: 'none' }
	| { kind: 'ready'; detail: LoyaltyMemberDetail }

/**
 * The points account of one customer, on the Customer profile. Everything is
 * read browser-direct from the regional tenant-api with a scoped token: App
 * loaders only decide whether the panel shows (flag and grants), never carry
 * the balance or history.
 */
export function CustomerLoyaltyPanel({
	orgSlug,
	customerId,
	capabilities,
}: {
	orgSlug: string
	customerId: string
	capabilities: LoyaltyCapabilities
}) {
	if (!capabilities.enabled || !capabilities.canRead) return null
	return (
		<LoyaltyClientProvider orgSlug={orgSlug}>
			<ProvidedCustomerLoyaltyPanel
				customerId={customerId}
				capabilities={capabilities}
			/>
		</LoyaltyClientProvider>
	)
}

function ProvidedCustomerLoyaltyPanel({
	customerId,
	capabilities,
}: {
	customerId: string
	capabilities: LoyaltyCapabilities
}) {
	const client = useLoyaltyClient()
	return (
		<CustomerLoyaltyPanelView
			client={client}
			customerId={customerId}
			canAdjust={capabilities.canAdjust}
			canRecordRefund={capabilities.canReconcile}
		/>
	)
}

export function CustomerLoyaltyPanelView({
	client,
	customerId,
	canAdjust,
	canRecordRefund,
}: {
	client: LoyaltyClient
	customerId: string
	canAdjust: boolean
	canRecordRefund: boolean
}) {
	const { i18n } = useLingui()
	const tx = useCallback((d: MessageDescriptor) => i18n._(d), [i18n])
	const refundMessage = useRefundResultMessage()
	const [state, setState] = useState<PanelState>({ kind: 'loading' })
	const [error, setError] = useState<string | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [adjustOpen, setAdjustOpen] = useState(false)
	const [refundTarget, setRefundTarget] = useState<
		LoyaltyMemberDetail['purchases'][number] | null
	>(null)
	const [statusBusy, setStatusBusy] = useState(false)
	const statusKeyRef = useRef(newLoyaltySubmitKey('member-status'))
	const statusButtonRef = useRef<HTMLButtonElement>(null)
	const refocusStatus = useRef(false)
	// The button is disabled while the change runs, which drops keyboard
	// focus; the swapped Suspend or Reactivate button takes it back.
	useEffect(() => {
		if (statusBusy || !refocusStatus.current) return
		refocusStatus.current = false
		statusButtonRef.current?.focus()
	}, [statusBusy])
	// A fully refunded sale loses its Record refund button.
	const refundFocus = useSettledFocus(LOYALTY_PURCHASES_HEADING_ID)

	// One request at a time: a slow answer for an earlier load must never
	// replace the newer one.
	const requestRef = useRef<AbortController | null>(null)
	const startRequest = useCallback(() => {
		requestRef.current?.abort()
		const controller = new AbortController()
		requestRef.current = controller
		return controller
	}, [])

	const load = useCallback(
		async (options: { quiet?: boolean } = {}) => {
			const request = startRequest()
			if (!options.quiet) setState({ kind: 'loading' })
			try {
				const summary = await client.getCustomerMember(
					customerId,
					request.signal,
				)
				if (request.signal.aborted) return
				if (!summary) {
					setState({ kind: 'none' })
					return
				}
				const detail = await client.getMember(summary.id, request.signal)
				if (request.signal.aborted) return
				setState({ kind: 'ready', detail })
				setError(null)
			} catch (err) {
				if (request.signal.aborted) return
				setState({
					kind: 'failed',
					message: loyaltyErrorMessage(
						err,
						tx,
						msg`The points account could not be loaded.`,
					),
				})
			}
		},
		[client, customerId, startRequest, tx],
	)

	useEffect(() => {
		setError(null)
		setNotice(null)
		setAdjustOpen(false)
		setRefundTarget(null)
		void load()
		return () => requestRef.current?.abort()
	}, [load])

	const detail = state.kind === 'ready' ? state.detail : null
	const member: LoyaltyMemberSummary | null = detail?.member ?? null

	const changeStatus = useCallback(
		async (next: 'active' | 'suspended') => {
			if (!member) return
			refocusStatus.current = document.activeElement === statusButtonRef.current
			setStatusBusy(true)
			setError(null)
			const body = { status: next }
			try {
				await client.setMemberStatus(
					member.id,
					body,
					loyaltyKeyForSubmit(statusKeyRef, 'member-status', {
						memberId: member.id,
						...body,
					}),
				)
				statusKeyRef.current = newLoyaltySubmitKey('member-status')
				await load({ quiet: true })
			} catch (err) {
				afterFailedLoyaltySubmit(statusKeyRef, 'member-status', err)
				setError(
					loyaltyErrorMessage(
						err,
						tx,
						msg`The account status could not be changed.`,
					),
				)
			} finally {
				setStatusBusy(false)
			}
		},
		[client, member, load, tx],
	)

	return (
		<Frame
			role="region"
			aria-labelledby="customer-loyalty-title"
			data-testid="customer-loyalty"
		>
			<FrameHeader>
				<FrameTitle id="customer-loyalty-title">
					<Trans>Loyalty</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>Points this customer has earned with your program.</Trans>
				</FrameDescription>
			</FrameHeader>

			{state.kind === 'loading' ? (
				<FramePanel>
					<div
						role="status"
						className="flex flex-col gap-2"
						data-testid="customer-loyalty-loading"
					>
						<span className="sr-only">
							<Trans>Loading the points account…</Trans>
						</span>
						<Skeleton className="h-16 w-full" />
						<Skeleton className="h-24 w-full" />
					</div>
				</FramePanel>
			) : null}

			{state.kind === 'failed' ? (
				<FramePanel>
					<Alert variant="destructive" data-testid="customer-loyalty-error">
						<Icon name="alert-triangle" />
						<AlertDescription>
							<div className="flex flex-wrap items-center gap-3">
								{state.message}
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => void load()}
								>
									<Trans>Try again</Trans>
								</Button>
							</div>
						</AlertDescription>
					</Alert>
				</FramePanel>
			) : null}

			{state.kind === 'none' ? (
				<FramePanel>
					<p
						className="text-muted-foreground text-sm"
						data-testid="customer-loyalty-none"
					>
						<Trans>
							No points account yet. It is opened automatically when the
							customer signs in on the website or the app.
						</Trans>
					</p>
				</FramePanel>
			) : null}

			{detail && member ? (
				<FramePanel className="flex flex-col gap-4">
					{error ? (
						<Alert variant="destructive" data-testid="customer-loyalty-failure">
							<Icon name="alert-triangle" />
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					{notice ? (
						<Alert data-testid="customer-loyalty-notice">
							<Icon name="check" />
							<AlertDescription>{notice}</AlertDescription>
						</Alert>
					) : null}

					<dl
						className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border"
						data-testid="customer-loyalty-balance"
					>
						<Balance
							label={<Trans>Available</Trans>}
							value={member.balance.available}
						/>
						<Balance
							label={<Trans>Reserved</Trans>}
							value={member.balance.reserved}
						/>
						<Balance
							label={<Trans>Lifetime earned</Trans>}
							value={member.balance.lifetimeEarned}
						/>
					</dl>

					<div className="flex flex-wrap items-center gap-2">
						<Badge
							variant={member.status === 'active' ? 'success' : 'warning'}
							data-testid="customer-loyalty-status"
						>
							{loyaltyEnumLabel(
								tx,
								LOYALTY_MEMBER_STATUS_LABELS,
								member.status,
							)}
						</Badge>
						{detail.filteredByLocation ? (
							<span className="text-muted-foreground text-xs">
								<Trans>Activity at other locations is hidden.</Trans>
							</span>
						) : null}
						{canAdjust ? (
							<div className="ms-auto flex items-center gap-2">
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => setAdjustOpen(true)}
									data-testid="customer-loyalty-adjust-open"
								>
									<Trans>Adjust points</Trans>
								</Button>
								{member.status === 'active' ? (
									<Button
										ref={statusButtonRef}
										type="button"
										size="sm"
										variant="outline"
										disabled={statusBusy}
										onClick={() => void changeStatus('suspended')}
										data-testid="customer-loyalty-suspend"
									>
										<Trans>Suspend</Trans>
									</Button>
								) : member.status === 'suspended' ? (
									<Button
										ref={statusButtonRef}
										type="button"
										size="sm"
										disabled={statusBusy}
										onClick={() => void changeStatus('active')}
										data-testid="customer-loyalty-reactivate"
									>
										<Trans>Reactivate</Trans>
									</Button>
								) : null}
							</div>
						) : null}
					</div>

					<LoyaltyEntriesList entries={detail.entries} />
					<LoyaltyPurchasesList
						purchases={detail.purchases}
						canRecordRefund={canRecordRefund}
						onRecordRefund={(purchase) => {
							setNotice(null)
							setRefundTarget(purchase)
						}}
					/>
					<LoyaltyRedemptionsList redemptions={detail.redemptions} />
				</FramePanel>
			) : null}

			{refundTarget && refundTarget.sourceType === 'qr_tab' ? (
				<RecordRefundDialog
					key={refundTarget.id}
					client={client}
					source={{ type: refundTarget.sourceType, id: refundTarget.sourceId }}
					amounts={{
						currency: refundTarget.currency,
						paidMinor:
							refundTarget.state === 'completed'
								? refundTarget.totalPaidMinor
								: null,
						refundedMinor: refundTarget.refundedMinor,
					}}
					open
					onOpenChange={(open) => {
						if (!open) setRefundTarget(null)
					}}
					finalFocus={refundFocus.finalFocus}
					onRecorded={(result) => {
						refundFocus.settle()
						setRefundTarget(null)
						setNotice(refundMessage(result))
						void load({ quiet: true })
					}}
				/>
			) : null}

			{member && canAdjust ? (
				<AdjustDialog
					key={member.id}
					client={client}
					member={member}
					open={adjustOpen}
					onOpenChange={setAdjustOpen}
					onAdjusted={() => {
						setAdjustOpen(false)
						void load({ quiet: true })
					}}
				/>
			) : null}
		</Frame>
	)
}

function Balance({ label, value }: { label: React.ReactNode; value: number }) {
	return (
		<div className="bg-card flex flex-col gap-1 px-3 py-2.5">
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd className="text-lg font-semibold tabular-nums" dir="ltr">
				{value}
			</dd>
		</div>
	)
}

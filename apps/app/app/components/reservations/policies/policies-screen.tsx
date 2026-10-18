import { msg, plural } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import {
	AlertDialog,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { Skeleton } from '@repo/ui/skeleton'
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from '@repo/ui/table'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { PolicySheet } from '#app/components/reservations/policies/policy-sheet.tsx'
import { type Option, SelectField } from '#app/components/staff/controls.tsx'
import { formatMoney } from '#app/utils/reservations/payments-view.ts'
import {
	archivePolicy,
	createPolicy,
	fetchPolicies,
	fetchPolicyAttachments,
	type PolicyAttachments,
	type PolicyBody,
	type PolicyDto,
	setDefaultPolicy,
	setServicePolicy,
	updatePolicy,
} from '#app/utils/reservations/policies-api.ts'
import {
	policyErrorCode,
	policyErrorMessage,
	policyErrorStatus,
	POLICY_KIND_LABELS,
} from '#app/utils/reservations/policies-view.ts'
import { type ReservationsScopedClient } from '#app/utils/reservations/reservations-client.ts'

const NO_POLICY = '__none__'

type LoadState =
	| { status: 'loading' }
	| { status: 'denied' }
	| { status: 'failed' }
	| {
			status: 'ready'
			policies: PolicyDto[]
			attachments: PolicyAttachments
	  }

/**
 * Payment policies of one location: what guests pay or guarantee to book, and
 * where each policy applies (the location default and per service). Reads and
 * writes go browser-direct to the regional tenant-api with a `setup` token.
 */
export function PoliciesScreen({
	client,
	locationId,
	canWrite,
	region,
	onSettingsSaved,
}: {
	client: ReservationsScopedClient
	locationId: string
	canWrite: boolean
	region: string | null
	/** The location default lives in the settings, whose version other screens share. */
	onSettingsSaved?: () => void
}) {
	const { t, i18n } = useLingui()
	const [state, setState] = useState<LoadState>({ status: 'loading' })
	const [sheet, setSheet] = useState<
		{ mode: 'create' } | { mode: 'edit'; id: string } | null
	>(null)
	const [archiving, setArchiving] = useState<PolicyDto | null>(null)
	const [busy, setBusy] = useState(false)
	const [attachError, setAttachError] = useState<string | null>(null)
	const requestId = useRef(0)

	const load = useCallback(
		async (signal?: AbortSignal) => {
			const current = (requestId.current += 1)
			try {
				const [policies, attachments] = await Promise.all([
					fetchPolicies(client, locationId, signal),
					fetchPolicyAttachments(client, locationId, signal),
				])
				if (current !== requestId.current) return
				setState({ status: 'ready', policies, attachments })
			} catch (error) {
				if (signal?.aborted || current !== requestId.current) return
				const status = policyErrorStatus(error)
				setState({
					status: status === 403 || status === 404 ? 'denied' : 'failed',
				})
			}
		},
		[client, locationId],
	)

	useEffect(() => {
		const controller = new AbortController()
		setState({ status: 'loading' })
		void load(controller.signal)
		return () => controller.abort()
	}, [load])

	const policies = useMemo(
		() => (state.status === 'ready' ? state.policies : []),
		[state],
	)
	const currency = state.status === 'ready' ? state.attachments.currency : 'USD'
	const editing =
		sheet?.mode === 'edit'
			? (policies.find((policy) => policy.id === sheet.id) ?? null)
			: null

	const usage = useMemo(() => {
		const counts = new Map<string, number>()
		if (state.status !== 'ready') return counts
		for (const service of state.attachments.services) {
			if (service.policyId) {
				counts.set(service.policyId, (counts.get(service.policyId) ?? 0) + 1)
			}
		}
		return counts
	}, [state])

	const policyOptions: Option[] = useMemo(
		() => [
			{ value: NO_POLICY, label: i18n._(msg`No payment policy`) },
			...policies.map((policy) => ({ value: policy.id, label: policy.name })),
		],
		[policies, i18n],
	)

	async function save(body: PolicyBody) {
		try {
			if (sheet?.mode === 'edit' && editing) {
				await updatePolicy(
					client,
					locationId,
					editing.id,
					body,
					editing.version,
				)
			} else {
				await createPolicy(client, locationId, body)
			}
		} catch (error) {
			// A conflict reloads the list; the draft in the sheet is left as typed.
			if (policyErrorCode(error) === 'stale_version') void load()
			throw error
		}
		toast.success(t`Policy saved.`)
		setSheet(null)
		await load()
	}

	async function archive() {
		if (!archiving) return
		setBusy(true)
		try {
			await archivePolicy(client, locationId, archiving.id)
			toast.success(t`Policy archived.`)
			setArchiving(null)
			await load()
		} catch (error) {
			toast.error(
				policyErrorMessage(
					error,
					(descriptor) => i18n._(descriptor),
					msg`The policy could not be archived. Try again.`,
				),
			)
			if (policyErrorStatus(error) === 404) await load()
		} finally {
			setBusy(false)
		}
	}

	async function attach(
		run: () => Promise<void>,
		failure: ReturnType<typeof msg>,
	) {
		setBusy(true)
		setAttachError(null)
		try {
			await run()
			toast.success(t`Saved.`)
		} catch (error) {
			setAttachError(
				policyErrorMessage(error, (descriptor) => i18n._(descriptor), failure),
			)
		} finally {
			// Always show what the region now says, even after a conflict.
			await load()
			setBusy(false)
		}
	}

	function cancellationText(policy: PolicyDto): string {
		if (policy.kind === 'none') return '—'
		if (policy.freeCancelUntilMin === 0) return t`Never free`
		const hours = i18n.number(policy.freeCancelUntilMin / 60, {
			maximumFractionDigits: 2,
		})
		return t`Free until ${hours} h before`
	}

	function amountText(policy: PolicyDto): string {
		if (policy.kind === 'none') return '—'
		if (policy.kind === 'card_guarantee') return t`Card only`
		const amount = formatMoney(policy.amountMinor, policy.currency, i18n.locale)
		return policy.perCover ? t`${amount} per guest` : t`${amount} per booking`
	}

	function feesText(policy: PolicyDto): string {
		if (policy.kind === 'none') return '—'
		const parts: string[] = []
		if (policy.noShowFeeMinor > 0) {
			const fee = formatMoney(
				policy.noShowFeeMinor,
				policy.currency,
				i18n.locale,
			)
			parts.push(t`No-show ${fee}`)
		}
		if (policy.lateCancelFeeMinor > 0) {
			const fee = formatMoney(
				policy.lateCancelFeeMinor,
				policy.currency,
				i18n.locale,
			)
			parts.push(t`Late cancel ${fee}`)
		}
		return parts.length > 0 ? parts.join(' · ') : '—'
	}

	return (
		<div className="flex flex-col gap-6" data-testid="policies-screen">
			<PageHeader
				size="section"
				headingLevel="h2"
				title={<Trans>Payment policies</Trans>}
				description={
					<Trans>
						Choose what guests pay or guarantee to book, and what happens when
						they cancel or do not show.
					</Trans>
				}
				actions={
					canWrite ? (
						<Button
							type="button"
							onClick={() => setSheet({ mode: 'create' })}
							disabled={state.status !== 'ready'}
							data-testid="policy-new"
						>
							<Icon name="plus" />
							<Trans>New policy</Trans>
						</Button>
					) : null
				}
			/>

			{region === 'ksa' ? (
				<Alert data-testid="policies-ksa-note">
					<AlertDescription>
						<Trans>
							Prepaid deposits are recommended in this region. Card guarantees
							and fees depend on the guest&apos;s bank and may ask the guest to
							confirm.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{state.status === 'loading' ? (
				<div className="flex flex-col gap-2" data-testid="policies-loading">
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
					<Skeleton className="h-10 w-full" />
				</div>
			) : state.status === 'denied' ? (
				<Alert variant="destructive" data-testid="policies-denied">
					<AlertDescription>
						<Trans>You do not have access to payment policies here.</Trans>
					</AlertDescription>
				</Alert>
			) : state.status === 'failed' ? (
				<Alert variant="destructive" data-testid="policies-error">
					<AlertDescription>
						<div className="flex flex-wrap items-center gap-3">
							<Trans>The payment policies could not be loaded.</Trans>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={() => {
									setState({ status: 'loading' })
									void load()
								}}
							>
								<Trans>Try again</Trans>
							</Button>
						</div>
					</AlertDescription>
				</Alert>
			) : policies.length === 0 ? (
				<EmptyState
					icons={['credit-card', 'shield', 'clock']}
					title={<Trans>No payment policies yet</Trans>}
					description={
						<Trans>
							Without a policy, guests book without paying. Create a deposit,
							prepayment or card guarantee to protect busy nights.
						</Trans>
					}
				>
					{canWrite ? (
						<Button type="button" onClick={() => setSheet({ mode: 'create' })}>
							<Icon name="plus" />
							<Trans>New policy</Trans>
						</Button>
					) : null}
				</EmptyState>
			) : (
				<>
					<Frame>
						<Table variant="card" data-testid="policies-table">
							<TableHeader>
								<TableRow>
									<TableHead>
										<Trans>Policy</Trans>
									</TableHead>
									<TableHead>
										<Trans>Guests pay</Trans>
									</TableHead>
									<TableHead>
										<Trans>Cancellation</Trans>
									</TableHead>
									<TableHead>
										<Trans>Fees</Trans>
									</TableHead>
									<TableHead>
										<Trans>Used by</Trans>
									</TableHead>
									<TableHead className="w-24 text-end">
										<span className="sr-only">
											<Trans>Actions</Trans>
										</span>
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{policies.map((policy) => {
									const services = usage.get(policy.id) ?? 0
									const isDefault =
										state.status === 'ready' &&
										state.attachments.defaultPolicyId === policy.id
									return (
										<TableRow
											key={policy.id}
											data-testid="policy-row"
											data-policy-kind={policy.kind}
										>
											<TableCell className="min-w-40">
												<div className="flex flex-col gap-0.5">
													<span className="font-medium wrap-anywhere">
														{policy.name}
													</span>
													<span className="text-muted-foreground text-xs">
														{i18n._(POLICY_KIND_LABELS[policy.kind])}
													</span>
												</div>
											</TableCell>
											<TableCell className="tabular-nums">
												{amountText(policy)}
											</TableCell>
											<TableCell>{cancellationText(policy)}</TableCell>
											<TableCell className="tabular-nums">
												{feesText(policy)}
											</TableCell>
											<TableCell className="text-muted-foreground text-sm">
												{isDefault ? t`Location default` : null}
												{isDefault && services > 0 ? ' · ' : null}
												{services > 0
													? plural(services, {
															one: '# service',
															other: '# services',
														})
													: isDefault
														? null
														: '—'}
											</TableCell>
											<TableCell className="text-end">
												{canWrite ? (
													<div className="flex justify-end gap-1">
														<Button
															type="button"
															size="sm"
															variant="ghost"
															onClick={() =>
																setSheet({ mode: 'edit', id: policy.id })
															}
															data-testid="policy-edit"
														>
															<Trans>Edit</Trans>
														</Button>
														<Button
															type="button"
															size="icon-sm"
															variant="ghost"
															aria-label={t`Archive policy`}
															onClick={() => setArchiving(policy)}
															data-testid="policy-archive"
														>
															<Icon name="trash-2" />
														</Button>
													</div>
												) : null}
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					</Frame>

					{state.status === 'ready' ? (
						<Frame data-testid="policy-attachments">
							<FrameHeader>
								<FrameTitle className="font-medium">
									<Trans>Where policies apply</Trans>
								</FrameTitle>
								<FrameDescription>
									<Trans>
										A service uses its own policy first, then the location
										default.
									</Trans>
								</FrameDescription>
							</FrameHeader>
							<FramePanel className="flex flex-col gap-5">
								{attachError ? (
									<Alert
										variant="destructive"
										data-testid="policy-attach-error"
									>
										<AlertDescription>{attachError}</AlertDescription>
									</Alert>
								) : null}
								<SelectField
									label={<Trans>Location default</Trans>}
									value={state.attachments.defaultPolicyId ?? NO_POLICY}
									options={policyOptions}
									disabled={!canWrite || busy}
									onValueChange={(value) =>
										void attach(
											async () => {
												await setDefaultPolicy(
													client,
													locationId,
													value === NO_POLICY ? null : value,
													state.attachments.settingsVersion,
												)
												onSettingsSaved?.()
											},
											msg`The default policy could not be saved. Try again.`,
										)
									}
									id="policy-default"
								/>
								{state.attachments.services.map((service) => (
									<SelectField
										key={service.id}
										label={service.name}
										value={service.policyId ?? NO_POLICY}
										options={policyOptions}
										disabled={!canWrite || busy}
										onValueChange={(value) =>
											void attach(
												() =>
													setServicePolicy(
														client,
														locationId,
														service.id,
														value === NO_POLICY ? null : value,
													),
												msg`The service policy could not be saved. Try again.`,
											)
										}
									/>
								))}
							</FramePanel>
						</Frame>
					) : null}
				</>
			)}

			<PolicySheet
				open={sheet !== null && (sheet.mode === 'create' || editing !== null)}
				onClose={() => setSheet(null)}
				policy={editing}
				currency={currency}
				region={region}
				onSave={save}
			/>

			<AlertDialog
				open={archiving !== null}
				onOpenChange={(open) => {
					if (!open && !busy) setArchiving(null)
				}}
			>
				<AlertDialogContent data-testid="policy-archive-dialog">
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Archive this policy?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								New bookings stop using it. Bookings that already accepted it
								keep their terms.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>
							<Trans>Keep policy</Trans>
						</AlertDialogCancel>
						<Button
							type="button"
							variant="destructive"
							disabled={busy}
							onClick={() => void archive()}
							data-testid="policy-archive-confirm"
						>
							<Trans>Archive</Trans>
						</Button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

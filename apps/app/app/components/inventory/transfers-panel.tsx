import { Plural, Trans, useLingui } from '@lingui/react/macro'
import {
	listTransfersResultSchema,
	type TransferDetail,
	transferDetailSchema,
	type TransferSummary,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Skeleton } from '@repo/ui/skeleton'
import { WorkspacePanel } from '@repo/ui/workspace'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
	useInventoryRevision,
	useNotifyInventoryChanged,
} from '#app/components/inventory/inventory-prefs.tsx'
import {
	ConfirmTransferDialog,
	CreateTransferDialog,
	type TransferPlace,
} from '#app/components/inventory/transfer-dialogs.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventoryErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import {
	transferActions,
	transferErrorMessage,
	transferStatusLabel,
} from '#app/utils/inventory/transfer-form.ts'

/**
 * Open transfers and requests of the place being looked at, on Purchasing:
 * what is on its way in, what it must send, and what it asked for. Sending and
 * receiving confirm the real amounts in a dialog; stock moves only then.
 */
export function TransfersPanel({
	locationId,
	places,
	canEdit,
	canSeeCost,
	currency,
}: {
	locationId: string
	places: readonly TransferPlace[]
	canEdit: boolean
	canSeeCost: boolean
	currency: string
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const query = useInventoryQuery(
		`/transfers?${new URLSearchParams({ locationId, direction: 'all', status: 'open' })}`,
		listTransfersResultSchema,
	)
	const { reload } = query
	const revision = useInventoryRevision()
	const seen = useRef(revision)
	useEffect(() => {
		if (revision !== seen.current) {
			seen.current = revision
			reload()
		}
	}, [revision, reload])

	const [creating, setCreating] = useState<'transfer' | 'request' | null>(null)
	const [confirm, setConfirm] = useState<{
		step: 'send' | 'receive'
		transfer: TransferDetail
	} | null>(null)
	const [busyId, setBusyId] = useState<string | null>(null)

	const name = (id: string) =>
		places.find((place) => place.id === id)?.name ?? t`Another place`
	const others = places.filter((place) => place.id !== locationId)
	const rows = query.data?.transfers ?? []

	async function openConfirm(
		summary: TransferSummary,
		step: 'send' | 'receive',
	) {
		setBusyId(summary.id)
		try {
			const transfer = transferDetailSchema.parse(
				await request(`/transfers/${encodeURIComponent(summary.id)}`),
			)
			setConfirm({ step, transfer })
		} catch (caught) {
			toast.error(i18n._(inventoryErrorMessage(caught)))
		} finally {
			setBusyId(null)
		}
	}

	async function cancel(summary: TransferSummary) {
		setBusyId(summary.id)
		try {
			transferDetailSchema.parse(
				await request(`/transfers/${encodeURIComponent(summary.id)}/cancel`, {
					method: 'POST',
					body: JSON.stringify({ expectedVersion: summary.version }),
				}),
			)
			toast.success(t`Cancelled.`)
			notifyChanged()
			reload()
		} catch (caught) {
			toast.error(i18n._(transferErrorMessage(caught)))
		} finally {
			setBusyId(null)
		}
	}

	const actions =
		canEdit && others.length > 0 ? (
			<div className="flex flex-wrap gap-2">
				<Button
					variant="outline"
					size="sm"
					onClick={() => setCreating('request')}
					data-testid="transfers-ask"
				>
					<Trans>Ask for stock</Trans>
				</Button>
				<Button
					variant="outline"
					size="sm"
					onClick={() => setCreating('transfer')}
					data-testid="transfers-send"
				>
					<Trans>Send stock</Trans>
				</Button>
			</div>
		) : null

	return (
		<WorkspacePanel title={<Trans>Moving stock</Trans>} action={actions}>
			{query.error && !query.data ? (
				<Alert variant="destructive" data-testid="transfers-error">
					<AlertDescription>
						{i18n._(inventoryErrorMessage(query.error))}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={query.reload}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			) : !query.data ? (
				<Skeleton className="h-16 w-full" />
			) : rows.length === 0 ? (
				<p
					className="text-muted-foreground text-sm"
					data-testid="transfers-empty"
				>
					<Trans>
						Nothing is moving between places. Send stock to another place, or
						ask one for what you need.
					</Trans>
				</p>
			) : (
				<ul
					className="flex flex-col divide-y rounded-xl border"
					data-testid="transfers-list"
				>
					{rows.map((transfer) => {
						const can = canEdit
							? transferActions(transfer, locationId)
							: { send: false, receive: false, cancel: false }
						const incoming = transfer.toLocationId === locationId
						const other = name(
							incoming ? transfer.fromLocationId : transfer.toLocationId,
						)
						return (
							<li
								key={transfer.id}
								className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
								data-testid={`transfer-${transfer.id}`}
							>
								<div className="flex min-w-0 flex-col gap-1">
									<p className="text-sm text-pretty">
										<span className="font-medium">#{transfer.number}</span>{' '}
										{transfer.kind === 'request' ? (
											incoming ? (
												<Trans>
													You asked{' '}
													<span className="wrap-anywhere">{other}</span>
												</Trans>
											) : (
												<Trans>
													<span className="wrap-anywhere">{other}</span> asked
													you
												</Trans>
											)
										) : incoming ? (
											<Trans>
												From <span className="wrap-anywhere">{other}</span>
											</Trans>
										) : (
											<Trans>
												To <span className="wrap-anywhere">{other}</span>
											</Trans>
										)}
										<span className="text-muted-foreground">
											{' · '}
											<Plural
												value={transfer.lineCount}
												one="# item"
												other="# items"
											/>
											{canSeeCost && transfer.valueMinor !== undefined
												? ` · ${formatMoney(transfer.valueMinor, transfer.currency ?? currency, i18n.locale)}`
												: ''}
										</span>
									</p>
									{transfer.note ? (
										<p className="text-muted-foreground text-sm wrap-anywhere">
											{transfer.note}
										</p>
									) : null}
								</div>
								<div className="flex shrink-0 flex-wrap items-center gap-2">
									<Badge
										variant={transfer.status === 'sent' ? 'warning' : 'outline'}
									>
										{i18n._(transferStatusLabel(transfer.status))}
									</Badge>
									{can.send ? (
										<Button
											size="sm"
											disabled={busyId !== null}
											onClick={() => void openConfirm(transfer, 'send')}
											data-testid={`transfer-send-${transfer.id}`}
										>
											<Trans>Send</Trans>
										</Button>
									) : null}
									{can.receive ? (
										<Button
											size="sm"
											disabled={busyId !== null}
											onClick={() => void openConfirm(transfer, 'receive')}
											data-testid={`transfer-receive-${transfer.id}`}
										>
											<Trans>Receive</Trans>
										</Button>
									) : null}
									{can.cancel ? (
										<Button
											size="sm"
											variant="outline"
											disabled={busyId !== null}
											onClick={() => void cancel(transfer)}
											data-testid={`transfer-cancel-${transfer.id}`}
										>
											<Trans>Cancel</Trans>
										</Button>
									) : null}
								</div>
							</li>
						)
					})}
				</ul>
			)}

			{creating ? (
				<CreateTransferDialog
					kind={creating}
					locationId={locationId}
					places={places}
					open
					onOpenChange={(open) => {
						if (!open) setCreating(null)
					}}
					onCreated={reload}
				/>
			) : null}
			<ConfirmTransferDialog
				step={confirm?.step ?? 'send'}
				transfer={confirm?.transfer ?? null}
				open={confirm !== null}
				onOpenChange={(open) => {
					if (!open) setConfirm(null)
				}}
				onDone={reload}
				placeName={name}
			/>
		</WorkspacePanel>
	)
}

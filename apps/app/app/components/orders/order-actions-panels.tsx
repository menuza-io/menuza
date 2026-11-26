import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { isTaxExemptSupportedForCurrency } from '@repo/common/order-edits'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Input } from '@repo/ui/input'
import { useState } from 'react'
import {
	CLOSED_ORDER_STATUSES,
	formatMoney,
	type Order,
} from '#app/utils/orders/order-model.ts'

/**
 * Operator order detail panels for:
 * - #163 Send pay link (SMS on US nodes, email everywhere, or copy link)
 * - #162 Edit placed order (quantities, remove, comp with reason, switch pickup)
 * - #166 Tax-exempt orders (certificate ref + org, hidden for SAR locations)
 */
export function OrderActionsPanels({
	order,
	request,
	canWrite,
	canRefund,
	payLinksEnabled,
	orderEditsEnabled,
	isUsNode,
	onUpdated,
}: {
	order: Order
	request: (path: string, init?: RequestInit) => Promise<unknown>
	canWrite: boolean
	canRefund: boolean
	payLinksEnabled: boolean
	orderEditsEnabled: boolean
	isUsNode: boolean
	onUpdated: () => void
}) {
	const { _, i18n } = useLingui()
	const isClosed = (CLOSED_ORDER_STATUSES as readonly string[]).includes(
		order.status,
	)
	const amountDueCents =
		order.amountDueCents ??
		(order.paymentStatus === 'paid' ? 0 : order.totalCents)
	const taxExemptSupported = isTaxExemptSupportedForCurrency(order.currency)
	const money = (cents: number) =>
		formatMoney(cents, order.currency, i18n.locale)

	// Pay link state (#163)
	const [payLinkBusy, setPayLinkBusy] = useState(false)
	const [payLinkUrl, setPayLinkUrl] = useState<string | null>(null)
	const [payLinkMsg, setPayLinkMsg] = useState<string | null>(null)

	// Tax exempt state (#166)
	const [taxExemptOpen, setTaxExemptOpen] = useState(false)
	const [taxRef, setTaxRef] = useState(order.taxExempt?.ref ?? '')
	const [taxOrg, setTaxOrg] = useState(order.taxExempt?.org ?? '')
	const [taxBusy, setTaxBusy] = useState(false)
	const [taxMsg, setTaxMsg] = useState<string | null>(null)

	// Edit order state (#162)
	const [editOpen, setEditOpen] = useState(false)
	const [editReason, setEditReason] = useState('')
	const [editFulfillment, setEditFulfillment] = useState<'pickup' | 'delivery'>(
		order.fulfillment === 'delivery' ? 'delivery' : 'pickup',
	)
	const [editLines, setEditLines] = useState(() =>
		order.lines.map((l) => ({
			itemId: l.itemId ?? '',
			variantId: l.variantId ?? null,
			name: l.itemName,
			quantity: l.quantity,
			comped: false,
			compReason: '',
			options: (l.options ?? [])
				.filter((o) => Boolean(o.groupId && o.optionId))
				.map((o) => ({
					groupId: o.groupId ?? '',
					optionId: o.optionId ?? '',
					quantity: o.quantity,
				})),
		})),
	)
	const [editBusy, setEditBusy] = useState(false)
	const [editOutcome, setEditOutcome] = useState<{
		deltaCents: number
		refundAvailableCents: number
		amountDueCents: number
		suggestedAction: 'refund' | 'pay_link' | 'none'
	} | null>(null)
	const [editError, setEditError] = useState<string | null>(null)

	const sendPayLink = async (channel: 'sms' | 'email' | 'copy') => {
		setPayLinkBusy(true)
		setPayLinkMsg(null)
		try {
			const res = (await request(`/${order.id}/pay-link`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ channel }),
			})) as { url: string; sent: boolean }
			setPayLinkUrl(res.url)
			if (channel === 'copy' && navigator.clipboard) {
				await navigator.clipboard.writeText(res.url).catch(() => {})
				setPayLinkMsg(_(msg`Pay link copied to clipboard.`))
			} else if (channel === 'sms') {
				setPayLinkMsg(_(msg`Pay link sent by text.`))
			} else {
				setPayLinkMsg(_(msg`Pay link sent by email.`))
			}
		} catch {
			setPayLinkMsg(_(msg`Could not send pay link.`))
		} finally {
			setPayLinkBusy(false)
		}
	}

	const saveTaxExempt = async (clear = false) => {
		setTaxBusy(true)
		setTaxMsg(null)
		try {
			const res = (await request(`/${order.id}/revise`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Idempotency-Key': crypto.randomUUID(),
				},
				body: JSON.stringify({
					expectedRevision: order.revision ?? 1,
					reason: clear ? 'Cleared tax exemption' : 'Marked tax-exempt',
					taxExempt: clear ? null : { ref: taxRef.trim(), org: taxOrg.trim() },
				}),
			})) as { refundAvailableCents?: number }
			setTaxExemptOpen(false)
			if (res.refundAvailableCents && res.refundAvailableCents > 0) {
				setTaxMsg(
					_(
						msg`Tax removed. You can now refund ${money(res.refundAvailableCents)} in tax.`,
					),
				)
			}
			onUpdated()
		} catch {
			setTaxMsg(
				_(msg`Could not update tax-exempt status. Reload and try again.`),
			)
		} finally {
			setTaxBusy(false)
		}
	}

	const submitEdit = async (dryRun: boolean) => {
		setEditBusy(true)
		setEditError(null)
		try {
			const res = (await request(`/${order.id}/revise`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Idempotency-Key': crypto.randomUUID(),
				},
				body: JSON.stringify({
					expectedRevision: order.revision ?? 1,
					dryRun,
					reason: editReason.trim() || 'Operator order edit',
					fulfillment: editFulfillment,
					lines: editLines.map((l) => ({
						itemId: l.itemId,
						variantId: l.variantId,
						quantity: l.quantity,
						options: l.options,
						...(l.comped
							? { comped: true, compReason: l.compReason.trim() || 'Comped' }
							: {}),
					})),
				}),
			})) as {
				deltaCents: number
				refundAvailableCents: number
				amountDueCents: number
				suggestedAction: 'refund' | 'pay_link' | 'none'
			}
			setEditOutcome(res)
			if (!dryRun) {
				setEditOpen(false)
				onUpdated()
			}
		} catch (caught) {
			const message = caught instanceof Error ? caught.message : ''
			setEditError(
				message.includes('stale_version')
					? _(msg`Someone else edited this order. Reload and try again.`)
					: _(msg`Could not save changes to this order.`),
			)
		} finally {
			setEditBusy(false)
		}
	}

	const showPayLinkCard =
		payLinksEnabled && canWrite && !isClosed && amountDueCents > 0
	const showEditButton =
		orderEditsEnabled && canWrite && !isClosed && !order.tabId
	const showTaxExemptControl = canWrite && !isClosed && taxExemptSupported

	if (
		!showPayLinkCard &&
		!showEditButton &&
		!showTaxExemptControl &&
		!order.taxExempt
	) {
		return null
	}

	return (
		<Card>
			<CardContent className="space-y-4 p-4">
				{order.taxExempt ? (
					<div
						className="flex flex-wrap items-center gap-2 text-sm"
						data-testid="tax-exempt-badge"
					>
						<Badge variant="outline">
							<Trans>Tax exempt</Trans>
						</Badge>
						<span>
							{order.taxExempt.ref}
							{order.taxExempt.org ? ` · ${order.taxExempt.org}` : ''}
						</span>
					</div>
				) : null}

				<div className="flex flex-wrap gap-2">
					{showPayLinkCard ? (
						<>
							{isUsNode ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={payLinkBusy}
									onClick={() => void sendPayLink('sms')}
								>
									<Trans>Text pay link ({money(amountDueCents)})</Trans>
								</Button>
							) : null}
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={payLinkBusy}
								onClick={() => void sendPayLink('email')}
							>
								<Trans>Email pay link</Trans>
							</Button>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={payLinkBusy}
								onClick={() => void sendPayLink('copy')}
							>
								<Trans>Copy pay link</Trans>
							</Button>
						</>
					) : null}

					{showEditButton ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setEditOpen((v) => !v)}
						>
							<Trans>Edit order</Trans>
						</Button>
					) : null}

					{showTaxExemptControl ? (
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={() => setTaxExemptOpen((v) => !v)}
							data-testid="tax-exempt-toggle"
						>
							{order.taxExempt ? (
								<Trans>Edit tax exemption</Trans>
							) : (
								<Trans>Tax exempt</Trans>
							)}
						</Button>
					) : null}
				</div>

				{payLinkMsg ? (
					<p role="status" className="text-muted-foreground text-sm">
						{payLinkMsg}
						{payLinkUrl ? (
							<span className="ms-2 font-mono text-xs break-all">
								{payLinkUrl}
							</span>
						) : null}
					</p>
				) : null}

				{taxMsg ? (
					<p role="status" className="text-muted-foreground text-sm">
						{taxMsg}
					</p>
				) : null}

				{taxExemptOpen && showTaxExemptControl ? (
					<div className="space-y-3 rounded-md border p-3">
						<p className="text-sm font-semibold">
							<Trans>Tax-exempt certificate</Trans>
						</p>
						<div className="grid gap-2 sm:grid-cols-2">
							<Input
								placeholder={_(msg`Certificate number (max 40 chars)`)}
								maxLength={40}
								value={taxRef}
								onChange={(e) => setTaxRef(e.target.value)}
							/>
							<Input
								placeholder={_(msg`Organization name`)}
								maxLength={120}
								value={taxOrg}
								onChange={(e) => setTaxOrg(e.target.value)}
							/>
						</div>
						<div className="flex gap-2">
							<Button
								type="button"
								size="sm"
								disabled={taxBusy || !taxRef.trim() || !taxOrg.trim()}
								onClick={() => void saveTaxExempt(false)}
							>
								<Trans>Apply tax exemption</Trans>
							</Button>
							{order.taxExempt ? (
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={taxBusy}
									onClick={() => void saveTaxExempt(true)}
								>
									<Trans>Remove exemption</Trans>
								</Button>
							) : null}
						</div>
					</div>
				) : null}

				{editOpen && showEditButton ? (
					<div className="space-y-3 rounded-md border p-3">
						<p className="text-sm font-semibold">
							<Trans>Edit order</Trans>
						</p>
						<div className="space-y-2">
							{editLines.map((line, idx) => (
								<div
									key={`${line.itemId}-${idx}`}
									className="flex flex-wrap items-center justify-between gap-2 rounded border p-2 text-sm"
								>
									<span className="font-medium">{line.name}</span>
									<div className="flex items-center gap-2">
										<Input
											type="number"
											min={1}
											max={50}
											className="h-8 w-16"
											value={String(line.quantity)}
											onChange={(e) => {
												const qty = Math.max(1, Number(e.target.value) || 1)
												setEditLines((prev) =>
													prev.map((item, i) =>
														i === idx ? { ...item, quantity: qty } : item,
													),
												)
											}}
										/>
										{canRefund ? (
											<label className="flex items-center gap-1 text-xs">
												<input
													type="checkbox"
													checked={line.comped}
													onChange={(e) => {
														const checked = e.target.checked
														setEditLines((prev) =>
															prev.map((item, i) =>
																i === idx ? { ...item, comped: checked } : item,
															),
														)
													}}
												/>
												<Trans>Comp</Trans>
											</label>
										) : null}
										{editLines.length > 1 ? (
											<Button
												type="button"
												variant="ghost"
												size="sm"
												onClick={() =>
													setEditLines((prev) =>
														prev.filter((_, i) => i !== idx),
													)
												}
											>
												<Trans>Remove</Trans>
											</Button>
										) : null}
									</div>
								</div>
							))}
						</div>
						{order.fulfillment === 'delivery' ? (
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={editFulfillment === 'pickup'}
									onChange={(e) =>
										setEditFulfillment(e.target.checked ? 'pickup' : 'delivery')
									}
								/>
								<Trans>Switch to pickup (removes delivery fee)</Trans>
							</label>
						) : null}
						<Input
							placeholder={_(msg`Reason for edit`)}
							maxLength={300}
							value={editReason}
							onChange={(e) => setEditReason(e.target.value)}
						/>
						{editOutcome ? (
							<p className="text-muted-foreground text-sm">
								<Trans>
									Difference: {money(editOutcome.deltaCents)}
									{editOutcome.suggestedAction === 'refund'
										? ` · Refund available: ${money(editOutcome.refundAvailableCents)}`
										: editOutcome.suggestedAction === 'pay_link'
											? ` · Amount due: ${money(editOutcome.amountDueCents)}`
											: ''}
								</Trans>
							</p>
						) : null}
						{editError ? (
							<p role="alert" className="text-destructive text-sm">
								{editError}
							</p>
						) : null}
						<div className="flex gap-2">
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={editBusy}
								onClick={() => void submitEdit(true)}
							>
								<Trans>Preview total</Trans>
							</Button>
							<Button
								type="button"
								size="sm"
								disabled={editBusy}
								onClick={() => void submitEdit(false)}
							>
								<Trans>Save changes</Trans>
							</Button>
						</div>
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}

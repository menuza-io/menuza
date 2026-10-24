import { type MessageDescriptor } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { zatcaQrPayload } from '@repo/common/pos-fiscal'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { PhonePickupDetails } from './PhonePickupDetails.tsx'
import { type PosOrder } from '~/lib/db.ts'
import { moneyFormatter } from '~/lib/money.ts'
import { lineTotalCents } from '~/lib/pricing.ts'
import { shownLine } from '~/lib/store.ts'
import { cn } from '~/ui/primitives.tsx'

const TENDER_LABEL: Record<'cash' | 'card' | 'other', MessageDescriptor> = {
	cash: msg`Cash`,
	card: msg`Card`,
	other: msg`Other`,
}

/**
 * Plain, monochrome 72 mm receipt. Rendered hidden; `window.print()` shows only this.
 * When the restaurant has a VAT number it is a simplified tax invoice: it shows
 * the number, the fiscal invoice number and the QR code ZATCA requires.
 */
export function Receipt({
	order,
	businessName,
	vatNumber = null,
}: {
	order: PosOrder
	businessName: string
	vatNumber?: string | null
}) {
	const { _, i18n } = useLingui()
	const money = moneyFormatter(order.currency)
	const when = new Date(order.createdAt).toLocaleString(i18n.locale)
	const change = order.payments.reduce((s, p) => s + p.changeCents, 0)
	const balance = Math.max(
		0,
		order.totals.totalCents -
			order.payments.reduce((s, p) => s + p.amountCents, 0),
	)
	const invoice = (order.fiscal ?? []).find((d) => d.kind === 'invoice') ?? null
	const invoiceCounter = invoice?.counter ?? 0
	const table = order.tableLabel
	const servedBy = order.staff?.name ?? null
	// An onboarded ZATCA unit signed this invoice: print its Phase 2 QR and number.
	const signed = invoice?.zatca ?? null
	const qr = useInvoiceQr(
		signed
			? signed.qr
			: vatNumber && invoice
				? zatcaQrPayload({
						sellerName: businessName,
						vatNumber,
						at: invoice.at,
						totalCents: invoice.totalCents,
						taxCents: invoice.taxCents,
					})
				: null,
	)
	const invoiceNumber = signed ? signed.invoiceNumber : String(invoiceCounter)
	// Portalled to <body>: a <dialog> clips and offsets anything printed inside it.
	return createPortal(
		<div id="receipt" className="hidden print:block" aria-hidden>
			<div className="text-center text-sm font-bold">{businessName}</div>
			{vatNumber ? (
				<div className="text-center">
					<Trans>VAT No. {vatNumber}</Trans>
				</div>
			) : null}
			{(vatNumber || signed) && invoice ? (
				<div className="text-center font-bold">
					<Trans>Simplified tax invoice</Trans>
				</div>
			) : null}
			<div className="text-center">{when}</div>
			<div className="my-1.5 text-center text-base font-bold">
				#{order.number}
			</div>
			{invoice ? (
				<div className="text-center">
					<Trans>Invoice {invoiceNumber}</Trans>
				</div>
			) : null}
			{order.orderSource === 'phone' ? (
				<div className="text-center">
					<PhonePickupDetails order={order} printed />
				</div>
			) : (
				<div className="text-center">
					{order.orderType === 'dine_in'
						? `${_(t`Dine in`)}${table ? ` · ${_(t`Table ${table}`)}` : ''}`
						: `${_(t`Takeaway`)}${order.customerName ? ` · ${order.customerName}` : ''}`}
				</div>
			)}
			{servedBy ? (
				<div className="text-center">
					<Trans>Served by {servedBy}</Trans>
				</div>
			) : null}
			<hr />
			{order.lines.map(shownLine).map((line) => (
				<div key={line.id} className="mb-1">
					<Row>
						<span>
							{line.quantity} × {line.name}
							{line.variantLabel ? ` (${line.variantLabel})` : ''}
						</span>
						<span>{money(lineTotalCents(line))}</span>
					</Row>
					{line.options.map((o) => (
						<Row key={o.groupId + o.optionId} className="ps-2.5">
							<span>
								+ {o.quantity > 1 ? `${o.quantity} × ` : ''}
								{o.optionName}
							</span>
							{o.unitCents > 0 ? (
								<span>{money(o.unitCents * o.quantity * line.quantity)}</span>
							) : null}
						</Row>
					))}
					{line.instructions ? (
						<div className="ps-2.5 italic">“{line.instructions}”</div>
					) : null}
				</div>
			))}
			<hr />
			<Row>
				<span>
					<Trans>Subtotal</Trans>
				</span>
				<span>{money(order.totals.subtotalCents)}</span>
			</Row>
			{order.adjustments.map((a) => (
				<Row key={a.id}>
					<span>{a.label}</span>
					<span>-{money(a.amountCents)}</span>
				</Row>
			))}
			<Row>
				<span>
					{order.taxInclusive ? _(t`VAT included`) : _(t`Tax`)}
					{order.taxRatePercent ? ` (${order.taxRatePercent}%)` : ''}
				</span>
				{/* The VAT on the signed invoice (and its QR code), when there is one. */}
				<span>{money(signed ? signed.taxCents : order.totals.taxCents)}</span>
			</Row>
			{order.totals.tipCents > 0 ? (
				<Row>
					<span>
						<Trans>Tip</Trans>
					</span>
					<span>{money(order.totals.tipCents)}</span>
				</Row>
			) : null}
			<Row className="text-sm font-bold">
				<span>
					<Trans>Total</Trans>
				</span>
				<span>{money(order.totals.totalCents)}</span>
			</Row>
			{order.payments.map((p) => (
				<Row key={p.id}>
					<span>
						{_(t`Paid`)} · {_(TENDER_LABEL[p.method])}
						{p.reference ? ` · ${p.reference}` : ''}
					</span>
					<span>{money(p.tenderedCents)}</span>
				</Row>
			))}
			{change > 0 ? (
				<Row>
					<span>
						<Trans>Change</Trans>
					</span>
					<span>{money(change)}</span>
				</Row>
			) : null}
			{(order.refunds ?? []).map((r) => (
				<Row key={r.id}>
					<span>
						{_(t`Refunded`)} · {_(TENDER_LABEL[r.method])}
					</span>
					<span>-{money(r.amountCents)}</span>
				</Row>
			))}
			{balance > 0 ? (
				<Row className="text-sm font-bold">
					<span>
						<Trans>Balance due</Trans>
					</span>
					<span>{money(balance)}</span>
				</Row>
			) : null}
			{qr ? <img src={qr} alt="" className="mx-auto mt-2 size-32" /> : null}
			<div className="mt-2.5 text-center">
				<Trans>Thank you!</Trans>
			</div>
		</div>,
		document.body,
	)
}

/** A ZATCA QR payload drawn as an image, once it is ready. */
function useInvoiceQr(payload: string | null) {
	const [url, setUrl] = useState<string | null>(null)
	useEffect(() => {
		if (!payload) {
			setUrl(null)
			return
		}
		let live = true
		QRCode.toDataURL(payload, {
			margin: 0,
			width: 256,
			errorCorrectionLevel: 'M',
		})
			.then((data) => live && setUrl(data))
			.catch(() => live && setUrl(null))
		return () => {
			live = false
		}
	}, [payload])
	return url
}

function Row({
	className,
	children,
}: {
	className?: string
	children: React.ReactNode
}) {
	return <div className={cn('flex justify-between', className)}>{children}</div>
}

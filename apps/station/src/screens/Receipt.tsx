import { type MessageDescriptor } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { zatcaQrPayload } from '@repo/common/pos-fiscal'
import { planReceiptExtras } from '@repo/common/receipt-extras'
import QRCode from 'qrcode'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { PhonePickupDetails } from './PhonePickupDetails.tsx'
import { orderHasAlcohol } from '~/lib/alcohol.ts'
import { type PosOrder, type TenderMethod } from '~/lib/db.ts'
import { moneyFormatter } from '~/lib/money.ts'
import { lineTotalCents } from '~/lib/pricing.ts'
import { saleLine, usePos } from '~/lib/store.ts'
import {
	fieldOf,
	useReceiptLogoUrl,
	useReceiptTargets,
	useTickets,
} from '~/lib/tickets.ts'
import { isTrainingMode } from '~/lib/training-flag.ts'
import { cn } from '~/ui/primitives.tsx'

const TENDER_LABEL: Record<TenderMethod, MessageDescriptor> = {
	cash: msg`Cash`,
	card: msg`Card`,
	other: msg`Other`,
	gift_card: msg`Gift card`,
}

/**
 * Plain, monochrome 72 mm receipt. Rendered hidden; `window.print()` shows only this.
 * When the restaurant has a VAT number it is a simplified tax invoice: it shows
 * the number, the fiscal invoice number and the QR code ZATCA requires.
 */
export function Receipt({
	order,
	businessName,
	vatNumber: realVatNumber = null,
}: {
	order: PosOrder
	businessName: string
	vatNumber?: string | null
}) {
	const { _, i18n } = useLingui()
	const tickets = useTickets()
	const items = usePos((state) => state.recordItems)
	const checkId = orderHasAlcohol(order.lines, items)
	/** How one field of the guest receipt prints (#363). */
	const f = (key: string) => fieldOf(tickets, 'receipt', key)
	// A training receipt is never a tax invoice (#383).
	const training = isTrainingMode()
	const vatNumber = training ? null : realVatNumber
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
	// Typed text and names in the language of record are isolated (<bdi>), so
	// text in the other direction never reorders the punctuation beside it.
	const table = order.tableLabel ? <bdi>{order.tableLabel}</bdi> : null
	const servedBy = order.staff?.name ? <bdi>{order.staff.name}</bdi> : null
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
	// The logo and the review and app codes (#263). One decision shared with the
	// cloud printers and the settings preview; the fiscal code above is never
	// touched, and a narrow roll drops these, not it.
	const targets = useReceiptTargets()
	const logoSrc = useReceiptLogoUrl()
	const extras = planReceiptExtras({
		config: tickets.extras,
		targets,
		logoUrl: logoSrc,
		width: 72,
		fiscalQr: Boolean(qr),
		kind:
			order.status === 'void'
				? 'void'
				: order.status === 'refunded'
					? 'refund'
					: 'sale',
	})
	const codeImages = useCodeQrs(extras.codes.map((code) => code.url))
	// Portalled to <body>: a <dialog> clips and offsets anything printed inside it.
	return createPortal(
		<div id="receipt" className="hidden print:block" aria-hidden>
			{training ? (
				<div className="text-center font-semibold">
					<Trans>TRAINING: NOT A REAL RECEIPT</Trans>
				</div>
			) : null}
			{extras.logo && logoSrc ? (
				<img
					src={logoSrc}
					alt=""
					data-receipt-logo=""
					className="receipt-logo mx-auto mb-1"
				/>
			) : null}
			{f('businessName').show ? (
				<div
					className={cn(
						'text-center text-sm font-semibold',
						f('businessName').cls,
					)}
				>
					{businessName}
				</div>
			) : null}
			{vatNumber ? (
				<div className={cn('text-center', f('vatNumber').cls)}>
					<Trans>VAT No. {vatNumber}</Trans>
				</div>
			) : null}
			{(vatNumber || signed) && invoice ? (
				<div className={cn('text-center font-semibold', f('invoiceTitle').cls)}>
					<Trans>Simplified tax invoice</Trans>
				</div>
			) : null}
			{f('dateTime').show ? (
				<div className={cn('text-center', f('dateTime').cls)}>{when}</div>
			) : null}
			{f('orderNumber').show ? (
				<div
					className={cn(
						'my-1.5 text-center text-base font-semibold',
						f('orderNumber').cls,
					)}
				>
					#{order.number}
				</div>
			) : null}
			{invoice ? (
				<div className={cn('text-center', f('invoiceNumber').cls)}>
					<Trans>Invoice {invoiceNumber}</Trans>
				</div>
			) : null}
			{!f('orderType').show ? null : order.orderSource === 'phone' ? (
				<div className={cn('text-center', f('orderType').cls)}>
					<PhonePickupDetails order={order} printed />
				</div>
			) : (
				<div className={cn('text-center', f('orderType').cls)}>
					{order.orderType === 'dine_in' ? (
						<>
							{_(t`Dine in`)}
							{table ? (
								<>
									{' · '}
									<Trans>Table {table}</Trans>
								</>
							) : null}
						</>
					) : order.orderType === 'drive_through' ? (
						<>
							{_(t`Drive-through`)}
							{order.driveThroughNote ? (
								<>
									{' · '}
									<bdi>{order.driveThroughNote}</bdi>
								</>
							) : null}
						</>
					) : (
						<>
							{_(t`Takeaway`)}
							{order.customerName ? (
								<>
									{' · '}
									<bdi>{order.customerName}</bdi>
								</>
							) : null}
						</>
					)}
				</div>
			)}
			{servedBy && f('servedBy').show ? (
				<div className={cn('text-center', f('servedBy').cls)}>
					<Trans>Served by {servedBy}</Trans>
				</div>
			) : null}
			{checkId ? (
				<div
					className="my-1 border-2 px-1.5 text-center font-semibold"
					data-check-id
				>
					<Trans>Check ID</Trans>
				</div>
			) : null}
			<hr />
			{order.lines
				.map((line) => saleLine(line, order.status === 'open'))
				.map((line) => (
					<div key={line.id} className={cn('mb-1', f('items').cls)}>
						<Row>
							<span>
								{line.quantity} × <bdi>{line.name}</bdi>
								{line.kind === 'custom' ? ` (${_(t`Custom`)})` : null}
								{line.variantLabel ? (
									<>
										{' ('}
										<bdi>{line.variantLabel}</bdi>
										{')'}
									</>
								) : null}
							</span>
							<span>{money(lineTotalCents(line))}</span>
						</Row>
						{(f('itemOptions').show ? line.options : []).map((o) => (
							<Row
								key={o.groupId + o.optionId}
								className={cn('ps-2.5', f('itemOptions').cls)}
							>
								<span>
									+ {o.quantity > 1 ? `${o.quantity} × ` : ''}
									<bdi>{o.optionName}</bdi>
								</span>
								{o.unitCents > 0 ? (
									<span>{money(o.unitCents * o.quantity * line.quantity)}</span>
								) : null}
							</Row>
						))}
						{line.instructions && f('itemNotes').show ? (
							<div className={cn('ps-2.5 italic', f('itemNotes').cls)}>
								“<bdi>{line.instructions}</bdi>”
							</div>
						) : null}
					</div>
				))}
			<hr />
			{f('subtotal').show ? (
				<Row className={f('subtotal').cls}>
					<span>
						<Trans>Subtotal</Trans>
					</span>
					<span>{money(order.totals.subtotalCents)}</span>
				</Row>
			) : null}
			{(f('discounts').show ? order.adjustments : []).map((a) => (
				<Row key={a.id} className={f('discounts').cls}>
					<span>{a.label}</span>
					<span>{money(-a.amountCents)}</span>
				</Row>
			))}
			<Row className={f('tax').cls}>
				<span>
					{order.taxInclusive ? _(t`VAT included`) : _(t`Tax`)}
					{order.taxRatePercent ? ` (${order.taxRatePercent}%)` : ''}
				</span>
				{/* The VAT on the signed invoice (and its QR code), when there is one. */}
				<span>{money(signed ? signed.taxCents : order.totals.taxCents)}</span>
			</Row>
			{order.totals.tipCents > 0 && f('tip').show ? (
				<Row className={f('tip').cls}>
					<span>
						<Trans>Tip</Trans>
					</span>
					<span>{money(order.totals.tipCents)}</span>
				</Row>
			) : null}
			<Row className={cn('text-sm font-semibold', f('total').cls)}>
				<span>
					<Trans>Total</Trans>
				</span>
				<span>{money(order.totals.totalCents)}</span>
			</Row>
			{(f('payments').show ? order.payments : []).map((p) => (
				<Row key={p.id} className={f('payments').cls}>
					<span>
						{_(t`Paid`)} · {_(TENDER_LABEL[p.method])}
						{p.reference ? (
							<>
								{' · '}
								<bdi>{p.reference}</bdi>
							</>
						) : null}
					</span>
					<span>{money(p.tenderedCents)}</span>
				</Row>
			))}
			{change > 0 && f('change').show ? (
				<Row className={f('change').cls}>
					<span>
						<Trans>Change</Trans>
					</span>
					<span>{money(change)}</span>
				</Row>
			) : null}
			{(f('refunds').show ? (order.refunds ?? []) : []).map((r) => (
				<Row key={r.id} className={f('refunds').cls}>
					<span>
						{_(t`Refunded`)} · {_(TENDER_LABEL[r.method])}
					</span>
					<span>{money(-r.amountCents)}</span>
				</Row>
			))}
			{balance > 0 && f('balanceDue').show ? (
				<Row className={cn('text-sm font-semibold', f('balanceDue').cls)}>
					<span>
						<Trans>Balance due</Trans>
					</span>
					<span>{money(balance)}</span>
				</Row>
			) : null}
			{qr ? <img src={qr} alt="" className="mx-auto mt-2 size-32" /> : null}
			{extras.codes.map((code, index) => (
				<div
					key={code.kind}
					data-receipt-code={code.kind}
					className="mt-2 text-center"
				>
					{codeImages[index] ? (
						<img
							src={codeImages[index]!}
							alt=""
							className="mx-auto size-20"
						/>
					) : null}
					<div className="text-xs">{code.caption}</div>
				</div>
			))}
			{f('thankYou').show ? (
				<div className={cn('mt-2.5 text-center', f('thankYou').cls)}>
					<Trans>Thank you!</Trans>
				</div>
			) : null}
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

/** Small QR codes for the marketing links, once they are ready. */
function useCodeQrs(urls: string[]): Array<string | null> {
	const key = urls.join('\n')
	const [images, setImages] = useState<Array<string | null>>([])
	useEffect(() => {
		let live = true
		const list = key ? key.split('\n') : []
		if (list.length === 0) {
			setImages([])
			return
		}
		Promise.all(
			list.map((url) =>
				QRCode.toDataURL(url, {
					margin: 0,
					width: 160,
					errorCorrectionLevel: 'M',
				}).catch(() => null),
			),
		).then((data) => live && setImages(data))
		return () => {
			live = false
		}
	}, [key])
	return images
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

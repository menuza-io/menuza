import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useMemo, useState } from 'react'
import {
	createGiftCardApi,
	GiftCardApiError,
	type GiftCardView,
	type SoldGiftCard,
} from '~/lib/gift-cards.ts'
import { usePos } from '~/lib/store.ts'
import { Button, Input, Modal, Segmented } from '~/ui/primitives.tsx'

/**
 * Gift cards at the till: look a card up, sell one (a new card with a code
 * shown once, or a printed card scanned and activated with the paid amount),
 * top one up. Online only: nothing is queued, so offline the sheet says so.
 * Redeeming happens in Checkout, as a tender.
 */

const ERRORS: Record<string, MessageDescriptor> = {
	offline: msg`Gift cards need the internet. Take another payment, or try again when the till is back online.`,
	code_invalid: msg`No gift card matches that number.`,
	gift_card_inactive: msg`This card has not been activated.`,
	gift_card_held: msg`This card is on hold.`,
	gift_card_frozen: msg`This card is frozen.`,
	gift_card_voided: msg`This card was voided.`,
	gift_card_expired: msg`This card has expired.`,
	already_active: msg`This card is already active.`,
	amount_out_of_range: msg`That amount is outside what the restaurant allows for a card.`,
	rate_limited: msg`Too many tries. Wait a moment and try again.`,
	feature_disabled: msg`Gift cards are not turned on for this till.`,
	gift_cards_disabled: msg`Gift cards are not turned on.`,
	gift_cards_unavailable: msg`Gift cards are temporarily unavailable.`,
}

export function giftCardErrorMessage(
	error: unknown,
	translate: (m: MessageDescriptor) => string,
): string {
	if (error instanceof GiftCardApiError) {
		const known = ERRORS[error.offline ? 'offline' : error.code]
		if (known) return translate(known)
	}
	return translate(msg`Something went wrong. Try again.`)
}

/** A labelled text field (the till's `Input` has no label of its own). */
export function LabeledInput({
	label,
	...input
}: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
	return (
		<label className="flex flex-col gap-1 text-sm">
			<span className="font-medium">{label}</span>
			<Input {...input} />
		</label>
	)
}

type Mode = 'lookup' | 'sell' | 'top_up'

function parseAmount(text: string): number | null {
	const cleaned = text.replace(/,/g, '.').trim()
	if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
	const minor = Math.round(Number(cleaned) * 100)
	return minor > 0 ? minor : null
}

export function GiftCardSheet({
	open,
	onClose,
	money,
}: {
	open: boolean
	onClose: () => void
	money: (minor: number) => string
}) {
	const { _ } = useLingui()
	const online = usePos((s) => s.online)
	const api = useMemo(
		() =>
			createGiftCardApi({
				settings: () => usePos.getState().settings,
				session: () => usePos.getState().session,
			}),
		[],
	)
	const [mode, setMode] = useState<Mode>('lookup')
	const [code, setCode] = useState('')
	const [amount, setAmount] = useState('')
	const [method, setMethod] = useState<'cash' | 'card' | 'other'>('cash')
	const [found, setFound] = useState<GiftCardView | null>(null)
	const [sold, setSold] = useState<SoldGiftCard | null>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [busy, setBusy] = useState(false)
	// One request id per attempt: a double tap sells once.
	const [requestId, setRequestId] = useState(() => crypto.randomUUID())

	const translate = (m: MessageDescriptor) => _(m)
	const run = async (work: () => Promise<void>) => {
		setBusy(true)
		setError(null)
		setNotice(null)
		try {
			await work()
		} catch (caught) {
			setError(giftCardErrorMessage(caught, translate))
		} finally {
			setBusy(false)
		}
	}

	const reset = () => {
		setFound(null)
		setSold(null)
		setCode('')
		setAmount('')
		setRequestId(crypto.randomUUID())
	}

	return (
		<Modal open={open} onClose={() => { reset(); onClose() }} title={_(t`Gift cards`)} size="md">
			<div className="flex flex-col gap-4 p-4">
				{!online ? (
					<p role="alert" className="notice-warning px-3 py-2 text-sm">
						{_(ERRORS.offline!)}
					</p>
				) : null}
				<Segmented
					label={_(t`Gift card action`)}
					value={mode}
					onChange={(next) => {
						setMode(next)
						reset()
						setError(null)
					}}
					options={[
						{ value: 'lookup', label: _(t`Check balance`) },
						{ value: 'sell', label: _(t`Sell a card`) },
						{ value: 'top_up', label: _(t`Top up`) },
					]}
				/>

				{sold ? (
					<div className="flex flex-col gap-2 text-center">
						<p className="text-muted-foreground text-sm">
							{_(t`Card sold. This is the only time the full number is shown.`)}
						</p>
						{sold.formattedCode ? (
							<p className="tnum text-2xl font-semibold tracking-wider" dir="ltr">
								{sold.formattedCode}
							</p>
						) : (
							<p className="text-sm">{_(t`Card activated`)} · {sold.last4}</p>
						)}
						<p className="tnum">{money(sold.balanceMinor)}</p>
						<Button onClick={() => { reset() }}>{_(t`Done`)}</Button>
					</div>
				) : (
					<form
						className="flex flex-col gap-3"
						onSubmit={(event) => {
							event.preventDefault()
							if (!online || busy) return
							void run(async () => {
								if (mode === 'lookup') {
									setFound(await api.lookup(code.trim()))
									return
								}
								const minor = parseAmount(amount)
								if (minor === null) {
									setError(_(t`Enter an amount above zero.`))
									return
								}
								if (mode === 'sell') {
									setSold(
										await api.sell({
											code: code.trim() || undefined,
											amountMinor: minor,
											paymentMethod: method,
											clientRequestId: requestId,
										}),
									)
								} else {
									const topped = await api.topUp({
										code: code.trim(),
										amountMinor: minor,
										clientRequestId: requestId,
									})
									setNotice(_(t`Topped up. New balance ${money(topped.balanceMinor)}.`))
									setRequestId(crypto.randomUUID())
									setAmount('')
								}
							})
						}}
					>
						<LabeledInput
							label={mode === 'sell' ? _(t`Card number (leave empty for a card with no plastic)`) : _(t`Card number or scan`)}
							value={code}
							onChange={(event) => setCode(event.target.value)}
							autoComplete="off"
							autoCapitalize="characters"
							dir="ltr"
						/>
						{mode !== 'lookup' ? (
							<LabeledInput
								label={_(t`Amount`)}
								value={amount}
								onChange={(event) => setAmount(event.target.value)}
								inputMode="decimal"
								autoComplete="off"
							/>
						) : null}
						{mode === 'sell' ? (
							<Segmented
								label={_(t`Payment method`)}
								value={method}
								onChange={setMethod}
								options={[
									{ value: 'cash', label: _(t`Cash`) },
									{ value: 'card', label: _(t`Card`) },
									{ value: 'other', label: _(t`Other`) },
								]}
							/>
						) : null}
						{error ? <p role="alert" className="text-destructive text-sm">{error}</p> : null}
						{notice ? <p role="status" className="text-sm">{notice}</p> : null}
						{found ? (
							<div className="rounded-md border p-3 text-sm">
								<p>{_(t`Card ending`)} {found.last4}</p>
								<p className="tnum text-xl font-semibold">{money(found.balanceMinor)}</p>
								{found.note === 'being_prepared' ? <p>{_(t`Being prepared`)}</p> : null}
								{found.status === 'inactive' ? <p>{_(t`This card has not been activated.`)}</p> : null}
								{found.status === 'voided' || found.status === 'expired' ? (
									<p>{_(t`This card can no longer be used.`)}</p>
								) : null}
							</div>
						) : null}
						<Button type="submit" disabled={!online || busy || (mode !== 'sell' && code.trim().length < 8)}>
							{mode === 'lookup' ? _(t`Check balance`) : mode === 'sell' ? _(t`Sell card`) : _(t`Top up card`)}
						</Button>
					</form>
				)}
			</div>
		</Modal>
	)
}

import { useLingui } from '@lingui/react'
import { Trans, useLingui as useLinguiMacro } from '@lingui/react/macro'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { TextAreaField, TextField } from '#app/components/staff/controls.tsx'
import {
	GiftCardApiError,
	type GiftCardClient,
	type GiftCardSummary,
} from '#app/utils/gift-cards/gift-card-client.ts'
import {
	formatGiftCardMoney,
	GIFT_CARD_ERROR_MESSAGES,
} from '#app/utils/gift-cards/labels.ts'
import { parseMoneyToMinor } from '#app/utils/money-input.ts'

/** A fresh idempotency key for one intent (a click, kept across a retry). */
function newKey(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}`
}

export function useGiftCardErrorText() {
	const { _ } = useLingui()
	const { t } = useLinguiMacro()
	return (error: unknown): string => {
		if (error instanceof GiftCardApiError) {
			const known = error.code ? GIFT_CARD_ERROR_MESSAGES[error.code] : undefined
			if (known) return _(known)
			if (error.status === 0) return t`No connection. Check your internet and try again.`
		}
		return t`Something went wrong. Try again.`
	}
}

function DialogShell({
	open,
	onOpenChange,
	title,
	description,
	children,
	submitting,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: ReactNode
	description: ReactNode
	children: ReactNode
	submitting: boolean
}) {
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!submitting) onOpenChange(next)
			}}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{children}
			</DialogContent>
		</Dialog>
	)
}

/** Adjust balance: the expected balance, a reason, and the named operator (the token's). */
export function AdjustDialog({
	client,
	card,
	open,
	onOpenChange,
	onDone,
}: {
	client: GiftCardClient
	card: GiftCardSummary
	open: boolean
	onOpenChange: (open: boolean) => void
	onDone: () => void
}) {
	const { t, i18n } = useLinguiMacro()
	const errorText = useGiftCardErrorText()
	const [amount, setAmount] = useState('')
	const [direction, setDirection] = useState<'add' | 'remove'>('add')
	const [reason, setReason] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [submitting, setSubmitting] = useState(false)
	const key = useRef(newKey('adjust'))

	async function submit(event: FormEvent) {
		event.preventDefault()
		const minor = parseMoneyToMinor(amount, { currency: card.currency, min: 1 })
		if (minor === null) return setError(t`Enter an amount above zero.`)
		if (!reason.trim()) return setError(t`A reason is required.`)
		setSubmitting(true)
		setError(null)
		try {
			await client.adjust({
				cardId: card.id,
				expectedBalanceMinor: card.balanceMinor,
				deltaMinor: direction === 'add' ? minor : -minor,
				reason: reason.trim(),
				key: key.current,
			})
			onDone()
			onOpenChange(false)
		} catch (caught) {
			setError(errorText(caught))
			// A different intent gets a new key; a retry of the same one keeps it.
			if (caught instanceof GiftCardApiError && caught.status === 409) {
				key.current = newKey('adjust')
			}
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<DialogShell
			open={open}
			onOpenChange={onOpenChange}
			submitting={submitting}
			title={<Trans>Adjust balance</Trans>}
			description={
				<Trans>
					The balance now is {formatGiftCardMoney(card.balanceMinor, card.currency, i18n.locale)}.
					Your name and the reason go in the card's history.
				</Trans>
			}
		>
			<form onSubmit={submit} className="grid gap-4" noValidate>
				<div className="flex gap-2" role="group" aria-label={t`Add or remove`}>
					<Button
						type="button"
						variant={direction === 'add' ? 'default' : 'outline'}
						onClick={() => setDirection('add')}
					>
						<Trans>Add</Trans>
					</Button>
					<Button
						type="button"
						variant={direction === 'remove' ? 'default' : 'outline'}
						onClick={() => setDirection('remove')}
					>
						<Trans>Remove</Trans>
					</Button>
				</div>
				<TextField
					label={t`Amount`}
					inputMode="decimal"
					value={amount}
					onChange={(event) => setAmount(event.target.value)}
					autoComplete="off"
				/>
				<TextAreaField
					label={t`Reason`}
					value={reason}
					onChange={(event) => setReason(event.target.value)}
					maxLength={500}
				/>
				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<DialogFooter>
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
						<Trans>Cancel</Trans>
					</Button>
					<Button type="submit" disabled={submitting}>
						<Trans>Save adjustment</Trans>
					</Button>
				</DialogFooter>
			</form>
		</DialogShell>
	)
}

/** Void: removes any balance and stops the card from being spent or activated. */
export function VoidDialog({
	client,
	card,
	open,
	onOpenChange,
	onDone,
}: {
	client: GiftCardClient
	card: GiftCardSummary
	open: boolean
	onOpenChange: (open: boolean) => void
	onDone: () => void
}) {
	const { t, i18n } = useLinguiMacro()
	const errorText = useGiftCardErrorText()
	const [reason, setReason] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [submitting, setSubmitting] = useState(false)
	const key = useRef(newKey('void'))

	async function submit(event: FormEvent) {
		event.preventDefault()
		if (!reason.trim()) return setError(t`A reason is required.`)
		setSubmitting(true)
		setError(null)
		try {
			await client.void({ cardId: card.id, reason: reason.trim(), key: key.current })
			onDone()
			onOpenChange(false)
		} catch (caught) {
			setError(errorText(caught))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<DialogShell
			open={open}
			onOpenChange={onOpenChange}
			submitting={submitting}
			title={<Trans>Void this card</Trans>}
			description={
				<Trans>
					The {formatGiftCardMoney(card.balanceMinor, card.currency, i18n.locale)} left on the card is
					removed and it can no longer be spent. This cannot be undone.
				</Trans>
			}
		>
			<form onSubmit={submit} className="grid gap-4" noValidate>
				<TextAreaField
					label={t`Reason`}
					value={reason}
					onChange={(event) => setReason(event.target.value)}
					maxLength={500}
				/>
				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<DialogFooter>
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
						<Trans>Cancel</Trans>
					</Button>
					<Button type="submit" variant="destructive" disabled={submitting}>
						<Trans>Void card</Trans>
					</Button>
				</DialogFooter>
			</form>
		</DialogShell>
	)
}

/**
 * Charge card: look up the number, see the balance, enter the amount and what
 * it is for, confirm. A double click charges once (one request id per open
 * dialog). Over the balance is refused with the balance shown.
 */
export function ChargeDialog({
	client,
	card: initialCard,
	attachTo,
	open,
	onOpenChange,
	onDone,
}: {
	client: GiftCardClient
	/** A card already open (its detail page); omit to look one up by number. */
	card?: GiftCardSummary
	attachTo?: { kind: 'restaurant_order' | 'quote' | 'payment_link'; id: string } | null
	open: boolean
	onOpenChange: (open: boolean) => void
	onDone: (balanceMinor: number) => void
}) {
	const { t, i18n } = useLinguiMacro()
	const errorText = useGiftCardErrorText()
	const [number, setNumber] = useState('')
	const [card, setCard] = useState<GiftCardSummary | null>(initialCard ?? null)
	const [amount, setAmount] = useState('')
	const [note, setNote] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [submitting, setSubmitting] = useState(false)
	const requestId = useRef(newKey('charge'))

	async function lookup(event: FormEvent) {
		event.preventDefault()
		setSubmitting(true)
		setError(null)
		try {
			setCard(await client.lookup(number.trim()))
		} catch (caught) {
			setError(errorText(caught))
		} finally {
			setSubmitting(false)
		}
	}

	async function charge(event: FormEvent) {
		event.preventDefault()
		if (!card) return
		const minor = parseMoneyToMinor(amount, { currency: card.currency, min: 1 })
		if (minor === null) return setError(t`Enter an amount above zero.`)
		if (minor > card.balanceMinor) {
			return setError(
				t`The card has ${formatGiftCardMoney(card.balanceMinor, card.currency, i18n.locale)}. Enter that or less.`,
			)
		}
		if (!note.trim()) return setError(t`Say what the charge is for.`)
		setSubmitting(true)
		setError(null)
		try {
			const done = await client.charge({
				cardId: card.id,
				amountMinor: minor,
				note: note.trim(),
				attachTo: attachTo ?? null,
				clientRequestId: requestId.current,
			})
			onDone(done.balanceMinor)
			onOpenChange(false)
		} catch (caught) {
			setError(errorText(caught))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<DialogShell
			open={open}
			onOpenChange={onOpenChange}
			submitting={submitting}
			title={<Trans>Charge a gift card</Trans>}
			description={
				<Trans>
					Take a payment from a card for a phone, catering or invoice order. It is recorded as
					"Charged from the App" with your name, not as an adjustment.
				</Trans>
			}
		>
			{card ? (
				<form onSubmit={charge} className="grid gap-4" noValidate>
					<p className="text-sm">
						<Trans>
							Card ending {card.last4}: balance{' '}
							<strong>{formatGiftCardMoney(card.balanceMinor, card.currency, i18n.locale)}</strong>
						</Trans>
					</p>
					<TextField
						label={t`Amount`}
						inputMode="decimal"
						value={amount}
						onChange={(event) => setAmount(event.target.value)}
						autoComplete="off"
					/>
					<TextAreaField
						label={t`What it is for`}
						value={note}
						onChange={(event) => setNote(event.target.value)}
						maxLength={500}
					/>
					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={submitting}>
							<Trans>Charge card</Trans>
						</Button>
					</DialogFooter>
				</form>
			) : (
				<form onSubmit={lookup} className="grid gap-4" noValidate>
					<TextField
						label={t`Card number`}
						value={number}
						onChange={(event) => setNumber(event.target.value)}
						autoComplete="off"
						autoCapitalize="characters"
					/>
					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={submitting || number.trim().length < 8}>
							<Trans>Find card</Trans>
						</Button>
					</DialogFooter>
				</form>
			)}
		</DialogShell>
	)
}

/** Refund a charge back to the card from its own history line. */
export function RefundChargeDialog({
	client,
	card,
	chargeId,
	maxMinor,
	open,
	onOpenChange,
	onDone,
}: {
	client: GiftCardClient
	card: GiftCardSummary
	chargeId: string
	maxMinor: number
	open: boolean
	onOpenChange: (open: boolean) => void
	onDone: () => void
}) {
	const { t, i18n } = useLinguiMacro()
	const errorText = useGiftCardErrorText()
	const [amount, setAmount] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [submitting, setSubmitting] = useState(false)
	const requestId = useRef(newKey('charge-refund'))

	async function submit(event: FormEvent) {
		event.preventDefault()
		const minor = parseMoneyToMinor(amount, { currency: card.currency, min: 1 })
		if (minor === null || minor > maxMinor) {
			return setError(
				t`Enter an amount up to ${formatGiftCardMoney(maxMinor, card.currency, i18n.locale)}.`,
			)
		}
		setSubmitting(true)
		setError(null)
		try {
			await client.refundCharge({
				cardId: card.id,
				chargeId,
				amountMinor: minor,
				clientRequestId: requestId.current,
			})
			onDone()
			onOpenChange(false)
		} catch (caught) {
			setError(errorText(caught))
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<DialogShell
			open={open}
			onOpenChange={onOpenChange}
			submitting={submitting}
			title={<Trans>Refund to the card</Trans>}
			description={
				<Trans>
					Give money from this charge back to the card, up to{' '}
					{formatGiftCardMoney(maxMinor, card.currency, i18n.locale)}.
				</Trans>
			}
		>
			<form onSubmit={submit} className="grid gap-4" noValidate>
				<TextField
					label={t`Amount`}
					inputMode="decimal"
					value={amount}
					onChange={(event) => setAmount(event.target.value)}
					autoComplete="off"
				/>
				{error ? (
					<Alert variant="destructive">
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<DialogFooter>
					<Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
						<Trans>Cancel</Trans>
					</Button>
					<Button type="submit" disabled={submitting}>
						<Trans>Refund</Trans>
					</Button>
				</DialogFooter>
			</form>
		</DialogShell>
	)
}

import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Armchair } from 'lucide-react'
import { useEffect, useState } from 'react'
import { waitlistDirty, walkInDirty } from './booking.ts'
import { DiscardAsk, DiscardClose, useDiscardGuard } from './discard.tsx'
import { formatPhoneTyping } from './guest.ts'
import { looksLikePhone, PartySize } from './sheets.tsx'
import { Button, cn, fieldClass, Modal } from '~/ui/primitives.tsx'

/** A walk-in from the top bar: how many, then the floor picks the table. */
export function WalkInSheet({
	open,
	onPlace,
	onClose,
}: {
	open: boolean
	onPlace: (partySize: number, guestName: string) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const [size, setSize] = useState(2)
	const [name, setName] = useState('')
	useEffect(() => {
		if (open) {
			setSize(2)
			setName('')
		}
	}, [open])
	// A name or a size typed is not thrown away by a stray tap outside.
	const guard = useDiscardGuard({
		open,
		dirty: walkInDirty({ name, size }),
		onClose,
	})
	return (
		<Modal
			open={open}
			onClose={onClose}
			dismissible={guard.dismissible}
			title={_(msg`Walk-in`)}
			footer={
				guard.asking ? (
					<DiscardAsk
						question={<Trans>Discard this walk-in?</Trans>}
						onKeep={guard.keep}
						onDiscard={guard.discard}
					/>
				) : (
					<div className="mb-safe">
						<Button
							variant="primary"
							size="lg"
							className="w-full"
							onClick={() => onPlace(size, name)}
						>
							<Armchair className="size-5" />
							<Trans>Choose a table</Trans>
						</Button>
					</div>
				)
			}
		>
			{guard.dismissible ? null : <DiscardClose onClick={guard.requestClose} />}
			<div className="flex flex-col gap-5 p-4 sm:p-5">
				<div className="flex flex-col gap-3">
					<p className="font-semibold">
						<Trans>How many?</Trans>
					</p>
					<PartySize value={size} onChange={setSize} />
				</div>
				<label className="flex flex-col gap-2">
					<span className="font-semibold">
						<Trans>Name (optional)</Trans>
					</span>
					<input
						className={fieldClass}
						value={name}
						maxLength={120}
						onChange={(event) => setName(event.target.value)}
						autoComplete="off"
					/>
				</label>
			</div>
		</Modal>
	)
}

/** What the waitlist form starts with: a name, or a number, typed into a search that found no one. */
export type WaitlistPrefill = { displayName: string; phone: string }

/** Adds a party to the waitlist at the stand. */
export function JoinWaitlistSheet({
	open,
	busy,
	prefill = null,
	loadQuote,
	onJoin,
	onClose,
}: {
	open: boolean
	busy: boolean
	/** Start with this name and number instead of an empty form. */
	prefill?: WaitlistPrefill | null
	/** How long a party this size would wait now, to tell them before they join. */
	loadQuote: (partySize: number) => Promise<{
		quotedMin: number | null
		position: number
	}>
	onJoin: (input: {
		displayName: string
		partySize: number
		phone: string | null
	}) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const [name, setName] = useState('')
	const [size, setSize] = useState(2)
	const [phone, setPhone] = useState('')
	useEffect(() => {
		if (open) {
			setName(prefill?.displayName ?? '')
			setSize(2)
			setPhone(prefill?.phone ?? '')
		}
	}, [open, prefill])
	const phoneProblem = phone.trim() !== '' && !looksLikePhone(phone)
	const [quote, setQuote] = useState<{
		quotedMin: number | null
		position: number
	} | null>(null)
	useEffect(() => {
		if (!open) return
		let live = true
		setQuote(null)
		loadQuote(size).then(
			(answer) => live && setQuote(answer),
			() => live && setQuote(null),
		)
		return () => {
			live = false
		}
	}, [open, size, loadQuote])
	const quotedMin = quote?.quotedMin ?? null
	const position = quote?.position ?? 0
	// What the form was started with is not the host's work: only a change from it asks.
	const guard = useDiscardGuard({
		open,
		dirty: waitlistDirty(
			{ name, phone, size },
			{ name: prefill?.displayName ?? '', phone: prefill?.phone ?? '' },
		),
		onClose,
	})
	return (
		<Modal
			open={open}
			onClose={onClose}
			dismissible={guard.dismissible}
			title={_(msg`Add to the waitlist`)}
			footer={
				guard.asking ? (
					<DiscardAsk
						question={<Trans>Discard this entry?</Trans>}
						onKeep={guard.keep}
						onDiscard={guard.discard}
					/>
				) : (
					<div className="mb-safe">
						<Button
							variant="primary"
							size="lg"
							className="w-full"
							disabled={!name.trim() || phoneProblem || busy}
							onClick={() =>
								onJoin({
									displayName: name,
									partySize: size,
									phone: phone.trim() || null,
								})
							}
						>
							{!name.trim() ? (
								<Trans>Add a name</Trans>
							) : phoneProblem ? (
								<Trans>Check the phone number</Trans>
							) : (
								<Trans>Add to the waitlist</Trans>
							)}
						</Button>
					</div>
				)
			}
		>
			{guard.dismissible ? null : <DiscardClose onClick={guard.requestClose} />}
			<div className="flex flex-col gap-5 p-4 sm:p-5">
				<label className="flex flex-col gap-2">
					<span className="font-semibold">
						<Trans>Name</Trans>
					</span>
					<input
						className={fieldClass}
						value={name}
						maxLength={120}
						autoComplete="off"
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<div className="flex flex-col gap-2">
					<span className="font-semibold">
						<Trans>Party size</Trans>
					</span>
					<PartySize value={size} onChange={setSize} />
					{/* Said to the party before they join: what they are signing up for. */}
					<p className="text-muted-foreground text-sm" role="status">
						{quote === null ? null : quotedMin === null ? (
							<Trans>No wait estimate right now.</Trans>
						) : (
							<Trans>
								About {quotedMin} min, number {position} in line.
							</Trans>
						)}
					</p>
				</div>
				<label className="flex flex-col gap-2">
					<span className="font-semibold">
						<Trans>Phone</Trans>
					</span>
					<input
						className={cn(fieldClass, 'tnum')}
						type="tel"
						inputMode="tel"
						dir="ltr"
						value={phone}
						maxLength={32}
						autoComplete="off"
						aria-invalid={phoneProblem}
						aria-describedby={
							phoneProblem ? 'waitlist-phone-problem' : undefined
						}
						onChange={(event) => {
							const field = event.target
							// Spaced as it is read out, while the caret is at the end of what is typed.
							setPhone(
								field.selectionStart === field.value.length
									? formatPhoneTyping(field.value)
									: field.value,
							)
						}}
					/>
					{/* The stand cannot record a guest's agreement: only the restaurant's own page or app can. */}
					<span className="text-muted-foreground text-sm">
						<Trans>A text is sent only if the guest agreed to messages.</Trans>
					</span>
					{phoneProblem ? (
						<span
							id="waitlist-phone-problem"
							className="text-destructive text-sm"
						>
							<Trans>
								Check the number: include the country code, like{' '}
								<bdi dir="ltr">+1 212 555 0100</bdi>.
							</Trans>
						</span>
					) : null}
				</label>
			</div>
		</Modal>
	)
}

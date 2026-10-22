import { type MessageDescriptor } from '@lingui/core'
import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { type Reason, type StaffRef } from '~/lib/db.ts'
import { type Audit } from '~/lib/orders.ts'
import { type ApprovalOutcome } from '~/lib/signin.ts'
import { Keypad } from '~/ui/Keypad.tsx'
import { Button, Modal, cn } from '~/ui/primitives.tsx'

const REASON_LABEL: Record<Reason, MessageDescriptor> = {
	mistake: msg`Rung up by mistake`,
	guest_request: msg`Guest changed their mind`,
	out_of_stock: msg`Out of stock`,
	quality: msg`Problem with the food`,
	wrong_charge: msg`Charged the wrong amount`,
	other: msg`Other`,
}

/** Why something came off a bill or money went back, in the till's language. */
export function useReasonLabel() {
	const { _ } = useLingui()
	return (reason: Reason) => _(REASON_LABEL[reason])
}

/**
 * Asks why something is coming off a bill or money is going back, and, when the
 * person at the till is not a manager, for a manager's PIN. The till records the
 * answer with the change; nothing here is optional when sign-in is on.
 */
export function AuditSheet({
	title,
	description,
	confirmLabel,
	reasons,
	me,
	needsManager,
	onApprove,
	onConfirm,
	onClose,
	children,
	canConfirm = true,
}: {
	title: string
	description: string
	confirmLabel: string
	reasons: Reason[]
	/** Who is signed in (null when the terminal does not use sign-in). */
	me: StaffRef | null
	/** True when sign-in is on and the person signed in is not a manager. */
	needsManager: boolean
	onApprove: (pin: string) => Promise<ApprovalOutcome>
	onConfirm: (audit: Audit) => Promise<string | null>
	onClose: () => void
	/** Extra inputs (an amount to refund), shown above the reasons. */
	children?: React.ReactNode
	canConfirm?: boolean
}) {
	const { _ } = useLingui()
	const reasonLabel = useReasonLabel()
	const [reason, setReason] = useState<Reason | null>(null)
	const [pin, setPin] = useState('')
	const [approvedBy, setApprovedBy] = useState<StaffRef | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const approve = async () => {
		if (pin.length < 4 || busy) return
		setBusy(true)
		setError(null)
		const outcome = await onApprove(pin)
		setBusy(false)
		setPin('')
		if (outcome.ok) setApprovedBy(outcome.manager)
		else setError(outcome.message)
	}

	const approverName = approvedBy?.name ?? ''
	const ready =
		canConfirm &&
		reason !== null &&
		(!needsManager || approvedBy !== null) &&
		!busy
	const confirm = async () => {
		if (!ready || !reason) return
		setBusy(true)
		setError(null)
		const failed = await onConfirm({ reason, by: me, approvedBy })
		setBusy(false)
		if (failed) setError(failed)
	}

	return (
		<Modal
			open
			onClose={onClose}
			title={title}
			size="md"
			footer={
				<div className="grid grid-cols-2 gap-3">
					<Button variant="outline" size="lg" onClick={onClose}>
						<Trans>Back</Trans>
					</Button>
					<Button
						variant="danger"
						size="lg"
						disabled={!ready}
						onClick={() => void confirm()}
					>
						{busy ? <Trans>Saving…</Trans> : confirmLabel}
					</Button>
				</div>
			}
		>
			<div className="space-y-4 p-5">
				<p className="text-muted-foreground">{description}</p>
				{children}
				<fieldset>
					<legend className="mb-2 text-sm font-semibold">
						<Trans>Why?</Trans>
					</legend>
					<div className="grid gap-2 sm:grid-cols-2">
						{reasons.map((r) => (
							<button
								key={r}
								type="button"
								aria-pressed={reason === r}
								onClick={() => setReason(r)}
								className={cn(
									'min-h-12 rounded-xl border px-3 text-start text-sm font-semibold transition active:scale-[0.98]',
									reason === r
										? 'border-primary bg-primary text-primary-foreground'
										: 'border-border bg-card hover:bg-accent',
								)}
							>
								{reasonLabel(r)}
							</button>
						))}
					</div>
				</fieldset>
				{needsManager ? (
					approvedBy ? (
						<p
							role="status"
							className="bg-success/12 text-success flex items-center gap-2 rounded-xl p-3 text-sm font-semibold"
						>
							<ShieldCheck className="size-5" />{' '}
							<Trans>Approved by {approverName}</Trans>
						</p>
					) : (
						<div className="border-border space-y-2 rounded-2xl border p-3">
							<p className="text-sm font-semibold">
								<Trans>A manager approves this with their PIN</Trans>
							</p>
							<div
								className="flex justify-center gap-3"
								role="img"
								aria-label={_(
									plural(pin.length, {
										one: '# digit entered',
										other: '# digits entered',
									}),
								)}
							>
								{Array.from(
									{ length: Math.max(4, pin.length) },
									(_unused, i) => (
										<span
											key={i}
											className={cn(
												'border-primary size-3.5 rounded-full border-2',
												i < pin.length && 'bg-primary',
											)}
										/>
									),
								)}
							</div>
							<Keypad
								value={pin}
								onChange={(next) => !busy && setPin(next.slice(0, 6))}
								maxDigits={6}
								raw
							/>
							<Button
								variant="primary"
								className="w-full"
								disabled={pin.length < 4 || busy}
								onClick={() => void approve()}
							>
								{busy ? <Trans>Checking…</Trans> : <Trans>Approve</Trans>}
							</Button>
						</div>
					)
				) : null}
				{error ? (
					<p role="alert" className="text-destructive text-sm font-medium">
						{error}
					</p>
				) : null}
			</div>
		</Modal>
	)
}

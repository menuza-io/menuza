import { type MessageDescriptor } from '@lingui/core'
import { msg, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { type Reason, type StaffRef } from '~/lib/db.ts'
import { type Audit } from '~/lib/orders.ts'
import { type ApprovalOutcome } from '~/lib/signin.ts'
import { ManagerPinPad } from '~/ui/ManagerPinPad.tsx'
import { Button, Chip, Modal, Reveal } from '~/ui/primitives.tsx'

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
		try {
			const outcome = await onApprove(pin)
			if (outcome.ok) setApprovedBy(outcome.manager)
			else setError(outcome.message)
		} catch {
			setError(_(t`Could not check the PIN. Try again.`))
		} finally {
			setPin('')
			setBusy(false)
		}
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
		try {
			const failed = await onConfirm({ reason, by: me, approvedBy })
			if (failed) setError(failed)
		} catch (e) {
			setError(
				e instanceof Error ? e.message : _(t`Something went wrong. Try again.`),
			)
		} finally {
			setBusy(false)
		}
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
							<Chip
								look="outlined"
								key={r}
								selected={reason === r}
								aria-pressed={reason === r}
								onClick={() => setReason(r)}
								className="h-auto min-h-12 justify-start px-3 py-2 text-start active:scale-[0.98]"
							>
								{reasonLabel(r)}
							</Chip>
						))}
					</div>
				</fieldset>
				{needsManager ? (
					approvedBy ? (
						<p
							role="status"
							className="t-pop-in notice-success flex items-center gap-2 rounded-(--station-control-radius) p-3 text-sm"
						>
							<Icon name="shield-check" className="size-5" />{' '}
							<Trans>Approved by {approverName}</Trans>
						</p>
					) : (
						<ManagerPinPad
							prompt={<Trans>A manager approves this with their PIN</Trans>}
							pin={pin}
							onPin={setPin}
							busy={busy}
							onApprove={() => void approve()}
						/>
					)
				) : null}
				<Reveal open={Boolean(error)}>
					<p role="alert" className="text-destructive text-sm font-medium">
						{error}
					</p>
				</Reveal>
			</div>
		</Modal>
	)
}

import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { posCustomerPhoneSchema } from '@repo/common/pos-orders'
import { useId, useState } from 'react'
import {
	parsePickupLocal,
	pickupLocalValue,
	type PhonePickup,
} from '~/lib/pickup.ts'
import {
	Button,
	Modal,
	Reveal,
	Segmented,
	fieldClass,
} from '~/ui/primitives.tsx'

/** The caller's details are committed together; Escape never changes the order. */
export function PhoneOrderSheet({
	details,
	timeZone,
	onSave,
	onClose,
}: {
	details: {
		customerName: string
		customerPhone: string
		pickupAt: number | null
		pickupTimeZone: string | null
	}
	timeZone?: string
	onSave: (details: PhonePickup) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const id = useId()
	const zone =
		details.pickupTimeZone ??
		timeZone ??
		Intl.DateTimeFormat().resolvedOptions().timeZone
	const [name, setName] = useState(details.customerName)
	const [phone, setPhone] = useState(details.customerPhone)
	const [timing, setTiming] = useState<'asap' | 'scheduled'>(
		details.pickupAt == null ? 'asap' : 'scheduled',
	)
	const [localTime, setLocalTime] = useState(
		details.pickupAt == null ? '' : pickupLocalValue(details.pickupAt, zone),
	)
	const [error, setError] = useState<string | null>(null)
	return (
		<Modal
			open
			title={_(t`Phone order`)}
			onClose={onClose}
			footer={
				<div className="grid grid-cols-2 gap-3">
					<Button variant="outline" size="lg" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button variant="primary" size="lg" type="submit" form={id}>
						<Trans>Use these details</Trans>
					</Button>
				</div>
			}
		>
			<form
				id={id}
				className="space-y-5 p-5"
				onSubmit={(event) => {
					event.preventDefault()
					if (!name.trim()) {
						setError(_(t`Enter a customer name for this phone order`))
						return
					}
					const parsed = posCustomerPhoneSchema.safeParse(phone)
					if (!parsed.success) {
						setError(_(t`Enter a valid callback number`))
						return
					}
					const pickupAt =
						timing === 'asap' ? null : parsePickupLocal(localTime, zone)
					if (
						timing === 'scheduled' &&
						(pickupAt === null ||
							(pickupAt <= Date.now() && pickupAt !== details.pickupAt))
					) {
						setError(
							_(t`Choose a future pickup time in the restaurant’s time zone`),
						)
						return
					}
					onSave({
						customerName: name.trim(),
						customerPhone: parsed.data,
						pickupAt,
						pickupTimeZone: zone,
					})
				}}
			>
				<p className="text-muted-foreground text-sm">
					<Trans>
						Pickup only. Take payment now or when the customer collects.
					</Trans>
				</p>
				<div className="space-y-2">
					<label htmlFor={`${id}-name`} className="block text-sm font-semibold">
						<Trans>Customer name</Trans>
					</label>
					<input
						id={`${id}-name`}
						autoFocus
						autoComplete="off"
						required
						maxLength={120}
						value={name}
						onChange={(e) => setName(e.target.value)}
						className={fieldClass}
					/>
				</div>
				<div className="space-y-2">
					<label
						htmlFor={`${id}-phone`}
						className="block text-sm font-semibold"
					>
						<Trans>Callback number</Trans>
					</label>
					<input
						id={`${id}-phone`}
						type="tel"
						dir="ltr"
						autoComplete="off"
						required
						maxLength={32}
						value={phone}
						onChange={(e) => setPhone(e.target.value)}
						className={fieldClass}
					/>
				</div>
				<div className="space-y-3">
					<Segmented
						label={_(t`Pickup time`)}
						value={timing}
						onChange={setTiming}
						options={[
							{ value: 'asap', label: _(t`ASAP`) },
							{ value: 'scheduled', label: _(t`Scheduled`) },
						]}
					/>
					<Reveal open={timing === 'scheduled'}>
						<div className="space-y-2 pb-1">
							<label
								htmlFor={`${id}-time`}
								className="block text-sm font-semibold"
							>
								<Trans>Pickup date and time</Trans>
							</label>
							<input
								id={`${id}-time`}
								type="datetime-local"
								dir="ltr"
								required
								value={localTime}
								onChange={(e) => setLocalTime(e.target.value)}
								className={fieldClass}
								aria-describedby={`${id}-zone`}
							/>
						</div>
					</Reveal>
					<p id={`${id}-zone`} className="text-muted-foreground text-sm">
						<Trans>Restaurant time: {zone}</Trans>
					</p>
				</div>
				<Reveal open={Boolean(error)}>
					<p role="alert" className="text-destructive text-sm font-medium">
						{error}
					</p>
				</Reveal>
			</form>
		</Modal>
	)
}

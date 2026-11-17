import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useEffect, useState } from 'react'
import { parseDecimal, toCents, type MoneyFormatter } from '~/lib/money.ts'
import { type CartLine } from '~/lib/pricing.ts'
import { type ApprovalOutcome } from '~/lib/signin.ts'
import { type KdsStationSummary } from '~/lib/types.ts'
import { Button, Input, Modal, Segmented, Select } from '~/ui/primitives.tsx'

const NO_KITCHEN = '__none__'

export function CustomItemSheet({
	open,
	editing = null,
	maxCents,
	money,
	kdsStations,
	needsManagerPin,
	onApprove,
	onClose,
	onSubmit,
}: {
	open: boolean
	editing?: CartLine | null
	maxCents: number
	money: MoneyFormatter
	kdsStations: KdsStationSummary[]
	needsManagerPin: boolean
	onApprove: (pin: string) => Promise<ApprovalOutcome>
	onClose: () => void
	onSubmit: (line: Omit<CartLine, 'id'>) => void
}) {
	if (!open) return null
	return (
		<CustomItemSheetBody
			key={editing?.id ?? 'new'}
			open={open}
			editing={editing}
			maxCents={maxCents}
			money={money}
			kdsStations={kdsStations}
			needsManagerPin={needsManagerPin}
			onApprove={onApprove}
			onClose={onClose}
			onSubmit={onSubmit}
		/>
	)
}

function CustomItemSheetBody({
	open,
	editing,
	maxCents,
	money,
	kdsStations,
	needsManagerPin,
	onApprove,
	onClose,
	onSubmit,
}: {
	open: boolean
	editing: CartLine | null
	maxCents: number
	money: MoneyFormatter
	kdsStations: KdsStationSummary[]
	needsManagerPin: boolean
	onApprove: (pin: string) => Promise<ApprovalOutcome>
	onClose: () => void
	onSubmit: (line: Omit<CartLine, 'id'>) => void
}) {
	const { _ } = useLingui()
	const [name, setName] = useState(editing?.name ?? '')
	const [priceText, setPriceText] = useState(
		editing ? (editing.baseCents / 100).toFixed(2) : '',
	)
	const [taxable, setTaxable] = useState<'standard' | 'none'>(
		editing?.taxable === false ? 'none' : 'standard',
	)
	const [kitchenStationId, setKitchenStationId] = useState<string>(
		editing?.kitchenStationId ?? NO_KITCHEN,
	)
	const [instructions, setInstructions] = useState(editing?.instructions ?? '')
	const [pin, setPin] = useState('')
	const [checking, setChecking] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		setError(null)
	}, [open])

	async function handleSubmit(event: React.FormEvent) {
		event.preventDefault()
		if (checking) return
		const trimmedName = name.trim()
		if (!trimmedName) {
			setError(_(t`Enter a name for this custom item.`))
			return
		}
		if (trimmedName.length > 60) {
			setError(_(t`Custom item name must be at most 60 characters.`))
			return
		}
		const amount = parseDecimal(priceText)
		if (amount === null) {
			setError(_(t`Enter a valid price.`))
			return
		}
		const cents = toCents(amount)
		if (cents <= 0) {
			setError(_(t`Price must be above zero.`))
			return
		}
		if (cents > maxCents) {
			const limit = money(maxCents)
			setError(_(t`Price cannot exceed ${limit}.`))
			return
		}
		if (needsManagerPin) {
			if (!pin.trim()) {
				setError(_(t`Enter a manager PIN to add a custom item.`))
				return
			}
			setChecking(true)
			try {
				const approved = await onApprove(pin.trim())
				setPin('')
				if (!approved.ok) {
					setError(approved.message)
					return
				}
			} finally {
				setChecking(false)
			}
		}
		setError(null)
		onSubmit({
			kind: 'custom',
			itemId: editing?.itemId ?? `custom:${crypto.randomUUID()}`,
			name: trimmedName,
			variantId: null,
			variantLabel: null,
			quantity: editing?.quantity ?? 1,
			baseCents: cents,
			taxable: taxable === 'standard',
			kitchenStationId:
				kitchenStationId === NO_KITCHEN ? null : kitchenStationId,
			instructions: instructions.trim(),
			options: [],
		})
	}

	const maxLimitText = money(maxCents)

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={editing ? _(t`Edit custom item`) : _(t`Custom item`)}
			footer={
				<Button
					type="submit"
					form="custom-item-form"
					variant="primary"
					size="lg"
					className="w-full"
					disabled={checking}
				>
					{editing ? <Trans>Update item</Trans> : <Trans>Add to order</Trans>}
				</Button>
			}
		>
			<form
				id="custom-item-form"
				onSubmit={(e) => void handleSubmit(e)}
				className="space-y-4 p-5"
			>
				<div className="space-y-1.5">
					<label
						htmlFor="custom-item-name"
						className="block text-sm font-medium"
					>
						<Trans>Name</Trans>
					</label>
					<Input
						id="custom-item-name"
						autoFocus
						value={name}
						onChange={(e) => setName(e.target.value)}
						maxLength={60}
						placeholder={_(t`e.g. Corkage fee or Special request`)}
						className="h-12 px-4"
					/>
				</div>

				<div className="space-y-1.5">
					<label
						htmlFor="custom-item-price"
						className="block text-sm font-medium"
					>
						<Trans>Price</Trans>
					</label>
					<Input
						id="custom-item-price"
						type="text"
						inputMode="decimal"
						dir="ltr"
						value={priceText}
						onChange={(e) => setPriceText(e.target.value)}
						placeholder="0.00"
						className="h-12 px-4 font-mono tabular-nums"
					/>
					<p className="text-muted-foreground text-xs">
						<Trans>Up to {maxLimitText}. Not saved to the menu.</Trans>
					</p>
				</div>

				<div className="space-y-1.5">
					<span className="block text-sm font-medium">
						<Trans>Tax</Trans>
					</span>
					<Segmented
						label={_(t`Tax`)}
						value={taxable}
						onChange={setTaxable}
						options={[
							{ value: 'standard', label: _(t`Standard`) },
							{ value: 'none', label: _(t`None`) },
						]}
					/>
				</div>

				<div className="space-y-1.5">
					<label
						htmlFor="custom-item-station"
						className="block text-sm font-medium"
					>
						<Trans>Kitchen station</Trans>
					</label>
					<Select
						id="custom-item-station"
						value={kitchenStationId}
						onChange={(e) => setKitchenStationId(e.target.value)}
					>
						<option value={NO_KITCHEN}>{_(t`None (no kitchen)`)}</option>
						{kdsStations.map((station) => (
							<option key={station.id} value={station.id}>
								{station.name}
							</option>
						))}
					</Select>
				</div>

				<div className="space-y-1.5">
					<label
						htmlFor="custom-item-note"
						className="block text-sm font-medium"
					>
						<Trans>Note (optional)</Trans>
					</label>
					<Input
						id="custom-item-note"
						value={instructions}
						onChange={(e) => setInstructions(e.target.value)}
						maxLength={280}
						placeholder={_(t`Optional note`)}
						className="h-12 px-4"
					/>
				</div>

				{needsManagerPin ? (
					<div className="space-y-1.5">
						<label
							htmlFor="custom-item-pin"
							className="block text-sm font-medium"
						>
							<Trans>Manager PIN</Trans>
						</label>
						<Input
							id="custom-item-pin"
							type="password"
							inputMode="numeric"
							autoComplete="off"
							maxLength={6}
							value={pin}
							onChange={(e) => setPin(e.target.value)}
							placeholder={_(t`Enter manager PIN`)}
							className="h-12 px-4"
						/>
					</div>
				) : null}

				{error ? (
					<p role="alert" className="text-destructive text-sm font-medium">
						{error}
					</p>
				) : null}
			</form>
		</Modal>
	)
}

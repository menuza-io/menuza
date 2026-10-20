import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	TIP_CADENCES,
	TIP_CARD_FEE_MAX_BP,
	TIP_FULFILLMENTS,
	TIP_SPLIT_BASES,
	type TipCadence,
	type TipFulfillment,
	type TipSplitBasis,
} from '@repo/staffing'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import {
	Field,
	FieldDescription,
	FieldError,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from '@repo/ui/field'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { saveTipSettings } from '#app/utils/staffing/labor-api.ts'
import { describeLaborError } from '#app/utils/staffing/labor-errors.ts'
import {
	type LaborPosition,
	type TipSettings,
} from '#app/utils/staffing/labor-types.ts'
import {
	bpToPercentText,
	percentToBp,
	positionLabel,
} from '#app/utils/staffing/labor-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'

/**
 * How a scope's tips are pooled and split. A report setting, not a payout:
 * the split basis, whether each day or the whole range is pooled, the share of
 * online tips withheld for card fees, and which online orders' tips join the
 * pool (delivery stays out until chosen, since drivers often keep theirs).
 */
export function TipSettingsDialog({
	client,
	settings,
	positions,
	onClose,
	onSaved,
}: {
	client: StaffClient
	settings: TipSettings
	positions: readonly LaborPosition[]
	onClose: () => void
	onSaved: () => void
}) {
	const { _, i18n } = useLingui()
	const locale = i18n.locale
	const [basis, setBasis] = useState<TipSplitBasis>(settings.splitBasis)
	const [cadence, setCadence] = useState<TipCadence>(settings.cadence)
	const [fee, setFee] = useState(bpToPercentText(settings.cardFeeBp))
	const [fulfillment, setFulfillment] = useState<ReadonlySet<TipFulfillment>>(
		new Set(settings.fulfillment),
	)
	const [percents, setPercents] = useState<Record<string, string>>(
		Object.fromEntries(
			positions.map((position) => [
				position.id,
				settings.positionPercentBp[position.id] !== undefined
					? bpToPercentText(settings.positionPercentBp[position.id]!)
					: '',
			]),
		),
	)
	const [errors, setErrors] = useState<{ fee?: string; percents?: string }>({})
	const save = useStaffAction(describeLaborError)

	const basisLabels: Record<TipSplitBasis, string> = {
		hours: _(t`By hours worked`),
		position_percent: _(t`By position percentage`),
	}
	const cadenceLabels: Record<TipCadence, string> = {
		period: _(t`The whole date range together`),
		daily: _(t`Each day on its own`),
	}
	const fulfillmentLabels: Record<TipFulfillment, string> = {
		pickup: _(t`Pickup orders`),
		delivery: _(t`Delivery orders`),
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (save.pending) return
		const feeBp = percentToBp(fee === '' ? '0' : fee)
		const next: typeof errors = {}
		if (feeBp === null || feeBp > TIP_CARD_FEE_MAX_BP) {
			next.fee = _(t`Enter a fee from 0 to 10 percent.`)
		}
		const positionPercentBp: Record<string, number> = {}
		if (basis === 'position_percent') {
			let total = 0
			for (const position of positions) {
				const text = percents[position.id] ?? ''
				if (text.trim() === '') continue
				const bp = percentToBp(text)
				if (bp === null || bp > 10_000) {
					next.percents = _(t`Enter each percentage as a number from 0 to 100.`)
					break
				}
				if (bp > 0) positionPercentBp[position.id] = bp
				total += bp
			}
			if (!next.percents && total !== 10_000) {
				next.percents = _(t`The percentages need to add up to 100.`)
			}
		}
		setErrors(next)
		if (next.fee || next.percents || feeBp === null) return
		const result = await save.run(() =>
			saveTipSettings(client, {
				scopeId: settings.scopeId,
				splitBasis: basis,
				cadence,
				cardFeeBp: feeBp,
				fulfillment: TIP_FULFILLMENTS.filter((value) => fulfillment.has(value)),
				positionPercentBp,
			}),
		)
		if (result.ok) {
			toast.success(_(t`Tip rules saved.`))
			onSaved()
			onClose()
		}
	}

	const totalText = bpToPercentText(
		positions.reduce(
			(sum, position) => sum + (percentToBp(percents[position.id] ?? '') ?? 0),
			0,
		),
	)

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Tip rules</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							How the tip report divides tips for this workplace. It only builds
							a report; it does not pay anyone.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={(event) => void submit(event)}
					noValidate
					className="grid gap-4"
				>
					<SelectField
						label={<Trans>Divide tips</Trans>}
						value={basis}
						onValueChange={(value) => setBasis(value as TipSplitBasis)}
						options={TIP_SPLIT_BASES.map((value) => ({
							value,
							label: basisLabels[value],
						}))}
					/>
					<SelectField
						label={<Trans>Pool</Trans>}
						value={cadence}
						onValueChange={(value) => setCadence(value as TipCadence)}
						options={TIP_CADENCES.map((value) => ({
							value,
							label: cadenceLabels[value],
						}))}
					/>
					<TextField
						label={<Trans>Card fee withheld from online tips (%)</Trans>}
						inputMode="decimal"
						dir="ltr"
						value={fee}
						onChange={(event) => {
							setFee(event.target.value)
							setErrors((e) => ({ ...e, fee: undefined }))
						}}
						hint={<Trans>Cash tips have no card fee. Up to 10 percent.</Trans>}
						error={errors.fee}
					/>
					<FieldSet>
						<FieldLegend variant="label">
							<Trans>Online order tips that join the pool</Trans>
						</FieldLegend>
						<FieldDescription>
							<Trans>
								Whether online tips may be shared depends on where you operate.
								Delivery tips often belong to the driver, so they are left out
								unless you choose them.
							</Trans>
						</FieldDescription>
						{TIP_FULFILLMENTS.map((value) => (
							<Label key={value} className="min-h-11 items-center">
								<Checkbox
									checked={fulfillment.has(value)}
									onCheckedChange={(checked) =>
										setFulfillment((current) => {
											const next = new Set(current)
											if (checked) next.add(value)
											else next.delete(value)
											return next
										})
									}
								/>
								{fulfillmentLabels[value]}
							</Label>
						))}
					</FieldSet>
					{basis === 'position_percent' ? (
						<FieldSet>
							<FieldLegend variant="label">
								<Trans>Share of the pool for each position (%)</Trans>
							</FieldLegend>
							{positions.length === 0 ? (
								<FieldDescription>
									<Trans>Add positions on the Team page first.</Trans>
								</FieldDescription>
							) : (
								positions.map((position) => (
									<Field
										key={position.id}
										orientation="horizontal"
										className="justify-between gap-3"
									>
										<FieldLabel
											htmlFor={`tip-pct-${position.id}`}
											className="min-w-0 truncate font-normal"
										>
											{positionLabel(position, locale)}
										</FieldLabel>
										<Input
											id={`tip-pct-${position.id}`}
											inputMode="decimal"
											dir="ltr"
											value={percents[position.id] ?? ''}
											onChange={(event) => {
												const value = event.target.value
												setPercents((current) => ({
													...current,
													[position.id]: value,
												}))
												setErrors((e) => ({ ...e, percents: undefined }))
											}}
											className="h-11 w-24 text-end tabular-nums md:h-8"
										/>
									</Field>
								))
							)}
							{errors.percents ? (
								<FieldError>{errors.percents}</FieldError>
							) : (
								<FieldDescription>
									<Trans>Total {totalText} of 100</Trans>
								</FieldDescription>
							)}
						</FieldSet>
					) : null}
					{save.error ? <FieldError>{save.error}</FieldError> : null}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={save.pending}
							onClick={onClose}
						>
							<Trans>Cancel</Trans>
						</Button>
						<Button type="submit" disabled={save.pending}>
							{save.pending ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}

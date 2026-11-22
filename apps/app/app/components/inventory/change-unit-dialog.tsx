import { Trans, useLingui } from '@lingui/react/macro'
import {
	type Blocker,
	type InventoryBaseUnit,
	type ItemDetail,
	type UnitChangePlan,
	unitChangePlanSchema,
	unitChangeResultSchema,
	changeableTargets,
	conversionFactor,
} from '@repo/inventory'
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
import { Field, FieldError, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { formatMoney } from '#app/utils/inventory/format.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { BlockerList } from './blocker-list.tsx'

/** `1.5` and `1,5` both mean one and a half. */
function cleanAmount(text: string): string {
	return text.trim().replace(',', '.')
}

function unitLabel(unit: InventoryBaseUnit): string {
	return unit === 'piece' ? 'piece' : unit
}

/**
 * Change an item's unit (#494): pick the new base unit, say what one of the
 * old equals ("1 piece = 180 g"), and see what changes before it does: on
 * hand, cost, every pack size, every recipe line, the levels and the last
 * count, in the old and the new unit. Applying writes exactly the plan shown.
 * History is not rewritten; reports before and after show the same money.
 */
export function ChangeUnitDialog({
	item,
	open,
	onOpenChange,
	onChanged,
	canSeeCost,
	currency,
}: {
	item: ItemDetail
	open: boolean
	onOpenChange: (open: boolean) => void
	onChanged: () => void
	canSeeCost: boolean
	currency: string
}) {
	const { t, i18n } = useLingui()
	const { request } = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const oldId = useId()
	const newId = useId()
	const targets = changeableTargets(item.baseUnit)
	const [toUnit, setToUnit] = useState<InventoryBaseUnit>(targets[0]!)
	// "1 piece = 180 g": the old amount is 1 by default, except into pieces.
	const [oldAmount, setOldAmount] = useState('1')
	const [newAmount, setNewAmount] = useState('')
	const [plan, setPlan] = useState<UnitChangePlan | null>(null)
	const [loading, setLoading] = useState(false)
	const [applying, setApplying] = useState(false)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => {
		if (!open) return
		setToUnit(changeableTargets(item.baseUnit)[0]!)
		setOldAmount('1')
		setNewAmount('')
		setPlan(null)
		setError(null)
	}, [open, item.baseUnit])

	const factor = conversionFactor(
		cleanAmount(oldAmount),
		cleanAmount(newAmount),
	)
	const valid = factor.ok
	const body = {
		toUnit,
		oldAmount: cleanAmount(oldAmount),
		newAmount: cleanAmount(newAmount),
		expectedVersion: item.version,
	}

	// The preview follows the typing, a moment after it stops.
	useEffect(() => {
		if (!open || !valid) {
			setPlan(null)
			return
		}
		let cancelled = false
		setLoading(true)
		const timer = setTimeout(() => {
			request(`/items/${encodeURIComponent(item.id)}/unit-change/preview`, {
				method: 'POST',
				body: JSON.stringify(body),
				readOnly: true,
			})
				.then((answer) => {
					if (cancelled) return
					setPlan(unitChangePlanSchema.parse(answer))
					setError(null)
				})
				.catch((caught: unknown) => {
					if (cancelled) return
					setPlan(null)
					setError(i18n._(inventorySaveErrorMessage(caught)))
				})
				.finally(() => {
					if (!cancelled) setLoading(false)
				})
		}, 350)
		return () => {
			cancelled = true
			clearTimeout(timer)
		}
		// `body` is rebuilt from the inputs below on every render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, valid, toUnit, oldAmount, newAmount, item.id, item.version])

	async function apply() {
		if (!plan || !plan.canApply || applying) return
		setApplying(true)
		setError(null)
		try {
			unitChangeResultSchema.parse(
				await request(`/items/${encodeURIComponent(item.id)}/unit-change`, {
					method: 'POST',
					body: JSON.stringify(body),
				}),
			)
			toast.success(t`Unit changed.`)
			notifyChanged()
			onChanged()
			onOpenChange(false)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setApplying(false)
		}
	}

	const fromLabel = quantity.unitName(unitLabel(item.baseUnit), undefined)
	const toLabel = quantity.unitName(unitLabel(toUnit), undefined)
	const money = (minor: number | undefined) =>
		minor === undefined ? '' : formatMoney(minor, currency, i18n.locale)
	void money

	const fmtOld = (value: number) =>
		quantity.format(value, { baseUnit: item.baseUnit })
	const fmtNew = (value: number) => quantity.format(value, { baseUnit: toUnit })

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!applying) onOpenChange(next)
			}}
		>
			<DialogContent
				className="max-h-dvh overflow-y-auto sm:max-w-lg"
				data-testid="change-unit-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						<Trans>Change unit</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Count <span className="wrap-anywhere">{item.name}</span> in a
							different unit. Stock, prices per unit and recipes are converted
							for you. Your history is not changed.
						</Trans>
					</DialogDescription>
				</DialogHeader>

				{error ? (
					<Alert variant="destructive" data-testid="change-unit-error">
						<Icon name="alert-triangle" />
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}

				<Field>
					<FieldLabel>
						<Trans>New unit</Trans>
					</FieldLabel>
					<ToggleGroup
						aria-label={t`New unit`}
						variant="segmented"
						value={[toUnit]}
						disabled={applying}
						onValueChange={(next) => {
							const unit = next[0] as InventoryBaseUnit | undefined
							if (!unit) return
							setToUnit(unit)
							// Into pieces the one is on the new side ("180 g = 1 piece").
							if (unit === 'piece') {
								setOldAmount('')
								setNewAmount('1')
							} else {
								setOldAmount('1')
								setNewAmount('')
							}
						}}
					>
						{targets.map((unit) => (
							<ToggleGroupItem
								key={unit}
								value={unit}
								className="h-11 min-w-11 md:h-7"
								data-testid={`change-unit-to-${unit}`}
							>
								<bdi dir="ltr">
									{quantity.unitName(unitLabel(unit), undefined)}
								</bdi>
							</ToggleGroupItem>
						))}
					</ToggleGroup>
				</Field>

				<div className="flex flex-wrap items-end gap-2">
					<Field className="w-28">
						<FieldLabel htmlFor={oldId}>
							<Trans>How many</Trans>
						</FieldLabel>
						<Input
							id={oldId}
							inputMode="decimal"
							value={oldAmount}
							onChange={(event) => setOldAmount(event.target.value)}
							disabled={applying}
							dir="ltr"
							data-testid="change-unit-old"
						/>
					</Field>
					<span className="pb-2 text-sm">
						<bdi dir="ltr">{fromLabel}</bdi> =
					</span>
					<Field className="w-28">
						<FieldLabel htmlFor={newId}>
							<Trans>equals</Trans>
						</FieldLabel>
						<Input
							id={newId}
							inputMode="decimal"
							value={newAmount}
							onChange={(event) => setNewAmount(event.target.value)}
							disabled={applying}
							dir="ltr"
							data-testid="change-unit-new"
						/>
					</Field>
					<span className="pb-2 text-sm">
						<bdi dir="ltr">{toLabel}</bdi>
					</span>
				</div>
				{(oldAmount !== '' || newAmount !== '') && !valid ? (
					<FieldError>
						<Trans>Enter both amounts as numbers above zero.</Trans>
					</FieldError>
				) : null}

				{plan ? (
					<PlanPreview
						plan={plan}
						fmtOld={fmtOld}
						fmtNew={fmtNew}
						canSeeCost={canSeeCost}
						currency={currency}
					/>
				) : loading ? (
					<p
						className="text-muted-foreground text-sm"
						role="status"
						data-testid="change-unit-loading"
					>
						<Trans>Working out what changes…</Trans>
					</p>
				) : null}

				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={applying}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						onClick={() => void apply()}
						disabled={!plan || !plan.canApply || applying}
						data-testid="change-unit-apply"
					>
						{applying ? <Trans>Changing…</Trans> : <Trans>Change unit</Trans>}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function Row({
	label,
	before,
	after,
}: {
	label: React.ReactNode
	before: string
	after: string
}) {
	return (
		<li className="flex items-baseline justify-between gap-3 py-1 text-sm">
			<span className="min-w-0 wrap-anywhere">{label}</span>
			<span className="shrink-0 tabular-nums">
				<bdi dir="ltr">{before}</bdi> →{' '}
				<bdi dir="ltr" className="font-medium">
					{after}
				</bdi>
			</span>
		</li>
	)
}

function PlanPreview({
	plan,
	fmtOld,
	fmtNew,
	canSeeCost,
	currency,
}: {
	plan: UnitChangePlan
	fmtOld: (value: number) => string
	fmtNew: (value: number) => string
	canSeeCost: boolean
	currency: string
}) {
	const { i18n } = useLingui()
	const costNumber = (micro: number) =>
		new Intl.NumberFormat(i18n.locale, { maximumFractionDigits: 6 }).format(
			micro / 1_000_000,
		)
	return (
		<div className="flex flex-col gap-3" data-testid="change-unit-preview">
			{plan.blockers.length > 0 ? (
				<BlockerList
					blockers={plan.blockers satisfies Blocker[]}
					title={<Trans>Finish these first</Trans>}
				/>
			) : null}
			{plan.tooSmall ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>
							With this conversion an amount would round to nothing. Check the
							numbers.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			{plan.needsRecipeGrant ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>
							Recipes use this item, so changing its unit needs the recipe role.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}
			<h4 className="text-sm font-semibold">
				<Trans>What will change</Trans>
			</h4>
			<ul className="flex flex-col divide-y rounded-xl border px-3">
				{plan.onHand.map((row) => (
					<Row
						key={row.locationId}
						label={<Trans>On hand</Trans>}
						before={fmtOld(row.before)}
						after={fmtNew(row.after)}
					/>
				))}
				{canSeeCost && plan.cost?.avg ? (
					<Row
						label={<Trans>Average cost per unit</Trans>}
						before={`${currency} ${costNumber(plan.cost.avg.before ?? 0)}`}
						after={`${currency} ${costNumber(plan.cost.avg.after ?? 0)}`}
					/>
				) : null}
				{plan.packs.map((pack) => (
					<Row
						key={`${pack.kind}-${pack.id}`}
						label={pack.name}
						before={fmtOld(pack.before)}
						after={fmtNew(pack.after)}
					/>
				))}
				{plan.recipes.flatMap((recipe) =>
					recipe.lines.map((line) => (
						<Row
							key={`${recipe.ownerId}-${line.lineId}`}
							label={<Trans>A recipe line</Trans>}
							before={fmtOld(line.before)}
							after={fmtNew(line.after)}
						/>
					)),
				)}
				{plan.levels.flatMap((level) => [
					level.orderBelow ? (
						<Row
							key={`${level.locationId}-below`}
							label={<Trans>Order more when below</Trans>}
							before={fmtOld(level.orderBelow.before)}
							after={fmtNew(level.orderBelow.after)}
						/>
					) : null,
					level.fillUpTo ? (
						<Row
							key={`${level.locationId}-fill`}
							label={<Trans>Fill up to</Trans>}
							before={fmtOld(level.fillUpTo.before)}
							after={fmtNew(level.fillUpTo.after)}
						/>
					) : null,
				])}
				{plan.lastCount ? (
					<Row
						label={<Trans>Last count</Trans>}
						before={fmtOld(plan.lastCount.before)}
						after={fmtNew(plan.lastCount.after)}
					/>
				) : null}
			</ul>
			{plan.recipes.length > 0 ? (
				<p className="text-muted-foreground text-xs">
					<Trans>
						Recipes that use this item get a new version. The old versions are
						kept.
					</Trans>
				</p>
			) : null}
		</div>
	)
}

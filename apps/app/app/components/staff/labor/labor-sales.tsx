import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { addDays } from '@repo/staffing'
import { Button } from '@repo/ui/button'
import { FieldError } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Item, ItemActions, ItemContent, ItemGroup } from '@repo/ui/item'
import { Label } from '@repo/ui/label'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { deleteSale, saveSale } from '#app/utils/staffing/labor-api.ts'
import { describeLaborError } from '#app/utils/staffing/labor-errors.ts'
import { type SalesEntry } from '#app/utils/staffing/labor-types.ts'
import {
	amountInputOf,
	readAmountInput,
} from '#app/utils/staffing/labor-view.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { formatDateLabel } from '#app/utils/staffing/timesheet-view.ts'

/**
 * The net sales of each day in the range, typed in by hand. One row per day,
 * newest first, with the amount box already where the cursor goes: a manager
 * closing the day types the figure and presses Enter. A row only shows Save
 * once it differs from what is stored, and a day with nothing entered simply
 * has no sales (it is left out of the labor share, not counted as zero).
 */
export function LaborSales({
	client,
	scopeId,
	currency,
	from,
	to,
	entries,
	canEdit,
	onChanged,
	onImport,
}: {
	client: StaffClient
	scopeId: string
	/** The scope's currency, used for any day entered here. */
	currency: string
	from: string
	to: string
	entries: readonly SalesEntry[]
	canEdit: boolean
	onChanged: () => void
	onImport: () => void
}) {
	const { i18n } = useLingui()
	const locale = i18n.locale
	const byDate = useMemo(
		() => new Map(entries.map((entry) => [entry.date, entry])),
		[entries],
	)
	const dates = useMemo(() => {
		const out: string[] = []
		for (let date = to, guard = 0; date >= from && guard < 120; guard++) {
			out.push(date)
			date = addDays(date, -1)
		}
		return out
	}, [from, to])

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-muted-foreground max-w-prose text-sm text-pretty">
					<Trans>
						Net sales are sales before tax, tips and fees. Days you leave empty
						are not counted as zero: they are left out of the labor share.
					</Trans>
				</p>
				{canEdit ? (
					<Button variant="outline" onClick={onImport}>
						<Icon name="file-text" />
						<Trans>Import a file</Trans>
					</Button>
				) : null}
			</div>
			<ItemGroup className="gap-2">
				{dates.map((date) => (
					<SalesRow
						key={`${date}:${byDate.get(date)?.updatedAt ?? 0}`}
						client={client}
						scopeId={scopeId}
						currency={byDate.get(date)?.currency ?? currency}
						date={date}
						label={formatDateLabel(date, locale)}
						entry={byDate.get(date) ?? null}
						canEdit={canEdit}
						onChanged={onChanged}
					/>
				))}
			</ItemGroup>
		</div>
	)
}

function SalesRow({
	client,
	scopeId,
	currency,
	date,
	label,
	entry,
	canEdit,
	onChanged,
}: {
	client: StaffClient
	scopeId: string
	currency: string
	date: string
	label: string
	entry: SalesEntry | null
	canEdit: boolean
	onChanged: () => void
}) {
	const { _ } = useLingui()
	const stored = entry ? amountInputOf(entry.netSalesMinor) : ''
	const [text, setText] = useState(stored)
	const [problem, setProblem] = useState<string | null>(null)
	const action = useStaffAction(describeLaborError)
	const parsed = readAmountInput(text)
	const changed = text.trim() !== stored

	async function save() {
		if (action.pending || !changed) return
		if (parsed.state === 'empty') {
			if (!entry) return
			const result = await action.run(() =>
				deleteSale(client, { scopeId, date }),
			)
			if (result.ok) {
				toast.success(_(t`Sales for ${label} removed.`))
				onChanged()
			}
			return
		}
		if (parsed.state === 'invalid') {
			setProblem(_(t`Enter an amount like 1250.50.`))
			return
		}
		setProblem(null)
		const result = await action.run(() =>
			saveSale(client, {
				scopeId,
				date,
				netSalesMinor: parsed.minor,
				currency,
			}),
		)
		if (result.ok) {
			toast.success(_(t`Sales for ${label} saved.`))
			onChanged()
		}
	}

	const error = problem ?? action.error
	const inputId = `sales-${date}`
	return (
		<Item variant="outline">
			<ItemContent className="w-32 flex-none md:w-40">
				<Label htmlFor={inputId}>{label}</Label>
			</ItemContent>
			<ItemActions>
				<Input
					id={inputId}
					inputMode="decimal"
					dir="ltr"
					autoComplete="off"
					disabled={!canEdit}
					value={text}
					placeholder="0.00"
					aria-invalid={error ? true : undefined}
					aria-describedby={error ? `${inputId}-error` : undefined}
					className="h-11 w-32 text-end tabular-nums"
					onChange={(event) => {
						setText(event.target.value)
						setProblem(null)
					}}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault()
							void save()
						}
					}}
				/>
				<span className="text-muted-foreground text-xs" aria-hidden="true">
					{currency}
				</span>
				{canEdit && changed ? (
					<Button
						size="sm"
						disabled={action.pending}
						onClick={() => void save()}
					>
						{parsed.state === 'empty' ? (
							<Trans>Remove</Trans>
						) : (
							<Trans>Save</Trans>
						)}
					</Button>
				) : null}
			</ItemActions>
			{entry?.source === 'csv' && !changed ? (
				<span className="text-muted-foreground text-xs">
					<Trans>From a file</Trans>
				</span>
			) : null}
			{error ? (
				<FieldError id={`${inputId}-error`} className="basis-full">
					{error}
				</FieldError>
			) : null}
		</Item>
	)
}

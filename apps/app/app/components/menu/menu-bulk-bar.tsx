import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'

export function MenuBulkBar({
	selectedCount,
	allFilteredSelected,
	onToggleSelectAll,
	onBulkEdit,
	onClear,
}: {
	selectedCount: number
	allFilteredSelected: boolean
	onToggleSelectAll: (checked: boolean) => void
	onBulkEdit: () => void
	onClear: () => void
}) {
	const { _ } = useLingui()
	if (selectedCount === 0) return null

	return (
		<div
			role="region"
			aria-label={_(t`Selected menu rows`)}
			className="bg-background border-border sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-xl border p-2 shadow-md"
		>
			<div className="flex items-center gap-2 ps-2">
				<Checkbox
					id="menu-select-all-filtered"
					checked={allFilteredSelected}
					onCheckedChange={(value) => onToggleSelectAll(value === true)}
					aria-label={_(t`Select all matching filter`)}
				/>
				<Label htmlFor="menu-select-all-filtered" className="text-sm font-medium">
					{plural(selectedCount, {
						one: '# selected',
						other: '# selected',
					})}
				</Label>
			</div>
			<div className="ms-auto flex flex-wrap items-center gap-2">
				<Button onClick={onBulkEdit}>
					<Icon name="pencil" className="size-4" />
					<Trans>Bulk edit</Trans>
				</Button>
				<Button variant="ghost" onClick={onClear}>
					<Trans>Clear</Trans>
				</Button>
			</div>
		</div>
	)
}

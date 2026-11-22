import { Trans, useLingui } from '@lingui/react/macro'
import {
	type InventoryBaseUnit,
	type ItemGroup,
	conversionFactor,
	INVENTORY_BASE_UNITS,
	itemGroupSchema,
	MAX_GROUP_MEMBERS,
	type StockItem,
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
import { Field, FieldLabel } from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import {
	useNotifyInventoryChanged,
	useQuantityFormat,
} from '#app/components/inventory/inventory-prefs.tsx'
import { ItemPicker } from '#app/components/inventory/item-picker.tsx'
import { useInventoryClient } from '#app/hooks/use-inventory-client.ts'
import { inventorySaveErrorMessage } from '#app/utils/inventory/inventory-errors.ts'
import { newClientId } from '#app/utils/inventory/waste-form.ts'

type Draft = {
	itemId: string
	name: string
	baseUnit: InventoryBaseUnit
	/** "1 member = N group units", typed (only when the units differ). */
	memberAmount: string
	groupAmount: string
}

function toDraft(
	member: ItemGroup['members'][number],
	groupUnit: InventoryBaseUnit,
): Draft {
	if (member.baseUnit === groupUnit) {
		return {
			itemId: member.itemId,
			name: member.name,
			baseUnit: member.baseUnit,
			memberAmount: '1',
			groupAmount: '1',
		}
	}
	// member thousandths : group thousandths = memberQuantity : groupQuantity
	return {
		itemId: member.itemId,
		name: member.name,
		baseUnit: member.baseUnit,
		memberAmount: String(member.memberQuantity),
		groupAmount: String(member.groupQuantity),
	}
}

function ratio(draft: Draft, groupUnit: InventoryBaseUnit) {
	if (draft.baseUnit === groupUnit)
		return { memberQuantity: 1, groupQuantity: 1 }
	const factor = conversionFactor(
		draft.memberAmount.trim().replace(',', '.'),
		draft.groupAmount.trim().replace(',', '.'),
	)
	// new (group) per old (member) = num / den.
	return factor.ok
		? { memberQuantity: factor.factor.den, groupQuantity: factor.factor.num }
		: null
}

/**
 * Group products that can stand in for each other ("Olive oil": brand A, brand
 * B). Each stays its own item; recipes can name the group, a sale takes stock
 * from the first one and then the next, and a dish goes off the menu only when
 * all of them are out. Creates a group, or edits one (name and order).
 */
export function GroupDialog({
	group,
	locationId,
	open,
	onOpenChange,
	onSaved,
}: {
	group: ItemGroup | null
	locationId: string
	open: boolean
	onOpenChange: (open: boolean) => void
	onSaved: (group: ItemGroup) => void
}) {
	const { t, i18n } = useLingui()
	const client = useInventoryClient()
	const quantity = useQuantityFormat()
	const notifyChanged = useNotifyInventoryChanged()
	const nameId = useId()
	const [name, setName] = useState('')
	const [baseUnit, setBaseUnit] = useState<InventoryBaseUnit>('g')
	const [members, setMembers] = useState<Draft[]>([])
	const [saving, setSaving] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const clientId = useState(() => newClientId('grp'))[0]

	useEffect(() => {
		if (!open) return
		setError(null)
		if (group) {
			setName(group.name)
			setBaseUnit(group.baseUnit)
			setMembers(group.members.map((member) => toDraft(member, group.baseUnit)))
		} else {
			setName('')
			setBaseUnit('g')
			setMembers([])
		}
	}, [open, group])

	const converted = members.map((member) => ratio(member, baseUnit))
	const valid =
		name.trim() !== '' &&
		members.length > 0 &&
		converted.every((entry) => entry !== null)

	function move(index: number, by: -1 | 1) {
		const next = [...members]
		const target = index + by
		if (target < 0 || target >= next.length) return
		;[next[index], next[target]] = [next[target]!, next[index]!]
		setMembers(next)
	}

	function add(item: StockItem) {
		if (item.isGroup || item.groupId) {
			setError(t`That item is already in a group or is a group itself.`)
			return
		}
		if (members.some((member) => member.itemId === item.id)) return
		if (members.length === 0 && !group) setBaseUnit(item.baseUnit)
		setError(null)
		setMembers((current) => [
			...current,
			{
				itemId: item.id,
				name: item.name,
				baseUnit: item.baseUnit,
				memberAmount: '1',
				groupAmount: item.baseUnit === (group?.baseUnit ?? baseUnit) ? '1' : '',
			},
		])
	}

	async function save() {
		if (!valid || saving) return
		setSaving(true)
		setError(null)
		const payloadMembers = members.map((member, index) => ({
			itemId: member.itemId,
			...converted[index]!,
		}))
		try {
			const answer = group
				? await client.request(`/groups/${encodeURIComponent(group.id)}`, {
						method: 'PATCH',
						body: JSON.stringify({
							expectedVersion: group.version,
							name: name.trim(),
							members: payloadMembers,
						}),
					})
				: await client.request('/groups', {
						method: 'POST',
						body: JSON.stringify({
							clientId,
							name: name.trim(),
							baseUnit,
							members: payloadMembers,
						}),
					})
			const saved = itemGroupSchema.parse(answer)
			toast.success(group ? t`Group saved.` : t`Group created.`)
			notifyChanged()
			onSaved(saved)
			onOpenChange(false)
		} catch (caught) {
			setError(i18n._(inventorySaveErrorMessage(caught)))
		} finally {
			setSaving(false)
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!saving) onOpenChange(next)
			}}
		>
			<DialogContent
				className="max-h-dvh overflow-y-auto sm:max-w-lg"
				data-testid="group-dialog"
			>
				<DialogHeader>
					<DialogTitle>
						{group ? <Trans>Edit group</Trans> : <Trans>Group products</Trans>}
					</DialogTitle>
					<DialogDescription>
						<Trans>
							Products that can replace each other, like two brands of olive
							oil. Sales use the first one, then the next when it runs out. Each
							keeps its own count, pack and price.
						</Trans>
					</DialogDescription>
				</DialogHeader>
				{error ? (
					<Alert variant="destructive" data-testid="group-error">
						<Icon name="alert-triangle" />
						<AlertDescription>{error}</AlertDescription>
					</Alert>
				) : null}
				<Field>
					<FieldLabel htmlFor={nameId}>
						<Trans>Group name</Trans>
					</FieldLabel>
					<Input
						id={nameId}
						value={name}
						onChange={(event) => setName(event.target.value)}
						maxLength={80}
						disabled={saving}
						data-testid="group-name"
					/>
				</Field>
				{!group && members.length === 0 ? null : (
					<Field>
						<FieldLabel>
							<Trans>The group is counted in</Trans>
						</FieldLabel>
						<ToggleGroup
							aria-label={t`The group is counted in`}
							variant="segmented"
							value={[baseUnit]}
							disabled={saving || !!group}
							onValueChange={(next) => {
								if (next[0]) setBaseUnit(next[0] as InventoryBaseUnit)
							}}
						>
							{INVENTORY_BASE_UNITS.map((unit) => (
								<ToggleGroupItem
									key={unit}
									value={unit}
									className="h-11 min-w-11 md:h-7"
								>
									<bdi dir="ltr">{quantity.unitName(unit, undefined)}</bdi>
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</Field>
				)}
				<ol className="flex flex-col gap-2" data-testid="group-members">
					{members.map((member, index) => (
						<li
							key={member.itemId}
							className="flex flex-col gap-2 rounded-lg border p-3"
							data-testid={`group-member-${member.itemId}`}
						>
							<div className="flex items-center justify-between gap-2">
								<span className="min-w-0 text-sm font-medium wrap-anywhere">
									{index === 0 ? (
										<Trans>First: {member.name}</Trans>
									) : (
										<Trans>Then: {member.name}</Trans>
									)}
								</span>
								<span className="flex shrink-0 gap-1">
									<Button
										type="button"
										variant="outline"
										size="icon-sm"
										aria-label={t`Move up`}
										disabled={index === 0 || saving}
										onClick={() => move(index, -1)}
									>
										<Icon name="chevron-up" />
									</Button>
									<Button
										type="button"
										variant="outline"
										size="icon-sm"
										aria-label={t`Move down`}
										disabled={index === members.length - 1 || saving}
										onClick={() => move(index, 1)}
									>
										<Icon name="chevron-down" />
									</Button>
									<Button
										type="button"
										variant="outline"
										size="icon-sm"
										aria-label={t`Remove from the group`}
										disabled={saving}
										onClick={() =>
											setMembers(members.filter((_, i) => i !== index))
										}
									>
										<Icon name="x" />
									</Button>
								</span>
							</div>
							{member.baseUnit !== baseUnit ? (
								<div className="flex flex-wrap items-center gap-2 text-sm">
									<Input
										className="w-20"
										inputMode="decimal"
										dir="ltr"
										value={member.memberAmount}
										aria-label={t`Amount of this product`}
										onChange={(event) =>
											setMembers(
												members.map((entry, i) =>
													i === index
														? { ...entry, memberAmount: event.target.value }
														: entry,
												),
											)
										}
									/>
									<bdi dir="ltr">
										{quantity.unitName(member.baseUnit, undefined)}
									</bdi>
									<span>=</span>
									<Input
										className="w-24"
										inputMode="decimal"
										dir="ltr"
										value={member.groupAmount}
										aria-label={t`Same amount in the group's unit`}
										onChange={(event) =>
											setMembers(
												members.map((entry, i) =>
													i === index
														? { ...entry, groupAmount: event.target.value }
														: entry,
												),
											)
										}
										data-testid={`group-member-${member.itemId}-conversion`}
									/>
									<bdi dir="ltr">{quantity.unitName(baseUnit, undefined)}</bdi>
								</div>
							) : null}
						</li>
					))}
				</ol>
				{members.length < MAX_GROUP_MEMBERS ? (
					<ItemPicker
						label={<Trans>Add a product</Trans>}
						client={client}
						locationId={locationId}
						value={null}
						onChange={add}
						placeholder={t`Search items`}
						disabled={saving}
						testId="group-add-member"
					/>
				) : null}
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={saving}
					>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						type="button"
						onClick={() => void save()}
						disabled={!valid || saving}
						data-testid="group-save"
					>
						{saving ? <Trans>Saving…</Trans> : <Trans>Save group</Trans>}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

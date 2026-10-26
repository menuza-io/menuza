import { t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { kdsConfigSchema, type KdsConfig } from '@repo/common/kds'
import { Icon } from '@repo/ui/icon'
import { useEffect, useMemo, useState } from 'react'
import { holdLock } from '~/lib/activity.ts'
import { categoryItems } from '~/lib/catalog.ts'
import { menuText } from '~/lib/menu-text.ts'
import { type MenuCategory } from '~/lib/types.ts'
import {
	Checkbox,
	Input,
	Button,
	IconButton,
	Modal,
	Segmented,
	Select,
} from '~/ui/primitives.tsx'

/** Explicit Save: an interrupted setup never rewrites a live kitchen. */
export function KitchenSettings({
	config,
	version,
	categories,
	busy,
	error,
	onClose,
	onSave,
}: {
	config: KdsConfig
	version: number
	categories: MenuCategory[]
	busy: boolean
	error: string | null
	onClose: () => void
	onSave: (config: KdsConfig) => Promise<void>
}) {
	const { _ } = useLingui()
	const [draft, setDraft] = useState(() => structuredClone(config))
	const [originalVersion] = useState(version)
	const [problem, setProblem] = useState(false)
	useEffect(() => holdLock(), [])
	const items = useMemo(
		() => [
			...new Map(
				categories.flatMap(categoryItems).map((item) => [item.id, item]),
			).values(),
		],
		[categories],
	)
	const update = (patch: Partial<KdsConfig>) =>
		setDraft((current) => ({ ...current, ...patch }))
	const save = async () => {
		const parsed = kdsConfigSchema.safeParse(draft)
		setProblem(!parsed.success)
		if (parsed.success) await onSave(parsed.data)
	}
	// If another screen changed setup while this draft was open, do not save
	// against a newer version silently. Closing and reopening starts a fresh draft.
	const changed = version !== originalVersion
	return (
		<Modal
			open
			title={_(t`Kitchen setup`)}
			size="lg"
			onClose={busy ? () => undefined : onClose}
			footer={
				<div className="grid grid-cols-2 gap-3">
					<Button variant="outline" size="lg" onClick={onClose} disabled={busy}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						variant="primary"
						size="lg"
						onClick={() => void save()}
						disabled={busy || changed}
					>
						<Trans>Save kitchen setup</Trans>
					</Button>
				</div>
			}
		>
			<div className="space-y-7 p-5">
				<p className="text-muted-foreground text-sm">
					<Trans>
						This setup is shared by every kitchen screen at this location. Each
						screen can choose its own station and order source.
					</Trans>
				</p>
				{changed ? (
					<p
						role="alert"
						className="notice-danger rounded-(--station-control-radius) p-3 text-sm"
					>
						<Trans>
							The kitchen setup changed elsewhere. Close this panel and open it
							again before editing.
						</Trans>
					</p>
				) : null}
				{problem || error ? (
					<p role="alert" className="text-destructive font-semibold">
						{error ??
							_(
								t`Check station names, unique item routes, and timing. The late threshold must be greater than the warning threshold.`,
							)}
					</p>
				) : null}
				<section className="space-y-3">
					<h3 className="text-base font-semibold">
						<Trans>Preparation workflow</Trans>
					</h3>
					<Segmented
						label={_(t`Preparation workflow`)}
						value={draft.workflow}
						onChange={(workflow) => update({ workflow })}
						options={[
							{ value: 'ticket', label: _(t`Whole tickets`) },
							{ value: 'item', label: _(t`Individual items`) },
						]}
					/>
					<label className="flex min-h-11 items-center gap-3">
						<Checkbox
							checked={draft.showPreparing}
							onChange={(event) =>
								update({ showPreparing: event.target.checked })
							}
						/>
						<span>
							<Trans>Use a Preparing step before Ready</Trans>
						</span>
					</label>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Turn off the Preparing step for quick service. Individual items
							suit kitchens where dishes finish separately. The pass clears a
							ticket only when every item is ready.
						</Trans>
					</p>
				</section>
				<section className="space-y-4">
					<h3 className="text-base font-semibold">
						<Trans>Prep stations</Trans>
					</h3>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Name stations for your kitchen, bar, coffee counter or packing
							area. Each item goes to one station; anything not routed goes to
							the default.
						</Trans>
					</p>
					{draft.stations.map((station) => (
						<div
							key={station.id}
							className="border-border flex items-end gap-2 border-b pb-4"
						>
							<label className="min-w-0 flex-1 space-y-2 text-sm font-semibold">
								<span>
									<Trans>Station name</Trans>
								</span>
								<Input
									value={station.name}
									maxLength={60}
									onChange={(event) =>
										update({
											stations: draft.stations.map((entry) =>
												entry.id === station.id
													? { ...entry, name: event.target.value }
													: entry,
											),
										})
									}
								/>
							</label>
							<label className="flex h-12 items-center gap-2 text-sm">
								<input
									type="radio"
									className="accent-primary size-5"
									name="default-station"
									checked={draft.defaultStationId === station.id}
									onChange={() => update({ defaultStationId: station.id })}
								/>
								<Trans>Default</Trans>
							</label>
							<IconButton
								label={_(t`Remove station`)}
								disabled={
									draft.stations.length === 1 ||
									draft.defaultStationId === station.id
								}
								onClick={() =>
									update({
										stations: draft.stations.filter(
											(entry) => entry.id !== station.id,
										),
									})
								}
							>
								<Icon name="trash-2" className="size-5" />
							</IconButton>
						</div>
					))}
					<Button
						variant="outline"
						disabled={draft.stations.length >= 12}
						onClick={() =>
							update({
								stations: [
									...draft.stations,
									{
										id: crypto.randomUUID().slice(0, 8),
										name: _(t`New station`),
										itemIds: [],
									},
								],
							})
						}
					>
						<Icon name="plus" className="size-4" />
						<Trans>Add station</Trans>
					</Button>
				</section>
				<section className="space-y-3">
					<h3 className="text-base font-semibold">
						<Trans>Item routing</Trans>
					</h3>
					{!items.length ? (
						<p className="text-muted-foreground text-sm">
							<Trans>
								Publish and refresh the menu to route individual items. Until
								then, all food goes to the default station.
							</Trans>
						</p>
					) : (
						<div className="divide-border divide-y">
							{items.map((item) => (
								<label
									key={item.id}
									className="flex items-center justify-between gap-3 py-2"
								>
									<span className="min-w-0 flex-1 text-sm font-medium">
										{menuText(item.displayName)}
									</span>
									<Select
										aria-label={_(t`Station for ${item.displayName}`)}
										containerClassName="w-auto max-w-48"
										value={
											draft.stations.find((station) =>
												station.itemIds.includes(item.id),
											)?.id ?? ''
										}
										onChange={(event) =>
											update({
												stations: draft.stations.map((station) => ({
													...station,
													itemIds: [
														...station.itemIds.filter((id) => id !== item.id),
														...(station.id === event.target.value
															? [item.id]
															: []),
													],
												})),
											})
										}
									>
										<option value="">{_(t`Default station`)}</option>
										{draft.stations.map((station) => (
											<option key={station.id} value={station.id}>
												{station.name}
											</option>
										))}
									</Select>
								</label>
							))}
						</div>
					)}
				</section>
				<section className="space-y-3">
					<h3 className="text-base font-semibold">
						<Trans>Timing</Trans>
					</h3>
					<div className="grid gap-4 sm:grid-cols-3">
						{(
							[
								['warningMinutes', _(t`Warn after (min)`), 1, 180],
								['lateMinutes', _(t`Late after (min)`), 2, 240],
								['fireAheadMinutes', _(t`Start before pickup (min)`), 0, 240],
							] as const
						).map(([key, label, min, max]) => (
							<label key={key} className="space-y-2 text-sm font-semibold">
								<span className="block">{label}</span>
								<Input
									type="number"
									inputMode="numeric"
									min={min}
									max={max}

									value={draft[key]}
									onChange={(event) => {
										// Emptied while retyping: keep the last number, not NaN.
										const value = event.target.valueAsNumber
										if (Number.isFinite(value)) update({ [key]: value })
									}}
								/>
							</label>
						))}
					</div>
					<p className="text-muted-foreground text-sm">
						<Trans>
							Scheduled food waits in Scheduled until its preparation window.
							Its timer starts then, not when the order was placed.
						</Trans>
					</p>
				</section>
			</div>
		</Modal>
	)
}

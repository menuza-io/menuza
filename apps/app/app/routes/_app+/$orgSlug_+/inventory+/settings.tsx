import { Trans, useLingui } from '@lingui/react/macro'
import {
	inventorySettingsSchema,
	type UnitSystem,
} from '@repo/inventory'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Skeleton } from '@repo/ui/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/toggle-group'
import { WorkspacePanel } from '@repo/ui/workspace'
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { toast } from 'sonner'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { useNotifyInventoryChanged } from '#app/components/inventory/inventory-prefs.tsx'
import {
	useInventoryClient,
	useInventoryQuery,
} from '#app/hooks/use-inventory-client.ts'
import { requireInventoryAccess } from '#app/utils/inventory/access.server.ts'
import {
	inventoryErrorMessage,
	inventorySaveErrorMessage,
} from '#app/utils/inventory/inventory-errors.ts'
import { inventoryTabPath } from '#app/utils/inventory/nav.ts'
import { type Route } from './+types/settings.ts'
import { useInventoryLayoutData } from './_layout.tsx'

export async function loader({ request, params }: Route.LoaderArgs) {
	await requireInventoryAccess(request, params.orgSlug)
	return null
}

const NO_COUNT_DAY = 'none'

function formatDayStartTime(minutes: number, locale: string): string {
	const hours = Math.floor(minutes / 60)
	const mins = minutes % 60
	return new Intl.DateTimeFormat(locale, {
		hour: '2-digit',
		minute: '2-digit',
	}).format(new Date(2026, 0, 1, hours, mins))
}

export default function InventorySettingsRoute() {
	const { t, i18n } = useLingui()
	const { orgSlug, activeLocationId, canEdit, locations } =
		useInventoryLayoutData()
	const location = useLocation()
	const { request } = useInventoryClient()
	const notifyChanged = useNotifyInventoryChanged()
	const settings = useInventoryQuery('/settings', inventorySettingsSchema)
	const { reload } = settings

	const locParam = new URLSearchParams(location.search).get('locationId')
	const search =
		locations.length > 1 && locParam
			? `?locationId=${encodeURIComponent(locParam)}`
			: ''
	const stockPath = inventoryTabPath(orgSlug, 'stock')

	const [unitSystem, setUnitSystem] = useState<UnitSystem>('metric')
	const [targetPctText, setTargetPctText] = useState('30')
	const [countDay, setCountDay] = useState<string>(NO_COUNT_DAY)
	const [countTime, setCountTime] = useState('22:00')
	const [anyStaffCanReceive, setAnyStaffCanReceive] = useState(true)
	const [saving, setSaving] = useState(false)
	const [saveError, setSaveError] = useState<string | null>(null)

	useEffect(() => {
		if (!settings.data) return
		setUnitSystem(settings.data.unitSystem)
		setTargetPctText(String(settings.data.targetFoodCostBp / 100))
		setCountDay(
			settings.data.countDayOfWeek === null
				? NO_COUNT_DAY
				: String(settings.data.countDayOfWeek),
		)
		setCountTime(settings.data.countTime ?? '22:00')
		setAnyStaffCanReceive(settings.data.anyStaffCanReceive ?? true)
	}, [settings.data])

	const dayOptions = useMemo(
		() => [
			{ value: NO_COUNT_DAY, label: t`No scheduled count day` },
			{ value: '0', label: t`Sunday` },
			{ value: '1', label: t`Monday` },
			{ value: '2', label: t`Tuesday` },
			{ value: '3', label: t`Wednesday` },
			{ value: '4', label: t`Thursday` },
			{ value: '5', label: t`Friday` },
			{ value: '6', label: t`Saturday` },
		],
		[t],
	)

	const targetCostId = useId()
	const countDayId = useId()
	const countTimeId = useId()
	const receiveToggleId = useId()

	const activeLocationSettings = settings.data?.locations?.find(
		(loc) => loc.locationId === activeLocationId,
	)

	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!settings.data || !canEdit || saving) return
		const parsedPct = Number(targetPctText.trim())
		if (
			targetPctText.trim() === '' ||
			!Number.isFinite(parsedPct) ||
			parsedPct < 0 ||
			parsedPct > 100
		) {
			setSaveError(t`Enter a target food cost between 0% and 100%.`)
			return
		}
		const targetFoodCostBp = Math.round(parsedPct * 100)
		const countDayOfWeek =
			countDay === NO_COUNT_DAY ? null : Number(countDay)
		const normalizedTime = countTime.trim()
		if (
			countDayOfWeek !== null &&
			!/^([01]\d|2[0-3]):[0-5]\d$/.test(normalizedTime)
		) {
			setSaveError(t`Enter a valid time in 24-hour format (for example, 22:00).`)
			return
		}

		setSaving(true)
		setSaveError(null)
		try {
			await request('/settings', {
				method: 'PUT',
				body: JSON.stringify({
					expectedVersion: settings.data.version,
					unitSystem,
					targetFoodCostBp,
					countDayOfWeek,
					countTime: countDayOfWeek === null ? null : normalizedTime,
					anyStaffCanReceive,
				}),
			})
			toast.success(t`Inventory settings saved.`)
			notifyChanged()
			reload()
		} catch (caught) {
			setSaveError(i18n._(inventorySaveErrorMessage(caught)))
			reload()
		} finally {
			setSaving(false)
		}
	}

	if (settings.error && !settings.data) {
		return (
			<Alert variant="destructive" data-testid="inventory-settings-error">
				<AlertDescription>
					{i18n._(inventoryErrorMessage(settings.error))}
				</AlertDescription>
				<Button
					className="mt-2 justify-self-start"
					variant="outline"
					onClick={reload}
				>
					<Trans>Try again</Trans>
				</Button>
			</Alert>
		)
	}

	if (!settings.data) {
		return (
			<div
				role="status"
				className="flex flex-col gap-4"
				data-testid="inventory-settings-loading"
			>
				<span className="sr-only">
					<Trans>Loading inventory settings</Trans>
				</span>
				<Skeleton className="h-48 w-full rounded-xl" />
				<Skeleton className="h-32 w-full rounded-xl" />
			</div>
		)
	}

	const activeDayLabel =
		dayOptions.find((option) => option.value === countDay)?.label ??
		dayOptions[0]!.label

	return (
		<div
			className="flex flex-col gap-6"
			data-testid="inventory-settings-screen"
		>
			{!canEdit ? (
				<Alert data-testid="inventory-settings-readonly">
					<AlertDescription>
						<Trans>
							You can view these settings, but only someone with inventory
							editing access across all locations can change them.
						</Trans>
					</AlertDescription>
				</Alert>
			) : null}

			{saveError ? (
				<Alert variant="destructive" data-testid="inventory-settings-save-error">
					<AlertDescription>{saveError}</AlertDescription>
				</Alert>
			) : null}

			<WorkspacePanel
				title={<Trans>Units & cost targets</Trans>}
				description={
					<Trans>
						Choose the default measurement system and target food cost across
						your organization.
					</Trans>
				}
			>
				<form
					onSubmit={(event) => void handleSubmit(event)}
					className="flex flex-col gap-5"
					data-testid="inventory-settings-form"
				>
					<div className="flex flex-col gap-2">
						<Label>
							<Trans>Unit system</Trans>
						</Label>
						<div>
							<ToggleGroup
								variant="segmented"
								value={[unitSystem]}
								onValueChange={(next) => {
									if (next[0] === 'metric' || next[0] === 'us') {
										setUnitSystem(next[0])
									}
								}}
								aria-label={t`Unit system`}
							>
								<ToggleGroupItem
									value="metric"
									disabled={!canEdit}
									data-testid="settings-unit-metric"
								>
									<Trans>Metric (g, kg, ml, L)</Trans>
								</ToggleGroupItem>
								<ToggleGroupItem
									value="us"
									disabled={!canEdit}
									data-testid="settings-unit-us"
								>
									<Trans>US (oz, lb, fl oz, qt, gal)</Trans>
								</ToggleGroupItem>
							</ToggleGroup>
						</div>
					</div>

					<div className="flex max-w-xs flex-col gap-1.5">
						<Label htmlFor={targetCostId}>
							<Trans>Target food cost (%)</Trans>
						</Label>
						<Input
							id={targetCostId}
							type="text"
							inputMode="decimal"
							dir="ltr"
							value={targetPctText}
							onChange={(event) => setTargetPctText(event.target.value)}
							disabled={!canEdit}
							data-testid="settings-target-food-cost"
						/>
						<p className="text-muted-foreground text-xs">
							<Trans>
								Dishes above this percentage are highlighted in Recipes & menu
								cost.
							</Trans>
						</p>
					</div>

					<div className="grid max-w-lg grid-cols-1 gap-4 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor={countDayId}>
								<Trans>Scheduled count day</Trans>
							</Label>
							<Select
								items={dayOptions}
								value={countDay}
								onValueChange={(value) => {
									if (value) setCountDay(String(value))
								}}
								disabled={!canEdit}
							>
								<SelectTrigger
									id={countDayId}
									data-testid="settings-count-day"
								>
									<SelectValue>{activeDayLabel}</SelectValue>
								</SelectTrigger>
								<SelectContent>
									{dayOptions.map((option) => (
										<SelectItem key={option.value} value={option.value}>
											{option.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>

						{countDay !== NO_COUNT_DAY ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor={countTimeId}>
									<Trans>Reminder time (24h)</Trans>
								</Label>
								<Input
									id={countTimeId}
									type="text"
									dir="ltr"
									placeholder="22:00"
									value={countTime}
									onChange={(event) => setCountTime(event.target.value)}
									disabled={!canEdit}
									data-testid="settings-count-time"
								/>
							</div>
						) : null}
					</div>

					<div className="flex items-start gap-2.5">
						<Checkbox
							id={receiveToggleId}
							checked={anyStaffCanReceive}
							onCheckedChange={(checked) =>
								setAnyStaffCanReceive(Boolean(checked))
							}
							disabled={!canEdit}
							data-testid="settings-any-staff-receive"
						/>
						<div className="flex flex-col gap-0.5">
							<Label htmlFor={receiveToggleId} className="font-normal">
								<Trans>
									Allow any signed-in Station staff member to record deliveries
								</Trans>
							</Label>
							<p className="text-muted-foreground text-xs">
								<Trans>
									When turned off, only till managers can record deliveries on
									Station.
								</Trans>
							</p>
						</div>
					</div>

					{canEdit ? (
						<div className="flex items-center gap-2">
							<Button
								type="submit"
								disabled={saving}
								data-testid="settings-save"
							>
								{saving ? (
									<Icon name="loader" className="animate-spin" />
								) : null}
								<Trans>Save settings</Trans>
							</Button>
						</div>
					) : null}
				</form>
			</WorkspacePanel>

			<WorkspacePanel
				title={<Trans>Storage areas & count lists</Trans>}
				description={
					<Trans>
						Organize the shelves and walk order for this location, and group
						items you count together.
					</Trans>
				}
			>
				<div className="flex flex-wrap items-center gap-3">
					<Button
						variant="outline"
						render={<Link to={`${stockPath}/areas${search}`} />}
						data-testid="settings-manage-areas"
					>
						<Icon name="layers" />
						<Trans>Storage areas</Trans>
					</Button>
					<Button
						variant="outline"
						render={<Link to={`${stockPath}/lists${search}`} />}
						data-testid="settings-manage-lists"
					>
						<Icon name="list" />
						<Trans>Count lists</Trans>
					</Button>
				</div>
			</WorkspacePanel>

			{activeLocationSettings ? (
				<WorkspacePanel
					title={<Trans>Location defaults</Trans>}
					description={
						<Trans>
							Synced from your location configuration for counts, deliveries,
							and dish margin calculations.
						</Trans>
					}
				>
					<dl
						className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2 md:grid-cols-4"
						data-testid="settings-location-defaults"
					>
						<div className="flex flex-col gap-1">
							<dt className="text-muted-foreground text-xs">
								<Trans>Currency</Trans>
							</dt>
							<dd className="font-medium tabular-nums">
								<bdi dir="ltr">{activeLocationSettings.currency}</bdi>
							</dd>
						</div>
						<div className="flex flex-col gap-1">
							<dt className="text-muted-foreground text-xs">
								<Trans>Time zone</Trans>
							</dt>
							<dd className="font-medium">
								<bdi dir="ltr">{activeLocationSettings.timeZone}</bdi>
							</dd>
						</div>
						<div className="flex flex-col gap-1">
							<dt className="text-muted-foreground text-xs">
								<Trans>Business day starts</Trans>
							</dt>
							<dd className="font-medium tabular-nums">
								<bdi dir="ltr">
									{formatDayStartTime(
										activeLocationSettings.dayStartMinutes,
										i18n.locale,
									)}
								</bdi>
							</dd>
						</div>
						<div className="flex flex-col gap-1">
							<dt className="text-muted-foreground text-xs">
								<Trans>Menu tax</Trans>
							</dt>
							<dd className="font-medium tabular-nums">
								{(() => {
									const taxRatePct =
										activeLocationSettings.pricesIncludeTax &&
										activeLocationSettings.taxRateBp !== null
											? activeLocationSettings.taxRateBp / 100
											: null
									return taxRatePct !== null ? (
										<Trans>Included ({taxRatePct}%)</Trans>
									) : (
										<Trans>Excluded</Trans>
									)
								})()}
							</dd>
						</div>
					</dl>
				</WorkspacePanel>
			) : null}
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}

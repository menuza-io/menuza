import { Trans, useLingui } from '@lingui/react/macro'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Popover, PopoverContent, PopoverTrigger } from '@repo/ui/popover'
import { useState } from 'react'
import { FilterSelect } from '#app/components/staff/controls.tsx'
import {
	type RsvAreaRecord,
	type RsvServiceRecord,
} from '#app/utils/reservations/setup-api.ts'

const ALL = 'all'

/**
 * Service and Area behind ONE compact button. The button reads "Filters" and,
 * once something is chosen, the choice itself ("Dinner · Main room") with a
 * dot. A location with a single service has no Service filter, one with a
 * single area has no Area filter, and with neither the control is not drawn.
 */
export function HostFilters({
	services,
	selectedServiceId,
	onServiceChange,
	areas,
	selectedAreaId,
	onAreaChange,
}: {
	services: RsvServiceRecord[]
	selectedServiceId: string | null
	onServiceChange?: (serviceId: string | null) => void
	areas: RsvAreaRecord[]
	selectedAreaId: string | null
	onAreaChange?: (areaId: string | null) => void
}) {
	const { t } = useLingui()
	const [open, setOpen] = useState(false)
	const showService = services.length > 1 && Boolean(onServiceChange)
	const showArea = areas.length > 1 && Boolean(onAreaChange)
	if (!showService && !showArea) return null

	const service = showService
		? services.find((svc) => svc.id === selectedServiceId)
		: undefined
	const area = showArea ? areas.find((a) => a.id === selectedAreaId) : undefined
	const chosen = [service?.name, area?.name].filter((name): name is string =>
		Boolean(name),
	)
	const summary = chosen.join(' · ')

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger
				render={
					<Button
						type="button"
						variant="outline"
						className="h-8 max-w-56 gap-1.5 max-md:h-11 pointer-coarse:h-11"
						aria-label={summary ? t`Filters: ${summary}` : t`Filters`}
						data-testid="host-filters-btn"
					>
						<Icon name="list-filter-plus" />
						<span className="truncate">{summary || t`Filters`}</span>
						{chosen.length > 0 ? (
							<span
								aria-hidden
								className="bg-primary size-1.5 shrink-0 rounded-full"
								data-testid="host-filters-dot"
							/>
						) : null}
					</Button>
				}
			/>
			<PopoverContent align="end" className="flex w-72 flex-col gap-3">
				{showService ? (
					<FilterSelect
						label={t`Service`}
						testId="host-service-select"
						options={[
							{ value: ALL, label: t`All services` },
							...services.map((svc) => ({ value: svc.id, label: svc.name })),
						]}
						value={service ? service.id : ALL}
						onValueChange={(value) =>
							onServiceChange?.(value === ALL ? null : value)
						}
					/>
				) : null}
				{showArea ? (
					<FilterSelect
						label={t`Area`}
						testId="host-area-select"
						options={[
							{ value: ALL, label: t`All areas` },
							...areas.map((a) => ({ value: a.id, label: a.name })),
						]}
						value={area ? area.id : ALL}
						onValueChange={(value) =>
							onAreaChange?.(value === ALL ? null : value)
						}
					/>
				) : null}
				{chosen.length > 0 ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="self-start"
						onClick={() => {
							onServiceChange?.(null)
							onAreaChange?.(null)
						}}
						data-testid="host-filters-clear"
					>
						<Trans>Clear filters</Trans>
					</Button>
				) : null}
			</PopoverContent>
		</Popover>
	)
}

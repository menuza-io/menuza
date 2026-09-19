import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { type ReactNode } from 'react'
import { Link } from 'react-router'

export function MenuListHeader({
	title,
	subtitle,
	searchQuery,
	onSearchChange,
	searchPlaceholder,
	createHref,
	createOnClick,
	createLabel,
	canCreate,
	availabilityFilter,
	onAvailabilityFilterChange,
	extraActions,
}: {
	title: ReactNode
	subtitle: ReactNode
	searchQuery: string
	onSearchChange: (value: string) => void
	searchPlaceholder: string
	createHref?: string
	createOnClick?: () => void
	createLabel?: ReactNode
	canCreate?: boolean
	availabilityFilter?: 'all' | 'available' | 'unavailable'
	onAvailabilityFilterChange?: (
		value: 'all' | 'available' | 'unavailable',
	) => void
	extraActions?: ReactNode
}) {
	return (
		<header className="mb-4 flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-3">
				<div className="min-w-0 flex-1">
					<h2 className="text-lg font-semibold">{title}</h2>
					<p className="text-muted-foreground text-xs">{subtitle}</p>
				</div>
				{extraActions}
				{canCreate && (createHref || createOnClick) ? (
					createOnClick ? (
						<Button size="sm" onClick={createOnClick}>
							<Icon name="plus" className="size-3.5" />
							{createLabel}
						</Button>
					) : (
						<Button size="sm" render={<Link to={createHref!} />}>
							<Icon name="plus" className="size-3.5" />
							{createLabel}
						</Button>
					)
				) : null}
			</div>
			<div className="flex flex-wrap gap-2">
				<div className="relative min-w-56 flex-1">
					<Icon
						name="search"
						className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
					/>
					<Input
						value={searchQuery}
						onChange={(event) => onSearchChange(event.target.value)}
						placeholder={searchPlaceholder}
						className="pl-8"
						aria-label={searchPlaceholder}
					/>
				</div>
				{availabilityFilter !== undefined && onAvailabilityFilterChange ? (
					<Select
						value={availabilityFilter}
						onValueChange={(value) =>
							onAvailabilityFilterChange(
								value as 'all' | 'available' | 'unavailable',
							)
						}
					>
						<SelectTrigger className="w-40">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">
								<Trans>All availability</Trans>
							</SelectItem>
							<SelectItem value="available">
								<Trans>Available</Trans>
							</SelectItem>
							<SelectItem value="unavailable">
								<Trans>Unavailable</Trans>
							</SelectItem>
						</SelectContent>
					</Select>
				) : null}
			</div>
		</header>
	)
}

export function MenuTableShell({ children }: { children: ReactNode }) {
	return (
		<div className="bg-card overflow-hidden rounded-lg border">{children}</div>
	)
}

import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Button } from '@repo/ui/button'
import { Frame } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { PageHeader } from '@repo/ui/page-header'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { type ReactNode } from 'react'
import { Link } from 'react-router'

type SearchPlaceholder =
	'menus' | 'categories' | 'items' | 'modifier-sets' | 'modifiers'

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
	searchPlaceholder: SearchPlaceholder
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
	const { _ } = useLingui()
	const searchMessages = {
		menus: t`Search menus`,
		categories: t`Search categories`,
		items: t`Search items`,
		'modifier-sets': t`Search modifier sets`,
		modifiers: t`Search modifiers`,
	} as const
	const searchLabel = _(searchMessages[searchPlaceholder])

	return (
		<div className="space-y-4">
			<PageHeader
				title={title}
				description={subtitle}
				headingLevel="h2"
				size="section"
				actions={
					<>
						{extraActions}
						{canCreate && (createHref || createOnClick) ? (
							createOnClick ? (
								<Button size="sm" onClick={createOnClick}>
									<Icon name="plus" className="size-4" />
									{createLabel}
								</Button>
							) : (
								<Button size="sm" render={<Link to={createHref!} />}>
									<Icon name="plus" className="size-4" />
									{createLabel}
								</Button>
							)
						) : null}
					</>
				}
			/>
			<div className="flex flex-wrap gap-2">
				<div className="relative min-w-56 flex-1">
					<Icon
						name="search"
						className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2"
					/>
					<Input
						value={searchQuery}
						onChange={(event) => onSearchChange(event.target.value)}
						placeholder={searchLabel}
						className="pl-8"
						aria-label={searchLabel}
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
		</div>
	)
}

export function MenuTableShell({ children }: { children: ReactNode }) {
	return <Frame className="w-full">{children}</Frame>
}

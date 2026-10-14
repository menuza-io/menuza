import { type IconName } from '@repo/ui/icon'
import { PageHeader } from '@repo/ui/page-header'
import { EmptyState } from '#app/components/empty-state.tsx'

/**
 * Empty state for a Staff section whose features are turned on for the
 * organization but not built out yet. Rendered only after the route loader has
 * verified the staffing flags and the member's permission.
 */
export function StaffSectionPlaceholder({
	title,
	description,
	emptyTitle,
	emptyDescription,
	icons,
}: {
	title: string
	description: string
	emptyTitle: string
	emptyDescription: string
	icons: IconName[]
}) {
	return (
		<div className="flex flex-col gap-6">
			<PageHeader title={title} description={description} />
			<EmptyState
				title={emptyTitle}
				description={emptyDescription}
				icons={icons}
			/>
		</div>
	)
}

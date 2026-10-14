import { Trans } from '@lingui/macro'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { type RosterOnboarding } from '#app/utils/staffing/onboarding-view.ts'

/**
 * Roster progress: "Onboarding 3/5", with "late" in words and an icon when a
 * task is overdue. Shown only for people who still have tasks to finish, so a
 * finished or empty checklist adds no noise to the roster.
 */
export function OnboardingBadge({
	progress,
	className,
}: {
	progress: RosterOnboarding
	className?: string
}) {
	if (progress.kind === 'none') return null
	const { complete, total, overdue } = progress
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1 text-xs',
				overdue ? 'text-destructive font-medium' : 'text-muted-foreground',
				className,
			)}
		>
			{overdue ? <Icon name="alert-triangle" className="size-3.5" /> : null}
			<span>
				{overdue ? (
					<Trans>
						Onboarding {complete}/{total}, late
					</Trans>
				) : (
					<Trans>
						Onboarding {complete}/{total}
					</Trans>
				)}
			</span>
		</span>
	)
}

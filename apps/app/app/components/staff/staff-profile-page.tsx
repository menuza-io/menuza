import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Badge } from '@repo/ui/badge'
import { Button, buttonVariants } from '@repo/ui/button'
import { Frame, FrameHeader, FramePanel, FrameTitle } from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { type ReactNode } from 'react'
import { Link } from 'react-router'
import {
	type AttentionBadges,
	type AttentionItem,
	type ProfileSection,
} from '#app/hooks/use-staff-attention.ts'

/**
 * Pieces of the standalone team member page: a "needs attention" list that points at the part of the page that fixes each
 * thing, and a grouped section navigation. The sections themselves are the same
 * panels the drawer used to hold in tabs.
 */

export function AttentionList({
	items,
	onGo,
}: {
	items: readonly AttentionItem[]
	onGo: (section: ProfileSection) => void
}) {
	const { _ } = useLingui()
	if (items.length === 0) return null
	const count = items.length
	return (
		<Frame
			className="w-full"
			stackedPanels
			aria-label={_(t`Needs attention`)}
			role="region"
		>
			<FrameHeader>
				<FrameTitle className="flex items-center gap-2">
					<Icon name="alert-triangle" />
					{plural(count, {
						one: '# thing to sort out',
						other: '# things to sort out',
					})}
				</FrameTitle>
			</FrameHeader>
			{items.map((item) => (
				<FramePanel
					key={item.key}
					className="flex items-center justify-between gap-4 px-5 py-3.5"
				>
					<div className="min-w-0 space-y-0.5">
						<p
							className={cn(
								'text-sm text-pretty',
								item.urgent && 'text-destructive font-medium',
							)}
						>
							{item.message}
						</p>
						<p className="text-muted-foreground text-xs">{item.where}</p>
					</div>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="shrink-0"
						onClick={() => onGo(item.section)}
					>
						{item.action}
					</Button>
				</FramePanel>
			))}
		</Frame>
	)
}

type NavGroup = {
	label: ReactNode
	items: Array<{ id: ProfileSection; label: ReactNode }>
}

/** Six tabs grouped by what a manager is doing: who, where, how they get in, records. */
export function useProfileGroups(hiring: boolean): NavGroup[] {
	const records: NavGroup['items'] = [
		...(hiring
			? [
					{ id: 'onboarding' as const, label: <Trans>Onboarding</Trans> },
					{ id: 'certificates' as const, label: <Trans>Certificates</Trans> },
				]
			: []),
		{ id: 'notes', label: <Trans>Notes</Trans> },
	]
	return [
		{
			label: <Trans>Profile</Trans>,
			items: [{ id: 'details', label: <Trans>Details</Trans> }],
		},
		{
			label: <Trans>Work</Trans>,
			items: [{ id: 'positions', label: <Trans>Positions and pay</Trans> }],
		},
		{
			label: <Trans>Access</Trans>,
			items: [{ id: 'access', label: <Trans>Access and PIN</Trans> }],
		},
		{ label: <Trans>Records</Trans>, items: records },
	]
}

export function ProfileNav({
	groups,
	section,
	badges,
	hrefFor,
}: {
	groups: readonly NavGroup[]
	section: ProfileSection
	badges: AttentionBadges
	hrefFor: (section: ProfileSection) => string
}) {
	const { _ } = useLingui()
	return (
		<nav
			aria-label={_(t`Sections`)}
			className="-mx-4 flex gap-1 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:gap-5 lg:overflow-visible lg:px-0 lg:pb-0"
		>
			{groups.map((group, index) => (
				<div key={index} className="flex gap-1 lg:flex-col">
					<span className="text-muted-foreground hidden px-3 pb-1 text-xs font-medium lg:block">
						{group.label}
					</span>
					{group.items.map((item) => {
						const active = item.id === section
						const badge = badges[item.id]
						return (
							<Link
								key={item.id}
								to={hrefFor(item.id)}
								preventScrollReset
								className={cn(
									buttonVariants({ variant: active ? 'secondary' : 'ghost' }),
									'h-11 justify-between',
								)}
								aria-current={active ? 'page' : undefined}
							>
								{item.label}
								{badge ? (
									<Badge variant={badge.urgent ? 'destructive' : 'outline'}>
										<span className="sr-only">
											<Trans>Needs attention:</Trans>{' '}
										</span>
										{badge.count}
									</Badge>
								) : null}
							</Link>
						)
					})}
				</div>
			))}
		</nav>
	)
}

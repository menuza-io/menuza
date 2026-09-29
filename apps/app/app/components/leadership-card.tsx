import { Trans } from '@lingui/macro'
import { cn } from '@repo/ui'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'

import { UserAvatar } from './user-avatar'

interface LeadershipUser {
	id: string
	name: string
	email: string
	notesCount: number
	rank: number
	image?: string | null
}

interface LeadershipCardProps {
	leaders: LeadershipUser[]
	className?: string
}

const getRankIcon = (rank: number) => {
	switch (rank) {
		case 1:
			return 'crown'
		case 2:
			return 'trophy'
		case 3:
			return 'medal'
		default:
			return null
	}
}

const rankStyles: Record<number, string> = {
	1: 'bg-amber-500 text-white',
	2: 'bg-slate-400 text-white',
	3: 'bg-amber-700 text-white',
}

export function LeadershipCard({ leaders, className }: LeadershipCardProps) {
	return (
		<Card className={cn('flex h-full flex-col', className)}>
			<CardHeader>
				<CardTitle>
					<Trans>Top Contributors</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>Team members who have created the most notes</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="min-h-0 flex-1">
				{leaders.length === 0 ? (
					<div className="text-muted-foreground flex flex-col items-center gap-2 py-10 text-center">
						<Icon name="users" className="h-8 w-8 opacity-30" />
						<Trans>No notes created yet</Trans>
					</div>
				) : (
					<div className="divide-y">
						{leaders.map((leader) => (
							<div
								key={leader.id}
								className={cn(
									'flex items-center gap-3 px-0.5 py-3 first:pt-1 last:pb-1',
								)}
							>
								<div
									className={cn(
										'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums',
										rankStyles[leader.rank] ?? 'bg-muted text-muted-foreground',
									)}
								>
									{leader.rank}
								</div>

								<UserAvatar
									user={{
										name: leader.name,
										email: leader.email,
										image: leader.image,
									}}
									className="h-8 w-8 shrink-0"
									alt={leader.name}
								/>

								<div className="min-w-0 flex-1">
									<div className="truncate text-sm font-medium">
										{leader.name}
									</div>
								</div>

								<div className="flex shrink-0 items-center gap-1.5">
									<span className="text-sm tabular-nums">
										{leader.notesCount}
									</span>
									<span className="text-muted-foreground text-xs">
										{leader.notesCount !== 1 ? (
											<Trans>notes</Trans>
										) : (
											<Trans>note</Trans>
										)}
									</span>
								</div>

								{getRankIcon(leader.rank) && (
									<Icon
										name={getRankIcon(leader.rank)!}
										className="h-4 w-4 shrink-0 text-amber-500"
									/>
								)}
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	)
}

import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Icon, type IconName } from '@repo/ui/icon'
import * as React from 'react'

import { Link } from 'react-router'

interface EmptyStateProps {
	title: string
	description: string
	icons?: IconName[]
	action?: {
		label: string
		href: string
	}
	className?: string
}

export function EmptyState({
	title,
	description,
	icons = [],
	action,
	className,
}: EmptyStateProps) {
	return (
		<div
			className={cn(
				'dark:bg-background bg-muted text-center',
				'w-full rounded-xl p-1',
				'',
				className,
			)}
		>
			<div className="bg-background ring-border dark:bg-muted/50 hover:dark:bg-muted/70 group rounded-lg p-14 shadow-sm ring-1 motion-safe:transition motion-safe:duration-500 motion-safe:hover:duration-200">
				<div className="isolate flex justify-center">
					{icons.length === 3 ? (
						<>
							<div className="bg-background ring-border relative top-1.5 left-2.5 grid size-12 -rotate-6 place-items-center rounded-xl shadow-lg ring-1 motion-safe:transition motion-safe:duration-500 motion-safe:group-hover:-translate-x-5 motion-safe:group-hover:-translate-y-0.5 motion-safe:group-hover:-rotate-12 motion-safe:group-hover:duration-200">
								{icons[0] && (
									<Icon
										name={icons[0]}
										className="text-muted-foreground h-6 w-6"
									/>
								)}
							</div>
							<div className="bg-background ring-border relative z-10 grid size-12 place-items-center rounded-xl shadow-lg ring-1 motion-safe:transition motion-safe:duration-500 motion-safe:group-hover:-translate-y-0.5 motion-safe:group-hover:duration-200">
								{icons[1] && (
									<Icon
										name={icons[1]}
										className="text-muted-foreground h-6 w-6"
									/>
								)}
							</div>
							<div className="bg-background ring-border relative top-1.5 right-2.5 grid size-12 rotate-6 place-items-center rounded-xl shadow-lg ring-1 motion-safe:transition motion-safe:duration-500 motion-safe:group-hover:translate-x-5 motion-safe:group-hover:-translate-y-0.5 motion-safe:group-hover:rotate-12 motion-safe:group-hover:duration-200">
								{icons[2] && (
									<Icon
										name={icons[2]}
										className="text-muted-foreground h-6 w-6"
									/>
								)}
							</div>
						</>
					) : (
						<div className="bg-background ring-border grid size-12 place-items-center rounded-xl shadow-lg ring-1 motion-safe:transition motion-safe:duration-500 motion-safe:group-hover:-translate-y-0.5 motion-safe:group-hover:duration-200">
							{icons[0] && (
								<Icon
									name={icons[0]}
									className="text-muted-foreground h-6 w-6"
								/>
							)}
						</div>
					)}
				</div>
				<h2 className="text-foreground mt-6 text-lg font-medium">{title}</h2>
				<p className="text-muted-foreground text-md mt-1 whitespace-pre-line">
					{description}
				</p>
				{action && (
					<Button className={cn('mt-4')}>
						<Link to={action.href}>{action.label}</Link>
					</Button>
				)}
			</div>
		</div>
	)
}

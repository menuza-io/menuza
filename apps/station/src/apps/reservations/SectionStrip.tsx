import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { type SectionLoad } from './sections.ts'
import { Button, cn } from '~/ui/primitives.tsx'

/** A section's colour as a dot: in the strip, the sheets and the assign list. */
export function SectionDot({ color }: { color: string }) {
	return (
		<span
			aria-hidden
			className="inline-block size-2.5 shrink-0 rounded-full bg-(--section)"
			style={{ '--section': color } as React.CSSProperties}
		/>
	)
}

/**
 * The floor's sections at a glance, under the room switch: each section's
 * server, the covers they have now and the tables still free, with whose turn
 * it is to be sat next. The host assigns servers from here.
 */
export function SectionStrip({
	loads,
	upNextId,
	onAssign,
	offlineReason = null,
}: {
	loads: SectionLoad[]
	upNextId: string | null
	onAssign: () => void
	offlineReason?: string | null
}) {
	const { _ } = useLingui()
	const unassigned = loads.every((load) => !load.section.server)
	return (
		<div className="flex items-center gap-2 px-3 py-2">
			{/* The chips scroll sideways when there are many; the button stays in reach. */}
			<ul
				aria-label={_(msg`Server sections`)}
				className="flex min-w-0 flex-1 [scrollbar-width:none] gap-2 overflow-x-auto"
			>
				{loads.map((load) => {
					const { section } = load
					const next = section.id === upNextId
					return (
						<li
							key={section.id}
							className={cn(
								'bg-card inline-flex min-h-11 shrink-0 items-center gap-2 rounded-(--station-control-radius) border px-3 text-sm whitespace-nowrap',
								// Inside the chip: the row scrolls sideways and would clip a ring drawn outside it.
								next && 'border-primary ring-primary ring-1 ring-inset',
							)}
						>
							<SectionDot color={section.color} />
							<span className="font-semibold">{section.name}</span>
							{section.server ? (
								<span>{section.server.name}</span>
							) : (
								<span className="text-warning font-medium">
									<Trans>No server</Trans>
								</span>
							)}
							<span className="text-muted-foreground tnum">
								{_(
									plural(load.covers, {
										one: '# cover',
										other: '# covers',
									}),
								)}
								{' · '}
								{_(
									plural(load.free, {
										0: 'none free',
										one: '# free',
										other: '# free',
									}),
								)}
							</span>
							{next ? (
								<span className="bg-primary text-primary-foreground rounded-full px-2 py-0.5 text-xs font-semibold">
									<Trans>Up next</Trans>
								</span>
							) : null}
						</li>
					)
				})}
			</ul>
			<Button
				variant={unassigned ? 'primary' : 'ghost'}
				className="shrink-0"
				disabled={offlineReason !== null}
				title={offlineReason ?? undefined}
				onClick={onAssign}
			>
				<Icon name="users" className="size-4" />
				{unassigned ? <Trans>Assign servers</Trans> : <Trans>Servers</Trans>}
			</Button>
		</div>
	)
}

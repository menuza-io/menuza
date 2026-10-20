import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import { type ReactNode, useState } from 'react'

/**
 * A settings card that shows a one-line summary and opens to edit. It stays
 * open while `forceOpen` is set, so a field error is never hidden.
 */
export function SummaryCard({
	summary,
	forceOpen = false,
	defaultOpen = false,
	children,
}: {
	summary: ReactNode
	forceOpen?: boolean
	defaultOpen?: boolean
	children: ReactNode
}) {
	const [open, setOpen] = useState(defaultOpen)
	const shown = open || forceOpen
	return (
		<Card>
			<Collapsible open={shown} onOpenChange={setOpen}>
				<CardContent className="flex flex-col gap-5">
					<div className="flex items-start justify-between gap-4">
						<p className="text-muted-foreground min-w-0 text-sm text-pretty">
							{summary}
						</p>
						<CollapsibleTrigger
							render={
								<Button
									type="button"
									variant="outline"
									size="sm"
									className="shrink-0"
								/>
							}
						>
							{shown ? (
								<>
									<Icon name="chevron-up" />
									<Trans>Hide</Trans>
								</>
							) : (
								<>
									<Icon name="pencil" />
									<Trans>Edit</Trans>
								</>
							)}
						</CollapsibleTrigger>
					</div>
					<CollapsibleContent>
						<div className="flex flex-col gap-5">{children}</div>
					</CollapsibleContent>
				</CardContent>
			</Collapsible>
		</Card>
	)
}

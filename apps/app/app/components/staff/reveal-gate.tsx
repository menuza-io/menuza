import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import {
	Frame,
	FrameAction,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Icon } from '@repo/ui/icon'
import { type ReactNode, useId, useState } from 'react'

/**
 * Private and pay details stay out of sight until the manager asks. Children
 * mount only while shown, so the request that loads them (and the audit record
 * it creates) happens on "Show", never on page load. Hiding unmounts them again.
 * It is its own frame: the title and a Show/Hide button up top, the details in
 * a panel once shown.
 */
export function RevealGate({
	title,
	description,
	children,
}: {
	title: ReactNode
	description: ReactNode
	children: ReactNode
}) {
	const [shown, setShown] = useState(false)
	const regionId = useId()
	return (
		<Frame className="w-full" aria-labelledby={`${regionId}-title`}>
			<FrameHeader>
				<FrameTitle id={`${regionId}-title`}>{title}</FrameTitle>
				<FrameDescription>{description}</FrameDescription>
				<FrameAction>
					<Button
						type="button"
						variant="outline"
						aria-expanded={shown}
						aria-controls={regionId}
						onClick={() => setShown((value) => !value)}
					>
						<Icon name={shown ? 'lock' : 'unlock'} />
						{shown ? <Trans>Hide</Trans> : <Trans>Show</Trans>}
					</Button>
				</FrameAction>
			</FrameHeader>
			<div id={regionId}>
				{shown ? <FramePanel>{children}</FramePanel> : null}
			</div>
		</Frame>
	)
}

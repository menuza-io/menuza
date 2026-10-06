import { Trans } from '@lingui/macro'
import { type DropStatus, getDropDisplayStatus } from '@repo/common/menu-types'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
interface DropPreviewProps {
	title: string
	description: string
	coverImageUrl: string | null
	ordersOpenAt: string
	ordersCloseAt: string
	status: DropStatus
	visibility: 'public' | 'unlisted'
	now?: Date
}

export function getDropPreviewState(
	status: DropStatus,
	ordersOpenAt: string,
	ordersCloseAt: string,
	now = new Date(),
): 'draft' | 'upcoming' | 'open' | 'ended' {
	const phase = getDropDisplayStatus(status, ordersOpenAt, ordersCloseAt, now)
	if (phase === 'draft') return 'draft'
	if (phase === 'scheduled') return 'upcoming'
	if (phase === 'live') return 'open'
	return 'ended'
}

export function DropPreview({
	title,
	description,
	coverImageUrl,
	ordersOpenAt,
	ordersCloseAt,
	status,
	visibility,
	now,
}: DropPreviewProps) {
	// Drafts have no public card yet; show the phase they would have if published.
	const previewState = getDropPreviewState(
		status === 'draft' ? 'scheduled' : status,
		ordersOpenAt,
		ordersCloseAt,
		now,
	)

	return (
		<Frame className="w-full">
			<FrameHeader>
				<FrameTitle className="text-base">
					<Trans>Customer preview</Trans>
				</FrameTitle>
			</FrameHeader>
			<FramePanel className="overflow-hidden p-0">
				<div className="bg-card text-card-foreground flex flex-col">
					{coverImageUrl ? (
						<img
							src={coverImageUrl}
							alt=""
							className="aspect-[16/9] w-full object-cover"
						/>
					) : null}
					<div className="flex flex-1 flex-col gap-2 p-5">
						<span className="text-muted-foreground text-xs font-medium">
							{previewState === 'upcoming' ? (
								<Trans>Coming soon</Trans>
							) : previewState === 'ended' ? (
								<Trans>Closed</Trans>
							) : (
								<Trans>Ordering now</Trans>
							)}
						</span>
						<h3 className="text-foreground text-lg font-semibold break-words">
							{title || <Trans>Drop title</Trans>}
						</h3>
						{description ? (
							<p className="text-muted-foreground line-clamp-2 text-sm">
								{description}
							</p>
						) : null}
						<span className="text-primary mt-auto pt-2 text-sm font-semibold">
							<Trans>View drop</Trans>
						</span>
					</div>
				</div>
			</FramePanel>
		</Frame>
	)
}

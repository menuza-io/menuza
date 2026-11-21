import { Trans } from '@lingui/macro'
import { useState } from 'react'
import { useFetcher } from 'react-router'
import {
	MENU_POPULAR_DEFAULT_COUNT,
	MENU_POPULAR_MAX_COUNT,
	MENU_POPULAR_MIN_COUNT,
} from '@repo/common/menu-popular'
import {
	Frame,
	FrameDescription,
	FrameHeader,
	FramePanel,
	FrameTitle,
} from '@repo/ui/frame'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Switch } from '@repo/ui/switch'

const COUNT_OPTIONS = Array.from(
	{ length: MENU_POPULAR_MAX_COUNT - MENU_POPULAR_MIN_COUNT + 1 },
	(_, idx) => MENU_POPULAR_MIN_COUNT + idx,
)

/**
 * Organization-level setting for Auto Popular (#97), mounted in `items._index.tsx`.
 * Posts `intent=updateAutoPopular` to the current route (handled by
 * `handleAutoPopularSettingsAction`).
 */
export function AutoPopularSettings({
	featureEnabled,
	autoPopularCount,
	action = '.',
}: {
	featureEnabled: boolean
	autoPopularCount: number | null
	action?: string
}) {
	const fetcher = useFetcher()
	const [enabled, setEnabled] = useState(autoPopularCount != null)
	const [count, setCount] = useState(
		autoPopularCount ?? MENU_POPULAR_DEFAULT_COUNT,
	)

	if (!featureEnabled) return null

	const submitSettings = (nextEnabled: boolean, nextCount: number) => {
		const formData = new FormData()
		formData.set('intent', 'updateAutoPopular')
		formData.set('autoPopularEnabled', String(nextEnabled))
		formData.set('autoPopularCount', String(nextCount))
		void fetcher.submit(formData, { method: 'post', action })
	}

	return (
		<Frame>
			<FrameHeader>
				<FrameTitle>
					<Trans>Mark popular automatically</Trans>
				</FrameTitle>
				<FrameDescription>
					<Trans>
						Highlight your top-selling dishes on the website each day based on
						the last 28 days of sales.
					</Trans>
				</FrameDescription>
			</FrameHeader>
			<FramePanel className="flex flex-wrap items-center justify-between gap-4 px-5 py-3.5">
				<Label
					htmlFor="auto-popular-switch"
					className="block min-w-0 cursor-pointer space-y-0.5 font-normal"
				>
					<div className="text-foreground text-sm">
						<Trans>Automatic Popular badges</Trans>
					</div>
					<p className="text-muted-foreground text-xs">
						<Trans>
							Automatically updates dishes set to Automatic mode once a day.
						</Trans>
					</p>
				</Label>
				<div className="flex items-center gap-3">
					{enabled && (
						<Select
							value={String(count)}
							onValueChange={(next) => {
								const parsed = Number(next)
								if (!Number.isFinite(parsed)) return
								setCount(parsed)
								submitSettings(true, parsed)
							}}
						>
							<SelectTrigger aria-label="Top sellers count" className="w-28">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{COUNT_OPTIONS.map((n) => (
									<SelectItem key={n} value={String(n)}>
										<Trans>Top {n}</Trans>
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}
					<Switch
						id="auto-popular-switch"
						checked={enabled}
						disabled={fetcher.state !== 'idle'}
						onCheckedChange={(next) => {
							setEnabled(next)
							submitSettings(next, count)
						}}
					/>
				</div>
			</FramePanel>
		</Frame>
	)
}

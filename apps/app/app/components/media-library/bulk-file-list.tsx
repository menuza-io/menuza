import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	formatBytes,
	isSkippedEntry,
	type BulkEntry,
} from '#app/utils/media/bulk/entries.ts'
import { type PrecheckFlag } from '#app/utils/media/bulk/precheck.ts'
import { type QueueItem } from '#app/utils/media/bulk/upload-queue.ts'

function checkLabel(flag: PrecheckFlag) {
	switch (flag) {
		case 'not_an_image':
			return msg`Not a photo`
		case 'too_large':
			return msg`Too large`
		case 'too_small':
			return msg`Too small`
		case 'duplicate':
			return msg`Duplicate`
	}
}

function checkHint(flag: PrecheckFlag) {
	switch (flag) {
		case 'not_an_image':
			return msg`This file is not a JPEG, PNG, WebP, GIF or AVIF photo, so it will not be uploaded.`
		case 'too_large':
			return msg`This photo is over 10 MB, so it will not be uploaded.`
		case 'too_small':
			return msg`The short side is under 800 px. It will still upload, but it may look soft on a menu.`
		case 'duplicate':
			return msg`The same photo is already in this batch, so this copy will not be uploaded.`
	}
}

function stateLabel(item: QueueItem<File> | undefined, paused: boolean) {
	if (!item) return null
	switch (item.state) {
		case 'waiting':
			if (paused) return msg`Waiting for connection`
			return item.attempts > 0 ? msg`Retrying…` : msg`Waiting`
		case 'uploading':
			return msg`Uploading…`
		case 'done':
			return item.resumed ? msg`Already uploaded` : msg`Uploaded`
		case 'failed':
			return item.error === 'refused'
				? msg`Refused by the server`
				: msg`Upload failed`
	}
}

/**
 * The batch as a list (#316): each file with its early checks and, once the
 * upload starts, its own state. A failed file can be retried; nothing here
 * waits on the others.
 */
export function BulkFileList({
	entries,
	queueItems,
	paused,
	onRemove,
}: {
	entries: BulkEntry[]
	/** Upload state by queue id; `null` before the upload starts. */
	queueItems: Map<string, QueueItem<File>> | null
	paused: boolean
	onRemove?: (key: string) => void
}) {
	const { _ } = useLingui()
	return (
		<ul className="divide-border bg-card divide-y rounded-xl border">
			{entries.map((entry) => {
				const item = entry.queueId ? queueItems?.get(entry.queueId) : undefined
				const label = stateLabel(item, paused)
				const skipped = isSkippedEntry(entry)
				const name = entry.name
				return (
					<li
						key={entry.key}
						className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
					>
						<div className="min-w-0 flex-1">
							<p className="text-sm font-medium wrap-anywhere">{entry.name}</p>
							<p className="text-muted-foreground text-xs">
								{formatBytes(entry.size)}
							</p>
						</div>
						<div className="flex flex-wrap items-center gap-1">
							{entry.check === 'checking' ? (
								<Badge variant="secondary">
									<Icon name="loader" className="animate-spin" />
									{_(msg`Checking…`)}
								</Badge>
							) : null}
							{entry.flags.map((flag) => (
								<Badge
									key={flag}
									variant={
										flag === 'not_an_image' || flag === 'too_large'
											? 'destructive'
											: flag === 'too_small'
												? 'warning'
												: 'secondary'
									}
									title={_(checkHint(flag))}
								>
									<Icon name="alert-triangle" />
									{_(checkLabel(flag))}
								</Badge>
							))}
							{label ? (
								<Badge
									variant={
										item?.state === 'done'
											? 'success'
											: item?.state === 'failed'
												? 'destructive'
												: 'secondary'
									}
								>
									{item?.state === 'uploading' ? (
										<Icon name="loader" className="animate-spin" />
									) : null}
									{_(label)}
								</Badge>
							) : skipped && queueItems ? (
								<Badge variant="secondary">{_(msg`Not uploaded`)}</Badge>
							) : null}
						</div>
						{onRemove && !item ? (
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								onClick={() => onRemove(entry.key)}
							>
								<Icon name="x" />
								<span className="sr-only">{_(msg`Remove ${name}`)}</span>
							</Button>
						) : null}
					</li>
				)
			})}
		</ul>
	)
}

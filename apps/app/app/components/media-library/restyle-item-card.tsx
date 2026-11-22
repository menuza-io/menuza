import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useFetcher } from 'react-router'
import { type RestyleItemView } from '#app/utils/media/restyle/types.ts'
import {
	isRestyleErrorCode,
	RESTYLE_ERROR_MESSAGES,
	restyleFailureMessage,
	restyleSkipMessage,
} from './restyle-labels.ts'
import { RestyleTime } from './restyle-run-status.tsx'

type DecisionData = { ok?: boolean; error?: string }

function Photo({
	src,
	label,
	alt,
}: {
	src: string | null
	label: string
	alt: string
}) {
	return (
		<figure className="space-y-1.5">
			<div className="bg-muted aspect-4/3 overflow-hidden rounded-lg border">
				{src ? (
					<img
						src={src}
						alt={alt}
						loading="lazy"
						className="size-full object-cover"
					/>
				) : (
					<div className="text-muted-foreground flex size-full items-center justify-center">
						<Icon name="image" className="size-6" aria-hidden />
					</div>
				)}
			</div>
			<figcaption className="text-muted-foreground text-xs font-medium">
				{label}
			</figcaption>
		</figure>
	)
}

/**
 * One dish of a restyle run: the original next to the draft, and what the
 * operator can do about it. Every button is one decision sent to the run's
 * action; a refusal (`photo_changed` and the rest) is shown right here.
 */
export function RestyleItemCard({
	item,
	canApply,
	canStart,
	killed,
}: {
	item: RestyleItemView
	canApply: boolean
	canStart: boolean
	killed: boolean
}) {
	const { _ } = useLingui()
	const name = item.name
	const fetcher = useFetcher<DecisionData>()
	const busy = fetcher.state !== 'idle'
	const error =
		fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null

	const send = (intent: string) => {
		const data = new FormData()
		data.set('intent', intent)
		data.set('itemRowId', item.id)
		if (intent === 'use' && item.draftKey) data.set('draftKey', item.draftKey)
		void fetcher.submit(data, { method: 'POST' })
	}

	const open = item.status === 'drafted' && item.decision === null
	const used = item.decision === 'used'
	const kept = item.decision === 'kept'

	return (
		<li className="bg-card space-y-3 rounded-xl border p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h3 className="text-sm font-medium wrap-anywhere">{item.name}</h3>
				{used ? (
					<Badge variant="success">
						<Trans>New photo in use</Trans>
					</Badge>
				) : kept ? (
					<Badge variant="outline">
						<Trans>Original kept</Trans>
					</Badge>
				) : item.status === 'pending' ? (
					<Badge variant="secondary">
						<Trans>Waiting</Trans>
					</Badge>
				) : item.status === 'failed' ? (
					<Badge variant="destructive">
						<Trans>Could not be restyled</Trans>
					</Badge>
				) : null}
			</div>

			<div className="grid grid-cols-2 gap-3">
				<Photo
					src={item.originalUrl}
					label={_(msg`Original`)}
					alt={_(msg`Original photo of ${name}`)}
				/>
				<Photo
					src={item.draftUrl}
					label={used ? _(msg`New (in use)`) : _(msg`New`)}
					alt={_(msg`Restyled photo of ${name}`)}
				/>
			</div>

			{item.status === 'failed' ? (
				<p className="text-muted-foreground text-sm">
					{_(restyleFailureMessage(item.error))}
				</p>
			) : null}
			{open && item.draftExpiresAt ? (
				<p className="text-muted-foreground text-xs">
					<Trans>
						Deleted if you do not choose by{' '}
						<RestyleTime iso={item.draftExpiresAt} />
					</Trans>
				</p>
			) : null}

			{error ? (
				<Alert variant="destructive">
					<AlertDescription>
						{isRestyleErrorCode(error)
							? _(RESTYLE_ERROR_MESSAGES[error])
							: _(RESTYLE_ERROR_MESSAGES.not_found)}
					</AlertDescription>
				</Alert>
			) : null}

			<div className="flex flex-wrap gap-2">
				{open ? (
					<>
						<Button
							size="sm"
							disabled={busy || !canApply}
							onClick={() => send('use')}
						>
							<Trans>Use new</Trans>
						</Button>
						<Button
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => send('keep')}
						>
							<Trans>Keep original</Trans>
						</Button>
					</>
				) : null}
				{used ? (
					<Button
						size="sm"
						variant="outline"
						disabled={busy || !canApply}
						onClick={() => send('switchBack')}
					>
						<Icon name="rotate-ccw" aria-hidden />
						<Trans>Switch back</Trans>
					</Button>
				) : null}
				{open || kept || item.status === 'failed' ? (
					<Button
						size="sm"
						variant="ghost"
						disabled={busy || !canStart || killed}
						onClick={() => send('retry')}
					>
						<Icon name="refresh-cw" aria-hidden />
						<Trans>Try again</Trans>
					</Button>
				) : null}
			</div>
		</li>
	)
}

/** A dish the run did not restyle, with the plain reason. */
export function RestyleSkippedRow({ item }: { item: RestyleItemView }) {
	const { _ } = useLingui()
	return (
		<li className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
			<span className="wrap-anywhere">{item.name}</span>
			<span className="text-muted-foreground">
				{_(restyleSkipMessage(item.skipReason))}
			</span>
		</li>
	)
}

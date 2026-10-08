import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	type CallFollowUpStatus,
	LOW_RATING_MAX,
	MAX_CALL_TAGS,
} from '@repo/phone-agent'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { useState } from 'react'
import { phoneCallsErrorMessage } from '#app/hooks/use-phone-calls.ts'
import {
	type CallSummary,
	FOLLOW_UP_LABELS,
	SENTIMENT_LABELS,
	TRANSFER_RESULT_LABELS,
} from './call-data.ts'

export type CallTagOption = { id: string; name: string; important: boolean }

type CallsClient = (path: string, init?: RequestInit) => Promise<unknown>

function tagName(id: string, tags: CallTagOption[]) {
	return (
		tags.find((tag) => tag.id === id)?.name ??
		id.replace(/_/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase())
	)
}

/** Compact badges for a call row: follow-up, tags, rating, voicemail. */
export function CallInsightBadges({
	call,
	tags,
	showFollowUp = true,
}: {
	call: CallSummary
	tags: CallTagOption[]
	/** Off where every listed call already needs follow-up. */
	showFollowUp?: boolean
}) {
	const { _ } = useLingui()
	const rating = call.rating
	return (
		<>
			{showFollowUp && call.followUpStatus === 'open' ? (
				<Badge variant="default">{_(FOLLOW_UP_LABELS.open)}</Badge>
			) : null}
			{call.voicemail ? (
				<Badge variant="outline">
					<Icon name="mic" />
					<Trans>Voicemail</Trans>
				</Badge>
			) : null}
			{call.transferResult === 'no_answer' ? (
				<Badge variant="outline">{_(TRANSFER_RESULT_LABELS.no_answer)}</Badge>
			) : null}
			{call.tags.map((id) => (
				<Badge key={id} variant="outline">
					<Icon name="tag" />
					{tagName(id, tags)}
				</Badge>
			))}
			{rating != null ? (
				<Badge
					variant={rating <= LOW_RATING_MAX ? 'destructive' : 'outline'}
					aria-label={_(msg`Rated ${rating} out of 5`)}
				>
					<Icon name="star" />
					{rating}
				</Badge>
			) : null}
		</>
	)
}

/** Follow-up status and tags for one call, editable by people who can update. */
export function CallFollowUpPanel({
	call,
	tags,
	canUpdate,
	request,
	onChanged,
}: {
	call: CallSummary
	tags: CallTagOption[]
	canUpdate: boolean
	request: CallsClient
	onChanged: (patch: {
		followUpStatus: CallFollowUpStatus
		tags: string[]
	}) => void
}) {
	const { _ } = useLingui()
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const update = async (patch: {
		followUpStatus?: CallFollowUpStatus
		tags?: string[]
	}) => {
		setPending(true)
		setError(null)
		try {
			await request(`/${encodeURIComponent(call.id)}`, {
				method: 'PATCH',
				body: JSON.stringify(patch),
			})
			onChanged({
				followUpStatus: patch.followUpStatus ?? call.followUpStatus,
				tags: patch.tags ?? call.tags,
			})
		} catch (cause) {
			setError(
				phoneCallsErrorMessage(
					cause,
					_(msg`Could not update this call. Try again.`),
				),
			)
		} finally {
			setPending(false)
		}
	}

	const open = call.followUpStatus === 'open'
	const rating = call.rating
	const unknownTags = call.tags.filter(
		(id) => !tags.some((tag) => tag.id === id),
	)
	const tagsFull = call.tags.length >= MAX_CALL_TAGS

	return (
		<section className="flex flex-col gap-3 rounded-lg border p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-2 text-sm font-medium">
					<Icon
						name={open ? 'circle' : 'circle-check'}
						className={open ? 'text-primary' : 'text-muted-foreground'}
					/>
					{_(FOLLOW_UP_LABELS[call.followUpStatus])}
				</div>
				{canUpdate ? (
					<Button
						size="sm"
						variant={open ? 'default' : 'outline'}
						disabled={pending}
						onClick={() =>
							void update({ followUpStatus: open ? 'resolved' : 'open' })
						}
					>
						{open ? <Trans>Mark complete</Trans> : <Trans>Reopen</Trans>}
					</Button>
				) : null}
			</div>

			<dl className="text-muted-foreground grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
				{call.transferResult !== 'none' ? (
					<>
						<dt>
							<Trans>Transfer</Trans>
						</dt>
						<dd className="text-foreground">
							{_(TRANSFER_RESULT_LABELS[call.transferResult])}
						</dd>
					</>
				) : null}
				{rating != null ? (
					<>
						<dt>
							<Trans>Caller rating</Trans>
						</dt>
						<dd className="text-foreground tabular-nums">
							<Trans>{rating} out of 5</Trans>
						</dd>
					</>
				) : null}
				{call.sentiment ? (
					<>
						<dt>
							<Trans>Caller mood</Trans>
						</dt>
						<dd className="text-foreground">
							{_(SENTIMENT_LABELS[call.sentiment])}
						</dd>
					</>
				) : null}
				{call.calledWhileOpen != null ? (
					<>
						<dt>
							<Trans>Called</Trans>
						</dt>
						<dd className="text-foreground">
							{call.calledWhileOpen ? (
								<Trans>While open</Trans>
							) : (
								<Trans>While closed</Trans>
							)}
						</dd>
					</>
				) : null}
			</dl>

			{tags.length || call.tags.length ? (
				<div className="flex flex-col gap-2">
					<span className="text-xs font-medium">
						<Trans>Tags</Trans>
					</span>
					<div className="flex flex-wrap gap-2">
						{[
							...tags,
							...unknownTags.map((id) => ({
								id,
								name: tagName(id, tags),
								important: false,
							})),
						].map((tag) => {
							const active = call.tags.includes(tag.id)
							return (
								<Button
									key={tag.id}
									type="button"
									size="sm"
									variant={active ? 'secondary' : 'outline'}
									aria-pressed={active}
									disabled={!canUpdate || pending || (!active && tagsFull)}
									onClick={() =>
										void update({
											tags: active
												? call.tags.filter((id) => id !== tag.id)
												: [...call.tags, tag.id],
										})
									}
								>
									<Icon name={active ? 'check' : 'tag'} />
									{tag.name}
								</Button>
							)
						})}
					</div>
					{canUpdate && tagsFull ? (
						<p className="text-muted-foreground text-xs">
							<Trans>
								A call can have up to {MAX_CALL_TAGS} tags. Remove one to add
								another.
							</Trans>
						</p>
					) : null}
				</div>
			) : null}
			{error ? (
				<p role="alert" className="text-destructive text-sm">
					{error}
				</p>
			) : null}
		</section>
	)
}

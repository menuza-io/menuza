import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type WaitlistEntry } from '@repo/reservations'
import { Icon } from '@repo/ui/icon'
import { type LeaveTarget } from './api.ts'
import { ContactRow } from './contact.tsx'
import { OfflineNote } from './OfflineStrip.tsx'
import { ConfirmButton, Detail } from './sheets.tsx'
import {
	isNoResponse,
	joinedOnline,
	minutesWaited,
	textability,
	textedState,
	toldHow,
} from './waitlist.ts'
import { Badge, Button, cn, Modal } from '~/ui/primitives.tsx'

/**
 * A party on the waitlist: how long they have waited, how to reach them, and
 * what to do next. Once told their table is ready it counts down their hold
 * and says plainly when it ends; when it runs out with no answer the party
 * leaves the line (the server's tick does it), and the sheet offers a way back.
 * On a phone the actions stack: seat them first, then the two others side by
 * side.
 */
export function WaitlistSheet({
	entry,
	canReadGuest,
	busy,
	offlineReason = null,
	now,
	formatTime,
	textQueued,
	onNotify,
	onPlace,
	onRemove,
	onBack,
	onClose,
}: {
	entry: WaitlistEntry | null
	/** Without guest details the server sends only the end of the number. */
	canReadGuest: boolean
	busy: boolean
	/** The connection is down: the actions wait for it, and the sheet says so. */
	offlineReason?: string | null
	now: number
	formatTime: (epochMs: number) => string
	/**
	 * What the server said when this party was told their table is ready: a
	 * text was queued (true), none was (false), or it did not say / this tablet
	 * did not tell them (undefined).
	 */
	textQueued?: boolean
	onNotify: (entry: WaitlistEntry) => void
	onPlace: (entry: WaitlistEntry) => void
	/**
	 * Take them off. `version` is the entry's version when the host armed the
	 * button (so a change made meanwhile is refused, not overwritten); `target`
	 * says whether they left or their hold ran out with no answer.
	 */
	onRemove: (entry: WaitlistEntry, version: number, target: LeaveTarget) => void
	/**
	 * Put them back in line: a party told by mistake, or one whose hold ran out
	 * (the guest answered late, or their text never arrived). `version` is the
	 * entry's version as the host saw it.
	 */
	onBack: (entry: WaitlistEntry, version: number) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const waited = entry ? minutesWaited(entry, now) : 0
	const quoted = entry?.quotedMin ?? null
	const texted = entry ? textedState(entry, now) : null
	const canText = entry ? textability(entry) : 'ok'
	const how = entry ? toldHow(entry, textQueued) : 'told'
	const outOfLine = entry ? isNoResponse(entry) : false
	const textedAt = texted ? formatTime(texted.notifiedAt) : ''
	const holdsUntil =
		texted?.deadlineAt != null ? formatTime(texted.deadlineAt) : ''
	const endedAt =
		entry && outOfLine && typeof entry.responseDeadlineAt === 'number'
			? formatTime(entry.responseDeadlineAt)
			: ''
	const minutesLeft = texted?.minutesLeft ?? 0
	const waitedText = _(
		plural(waited, { one: 'Waiting # min', other: 'Waiting # min' }),
	)
	return (
		<Modal
			open={entry !== null}
			onClose={onClose}
			title={entry?.displayName ?? ''}
			footer={
				entry ? (
					<div className="flex flex-col gap-3">
						<OfflineNote reason={offlineReason} />
						{outOfLine ? (
							// Out of the line (the hold ended with no answer): only a way back.
							<Button
								variant="primary"
								size="lg"
								className="w-full"
								disabled={busy}
								onClick={() => onBack(entry, entry.version)}
							>
								<Icon name="undo-2" className="size-5" />
								<Trans>Back in line</Trans>
							</Button>
						) : (
							<>
								<Button
									variant="primary"
									size="lg"
									className="w-full"
									disabled={busy}
									onClick={() => onPlace(entry)}
								>
									<Icon name="armchair" className="size-5" />
									<Trans>Choose a table</Trans>
								</Button>
								<div className="grid grid-cols-2 gap-3">
									{entry.status === 'waiting' ? (
										// Marking them ready works with or without a text: the answer says which.
										<Button
											variant="outline"
											size="lg"
											className="h-auto min-h-14 py-2 leading-tight"
											disabled={busy}
											onClick={() => onNotify(entry)}
										>
											<Icon name="bell-ring" className="size-5 shrink-0" />
											{canText === 'ok' ? (
												<Trans>Tell them it’s ready</Trans>
											) : (
												<Trans>Mark ready</Trans>
											)}
										</Button>
									) : (
										// Told by mistake, or their hold ran out: back to where they stood.
										<Button
											variant="outline"
											size="lg"
											className="h-auto min-h-14 py-2 leading-tight"
											disabled={busy}
											onClick={() => onBack(entry, entry.version)}
										>
											<Icon name="undo-2" className="size-5 shrink-0" />
											<Trans>Back in line</Trans>
										</Button>
									)}
									{texted?.expired ? (
										// The hold ran out with no answer: recorded as that, not as "left".
										<ConfirmButton
											busy={busy}
											token={entry.version}
											onConfirm={(version) =>
												onRemove(
													entry,
													Number(version ?? entry.version),
													'no_response',
												)
											}
											label={_(msg`No response, remove`)}
											confirmLabel={_(msg`Tap again: remove`)}
											className="h-auto min-h-14 py-2 leading-tight"
										/>
									) : (
										<ConfirmButton
											busy={busy}
											token={entry.version}
											onConfirm={(version) =>
												onRemove(
													entry,
													Number(version ?? entry.version),
													'left',
												)
											}
											label={_(msg`They left`)}
											confirmLabel={_(msg`Tap again: remove`)}
											className="h-auto min-h-14 py-2 leading-tight"
										/>
									)}
								</div>
							</>
						)}
					</div>
				) : null
			}
		>
			{entry ? (
				<div className="flex flex-col gap-4 p-4 sm:p-5">
					<p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-base">
						<span className="inline-flex items-center gap-1.5">
							<Icon name="users" className="text-muted-foreground size-5" />
							<span className="tnum">{entry.partySize}</span>
						</span>
						<span className="text-muted-foreground tnum">
							{waitedText}
							{quoted !== null
								? ` · ${_(plural(quoted, { one: 'Quoted # min', other: 'Quoted # min' }))}`
								: ''}
						</span>
						{joinedOnline(entry) ? (
							<Badge tone="primary">
								<Icon name="smartphone" aria-hidden className="size-3.5" />
								<Trans>Joined online</Trans>
							</Badge>
						) : null}
					</p>
					{outOfLine ? (
						<div className="notice-warning flex flex-col gap-1 rounded-(--station-panel-radius) px-4 py-3">
							<p className="flex items-center gap-2 font-semibold">
								<Icon
									name="bell-ring"
									aria-hidden
									className="size-5 shrink-0"
								/>
								<Trans>Did not respond</Trans>
							</p>
							<p className="font-medium">
								{endedAt ? (
									<Trans>
										Their hold ended {endedAt}, so they left the line. Put them
										back if they are here.
									</Trans>
								) : (
									<Trans>
										Their hold ended, so they left the line. Put them back if
										they are here.
									</Trans>
								)}
							</p>
						</div>
					) : null}
					{/* Always present, so the end of the hold is announced when it comes (a region that mounts filled is not read). */}
					<p role="status" className="sr-only">
						{texted?.expired ? <Trans>No response by {holdsUntil}</Trans> : ''}
					</p>
					{texted ? (
						<div
							className={cn(
								'flex flex-col gap-1 rounded-(--station-panel-radius) px-4 py-3',
								texted.urgent || how === 'no_text'
									? 'notice-warning'
									: 'notice-success',
							)}
						>
							<p className="flex items-center gap-2 font-semibold">
								<Icon
									name="bell-ring"
									aria-hidden
									className="size-5 shrink-0"
								/>
								{how === 'text_queued' ? (
									<Trans>Told {textedAt} · text on its way</Trans>
								) : how === 'no_text' ? (
									<Trans>Told {textedAt} · no text sent, call them</Trans>
								) : (
									<Trans>Told {textedAt}</Trans>
								)}
							</p>
							{texted.deadlineAt !== null ? (
								<p className="tnum font-medium">
									{texted.expired ? (
										<Trans>No response by {holdsUntil}</Trans>
									) : (
										<>
											<Trans>
												Holds until {holdsUntil}, then they leave the line
											</Trans>
											{' · '}
											{_(
												plural(minutesLeft, {
													one: '# min left',
													other: '# min left',
												}),
											)}
										</>
									)}
								</p>
							) : null}
						</div>
					) : null}
					{entry.phone ? (
						<ContactRow
							phone={entry.phone}
							canContact={canReadGuest}
							canText={entry.smsOptIn}
							// Nothing was texted: calling them is the way to reach them.
							callFirst={
								(entry.status !== 'waiting' && how === 'no_text') || outOfLine
							}
						/>
					) : null}
					{entry.status === 'waiting' && canText === 'no_consent' ? (
						<Detail icon={'message-square-off'} tone="warning">
							<Trans>No SMS consent: no text will be sent. Call them.</Trans>
						</Detail>
					) : null}
					{entry.status === 'waiting' && canText === 'no_phone' ? (
						<Detail icon={'message-square-off'}>
							<Trans>No phone number: nothing to text.</Trans>
						</Detail>
					) : null}
					{entry.notes ? (
						<Detail icon={'user-round'}>{entry.notes}</Detail>
					) : null}
				</div>
			) : null}
		</Modal>
	)
}

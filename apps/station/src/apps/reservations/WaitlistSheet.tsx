import { msg, plural, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type WaitlistEntry } from '@repo/reservations'
import {
	Armchair,
	BellRing,
	MessageSquareOff,
	Smartphone,
	UserRound,
	Users,
} from 'lucide-react'
import { ContactRow } from './contact.tsx'
import { ConfirmButton, Detail } from './sheets.tsx'
import {
	joinedOnline,
	minutesWaited,
	textability,
	textedState,
} from './waitlist.ts'
import { Badge, Button, cn, Modal } from '~/ui/primitives.tsx'

/**
 * A party on the waitlist: how long they have waited, how to reach them, and
 * what to do next. Once told their table is ready it counts down their hold
 * and, when it runs out with no answer, offers to take them off. On a phone
 * the actions stack: seat them first, then the two others side by side.
 */
export function WaitlistSheet({
	entry,
	canReadGuest,
	busy,
	now,
	formatTime,
	onNotify,
	onPlace,
	onRemove,
	onClose,
}: {
	entry: WaitlistEntry | null
	/** Without guest details the server sends only the end of the number. */
	canReadGuest: boolean
	busy: boolean
	now: number
	formatTime: (epochMs: number) => string
	onNotify: (entry: WaitlistEntry) => void
	onPlace: (entry: WaitlistEntry) => void
	onRemove: (entry: WaitlistEntry) => void
	onClose: () => void
}) {
	const { _ } = useLingui()
	const waited = entry ? minutesWaited(entry, now) : 0
	const quoted = entry?.quotedMin ?? null
	const texted = entry ? textedState(entry, now) : null
	const canText = entry ? textability(entry) : 'ok'
	const textedAt = texted ? formatTime(texted.notifiedAt) : ''
	const holdsUntil =
		texted?.deadlineAt != null ? formatTime(texted.deadlineAt) : ''
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
					<div className="mb-safe flex flex-col gap-3">
						<Button
							variant="primary"
							size="lg"
							className="w-full"
							disabled={busy}
							onClick={() => onPlace(entry)}
						>
							<Armchair className="size-5" />
							<Trans>Choose a table</Trans>
						</Button>
						<div
							className={cn(
								'grid gap-3',
								entry.status === 'waiting' ? 'grid-cols-2' : 'grid-cols-1',
							)}
						>
							{entry.status === 'waiting' ? (
								<>
									<Button
										variant="outline"
										size="lg"
										className="h-auto min-h-14 py-2 leading-tight"
										disabled={busy || canText !== 'ok'}
										onClick={() => onNotify(entry)}
									>
										<BellRing className="size-5 shrink-0" />
										<Trans>Tell them it’s ready</Trans>
									</Button>
									<ConfirmButton
										busy={busy}
										onConfirm={() => onRemove(entry)}
										label={_(msg`They left`)}
										confirmLabel={_(msg`Tap again: remove`)}
										className="h-auto min-h-14 py-2 leading-tight"
									/>
								</>
							) : texted?.expired ? (
								<ConfirmButton
									busy={busy}
									onConfirm={() => onRemove(entry)}
									label={_(msg`No response, remove`)}
									confirmLabel={_(msg`Tap again: remove`)}
								/>
							) : (
								<ConfirmButton
									busy={busy}
									onConfirm={() => onRemove(entry)}
									label={_(msg`They left`)}
									confirmLabel={_(msg`Tap again: remove`)}
								/>
							)}
						</div>
					</div>
				) : null
			}
		>
			{entry ? (
				<div className="flex flex-col gap-4 p-4 sm:p-5">
					<p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-lg">
						<span className="inline-flex items-center gap-1.5">
							<Users className="text-muted-foreground size-5" />
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
								<Smartphone aria-hidden className="size-3.5" />
								<Trans>Joined online</Trans>
							</Badge>
						) : null}
					</p>
					{texted ? (
						<div
							role="status"
							className={cn(
								'flex flex-col gap-1 rounded-2xl px-4 py-3',
								texted.urgent
									? 'bg-warning/12 text-warning'
									: 'bg-success/12 text-success',
							)}
						>
							<p className="flex items-center gap-2 font-semibold">
								<BellRing aria-hidden className="size-5 shrink-0" />
								<Trans>Texted {textedAt}</Trans>
							</p>
							{texted.deadlineAt !== null ? (
								<p className="tnum font-medium">
									{texted.expired ? (
										<Trans>No response by {holdsUntil}</Trans>
									) : (
										<>
											<Trans>Holds until {holdsUntil}</Trans>
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
						/>
					) : null}
					{entry.status === 'waiting' && canText === 'no_consent' ? (
						<Detail icon={MessageSquareOff} tone="warning">
							<Trans>No SMS consent: they cannot be texted.</Trans>
						</Detail>
					) : null}
					{entry.status === 'waiting' && canText === 'no_phone' ? (
						<Detail icon={MessageSquareOff}>
							<Trans>No phone number to text.</Trans>
						</Detail>
					) : null}
					{entry.notes ? <Detail icon={UserRound}>{entry.notes}</Detail> : null}
				</div>
			) : null}
		</Modal>
	)
}

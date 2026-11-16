import { Plural, Trans, useLingui } from '@lingui/react/macro'
import { type DiscountUsedIn } from '@repo/discounts'
import { Button } from '@repo/ui/button'
import { Checkbox } from '@repo/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Label } from '@repo/ui/label'
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from 'react'
import { Link } from 'react-router'
import { createDiscountUsageClient } from '#app/utils/discounts/usage-client.ts'

/**
 * Where a discount is promised, and what a change would break (#236). Messages
 * that still offer a discount keep promising its code: pausing, archiving or
 * giving it an earlier end leaves guests holding a code that does not work. The
 * lists here come from the customer's region by ids and names only.
 */

export type ImpactKind = 'pause' | 'archive' | 'shorten_end' | 'edit'

export type ImpactChoice = {
	pauseAutomations: boolean
	cancelBroadcasts: boolean
}

/** What a member may do to messages, from their own permissions. */
export type ImpactPermissions = {
	canChangeAutomations: boolean
	canChangeBroadcasts: boolean
	/** Whether they may open the message (read access) to follow a link. */
	canOpenAutomations: boolean
	canOpenBroadcasts: boolean
}

function broadcastWhen(
	entry: DiscountUsedIn['broadcasts'][number],
	locale: string,
) {
	return entry.scheduledAt === null
		? null
		: new Date(entry.scheduledAt).toLocaleString(locale)
}

/** The lists of messages, as the "Used in" card and the dialogs show them. */
export function UsedInLists({
	orgSlug,
	usedIn,
	permissions,
}: {
	orgSlug: string
	usedIn: DiscountUsedIn
	permissions: Pick<
		ImpactPermissions,
		'canOpenAutomations' | 'canOpenBroadcasts'
	>
}) {
	const { t, i18n } = useLingui()
	const locale = i18n.locale
	return (
		<div className="space-y-4">
			{usedIn.automations.length > 0 ? (
				<div className="space-y-1.5">
					<h3 className="text-sm font-medium">
						<Trans>Automations running</Trans>
					</h3>
					<ul className="space-y-1 text-sm">
						{usedIn.automations.map((automation) => (
							<li key={automation.id}>
								{permissions.canOpenAutomations ? (
									<Link
										className="underline"
										to={`/${orgSlug}/marketing/automations/${automation.id}`}
									>
										{automation.name}
									</Link>
								) : (
									automation.name
								)}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{usedIn.broadcasts.length > 0 ? (
				<div className="space-y-1.5">
					<h3 className="text-sm font-medium">
						<Trans>Broadcasts waiting or sending</Trans>
					</h3>
					<ul className="space-y-1 text-sm">
						{usedIn.broadcasts.map((broadcast) => {
							const when = broadcastWhen(broadcast, locale)
							const note =
								broadcast.status === 'Processing'
									? t`sending now`
									: when
										? t`scheduled for ${when}`
										: t`scheduled`
							return (
								<li key={broadcast.id}>
									{permissions.canOpenBroadcasts ? (
										<Link
											className="underline"
											to={`/${orgSlug}/marketing/campaigns/${broadcast.id}`}
										>
											{broadcast.name}
										</Link>
									) : (
										broadcast.name
									)}
									<span className="text-muted-foreground"> · {note}</span>
								</li>
							)
						})}
					</ul>
				</div>
			) : null}
		</div>
	)
}

export function hasMessages(usedIn: DiscountUsedIn | null | undefined) {
	return Boolean(
		usedIn && (usedIn.automations.length > 0 || usedIn.broadcasts.length > 0),
	)
}

/**
 * The question before a change that would break messages. Choices: also pause
 * those automations, also cancel those scheduled broadcasts, continue without
 * touching them, or go back. A member without the permission for a kind of
 * message sees the list, cannot tick its choice and is told to ask someone who
 * can. A broadcast already sending cannot be stopped.
 */
export function MessageImpactDialog({
	open,
	orgSlug,
	discountName,
	kind,
	usedIn,
	permissions,
	onConfirm,
	onClose,
}: {
	open: boolean
	orgSlug: string
	discountName: string
	kind: ImpactKind
	usedIn: DiscountUsedIn
	permissions: ImpactPermissions
	onConfirm: (choice: ImpactChoice) => void
	onClose: () => void
}) {
	const { t } = useLingui()
	const scheduled = usedIn.broadcasts.filter((b) => b.status === 'Scheduled')
	const sending = usedIn.broadcasts.length - scheduled.length
	const canPause =
		permissions.canChangeAutomations && usedIn.automations.length > 0
	const canCancel = permissions.canChangeBroadcasts && scheduled.length > 0
	const [pauseAutomations, setPauseAutomations] = useState(true)
	const [cancelBroadcasts, setCancelBroadcasts] = useState(true)
	const blockedByPermission =
		(usedIn.automations.length > 0 && !permissions.canChangeAutomations) ||
		(scheduled.length > 0 && !permissions.canChangeBroadcasts)
	const chosen =
		(canPause && pauseAutomations) || (canCancel && cancelBroadcasts)
	const automationCount = usedIn.automations.length
	const scheduledCount = scheduled.length
	const sendingCount = sending
	const issuedCount = usedIn.issuedCodes

	const title =
		kind === 'pause'
			? t`Pause ${discountName}?`
			: kind === 'archive'
				? t`Archive ${discountName}?`
				: kind === 'edit'
					? t`Change ${discountName}?`
					: t`Shorten the end date of ${discountName}?`

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="gap-4 sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>
						{kind === 'edit' ? (
							<Trans>
								Guests who already got a message keep the code and amount they
								were sent. These messages have not finished going out and still
								carry the old ones.
							</Trans>
						) : (
							<Trans>
								These messages still promise this discount. Guests who get them
								would be offered a code that stops working.
							</Trans>
						)}
					</DialogDescription>
				</DialogHeader>
				<UsedInLists
					orgSlug={orgSlug}
					usedIn={usedIn}
					permissions={{
						canOpenAutomations: permissions.canOpenAutomations,
						canOpenBroadcasts: permissions.canOpenBroadcasts,
					}}
				/>
				{usedIn.issuedCodes > 0 ? (
					<p className="text-muted-foreground text-sm">
						<Plural
							value={issuedCount}
							one="# single-use code already sent keeps working until it expires."
							other="# single-use codes already sent keep working until they expire."
						/>
					</p>
				) : null}

				{automationCount > 0 ? (
					<div className="flex items-start gap-2">
						<Checkbox
							id="impact-pause-automations"
							checked={canPause && pauseAutomations}
							disabled={!canPause}
							onCheckedChange={(next) => setPauseAutomations(next === true)}
						/>
						<Label htmlFor="impact-pause-automations" className="leading-snug">
							<Plural
								value={automationCount}
								one="Pause this automation too"
								other="Pause these # automations too"
							/>
						</Label>
					</div>
				) : null}
				{scheduledCount > 0 ? (
					<div className="flex items-start gap-2">
						<Checkbox
							id="impact-cancel-broadcasts"
							checked={canCancel && cancelBroadcasts}
							disabled={!canCancel}
							onCheckedChange={(next) => setCancelBroadcasts(next === true)}
						/>
						<Label htmlFor="impact-cancel-broadcasts" className="leading-snug">
							<Plural
								value={scheduledCount}
								one="Cancel this scheduled broadcast"
								other="Cancel these # scheduled broadcasts"
							/>
						</Label>
					</div>
				) : null}
				{sendingCount > 0 ? (
					<p className="text-muted-foreground text-sm">
						<Plural
							value={sendingCount}
							one="A broadcast is sending now. A send that has started cannot be stopped."
							other="# broadcasts are sending now. A send that has started cannot be stopped."
						/>
					</p>
				) : null}
				{blockedByPermission ? (
					<p role="note" className="text-sm font-medium">
						<Trans>
							You can change discounts but not broadcasts or automations. Ask
							someone who can to pause or cancel these.
						</Trans>
					</p>
				) : null}

				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						<Trans>Go back</Trans>
					</Button>
					<Button
						type="button"
						variant={chosen ? 'default' : 'destructive'}
						onClick={() =>
							onConfirm({
								pauseAutomations: canPause && pauseAutomations,
								cancelBroadcasts: canCancel && cancelBroadcasts,
							})
						}
					>
						{chosen ? (
							<Trans>Continue and update these messages</Trans>
						) : (
							<Trans>Continue without changing them</Trans>
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

/**
 * Asks the region where a discount is promised only when a change is about to
 * happen, then either lets it through (nothing is promised, or the region could
 * not be reached: this is a warning, not a gate) or opens the dialog. `render`
 * goes once in the page.
 */
export function useMessageImpact({
	orgSlug,
	permissions,
}: {
	orgSlug: string
	permissions: ImpactPermissions
}): {
	guard: (input: {
		discountId: string
		discountName: string
		kind: ImpactKind
		proceed: (choice: ImpactChoice | null) => void
	}) => void
	render: ReactNode
	checking: boolean
} {
	const client = useMemo(
		() => createDiscountUsageClient({ orgSlug }),
		[orgSlug],
	)
	const [checking, setChecking] = useState(false)
	const [pending, setPending] = useState<{
		discountName: string
		kind: ImpactKind
		usedIn: DiscountUsedIn
		proceed: (choice: ImpactChoice | null) => void
	} | null>(null)
	const busy = useRef(false)

	const guard = useCallback(
		(input: {
			discountId: string
			discountName: string
			kind: ImpactKind
			proceed: (choice: ImpactChoice | null) => void
		}) => {
			if (busy.current) return
			busy.current = true
			setChecking(true)
			void client
				.fetchUsedIn(input.discountId)
				.then((usedIn) => {
					if (usedIn && hasMessages(usedIn)) {
						setPending({
							discountName: input.discountName,
							kind: input.kind,
							usedIn,
							proceed: input.proceed,
						})
					} else {
						input.proceed(null)
					}
				})
				.finally(() => {
					busy.current = false
					setChecking(false)
				})
		},
		[client],
	)

	const render = pending ? (
		<MessageImpactDialog
			open
			orgSlug={orgSlug}
			discountName={pending.discountName}
			kind={pending.kind}
			usedIn={pending.usedIn}
			permissions={permissions}
			onClose={() => setPending(null)}
			onConfirm={(choice) => {
				const { proceed } = pending
				setPending(null)
				proceed(choice)
			}}
		/>
	) : null

	return { guard, render, checking }
}

/**
 * "Used in" on a discount's page (#236): the messages that still promise it.
 * Anyone who can read discounts sees the list; opening a message needs the read
 * permission for that kind of message.
 */
export function UsedInPanel({
	orgSlug,
	discountId,
	permissions,
}: {
	orgSlug: string
	discountId: string
	permissions: Pick<
		ImpactPermissions,
		'canOpenAutomations' | 'canOpenBroadcasts'
	>
}) {
	const client = useMemo(
		() => createDiscountUsageClient({ orgSlug }),
		[orgSlug],
	)
	const [usedIn, setUsedIn] = useState<DiscountUsedIn | null | 'loading'>(
		'loading',
	)
	const issuedCount = usedIn && usedIn !== 'loading' ? usedIn.issuedCodes : 0
	useEffect(() => {
		const controller = new AbortController()
		void client.fetchUsedIn(discountId, controller.signal).then((value) => {
			if (!controller.signal.aborted) setUsedIn(value)
		})
		return () => controller.abort()
	}, [client, discountId])

	return (
		<section
			aria-labelledby="discount-used-in"
			className="border-border mx-4 mt-4 space-y-3 rounded-lg border p-4 md:mx-6"
		>
			<h2 id="discount-used-in" className="text-sm font-medium">
				<Trans>Used in</Trans>
			</h2>
			{usedIn === 'loading' ? (
				<p className="text-muted-foreground text-sm" role="status">
					<Trans>Checking your messages…</Trans>
				</p>
			) : usedIn === null ? (
				<p className="text-muted-foreground text-sm">
					<Trans>Could not check which messages use this discount.</Trans>
				</p>
			) : hasMessages(usedIn) ? (
				<>
					<UsedInLists
						orgSlug={orgSlug}
						usedIn={usedIn}
						permissions={permissions}
					/>
					{usedIn.issuedCodes > 0 ? (
						<p className="text-muted-foreground text-sm">
							<Plural
								value={issuedCount}
								one="# single-use code already sent keeps working until it expires."
								other="# single-use codes already sent keep working until they expire."
							/>
						</p>
					) : null}
				</>
			) : (
				<p className="text-muted-foreground text-sm">
					<Trans>
						No broadcast waiting to go out and no running automation offers this
						discount.
					</Trans>
				</p>
			)}
		</section>
	)
}

/**
 * Resuming a discount that took automations with it when it was paused: offer
 * to resume them too. Those that were changed since stay as they are.
 */
export function ResumeWithAutomationsDialog({
	open,
	discountName,
	automations,
	onResume,
	onClose,
}: {
	open: boolean
	discountName: string
	automations: ReadonlyArray<{ id: string; name: string }>
	onResume: (withAutomations: boolean) => void
	onClose: () => void
}) {
	const { t } = useLingui()
	const count = automations.length
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="gap-4 sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t`Resume ${discountName}?`}</DialogTitle>
					<DialogDescription>
						<Plural
							value={count}
							one="This automation was paused together with this discount. Resume it too?"
							other="These # automations were paused together with this discount. Resume them too?"
						/>
					</DialogDescription>
				</DialogHeader>
				<ul className="space-y-1 text-sm">
					{automations.map((automation) => (
						<li key={automation.id}>{automation.name}</li>
					))}
				</ul>
				<DialogFooter>
					<Button type="button" variant="outline" onClick={onClose}>
						<Trans>Go back</Trans>
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => onResume(false)}
					>
						<Trans>Resume only the discount</Trans>
					</Button>
					<Button type="button" onClick={() => onResume(true)}>
						<Trans>Resume the discount and the automations</Trans>
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

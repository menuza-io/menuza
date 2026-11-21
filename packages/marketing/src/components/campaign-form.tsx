import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type BroadcastProblem } from '@repo/common/broadcast-checks'
import { type EmailBlock } from '@repo/common/email-blocks'
import { PUSH_BODY_MAX, PUSH_TITLE_MAX } from '@repo/common/push'
import {
	countMarketingSmsSegments,
	SMS_OPT_OUT_PHRASE,
} from '@repo/common/sms-compliance'
import { cn } from '@repo/ui'
import { Button } from '@repo/ui/button'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { Textarea } from '@repo/ui/textarea'
import { Icon } from '@repo/ui/icon'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useCampaignLabels } from '../i18n/campaign-labels.ts'
import { type CampaignChannel } from '../types/campaign.ts'
import { AiDraftButton, AiDraftDialog } from './ai/ai-draft-dialog.tsx'
import { RewriteWithAi } from './ai/rewrite-with-ai.tsx'
import { BroadcastCheckDialog } from './broadcast-check-dialog.tsx'

/** Merge tags are passed as values: Lingui reads literal braces as a placeholder. */
const NAME_TAG = '{{name}}'

/** Hours a scheduled broadcast may start late before it is skipped (#232). */
export const LATE_WINDOW_HOURS = [1, 2, 4, 8, 12, 24, 48, 72] as const
export const DEFAULT_LATE_WINDOW_HOURS = 4

/** The values an existing broadcast puts back in the form (edit, re-send). */
export interface CampaignFormDefaults {
	name?: string
	channel?: CampaignChannel
	subject?: string | null
	content?: string | null
	/** Push (#105): the image and the site page a tap opens. */
	pushImageUrl?: string | null
	pushLink?: string | null
	audience?: string | null
	/** A text prefilled for when the operator switches to Text (an occasion's, #152). */
	smsContent?: string | null
	/** ISO instant of a scheduled send. */
	scheduledAt?: string | null
	lateAfterMinutes?: number | null
}

/** `<input type="datetime-local">` takes the browser's local time. */
function toLocalInput(iso: string | null | undefined) {
	if (!iso) return ''
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return ''
	const pad = (value: number) => String(value).padStart(2, '0')
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export interface CampaignFormProps {
	error?: string | null
	isSubmitting?: boolean
	cancelTo?: string
	showSmsProBadge?: boolean
	/**
	 * Offer the Push channel (#105): the organization has `marketing.push` and
	 * the app's push. An existing push broadcast always shows it.
	 */
	pushEnabled?: boolean
	audienceField?: ReactNode
	/** Replaces the message textarea when the email channel is selected. */
	emailDesigner?: ReactNode
	/** Optional coupon picker, shown under the message (`{{couponCode}}`). */
	couponField?: ReactNode
	submitLabel?: string
	submittingLabel?: string
	/**
	 * Tenant broadcasts (#101, #232): audience, when it goes (now or later), how
	 * late a scheduled send may start, Save draft, and the pre-send check. The
	 * form posts an `intent`: `send`, `schedule`, `draft` or `test`.
	 */
	scheduling?: boolean
	/** Offer "Send a test" (email only: the operator's own address). */
	canTestSend?: boolean
	defaults?: CampaignFormDefaults
	/** The channel is fixed (an existing broadcast). */
	lockChannel?: boolean
	/** What the pre-send check found; opens the check dialog when set. */
	problems?: BroadcastProblem[] | null
	/** The email's blocks, to name the one a problem is in. */
	blocks?: EmailBlock[]
	/** Opens the designer on a block (the check's "Edit" link). */
	onEditBlock?: (blockId: string) => void
	/** The answer to the last "Send a test". */
	testResult?: { ok: boolean; message: string } | null
	/** Extra words above the form (for a re-send to non-openers). */
	notice?: ReactNode
	/**
	 * AI drafts (#155): the host puts a drafted email design into its designer
	 * state (the form fills the subject itself). Without it only text messages
	 * can be drafted. `hasEmailBlocks`: the design already has content, so a
	 * draft asks before replacing it.
	 */
	onAiDraftBlocks?: (blocks: EmailBlock[]) => void
	hasEmailBlocks?: boolean
	/**
	 * The text allowance of the month (#247), shown on the send step of a text
	 * broadcast: what the plan includes per month, how many sends are left and
	 * when they come back (epoch ms). A send over the allowance cannot start; it
	 * can still be scheduled for the first day of next month or later.
	 */
	smsAllowance?: { limit: number; remaining: number; resetsAt: number } | null
}

/** The line under "When" on a text broadcast: what this send costs and what is left. */
function allowanceNote(
	allowance: { limit: number; remaining: number },
	resetDate: string,
	over: boolean,
	_: (descriptor: MessageDescriptor) => string,
) {
	const { limit, remaining } = allowance
	if (remaining <= 0) {
		return over
			? _(
					msg`You have used all ${limit} text sends this month. You get ${limit} more on ${resetDate}. Choose a time on ${resetDate} or later to schedule it.`,
				)
			: _(
					msg`This uses a text send of next month. You get ${limit} more on ${resetDate}.`,
				)
	}
	if (remaining === 1) {
		return _(
			msg`This is your last one this month. You get ${limit} more on ${resetDate}.`,
		)
	}
	return _(
		msg`This uses 1 of your ${limit} text sends this month. ${remaining} left.`,
	)
}

export function CampaignForm({
	error,
	isSubmitting = false,
	cancelTo,
	showSmsProBadge = true,
	pushEnabled = false,
	audienceField,
	emailDesigner,
	couponField,
	submitLabel,
	submittingLabel,
	scheduling = false,
	canTestSend = false,
	defaults,
	lockChannel = false,
	problems,
	blocks,
	onEditBlock,
	testResult,
	notice,
	onAiDraftBlocks,
	hasEmailBlocks = false,
	smsAllowance = null,
}: CampaignFormProps) {
	const { _, i18n } = useLingui()
	const { channelLabel } = useCampaignLabels()
	const [channel, setChannel] = useState<CampaignChannel>(
		defaults?.channel ?? 'email',
	)
	const [smsContent, setSmsContent] = useState(
		defaults?.channel === 'sms'
			? (defaults.content ?? '')
			: (defaults?.smsContent ?? ''),
	)
	// The segment count the guest is billed for includes the opt-out line the
	// server adds to every marketing text (#75).
	const smsSegments = countMarketingSmsSegments(smsContent).segments
	const [pushContent, setPushContent] = useState(
		defaults?.channel === 'push' ? (defaults.content ?? '') : '',
	)
	const [pushTitle, setPushTitle] = useState(
		defaults?.channel === 'push' ? (defaults.subject ?? '') : '',
	)
	const [emailContent, setEmailContent] = useState(
		defaults?.channel === 'email' ? (defaults.content ?? '') : '',
	)
	const [when, setWhen] = useState<'now' | 'later'>(
		defaults?.scheduledAt ? 'later' : 'now',
	)
	const [localTime, setLocalTime] = useState(
		toLocalInput(defaults?.scheduledAt),
	)
	const [audience, setAudience] = useState(defaults?.audience ?? 'all')
	const [lateHours, setLateHours] = useState(
		defaults?.lateAfterMinutes
			? Math.round(defaults.lateAfterMinutes / 60)
			: DEFAULT_LATE_WINDOW_HOURS,
	)
	const [acknowledged, setAcknowledged] = useState(false)
	const [checkOpen, setCheckOpen] = useState(false)
	const formRoot = useRef<HTMLDivElement>(null)
	const subjectInput = useRef<HTMLInputElement>(null)
	const [aiOpen, setAiOpen] = useState(false)
	const primaryButton = useRef<HTMLButtonElement>(null)

	// A new answer from the pre-send check opens the dialog; the next submit
	// starts again from an unacknowledged state.
	useEffect(() => {
		if (problems && problems.length > 0) setCheckOpen(true)
		setAcknowledged(false)
	}, [problems])

	const scheduledIso =
		when === 'later' && localTime ? new Date(localTime).toISOString() : ''
	// A text over the month's allowance cannot start in that month (#247).
	const scheduledMs = scheduledIso ? new Date(scheduledIso).getTime() : null
	const overAllowance =
		channel === 'sms' &&
		smsAllowance !== null &&
		smsAllowance.remaining <= 0 &&
		(when === 'now' ||
			scheduledMs === null ||
			scheduledMs < smsAllowance.resetsAt)
	const resetDate = smsAllowance
		? new Intl.DateTimeFormat(i18n.locale, {
				dateStyle: 'long',
				timeZone: 'UTC',
			}).format(new Date(smsAllowance.resetsAt))
		: ''

	const sendAnyway = () => {
		setAcknowledged(true)
		setCheckOpen(false)
		// Submit the same form again, now with the warnings acknowledged.
		queueMicrotask(() => {
			const form = formRoot.current?.closest('form')
			if (form && primaryButton.current) {
				form.requestSubmit(primaryButton.current)
			}
		})
	}

	const channels: Array<{
		value: CampaignChannel
		icon: 'mail' | 'smartphone' | 'bell'
	}> = [
		{ value: 'email', icon: 'mail' },
		{ value: 'sms', icon: 'smartphone' },
		...(pushEnabled || defaults?.channel === 'push'
			? [{ value: 'push' as const, icon: 'bell' as const }]
			: []),
	]

	const resolvedSubmitLabel = submitLabel ?? _(msg`Send now`)
	const resolvedSubmittingLabel = submittingLabel ?? _(msg`Sending...`)

	return (
		<div className="space-y-6" ref={formRoot}>
			{error ? <p className="text-destructive text-sm">{error}</p> : null}
			{notice}
			{testResult ? (
				<p
					role="status"
					className={cn(
						'text-sm',
						testResult.ok ? 'text-emerald-600' : 'text-destructive',
					)}
				>
					{testResult.message}
				</p>
			) : null}

			<div className="space-y-2">
				<Label>{_(msg`Channel`)}</Label>
				<input type="hidden" name="channel" value={channel} />
				<div className="inline-flex rounded-lg border p-1">
					{channels.map((option) => (
						<button
							key={option.value}
							type="button"
							disabled={lockChannel && channel !== option.value}
							onClick={() => setChannel(option.value)}
							className={cn(
								'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
								channel === option.value
									? 'bg-muted text-foreground'
									: 'text-muted-foreground hover:text-foreground',
							)}
						>
							<Icon name={option.icon} className="size-4" />
							<span>{channelLabel(option.value)}</span>
							{showSmsProBadge && option.value === 'sms' ? (
								<span className="text-muted-foreground text-[10px] font-normal tracking-wide uppercase">
									{_(msg`Pro`)}
								</span>
							) : null}
						</button>
					))}
				</div>
			</div>

			<div className="space-y-5 rounded-lg border p-5">
				{audienceField}
				{scheduling ? (
					<div className="space-y-2">
						<Label htmlFor="audience">{_(msg`Audience`)}</Label>
						<select
							id="audience"
							name="audience"
							className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm sm:max-w-xs"
							value={
								(channel === 'sms' || channel === 'push') &&
								audience === 'unverified'
									? 'all'
									: channel === 'push'
										? 'all'
										: audience
							}
							onChange={(event) => setAudience(event.target.value)}
						>
							<option value="all">
								{channel === 'push'
									? _(msg`Everyone who opted in to notifications`)
									: _(msg`Everyone subscribed`)}
							</option>
							{channel === 'push' ? null : (
								<option value="verified">
									{_(msg`Verified phone numbers only`)}
								</option>
							)}
							{channel === 'email' ? (
								<option value="unverified">
									{_(msg`Without a verified phone`)}
								</option>
							) : null}
						</select>
					</div>
				) : null}

				<div className="space-y-2">
					<Label htmlFor="name">{_(msg`Campaign name`)}</Label>
					<Input
						id="name"
						name="name"
						defaultValue={defaults?.name}
						placeholder={_(msg`Summer promo`)}
						required
					/>
				</div>

				{channel === 'push' ? (
					<div className="space-y-2">
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="subject">{_(msg`Title`)}</Label>
							<span className="text-muted-foreground text-xs">
								{pushTitle.length} / {PUSH_TITLE_MAX}
							</span>
						</div>
						<Input
							id="subject"
							name="subject"
							value={pushTitle}
							onChange={(event) =>
								setPushTitle(event.target.value.slice(0, PUSH_TITLE_MAX))
							}
							maxLength={PUSH_TITLE_MAX}
							placeholder={_(msg`Fresh summer menu`)}
							required
						/>
					</div>
				) : null}

				{channel === 'email' ? (
					<div className="space-y-2">
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="subject">{_(msg`Subject`)}</Label>
							{onAiDraftBlocks ? (
								<AiDraftButton onClick={() => setAiOpen(true)} />
							) : null}
						</div>
						<Input
							ref={subjectInput}
							id="subject"
							name="subject"
							defaultValue={defaults?.subject ?? undefined}
							placeholder={_(msg`Check out our new summer menu`)}
							required
						/>
					</div>
				) : null}

				{channel === 'email' && emailDesigner ? (
					<div className="space-y-2">
						<Label>{_(msg`Email design`)}</Label>
						{emailDesigner}
					</div>
				) : (
					<div className="space-y-2">
						<div className="flex items-center justify-between gap-4">
							<Label htmlFor="content">{_(msg`Message`)}</Label>
							{channel === 'sms' ? (
								<AiDraftButton onClick={() => setAiOpen(true)} />
							) : null}
							{channel === 'sms' ? (
								<span
									className="text-muted-foreground text-xs"
									data-testid="sms-count"
								>
									{smsContent.length} / 1600
									{' · '}
									{_(msg`Segments: ${smsSegments} (opt-out line included)`)}
								</span>
							) : channel === 'push' ? (
								<span className="text-muted-foreground text-xs">
									{pushContent.length} / {PUSH_BODY_MAX}
								</span>
							) : (
								<span className="text-muted-foreground text-xs">
									{'{{name}}'} {_(msg`supported`)}
								</span>
							)}
						</div>
						{channel === 'sms' ? (
							<Textarea
								id="content"
								name="content"
								value={smsContent}
								onChange={(e) => setSmsContent(e.target.value.slice(0, 1600))}
								maxLength={1600}
								placeholder={_(msg`Write your text message`)}
								className="min-h-45 resize-y"
								required
							/>
						) : channel === 'push' ? (
							<Textarea
								id="content"
								name="content"
								value={pushContent}
								onChange={(e) =>
									setPushContent(e.target.value.slice(0, PUSH_BODY_MAX))
								}
								maxLength={PUSH_BODY_MAX}
								placeholder={_(msg`Write the notification`)}
								className="min-h-24 resize-y"
								required
							/>
						) : (
							<Textarea
								id="content"
								name="content"
								value={emailContent}
								onChange={(e) => setEmailContent(e.target.value)}
								placeholder={_(
									msg`Write your email. Use ${NAME_TAG} to personalize.`,
								)}
								className="min-h-45 resize-y"
								required
							/>
						)}
						{channel === 'sms' ? (
							<p className="text-muted-foreground text-xs">
								{_(
									msg`Every text ends with "${SMS_OPT_OUT_PHRASE}" and goes out between 9:00 and 20:00 local time. We add both for you.`,
								)}
							</p>
						) : null}
						{channel === 'sms' ? (
							<RewriteWithAi
								sms
								text={smsContent}
								onRewrite={(text) => setSmsContent(text.slice(0, 1600))}
							/>
						) : null}
					</div>
				)}

				{channel === 'push' ? (
					<div className="space-y-4">
						<p className="text-muted-foreground text-xs">
							{_(
								msg`A notification is written once for everyone and holds no names or codes. It goes only to guests who turned on Offers and news in your app.`,
							)}
						</p>
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="pushLink">{_(msg`Opens this page`)}</Label>
								<Input
									id="pushLink"
									name="pushLink"
									defaultValue={defaults?.pushLink ?? ''}
									placeholder="/menu"
								/>
								<p className="text-muted-foreground text-xs">
									{_(msg`A page on your site. Leave empty for the menu.`)}
								</p>
							</div>
							<div className="space-y-2">
								<Label htmlFor="pushImageUrl">{_(msg`Image address`)}</Label>
								<Input
									id="pushImageUrl"
									name="pushImageUrl"
									type="url"
									defaultValue={defaults?.pushImageUrl ?? ''}
									placeholder="https://"
								/>
								<p className="text-muted-foreground text-xs">
									{_(msg`Optional. A secure (https) address.`)}
								</p>
							</div>
						</div>
					</div>
				) : (
					couponField
				)}

				<AiDraftDialog
					open={aiOpen && channel !== 'push'}
					onOpenChange={setAiOpen}
					channel={channel === 'push' ? 'sms' : channel}
					hasContent={
						channel === 'sms'
							? smsContent.trim().length > 0
							: hasEmailBlocks ||
								(subjectInput.current?.value.trim().length ?? 0) > 0
					}
					onApply={(draft) => {
						if (draft.channel === 'sms') {
							setSmsContent(draft.message.slice(0, 1600))
						} else {
							if (subjectInput.current) {
								subjectInput.current.value = draft.subject
							}
							onAiDraftBlocks?.(draft.blocks)
						}
					}}
				/>
			</div>

			{scheduling ? (
				<div className="space-y-4 rounded-lg border p-5">
					<input type="hidden" name="scheduledAt" value={scheduledIso} />
					<input type="hidden" name="lateAfterHours" value={lateHours} />
					{acknowledged ? (
						<input type="hidden" name="acknowledgeWarnings" value="1" />
					) : null}
					<div className="space-y-2">
						<Label>{_(msg`When`)}</Label>
						<div
							className="inline-flex rounded-lg border p-1"
							role="radiogroup"
						>
							{(['now', 'later'] as const).map((option) => (
								<button
									key={option}
									type="button"
									role="radio"
									aria-checked={when === option}
									onClick={() => setWhen(option)}
									className={cn(
										'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
										when === option
											? 'bg-muted text-foreground'
											: 'text-muted-foreground hover:text-foreground',
									)}
								>
									{option === 'now'
										? _(msg`Send now`)
										: _(msg`Schedule for later`)}
								</button>
							))}
						</div>
					</div>
					{channel === 'sms' && smsAllowance ? (
						<p
							role={overAllowance ? 'alert' : undefined}
							className={cn(
								'text-sm',
								overAllowance ? 'text-destructive' : 'text-muted-foreground',
							)}
							data-testid="sms-allowance"
						>
							{allowanceNote(smsAllowance, resetDate, overAllowance, _)}
						</p>
					) : null}
					{when === 'later' ? (
						<div className="grid gap-4 sm:grid-cols-2">
							<div className="space-y-2">
								<Label htmlFor="scheduled-local">{_(msg`Send at`)}</Label>
								<Input
									id="scheduled-local"
									type="datetime-local"
									value={localTime}
									min={toLocalInput(new Date().toISOString())}
									onChange={(event) => setLocalTime(event.target.value)}
									required
								/>
								<p className="text-muted-foreground text-xs">
									{_(msg`In your time zone.`)}
								</p>
							</div>
							<div className="space-y-2">
								<Label htmlFor="late-window">
									{_(msg`Don't send if more than this late`)}
								</Label>
								<select
									id="late-window"
									className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
									value={lateHours}
									onChange={(event) => setLateHours(Number(event.target.value))}
								>
									{LATE_WINDOW_HOURS.map((hours) => (
										<option key={hours} value={hours}>
											{hours === 1
												? _(msg`1 hour late`)
												: _(msg`${hours} hours late`)}
										</option>
									))}
								</select>
								<p className="text-muted-foreground text-xs">
									{_(
										msg`If sending cannot start in time, it is not sent and you are told.`,
									)}
								</p>
							</div>
						</div>
					) : null}
				</div>
			) : null}

			<div className="flex items-center justify-between gap-3">
				{cancelTo ? (
					<Button
						type="button"
						variant="ghost"
						render={<Link to={cancelTo} />}
						disabled={isSubmitting}
					>
						{_(msg`Cancel`)}
					</Button>
				) : (
					<span />
				)}
				{scheduling ? (
					<div className="flex flex-wrap items-center justify-end gap-2">
						<Button
							type="submit"
							name="intent"
							value="draft"
							variant="outline"
							disabled={isSubmitting}
							formNoValidate
						>
							{_(msg`Save draft`)}
						</Button>
						{canTestSend && channel === 'email' ? (
							<Button
								type="submit"
								name="intent"
								value="test"
								variant="outline"
								disabled={isSubmitting}
								formNoValidate
							>
								{_(msg`Send a test`)}
							</Button>
						) : null}
						<Button
							ref={primaryButton}
							type="submit"
							name="intent"
							value={when === 'later' ? 'schedule' : 'send'}
							disabled={isSubmitting || overAllowance}
							className="gap-2"
						>
							{isSubmitting ? (
								<>
									<Icon name="loader" className="size-4 animate-spin" />
									{resolvedSubmittingLabel}
								</>
							) : (
								<>
									<Icon name="send" className="size-4" />
									{when === 'later' ? _(msg`Schedule`) : resolvedSubmitLabel}
								</>
							)}
						</Button>
					</div>
				) : (
					<Button type="submit" disabled={isSubmitting} className="gap-2">
						{isSubmitting ? (
							<>
								<Icon name="loader" className="size-4 animate-spin" />
								{resolvedSubmittingLabel}
							</>
						) : (
							<>
								<Icon name="send" className="size-4" />
								{resolvedSubmitLabel}
							</>
						)}
					</Button>
				)}
			</div>

			{scheduling && problems && problems.length > 0 ? (
				<BroadcastCheckDialog
					open={checkOpen}
					onOpenChange={setCheckOpen}
					problems={problems}
					blocks={blocks}
					scheduling={when === 'later'}
					onEditBlock={onEditBlock}
					onSendAnyway={sendAnyway}
					busy={isSubmitting}
				/>
			) : null}
		</div>
	)
}

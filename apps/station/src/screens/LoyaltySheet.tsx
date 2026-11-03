import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
	chooseReward,
	forgetMember,
	identifyByCode,
	liveEnv,
	pollApproval,
	removeReward,
	RewardRefusal,
	sendApprovalCode,
	sendJoinCode,
	submitApprovalCode,
	useLoyalty,
	verifyJoinCode,
} from '~/lib/loyalty-store.ts'
import {
	foldCodeInput,
	foldPhoneInput,
	LoyaltyApiError,
	nextReward,
	plausiblePhone,
	spendingAllowed,
	type LoyaltyReward,
	type SpendRefusal,
} from '~/lib/loyalty.ts'
import { type MoneyFormatter } from '~/lib/money.ts'
import { usePos } from '~/lib/store.ts'
import { Badge, Button, Input, Modal } from '~/ui/primitives.tsx'

/** How often the till asks the region whether the member has decided. */
const POLL_MS = 2_000
/** A join code can be sent again after this long (the region limits it too). */
const RESEND_AFTER_MS = 30_000

/** "12 points" or "12 stars", in the till's language. */
export function useUnitText() {
	const { _ } = useLingui()
	return (count: number, label: string): string =>
		label === 'stars'
			? _(plural(count, { one: '# star', other: '# stars' }))
			: _(plural(count, { one: '# point', other: '# points' }))
}

/** Last four digits only: the phone is never shown whole once it is typed. */
export const maskPhone = (phone: string): string => {
	const digits = phone.replace(/\D/g, '')
	return digits.length > 4 ? `••••${digits.slice(-4)}` : digits
}

/**
 * Rewards for the sale on screen: identify a member (a code from their wallet,
 * or a phone number that joins them), show what they have, and let them spend
 * it. The member earns on the sale just by being identified.
 */
export function LoyaltySheet({
	open,
	onClose,
	money,
}: {
	open: boolean
	onClose: () => void
	money: MoneyFormatter
}) {
	const { _ } = useLingui()
	const unitText = useUnitText()
	const env = useMemo(() => liveEnv(), [])
	const member = useLoyalty((s) => s.member)
	const waiting = useLoyalty((s) => s.waiting)
	const applied = useLoyalty((s) => s.applied)
	const quoting = useLoyalty((s) => s.quoting)
	const online = usePos((s) => s.online)
	const signInRequired = usePos((s) => s.settings.signInRequired)
	const session = usePos((s) => s.session)
	const hasLines = usePos((s) => s.lines.length > 0)

	const [code, setCode] = useState('')
	const [phone, setPhone] = useState('')
	const [joinCode, setJoinCode] = useState('')
	const [stage, setStage] = useState<'choose' | 'code'>('choose')
	const [sentAt, setSentAt] = useState(0)
	const [otp, setOtp] = useState('')
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState<string | null>(null)
	const [now, setNow] = useState(() => Date.now())
	const openRef = useRef(open)
	openRef.current = open

	// Forget what was typed when the sheet closes: a phone number or a code
	// never waits behind a closed sheet.
	useEffect(() => {
		if (open) return
		setCode('')
		setPhone('')
		setJoinCode('')
		setOtp('')
		setStage('choose')
		setMessage(null)
	}, [open])

	// While the member decides, ask the region every couple of seconds.
	const pendingId = waiting?.approval.id ?? null
	useEffect(() => {
		if (!open || !pendingId) return
		const timer = window.setInterval(() => {
			void pollApproval(env).catch(() => undefined)
		}, POLL_MS)
		return () => window.clearInterval(timer)
	}, [open, pendingId, env])

	// The resend button counts down.
	useEffect(() => {
		if (stage !== 'code') return
		const timer = window.setInterval(() => setNow(Date.now()), 1_000)
		return () => window.clearInterval(timer)
	}, [stage])

	const errorText = (error: unknown): string => {
		if (error instanceof RewardRefusal) return refusalText(error)
		if (error instanceof LoyaltyApiError) {
			if (error.offline)
				return _(
					t`No connection. Rewards need the internet; the sale can go on without.`,
				)
			if (error.unavailable)
				return _(t`Rewards are not switched on for this restaurant.`)
			if (error.redemptionOff)
				return _(t`Members can earn here, but spending points is switched off.`)
			if (error.needsSignIn)
				return _(t`Sign in again while online to use rewards.`)
			if (error.deviceProblem)
				return _(
					t`This terminal is not recognised. Ask a manager to pair it again.`,
				)
			if (error.rateLimited)
				return _(t`Too many tries. Wait a moment and try again.`)
			switch (error.code) {
				case 'code_invalid':
					return _(
						t`That code is not right, or it was already used. Ask for a new one from their wallet.`,
					)
				case 'otp_invalid':
					return _(t`That code is not right, or it has expired.`)
				case 'otp_locked':
					return _(t`Too many wrong codes. Send a new one.`)
				case 'otp_unavailable':
					return _(t`A text message could not be sent to that number.`)
				case 'invalid_request':
					return _(t`Check the number and try again.`)
				case 'member_inactive':
					return _(t`This member's account is not active.`)
				case 'reward_unavailable':
				case 'reward_not_found':
					return _(t`That reward is not available any more.`)
				case 'binding_invalid':
					return _(t`This member was forgotten. Find them again.`)
				case 'approval_expired':
					return _(t`The request expired. Ask again.`)
				default:
					return _(t`Something went wrong. Try again.`)
			}
		}
		return _(t`Something went wrong. Try again.`)
	}

	const refusalText = (refusal: RewardRefusal): string => {
		switch (refusal.reason) {
			case 'offline':
				return _(
					t`No connection. Rewards can only be spent when the till is online.`,
				)
			case 'spending_off':
				return _(t`Members can earn here, but spending points is switched off.`)
			case 'binding_expired':
				return _(t`This member was identified too long ago. Find them again.`)
			case 'sign_in_again':
				return _(t`Sign in again while online to spend rewards.`)
			case 'empty_cart':
				return _(t`Add items first, then choose a reward.`)
			case 'not_affordable':
				return _(t`They do not have enough points for that reward yet.`)
			case 'not_applicable':
				return _(t`That reward does not apply to what is on this order.`)
			default:
				return _(t`That reward cannot be used right now.`)
		}
	}

	const run = async (work: () => Promise<void>) => {
		if (busy) return
		setBusy(true)
		setMessage(null)
		try {
			await work()
		} catch (error) {
			if (openRef.current) setMessage(errorText(error))
		} finally {
			setBusy(false)
		}
	}

	const findByCode = () =>
		run(async () => {
			await identifyByCode(env, code)
			setCode('')
		})

	const sendJoin = () =>
		run(async () => {
			await sendJoinCode(env, foldPhoneInput(phone))
			setSentAt(Date.now())
			setNow(Date.now())
			setJoinCode('')
			setStage('code')
		})

	const verifyJoin = () =>
		run(async () => {
			await verifyJoinCode(env, foldPhoneInput(phone), foldCodeInput(joinCode))
			// The number is not needed any more.
			setPhone('')
			setJoinCode('')
			setStage('choose')
		})

	const pick = (reward: LoyaltyReward) =>
		run(async () => {
			await chooseReward(env, reward)
		})

	const resendIn = Math.max(
		0,
		Math.ceil((sentAt + RESEND_AFTER_MS - now) / 1000),
	)
	const spend = spendingAllowed({
		online,
		member,
		signInRequired,
		session,
		now,
	})
	const next = member
		? nextReward(member.rewards, member.balance.available)
		: null
	const toGoText = (reward: LoyaltyReward): string =>
		member
			? unitText(reward.pointsCost - member.balance.available, member.unitLabel)
			: ''
	const spendNote = (reason: SpendRefusal): string | null => {
		if (reason === 'no_member') return null
		return refusalText(new RewardRefusal(reason))
	}

	const title = _(t`Rewards`)
	const masked = maskPhone(phone)
	const heldText = member
		? unitText(member.balance.reserved, member.unitLabel)
		: ''
	const moreText = next && member ? unitText(next.needed, member.unitLabel) : ''
	const nextName = next?.reward.name ?? ''
	const waitingName = waiting?.approval.rewardName ?? ''
	const appliedName = applied?.name ?? ''
	const firstName = member?.firstName ?? ''

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={title}
			footer={
				member ? (
					<div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2 pb-4">
						<Button
							variant="ghost"
							disabled={busy}
							onClick={() => void run(() => forgetMember(env))}
						>
							<Trans>Not them</Trans>
						</Button>
						<Button variant="primary" size="lg" onClick={onClose}>
							<Trans>Done</Trans>
						</Button>
					</div>
				) : (
					<div className="pb-4">
						<Button variant="ghost" className="w-full" onClick={onClose}>
							<Trans>Skip</Trans>
						</Button>
					</div>
				)
			}
		>
			<div className="space-y-5 p-5">
				{!member && stage === 'choose' ? (
					<>
						<form
							className="space-y-2"
							onSubmit={(event) => {
								event.preventDefault()
								if (code.trim()) void findByCode()
							}}
						>
							<label htmlFor="loyalty-code" className="text-sm font-semibold">
								<Trans>Member code</Trans>
							</label>
							<p className="text-muted-foreground text-sm">
								<Trans>
									The code in the guest's wallet on the website or app.
								</Trans>
							</p>
							<div className="flex gap-2">
								<Input
									id="loyalty-code"
									autoFocus
									value={code}
									onChange={(e) => setCode(e.target.value)}
									maxLength={32}
									autoCapitalize="characters"
									autoComplete="off"
									spellCheck={false}
									dir="ltr"
									className="h-14 flex-1 px-4 tracking-widest"
								/>
								<Button
									type="submit"
									variant="primary"
									size="lg"
									disabled={busy || !code.trim()}
								>
									<Trans>Find</Trans>
								</Button>
							</div>
						</form>

						<div className="text-muted-foreground flex items-center gap-3 text-xs uppercase">
							<span className="bg-border h-px flex-1" />
							<Trans>or</Trans>
							<span className="bg-border h-px flex-1" />
						</div>

						<form
							className="space-y-2"
							onSubmit={(event) => {
								event.preventDefault()
								if (plausiblePhone(phone)) void sendJoin()
							}}
						>
							<label htmlFor="loyalty-phone" className="text-sm font-semibold">
								<Trans>Phone number</Trans>
							</label>
							<p
								id="loyalty-phone-note"
								className="text-muted-foreground text-sm"
							>
								<Trans>
									This number joins the rewards program. We text the guest a
									code to confirm it.
								</Trans>
							</p>
							<div className="flex gap-2">
								<Input
									id="loyalty-phone"
									type="tel"
									inputMode="tel"
									autoComplete="off"
									aria-describedby="loyalty-phone-note"
									value={phone}
									onChange={(e) => setPhone(e.target.value)}
									maxLength={24}
									dir="ltr"
									className="h-14 flex-1 px-4"
								/>
								<Button
									type="submit"
									variant="outline"
									size="lg"
									disabled={busy || !plausiblePhone(phone)}
								>
									<Icon name="send" className="size-4" aria-hidden />
									<Trans>Send code</Trans>
								</Button>
							</div>
						</form>
					</>
				) : null}

				{!member && stage === 'code' ? (
					<form
						className="space-y-3"
						onSubmit={(event) => {
							event.preventDefault()
							if (foldCodeInput(joinCode).length === 6) void verifyJoin()
						}}
					>
						<p className="text-sm">
							{_(
								t`We texted a 6-digit code to ${masked}. Ask the guest to read it out.`,
							)}
						</p>
						<div className="flex gap-2">
							<Input
								autoFocus
								aria-label={_(t`6-digit code`)}
								inputMode="numeric"
								autoComplete="one-time-code"
								value={joinCode}
								onChange={(e) =>
									setJoinCode(foldCodeInput(e.target.value).slice(0, 6))
								}
								maxLength={6}
								dir="ltr"
								className="h-14 flex-1 px-4 text-center text-xl tracking-widest"
							/>
							<Button
								type="submit"
								variant="primary"
								size="lg"
								disabled={busy || foldCodeInput(joinCode).length !== 6}
							>
								<Trans>Confirm</Trans>
							</Button>
						</div>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<Button
								variant="ghost"
								onClick={() => {
									setStage('choose')
									setJoinCode('')
									setMessage(null)
								}}
							>
								<Trans>Change number</Trans>
							</Button>
							<Button
								variant="ghost"
								disabled={busy || resendIn > 0}
								onClick={() => void sendJoin()}
							>
								{resendIn > 0
									? _(t`Send again in ${resendIn}s`)
									: _(t`Send again`)}
							</Button>
						</div>
					</form>
				) : null}

				{member ? (
					<>
						<section aria-live="polite" className="space-y-1">
							<div className="flex items-center gap-2">
								<Icon
									name={member.joined ? 'user-plus' : 'user-check'}
									className="text-primary size-5"
									aria-hidden
								/>
								<h3 className="text-xl font-semibold">
									{member.joined
										? member.firstName
											? _(t`Welcome, ${firstName}`)
											: _(t`Welcome to the rewards program`)
										: member.firstName
											? _(t`Member found: ${firstName}`)
											: _(t`Member found`)}
								</h3>
							</div>
							<p className="tnum text-3xl font-semibold">
								{unitText(member.balance.available, member.unitLabel)}
							</p>
							{member.balance.reserved > 0 ? (
								<p className="text-muted-foreground text-sm">
									{_(t`${heldText} held for a reward in progress`)}
								</p>
							) : null}
							<p className="text-muted-foreground text-sm">
								<Trans>They earn on this order when it is paid.</Trans>
							</p>
						</section>

						{next ? (
							<section className="space-y-1">
								<div
									role="progressbar"
									aria-valuemin={0}
									aria-valuemax={100}
									aria-valuenow={Math.round(next.progress * 100)}
									aria-label={_(t`Progress to ${nextName}`)}
									className="bg-secondary h-2 overflow-hidden rounded-full"
								>
									<div
										className="bg-primary h-full rounded-full transition-[width]"
										style={{ width: `${Math.round(next.progress * 100)}%` }}
									/>
								</div>
								<p className="text-muted-foreground text-sm">
									{_(t`${moreText} more to ${nextName}`)}
								</p>
							</section>
						) : null}

						{applied ? (
							<section className="bg-primary/10 text-primary flex items-center justify-between gap-3 rounded-xl px-3 py-2">
								<span className="min-w-0 text-sm font-semibold">
									{_(t`Reward on this order: ${appliedName}`)}
									<span className="tnum ms-2">
										−{money(applied.discountMinor)}
									</span>
								</span>
								<Button
									variant="ghost"
									disabled={busy}
									onClick={() => void run(() => removeReward(env))}
								>
									<Trans>Remove</Trans>
								</Button>
							</section>
						) : null}

						{waiting ? (
							<section className="border-border space-y-3 rounded-xl border p-3">
								<p className="text-sm font-semibold">
									{_(t`Waiting for the guest to approve ${waitingName}`)}
								</p>
								<p className="text-muted-foreground text-sm">
									<Trans>
										Ask them to open their wallet and approve it, or text them a
										code.
									</Trans>
								</p>
								{waiting.otpSent ? (
									<form
										className="flex gap-2"
										onSubmit={(event) => {
											event.preventDefault()
											if (otp.trim())
												void run(async () => {
													await submitApprovalCode(env, foldCodeInput(otp))
													setOtp('')
												})
										}}
									>
										<Input
											autoFocus
											aria-label={_(t`Code the guest was sent`)}
											inputMode="numeric"
											autoComplete="one-time-code"
											value={otp}
											onChange={(e) =>
												setOtp(foldCodeInput(e.target.value).slice(0, 12))
											}
											dir="ltr"
											className="h-14 flex-1 px-4 text-center tracking-widest"
										/>
										<Button
											type="submit"
											variant="primary"
											size="lg"
											disabled={busy || !otp.trim()}
										>
											<Trans>Confirm</Trans>
										</Button>
									</form>
								) : waiting.approval.otpAvailable ? (
									<Button
										variant="outline"
										disabled={busy}
										onClick={() =>
											void run(async () => void (await sendApprovalCode(env)))
										}
									>
										<Icon name="smartphone" className="size-4" aria-hidden />
										<Trans>Text them a code</Trans>
									</Button>
								) : null}
								<Button
									variant="ghost"
									disabled={busy}
									onClick={() => void run(() => removeReward(env))}
								>
									<Trans>Cancel request</Trans>
								</Button>
							</section>
						) : null}

						{member.rewards.length > 0 && !applied && !waiting ? (
							<section className="space-y-2">
								<h4 className="text-sm font-semibold">
									<Trans>Rewards</Trans>
								</h4>
								{!spend.ok && spendNote(spend.reason) ? (
									<p className="notice-warning rounded-lg px-3 py-2 text-sm">
										{spendNote(spend.reason)}
									</p>
								) : null}
								{!hasLines && spend.ok ? (
									<p className="text-muted-foreground text-sm">
										<Trans>Add items to the order to use a reward.</Trans>
									</p>
								) : null}
								<ul className="space-y-2">
									{member.rewards.map((reward) => {
										const affordable =
											reward.pointsCost <= member.balance.available
										const toGo = toGoText(reward)
										return (
											<li
												key={reward.id}
												className="border-border flex items-center justify-between gap-3 rounded-xl border p-3"
											>
												<div className="min-w-0">
													<div className="font-semibold break-words">
														{reward.name}
													</div>
													<div className="text-muted-foreground text-sm">
														{unitText(reward.pointsCost, member.unitLabel)}
													</div>
												</div>
												{affordable ? (
													<Button
														variant="primary"
														disabled={
															busy || quoting !== null || !spend.ok || !hasLines
														}
														onClick={() => void pick(reward)}
													>
														{quoting === reward.id
															? _(t`Checking…`)
															: _(t`Use`)}
													</Button>
												) : (
													<Badge tone="muted" className="shrink-0">
														{_(t`${toGo} to go`)}
													</Badge>
												)}
											</li>
										)
									})}
								</ul>
							</section>
						) : null}
					</>
				) : null}

				{message ? (
					<p role="alert" className="text-destructive text-sm font-medium">
						{message}
					</p>
				) : null}
			</div>
		</Modal>
	)
}

import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { Icon } from '@repo/ui/icon'
import { type ReactNode, useState } from 'react'

export const DIAL_PAD_KEYS = [
	'1',
	'2',
	'3',
	'4',
	'5',
	'6',
	'7',
	'8',
	'9',
	'*',
	'0',
	'#',
] as const
export type DialPadKey = (typeof DIAL_PAD_KEYS)[number]

/** Shown on the dialer when the organization has no agent number yet. */
export const PLACEHOLDER_AGENT_NUMBER = '+18888888888'

// Keypad letters are part of the keypad's look, not text to translate.
const KEY_LETTERS: Record<DialPadKey, string> = {
	'1': '',
	'2': 'ABC',
	'3': 'DEF',
	'4': 'GHI',
	'5': 'JKL',
	'6': 'MNO',
	'7': 'PQRS',
	'8': 'TUV',
	'9': 'WXYZ',
	'*': '',
	'0': '+',
	'#': '',
}

/** Formats a number the way a phone dialer shows it: `1 (888) 888-8888`. */
export function formatDialerNumber(e164: string) {
	const nanp = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164)
	return nanp ? `1 (${nanp[1]}) ${nanp[2]}-${nanp[3]}` : e164
}

function formatElapsed(seconds: number) {
	const minutes = Math.floor(seconds / 60)
	const rest = seconds % 60
	return `${minutes}:${String(rest).padStart(2, '0')}`
}

export type PhoneCallState =
	| { screen: 'dialer'; ended: boolean }
	| {
			screen: 'call'
			/** Seconds since the agent answered; null while still ringing. */
			elapsedSeconds: number | null
			/** What the agent is doing, once it answered. */
			activity: string | null
			muted: boolean
			canMute: boolean
			speakerOn: boolean
			dialed: string
	  }

export function TestCallPhone({
	agentName,
	agentNumber,
	state,
	canCall,
	onCall,
	onPressKey,
	onToggleMute,
	onToggleSpeaker,
	onHangUp,
}: {
	agentName: string
	agentNumber: string
	state: PhoneCallState
	canCall: boolean
	onCall: () => void
	onPressKey: (key: DialPadKey) => void
	onToggleMute: () => void
	onToggleSpeaker: () => void
	onHangUp: () => void
}) {
	const [keypadOpen, setKeypadOpen] = useState(false)
	const showKeypad = state.screen === 'call' && keypadOpen

	return (
		<div className="mx-auto w-72 max-w-full rounded-4xl bg-zinc-900 p-2.5 shadow-xl ring-1 ring-zinc-700 dark:ring-zinc-600">
			<div
				className={cn(
					'relative flex h-140 flex-col overflow-hidden rounded-3xl',
					state.screen === 'dialer'
						? 'bg-zinc-50 text-zinc-900'
						: showKeypad
							? 'bg-zinc-950 text-white'
							: 'bg-linear-to-b from-zinc-700 to-zinc-950 text-white',
				)}
			>
				{state.screen === 'dialer' ? (
					<DialerScreen
						agentNumber={agentNumber}
						ended={state.ended}
						canCall={canCall}
						onCall={() => {
							setKeypadOpen(false)
							onCall()
						}}
					/>
				) : showKeypad ? (
					<InCallKeypad
						dialed={state.dialed}
						onPressKey={onPressKey}
						onHangUp={onHangUp}
						onHide={() => setKeypadOpen(false)}
					/>
				) : (
					<CallScreen
						agentName={agentName}
						state={state}
						onOpenKeypad={() => setKeypadOpen(true)}
						onToggleMute={onToggleMute}
						onToggleSpeaker={onToggleSpeaker}
						onHangUp={onHangUp}
					/>
				)}
				<div
					className={cn(
						'absolute bottom-2 left-1/2 h-1 w-24 -translate-x-1/2 rounded-full',
						state.screen === 'dialer' ? 'bg-zinc-900' : 'bg-white',
					)}
					aria-hidden="true"
				/>
			</div>
		</div>
	)
}

function DialerScreen({
	agentNumber,
	ended,
	canCall,
	onCall,
}: {
	agentNumber: string
	ended: boolean
	canCall: boolean
	onCall: () => void
}) {
	const { _ } = useLingui()
	const number = formatDialerNumber(agentNumber)
	return (
		<div className="flex flex-1 flex-col items-center px-6 pt-16 pb-8">
			<p className="text-2xl font-normal tracking-tight tabular-nums" dir="ltr">
				{number}
			</p>
			<p
				className="mt-1 h-5 text-sm text-zinc-500"
				role="status"
				aria-live="polite"
			>
				{ended ? <Trans>Call ended</Trans> : null}
			</p>
			{/* The number is fixed: the keys only work during a call. */}
			<div
				className="mt-6 grid grid-cols-3 gap-x-5 gap-y-3"
				aria-hidden="true"
				dir="ltr"
			>
				{DIAL_PAD_KEYS.map((key) => (
					<KeyFace
						key={key}
						digit={key}
						className="bg-zinc-200 text-zinc-900"
					/>
				))}
			</div>
			<button
				type="button"
				className="mt-auto flex size-16 items-center justify-center rounded-full bg-green-500 text-white transition-colors hover:bg-green-600 focus-visible:ring-4 focus-visible:ring-green-300 focus-visible:outline-none disabled:opacity-50"
				disabled={!canCall}
				aria-label={_(msg`Call ${number}`)}
				onClick={onCall}
			>
				<Icon name="phone" className="size-7" />
			</button>
		</div>
	)
}

function CallScreen({
	agentName,
	state,
	onOpenKeypad,
	onToggleMute,
	onToggleSpeaker,
	onHangUp,
}: {
	agentName: string
	state: Extract<PhoneCallState, { screen: 'call' }>
	onOpenKeypad: () => void
	onToggleMute: () => void
	onToggleSpeaker: () => void
	onHangUp: () => void
}) {
	const { _ } = useLingui()
	const answered = state.elapsedSeconds !== null
	return (
		<div className="flex flex-1 flex-col items-center px-6 pt-16 pb-8">
			<p className="max-w-full truncate text-3xl font-normal">{agentName}</p>
			<div
				className="mt-1 flex flex-col items-center text-zinc-300"
				role="status"
				aria-live="polite"
			>
				<p className="text-lg tabular-nums">
					{answered ? (
						formatElapsed(state.elapsedSeconds ?? 0)
					) : (
						<Trans>Calling…</Trans>
					)}
				</p>
				<p className="h-5 text-sm text-zinc-400">
					{state.muted ? <Trans>You're muted</Trans> : state.activity}
				</p>
			</div>
			<div className="mt-10 grid grid-cols-3 gap-x-5">
				<CallAction
					label={<Trans>Mute</Trans>}
					icon={state.muted ? 'mic-off' : 'mic'}
					active={state.muted}
					disabled={!state.canMute}
					ariaLabel={
						state.muted ? _(msg`Unmute microphone`) : _(msg`Mute microphone`)
					}
					onClick={onToggleMute}
				/>
				<CallAction
					label={<Trans>Keypad</Trans>}
					icon="grip"
					active={false}
					disabled={!answered}
					ariaLabel={_(msg`Show keypad`)}
					onClick={onOpenKeypad}
				/>
				<CallAction
					label={<Trans>Speaker</Trans>}
					icon={state.speakerOn ? 'volume-2' : 'volume-x'}
					active={state.speakerOn}
					disabled={false}
					ariaLabel={
						state.speakerOn
							? _(msg`Turn off agent audio`)
							: _(msg`Turn on agent audio`)
					}
					onClick={onToggleSpeaker}
				/>
			</div>
			<HangUpButton onClick={onHangUp} className="mt-auto" />
		</div>
	)
}

function InCallKeypad({
	dialed,
	onPressKey,
	onHangUp,
	onHide,
}: {
	dialed: string
	onPressKey: (key: DialPadKey) => void
	onHangUp: () => void
	onHide: () => void
}) {
	const { _ } = useLingui()
	return (
		<div className="flex flex-1 flex-col items-center px-6 pt-10 pb-8">
			<p
				className="h-9 max-w-full truncate text-3xl font-normal tabular-nums"
				dir="ltr"
				aria-hidden="true"
			>
				{/* Keep the newest presses visible when the line is long. */}
				{dialed.slice(-12)}
			</p>
			<div
				role="group"
				aria-label={_(msg`Dial pad`)}
				className="mt-4 grid grid-cols-3 gap-x-5 gap-y-3"
				dir="ltr"
			>
				{DIAL_PAD_KEYS.map((key) => (
					<button
						key={key}
						type="button"
						className="rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none active:bg-zinc-500"
						aria-label={_(msg`Press ${key}`)}
						onClick={() => onPressKey(key)}
					>
						<KeyFace
							digit={key}
							className="bg-zinc-800 text-white hover:bg-zinc-700"
						/>
					</button>
				))}
			</div>
			<div className="mt-auto grid w-full grid-cols-3 items-center">
				<span />
				<HangUpButton onClick={onHangUp} className="justify-self-center" />
				<button
					type="button"
					className="justify-self-center rounded px-2 py-1 text-base text-white focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none"
					onClick={onHide}
				>
					<Trans>Hide</Trans>
				</button>
			</div>
		</div>
	)
}

function KeyFace({
	digit,
	className,
}: {
	digit: DialPadKey
	className: string
}) {
	return (
		<span
			className={cn(
				'flex size-16 flex-col items-center justify-center rounded-full leading-none',
				className,
			)}
		>
			<span className="text-2xl">{digit}</span>
			<span className="mt-0.5 h-3 text-[9px] font-semibold tracking-widest">
				{KEY_LETTERS[digit]}
			</span>
		</span>
	)
}

function CallAction({
	label,
	icon,
	active,
	disabled,
	ariaLabel,
	onClick,
}: {
	label: ReactNode
	icon: 'mic' | 'mic-off' | 'grip' | 'volume-2' | 'volume-x'
	active: boolean
	disabled: boolean
	ariaLabel: string
	onClick: () => void
}) {
	return (
		<div className="flex flex-col items-center gap-2">
			<button
				type="button"
				className={cn(
					'flex size-16 items-center justify-center rounded-full transition-colors focus-visible:ring-2 focus-visible:ring-white focus-visible:outline-none disabled:opacity-40',
					active
						? 'bg-white text-zinc-900'
						: 'bg-white/15 text-white hover:bg-white/25',
				)}
				aria-label={ariaLabel}
				aria-pressed={active}
				disabled={disabled}
				onClick={onClick}
			>
				<Icon name={icon} className="size-7" />
			</button>
			<span className={cn('text-sm', disabled && 'opacity-40')}>{label}</span>
		</div>
	)
}

function HangUpButton({
	onClick,
	className,
}: {
	onClick: () => void
	className?: string
}) {
	const { _ } = useLingui()
	return (
		<button
			type="button"
			className={cn(
				'flex size-16 items-center justify-center rounded-full bg-red-500 text-white transition-colors hover:bg-red-600 focus-visible:ring-4 focus-visible:ring-red-300 focus-visible:outline-none',
				className,
			)}
			aria-label={_(msg`End call`)}
			onClick={onClick}
		>
			<Icon name="phone" className="size-7 rotate-135" />
		</button>
	)
}

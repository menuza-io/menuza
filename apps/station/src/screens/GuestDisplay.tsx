import { plural, t, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Icon } from '@repo/ui/icon'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
	readGuestState,
	type GuestLoyalty,
	type GuestMessage,
	type GuestState,
} from '~/lib/guest-display.ts'
import { foldCodeInput, foldPhoneInput } from '~/lib/loyalty.ts'
import { moneyFormatter } from '~/lib/money.ts'
import { Button, Chip, Input, cn } from '~/ui/primitives.tsx'

/**
 * The guest's second screen (#367): the order as the till has it, the tip
 * prompt, the guest's own loyalty sign-in, and a picture between orders. It is
 * a view of the till's local cart, so it needs no network. It holds no data of
 * its own and never shows who is working the till or who ordered before.
 */
export function GuestDisplay({
	channelName,
	createChannel,
	onLocale,
}: {
	channelName: string
	/** Switches the page's language and direction to the till's (`applyLocale`). */
	onLocale?: (locale: 'en' | 'ar') => void
	/** Tests pass a fake channel. */
	createChannel?: (name: string) => {
		postMessage: (m: unknown) => void
		onmessage: ((e: { data: unknown }) => void) | null
		close: () => void
	}
}) {
	const [state, setState] = useState<GuestState | null>(null)
	const lastSeq = useRef(-1)
	const channel = useRef<ReturnType<NonNullable<typeof createChannel>> | null>(
		null,
	)

	useEffect(() => {
		const make =
			createChannel ?? ((name: string) => new BroadcastChannel(name) as never)
		const c = make(channelName)
		channel.current = c
		c.onmessage = (event) => {
			const next = readGuestState(event.data)
			// An older message never replaces a newer one.
			if (!next || next.seq <= lastSeq.current) return
			lastSeq.current = next.seq
			setState(next)
		}
		// The till answers with what it has right now.
		c.postMessage({ type: 'hello' } satisfies GuestMessage)
		return () => {
			c.onmessage = null
			c.close()
			channel.current = null
		}
	}, [channelName, createChannel])

	// Follow the till's language and direction.
	useEffect(() => {
		if (state) onLocale?.(state.locale === 'ar' ? 'ar' : 'en')
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [state?.locale])

	const send = (message: GuestMessage) => channel.current?.postMessage(message)

	return (
		<div
			className="bg-background text-foreground flex h-full flex-col"
			data-guest-display
			data-view={state?.view ?? 'idle'}
		>
			{state === null || state.view === 'idle' ? (
				<Idle state={state} />
			) : (
				<Order state={state} send={send} />
			)}
		</div>
	)
}

function Idle({ state }: { state: GuestState | null }) {
	const { _ } = useLingui()
	return (
		<div className="relative flex min-h-0 flex-1 items-center justify-center">
			{state?.idleImageUrl ? (
				<img
					src={state.idleImageUrl}
					alt=""
					data-guest-idle-image
					className="absolute inset-0 size-full object-cover"
				/>
			) : (
				<div className="p-8 text-center">
					<p className="text-4xl font-semibold">
						{state?.businessName || _(t`Welcome`)}
					</p>
					{state?.businessName ? (
						<p className="text-muted-foreground mt-2 text-xl">
							<Trans>Welcome</Trans>
						</p>
					) : null}
				</div>
			)}
			<FullscreenButton />
		</div>
	)
}

function FullscreenButton() {
	const { _ } = useLingui()
	const [on, setOn] = useState(false)
	useEffect(() => {
		const change = () => setOn(Boolean(document.fullscreenElement))
		document.addEventListener('fullscreenchange', change)
		return () => document.removeEventListener('fullscreenchange', change)
	}, [])
	return (
		<button
			type="button"
			aria-label={on ? _(t`Leave full screen`) : _(t`Full screen`)}
			onClick={() =>
				void (on
					? document.exitFullscreen()
					: document.documentElement.requestFullscreen())
			}
			className="text-muted-foreground/60 hover:text-foreground absolute end-3 top-3 rounded-md p-2"
		>
			<Icon name={on ? 'minimize' : 'maximize'} className="size-5" />
		</button>
	)
}

function Order({
	state,
	send,
}: {
	state: GuestState
	send: (message: GuestMessage) => void
}) {
	const { _, i18n } = useLingui()
	const money = useMemo(
		() => moneyFormatter(state.currency, i18n.locale),
		[state.currency, i18n.locale],
	)
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-guest-order>
			<header className="border-border relative flex shrink-0 items-center justify-between border-b px-6 py-4">
				<h1 className="text-2xl font-semibold">{state.businessName}</h1>
				<span className="text-muted-foreground text-xl">
					{state.view === 'checkout' ? (
						<Trans>Your total</Trans>
					) : (
						<Trans>Your order</Trans>
					)}
				</span>
				<FullscreenButton />
			</header>
			<ul
				className="min-h-0 flex-1 divide-y overflow-y-auto px-6"
				data-guest-lines
			>
				{state.lines.map((line) => (
					<li key={line.id} className="flex items-start gap-4 py-3">
						<span className="tnum w-10 shrink-0 text-xl font-semibold">
							{line.quantity}×
						</span>
						<span className="min-w-0 flex-1">
							<span className="block text-xl wrap-anywhere">{line.name}</span>
							{line.detail ? (
								<span className="text-muted-foreground block text-base wrap-anywhere">
									{line.detail}
								</span>
							) : null}
						</span>
						<span className="tnum shrink-0 text-xl">
							{money(line.totalCents)}
						</span>
					</li>
				))}
			</ul>
			<div className="border-border bg-card shrink-0 space-y-4 border-t px-6 py-4">
				{state.view === 'checkout' && state.tip ? (
					<section aria-label={_(t`Tip`)} data-guest-tip>
						<p className="mb-2 text-xl font-semibold">
							<Trans>Add a tip?</Trans>
						</p>
						<div className="grid grid-cols-4 gap-3">
							{state.tip.choices.map((percent) => (
								<Chip
									key={percent}
									look="outlined"
									size="lg"
									selected={state.tip!.selected === percent}
									aria-pressed={state.tip!.selected === percent}
									onClick={() => send({ type: 'tip', percent })}
									className="tabular-nums"
								>
									{percent === 0 ? <Trans>No tip</Trans> : `${percent}%`}
								</Chip>
							))}
						</div>
					</section>
				) : null}
				<Loyalty loyalty={state.loyalty} send={send} />
				<dl className="tnum space-y-1 text-xl">
					<Line label={_(t`Subtotal`)} value={money(state.subtotalCents)} />
					{state.discountCents > 0 ? (
						<Line
							label={_(t`Discount`)}
							value={`−${money(state.discountCents)}`}
						/>
					) : null}
					{state.taxCents > 0 ? (
						<Line
							label={state.taxInclusive ? _(t`VAT included`) : _(t`Tax`)}
							value={money(state.taxCents)}
						/>
					) : null}
					{state.tipCents > 0 ? (
						<Line label={_(t`Tip`)} value={money(state.tipCents)} />
					) : null}
					<div className="flex items-baseline justify-between border-t pt-2 text-3xl font-semibold">
						<dt>
							<Trans>Total</Trans>
						</dt>
						<dd data-guest-total>{money(state.totalCents)}</dd>
					</div>
				</dl>
			</div>
		</div>
	)
}

function Line({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex justify-between gap-4">
			<dt className="text-muted-foreground">{label}</dt>
			<dd>{value}</dd>
		</div>
	)
}

/** The guest signs in for rewards with their own phone and the code texted to it. */
function Loyalty({
	loyalty,
	send,
}: {
	loyalty: GuestLoyalty | null
	send: (message: GuestMessage) => void
}) {
	const { _ } = useLingui()
	const [phone, setPhone] = useState('')
	const [code, setCode] = useState('')
	useEffect(() => {
		if (loyalty?.stage === 'invite') {
			setPhone('')
			setCode('')
		}
	}, [loyalty?.stage])
	if (!loyalty) return null
	if (loyalty.stage === 'member') {
		const name = loyalty.firstName
		const points = loyalty.points
		const unit =
			loyalty.unitLabel === 'stars'
				? _(plural(points, { one: '# star', other: '# stars' }))
				: _(plural(points, { one: '# point', other: '# points' }))
		return (
			<p
				role="status"
				data-guest-loyalty="member"
				className="bg-muted flex items-center gap-2 rounded-lg px-4 py-3 text-xl"
			>
				<Icon name="star" className="text-primary size-5" aria-hidden />
				{name
					? _(t`Welcome back, ${name}. You have ${unit}.`)
					: _(t`You have ${unit}.`)}
			</p>
		)
	}
	const message = (error: string | null | undefined) =>
		error === 'invalid_phone'
			? _(t`Check the phone number and try again.`)
			: error === 'bad_code'
				? _(t`That code did not work. Try again.`)
				: error
					? _(t`Something went wrong. Try again.`)
					: null
	if (loyalty.stage === 'busy')
		return (
			<p role="status" className="text-muted-foreground text-xl">
				<Trans>One moment…</Trans>
			</p>
		)
	if (loyalty.stage === 'invite')
		return (
			<Button
				variant="outline"
				className="w-full justify-start"
				data-guest-loyalty="invite"
				onClick={() => send({ type: 'loyalty-start' })}
			>
				<Icon name="star" className="size-5" aria-hidden />
				<Trans>Earn rewards: sign in with your phone</Trans>
			</Button>
		)
	if (loyalty.stage === 'code')
		return (
			<form
				data-guest-loyalty="code"
				className="space-y-2"
				onSubmit={(event) => {
					event.preventDefault()
					const digits = foldCodeInput(code)
					if (digits) send({ type: 'loyalty-code', code: digits })
				}}
			>
				<label className="block text-xl font-semibold">
					<Trans>Enter the code we texted to {loyalty.maskedPhone}</Trans>
					<Input
						inputMode="numeric"
						autoComplete="one-time-code"
						dir="ltr"
						value={code}
						onChange={(e) => setCode(e.target.value)}
						className="mt-2"
					/>
				</label>
				{message(loyalty.error) ? (
					<p role="alert" className="text-destructive">
						{message(loyalty.error)}
					</p>
				) : null}
				<div className="flex gap-3">
					<Button
						type="submit"
						variant="primary"
						disabled={!foldCodeInput(code)}
					>
						<Trans>Confirm</Trans>
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() => send({ type: 'loyalty-reset' })}
					>
						<Trans>Cancel</Trans>
					</Button>
				</div>
			</form>
		)
	return (
		<form
			data-guest-loyalty="phone"
			className="space-y-2"
			onSubmit={(event) => {
				event.preventDefault()
				const digits = foldPhoneInput(phone)
				if (digits) send({ type: 'loyalty-phone', phone: digits })
			}}
		>
			<label className="block text-xl font-semibold">
				<Trans>Your mobile number</Trans>
				<Input
					type="tel"
					inputMode="tel"
					autoComplete="tel"
					dir="ltr"
					value={phone}
					onChange={(e) => setPhone(e.target.value)}
					className={cn('mt-2')}
				/>
			</label>
			{message('error' in loyalty ? loyalty.error : null) ? (
				<p role="alert" className="text-destructive">
					{message('error' in loyalty ? loyalty.error : null)}
				</p>
			) : null}
			<div className="flex gap-3">
				<Button
					type="submit"
					variant="primary"
					disabled={!foldPhoneInput(phone)}
				>
					<Trans>Send code</Trans>
				</Button>
				<Button
					type="button"
					variant="outline"
					onClick={() => send({ type: 'loyalty-reset' })}
				>
					<Trans>Cancel</Trans>
				</Button>
			</div>
		</form>
	)
}

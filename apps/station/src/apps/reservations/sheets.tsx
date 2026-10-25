import { type MessageDescriptor } from '@lingui/core'
import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type Phone } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type StatusTarget } from './api.ts'
import { keepOpenTime } from './booking.ts'
import { type Availability, type DayReservation } from './feed.ts'
import { foldDigits } from './phone.ts'
import { serverTime } from './zoned.ts'
import { Button, Chip, cn, Modal } from '~/ui/primitives.tsx'

export const STATUS_LABEL: Record<string, MessageDescriptor> = {
	booked: msg`Booked`,
	confirmed: msg`Confirmed`,
	partially_arrived: msg`Partly here`,
	arrived: msg`At the stand`,
	partially_seated: msg`Partly seated`,
	seated: msg`Seated`,
	finished: msg`Finished`,
	cancelled: msg`Cancelled`,
	no_show: msg`No-show`,
	requested: msg`Request`,
	pending_payment: msg`Awaiting payment`,
}

/** One equal column per button in a row of actions. */
export const EQUAL_COLUMNS: Record<number, string> = {
	1: 'grid-cols-1',
	2: 'grid-cols-2',
	3: 'grid-cols-3',
}

/** What a sheet asks the host stand to do; the stand runs it and reports back. */
export type PartyCommand =
	| {
			kind: 'status'
			to: StatusTarget
			reason?: string
			/** The version the host saw when they decided (an armed confirm). */
			expectedVersion?: number
	  }
	/** The guest called to say they are late (0 clears it). */
	| { kind: 'late'; minutes: number }
	/** Open the change sheet: the party's size or time. */
	| { kind: 'change' }
	/** Move a seated party to another table (the floor asks which). */
	| { kind: 'move' }
	/** Lengthen a seated party's stay by a step (15 minutes). */
	| { kind: 'extend' }
	| { kind: 'undo' }
	| { kind: 'place' }
	/** Seat them at the table they are booked at (one tap, no choosing). */
	| { kind: 'seatAt'; tableId: string }
	/** Start a new booking for the same guest: their name, number and party size. */
	| { kind: 'again' }

/**
 * Party size as big targets: 1 to 8 one tap away, and "9+" for a larger party,
 * which brings in a stepper. One control at a time, never chips and a stepper side by side.
 */
export function PartySize({
	value,
	onChange,
	max = 99,
}: {
	value: number
	onChange: (size: number) => void
	/** The most this party can be (a seated party at a table that seats so many). */
	max?: number
}) {
	const { _ } = useLingui()
	const large = value > 8
	return (
		<div
			role="group"
			aria-label={_(msg`Party size`)}
			className="flex flex-wrap items-center gap-2"
		>
			{[1, 2, 3, 4, 5, 6, 7, 8].map((size) => (
				<Chip
					key={size}
					size="lg"
					selected={value === size}
					aria-pressed={value === size}
					disabled={size > max}
					onClick={() => onChange(size)}
					className="tnum w-11 px-0"
				>
					{size}
				</Chip>
			))}
			<Chip
				size="lg"
				selected={large}
				aria-pressed={large}
				disabled={max < 9}
				onClick={() => onChange(Math.max(value, 9))}
				className="tnum w-12 px-0"
			>
				{/* "9+" keeps its order right to left. */}
				<span dir="ltr">9+</span>
			</Chip>
			{large ? (
				<div className="border-border bg-card flex h-12 items-center rounded-xl border">
					<button
						type="button"
						aria-label={_(msg`One fewer`)}
						onClick={() => onChange(Math.max(1, value - 1))}
						className="hover:bg-accent h-full w-11 rounded-s-xl text-lg font-semibold"
					>
						−
					</button>
					<span className="tnum mono w-10 text-center text-lg font-semibold">
						{value}
					</span>
					<button
						type="button"
						aria-label={_(msg`One more`)}
						onClick={() => onChange(Math.min(max, 99, value + 1))}
						className="hover:bg-accent h-full w-11 rounded-e-xl text-lg font-semibold"
					>
						+
					</button>
				</div>
			) : null}
		</div>
	)
}

export function Detail({
	icon: Icon,
	children,
	tone,
}: {
	icon: typeof Phone
	children: React.ReactNode
	tone?: 'warning'
}) {
	return (
		<p
			className={cn(
				'flex items-start gap-3 text-base',
				tone === 'warning' && 'text-warning font-medium',
			)}
		>
			<Icon className="text-muted-foreground mt-0.5 size-5 shrink-0" />
			<span className="min-w-0 break-words">{children}</span>
		</p>
	)
}

/**
 * A step that cannot be undone from the stand takes two taps: the first arms
 * it (the label says what the next tap does), and it disarms by itself. At
 * rest it is an outline in the destructive colour, so it is never the
 * button a thumb lands on by habit.
 */
export function ConfirmButton({
	label,
	confirmLabel,
	busy,
	onConfirm,
	token,
	className,
}: {
	label: string
	confirmLabel: string
	busy: boolean
	/** Gets the `token` the first tap armed (what the host decided about). */
	onConfirm: (armedToken: string | number | undefined) => void
	/**
	 * What is being decided about, as it stands (a version): it is captured when
	 * the first tap arms the button, and arming ends if it changes meanwhile,
	 * so the second tap never confirms something that is no longer what was seen.
	 */
	token?: string | number
	className?: string
}) {
	const [armed, setArmed] = useState<{
		token: string | number | undefined
	} | null>(null)
	useEffect(() => {
		if (!armed) return
		const timer = window.setTimeout(() => setArmed(null), 4000)
		return () => window.clearTimeout(timer)
	}, [armed])
	// Changed since it was armed: the decision was about something else.
	useEffect(() => {
		if (armed && armed.token !== token) setArmed(null)
	}, [armed, token])
	return (
		<Button
			variant={armed ? 'danger' : 'outline'}
			size="lg"
			className={cn(
				!armed &&
					'border-destructive/40 text-destructive hover:bg-destructive/10',
				className,
			)}
			disabled={busy}
			onClick={() => {
				if (!armed) return setArmed({ token })
				const decided = armed.token
				setArmed(null)
				onConfirm(decided)
			}}
		>
			{armed ? confirmLabel : label}
		</Button>
	)
}

/**
 * "We're six now", "can we make it 8:00": a booking's size or time, the only
 * things a till changes on it. Times come from availability for the new size;
 * keeping the time is the default.
 */
export function ChangePartySheet({
	reservation,
	seated = false,
	maxSize = null,
	busy,
	date,
	loadSlots,
	formatTime,
	onSave,
	onClose,
}: {
	reservation: DayReservation | null
	/**
	 * They are at the table already: only the size changes ("we're six now"),
	 * with no times to choose from.
	 */
	seated?: boolean
	/** The most the party can be: what the tables they sit at seat (null: not known). */
	maxSize?: number | null
	busy: boolean
	/** The day the booking is on (the stand shows one day). */
	date: string
	loadSlots: (date: string, partySize: number) => Promise<Availability>
	formatTime: (epochMs: number) => string
	onSave: (change: {
		partySize?: number
		time?: string
		/** The new time as minutes after the day's midnight (past 1440 after midnight). */
		localStartMin?: number
		/** The new time as the stand shows it, for the toast. */
		timeLabel?: string
	}) => void
	onClose: () => void
}) {
	const { _, i18n } = useLingui()
	const r = reservation
	const [size, setSize] = useState(r?.partySize ?? 2)
	const [time, setTime] = useState<{ min: number; label: string } | null>(null)
	const [slots, setSlots] = useState<Availability['slots'] | null>(null)
	const id = r?.id ?? null
	useEffect(() => {
		if (!r) return
		setSize(r.partySize)
		setTime(null)
		// eslint-disable-next-line react-hooks/exhaustive-deps -- reset per booking only
	}, [id])
	useEffect(() => {
		if (!id || seated) return
		let live = true
		setSlots(null)
		loadSlots(date, size).then(
			(result) => {
				if (!live) return
				const list = result.closed ? [] : result.slots
				setSlots(list)
				// A time chosen for the old size stays only if the new size still has room then.
				setTime((chosen) =>
					chosen && keepOpenTime(chosen.min, list) !== null ? chosen : null,
				)
			},
			() => {
				if (!live) return
				setSlots([])
				setTime(null)
			},
		)
		return () => {
			live = false
		}
	}, [id, date, size, loadSlots, seated])
	const slotLabel = useMemo(() => {
		const format = new Intl.DateTimeFormat(i18n.locale, {
			hour: 'numeric',
			minute: '2-digit',
			timeZone: 'UTC',
		})
		return (minutes: number) =>
			format.format(Date.UTC(2000, 0, 1, 0, minutes % 1440))
	}, [i18n.locale])
	const current = r ? formatTime(r.startAt) : ''
	const changed = r !== null && (size !== r.partySize || time !== null)
	// Slots are told apart by their minute, not their clock string: that wraps at midnight.
	const open_ = (slots ?? []).filter(
		(slot) => slot.available && slot.localStartMin !== r?.localStartMin,
	)
	return (
		<Modal
			open={r !== null}
			onClose={onClose}
			size="lg"
			title={seated ? _(msg`Change party size`) : _(msg`Change size or time`)}
			footer={
				r ? (
					<div className="mb-safe">
						<Button
							variant="primary"
							size="lg"
							className="w-full"
							// Not while the times for this size are still on their way.
							disabled={!changed || busy || (!seated && slots === null)}
							onClick={() =>
								onSave({
									...(size !== r.partySize ? { partySize: size } : {}),
									...(time
										? {
												time: serverTime(time.min),
												localStartMin: time.min,
												timeLabel: time.label,
											}
										: {}),
								})
							}
						>
							<Trans>Save</Trans>
						</Button>
					</div>
				) : null
			}
		>
			{r ? (
				<div className="flex flex-col gap-6 p-4 sm:p-5">
					<div className="flex flex-col gap-2">
						<span className="font-semibold">
							<Trans>Party size</Trans>
						</span>
						<PartySize
							value={size}
							onChange={setSize}
							max={maxSize ?? undefined}
						/>
						{seated && maxSize !== null ? (
							<p className="text-muted-foreground text-sm">
								<Trans>
									Their table seats {maxSize}. For more, move them to a bigger
									table first.
								</Trans>
							</p>
						) : null}
					</div>
					{seated ? null : (
						<div className="flex flex-col gap-2">
							<span className="font-semibold">
								<Trans>Time</Trans>
							</span>
							<div className="flex flex-wrap gap-2">
								<Chip
									selected={time === null}
									aria-pressed={time === null}
									onClick={() => setTime(null)}
									className="tnum"
								>
									<Trans>Keep {current}</Trans>
								</Chip>
								{slots === null ? (
									<span className="t-shimmer self-center text-sm">
										<Trans>Finding times…</Trans>
									</span>
								) : open_.length === 0 ? (
									<span className="text-muted-foreground self-center text-sm">
										<Trans>No times left for {size} on this day.</Trans>
									</span>
								) : (
									open_.map((slot) => (
										<Chip
											key={slot.localStartMin}
											selected={time?.min === slot.localStartMin}
											aria-pressed={time?.min === slot.localStartMin}
											onClick={() =>
												setTime({
													min: slot.localStartMin,
													label: slotLabel(slot.localStartMin),
												})
											}
											className="tnum min-w-20"
										>
											{slotLabel(slot.localStartMin)}
										</Chip>
									))
								)}
							</div>
						</div>
					)}
				</div>
			) : null}
		</Modal>
	)
}

type PartOfDay = 'morning' | 'afternoon' | 'evening' | 'night'

export const PART_OF_DAY: Record<PartOfDay, MessageDescriptor> = {
	morning: msg`Morning`,
	afternoon: msg`Afternoon`,
	evening: msg`Evening`,
	night: msg`After midnight`,
}

/** Slots in the order of the day, under morning, afternoon and evening. */
export function groupSlots<T extends { localStartMin: number }>(slots: T[]) {
	// Past 1440 it is still this business day, but after midnight on the wall.
	const part = (minutes: number): PartOfDay =>
		minutes >= 1440
			? 'night'
			: minutes < 12 * 60
				? 'morning'
				: minutes < 17 * 60
					? 'afternoon'
					: 'evening'
	const groups: Array<{ part: PartOfDay; slots: T[] }> = []
	for (const slot of slots) {
		const p = part(slot.localStartMin)
		const last = groups[groups.length - 1]
		if (last?.part === p) last.slots.push(slot)
		else groups.push({ part: p, slots: [slot] })
	}
	return groups
}

/** A number the server can text: 8 to 15 digits, with the country code. */
export function looksLikePhone(value: string) {
	// Digits from an Arabic keyboard count as the digits they are.
	const trimmed = foldDigits(value).trim()
	if (!/^\+?[\d\s().-]+$/.test(trimmed)) return false
	const digits = trimmed.replace(/\D/g, '').length
	return digits >= 8 && digits <= 15
}

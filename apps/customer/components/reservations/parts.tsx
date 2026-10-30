import { Icon } from '../ui/icon'
import { useLingui } from '@lingui/react/macro'
import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { BackHandler, Pressable, ScrollView, View } from 'react-native'
import { useAppSnapshot } from '../../lib/app/use-app'
import { type BookingFailure } from '../../lib/reservations/booking-flow'
import {
	dateLabel,
	dayNumber,
	failureMessageKey,
	ltr,
	money,
	type ReservationMessageKey,
	reservationStatusKey,
	shortWeekday,
} from '../../lib/reservations/format'
import {
	renderReservationMessage,
	type ReservationMessageValues,
} from '../../lib/reservations/messages'
import {
	type ReservationPolicy,
	type ReservationSlot,
} from '../../lib/reservations/models'
import { useThemePalette } from '../../lib/theme/use-theme-palette'
import { Badge, Card, Checkbox, Chip, Stepper, Text } from '../ui'

/** The reservation messages in the active language. */
export function useReservationText() {
	const { i18n } = useLingui()
	const m = useCallback(
		(key: ReservationMessageKey, values?: ReservationMessageValues) =>
			renderReservationMessage(i18n, key, values),
		[i18n],
	)
	return { i18n, m, locale: i18n.locale }
}

/** "Mon, Jun 24 · 19:00", the time kept left to right. */
export function whenLabel(date: string, time: string, locale: string): string {
	return `${dateLabel(date, locale)} \u00B7 ${ltr(time)}`
}

/** A chevron pointing back or forward in the reading direction. */
export function Chevron({
	direction,
	size = 24,
}: {
	direction: 'back' | 'forward'
	size?: number
}) {
	const { language } = useAppSnapshot()
	const palette = useThemePalette()
	const pointsLeft = (direction === 'back') !== language.isRtl
	return (
		<Icon
			name={pointsLeft ? 'chevron-back' : 'chevron-forward'}
			size={size}
			color={
				direction === 'back' ? palette.foreground : palette.mutedForeground
			}
		/>
	)
}

/**
 * The title row the stack's hidden native header leaves to each screen, with
 * a back button whose arrow follows the reading direction.
 */
export function ScreenHeader({
	title,
	onBack,
}: {
	title: string
	onBack?: () => void
}) {
	const { t } = useLingui()
	return (
		<View className="flex-row items-center gap-2 py-4">
			{onBack ? (
				<Pressable
					accessibilityRole="button"
					accessibilityLabel={t`Back`}
					onPress={onBack}
					hitSlop={8}
					className="h-11 w-11 items-center justify-center rounded-full"
				>
					<Chevron direction="back" />
				</Pressable>
			) : null}
			<Text variant="heading" accessibilityRole="header" className="flex-1">
				{title}
			</Text>
		</View>
	)
}

/**
 * While `active`, the Android back button runs `onBack` instead of popping
 * the screen (`onBack` returning nothing blocks it). iOS has no back button;
 * the stack turns its swipe off for these screens.
 */
export function useHardwareBack(active: boolean, onBack: () => void) {
	const latest = useRef(onBack)
	latest.current = onBack
	useEffect(() => {
		if (!active) return
		const subscription = BackHandler.addEventListener(
			'hardwareBackPress',
			() => {
				latest.current()
				return true
			},
		)
		return () => subscription.remove()
	}, [active])
}

/** "We're holding your table for 6:42": a countdown on the server's clock. */ export function CountdownBanner({
	text,
	urgent,
}: {
	text: string
	urgent: boolean
}) {
	return (
		<Card className="bg-muted">
			<Text variant={urgent ? 'error' : 'label'}>{text}</Text>
		</Card>
	)
}

export function StatusBadge({ status }: { status: string }) {
	const { m } = useReservationText()
	return <Badge>{m(reservationStatusKey(status))}</Badge>
}

/** A label and its value on one line, read as one element. */
export function DetailRow({ label, value }: { label: string; value: string }) {
	return (
		<View className="flex-row items-start justify-between gap-3" accessible>
			<Text variant="muted">{label}</Text>
			<Text variant="label" className="shrink">
				{value}
			</Text>
		</View>
	)
}

/** A failure in words, announced when it appears. */
export function FailureText({ failure }: { failure: BookingFailure }) {
	const { m } = useReservationText()
	return (
		<Text
			variant="error"
			accessibilityLiveRegion="polite"
			accessibilityRole="alert"
		>
			{m(failureMessageKey(failure))}
		</Text>
	)
}

/** A titled card. */
export function Section({
	title,
	children,
}: {
	title?: string
	children: ReactNode
}) {
	return (
		<Card className="gap-3">
			{title ? (
				<Text variant="label" accessibilityRole="header">
					{title}
				</Text>
			) : null}
			{children}
		</Card>
	)
}

export function PartyStepper({
	value,
	min,
	max,
	onChange,
}: {
	value: number
	min: number
	max: number
	onChange: (value: number) => void
}) {
	const { t } = useLingui()
	const { m } = useReservationText()
	return (
		<Stepper
			label={m('rsv.search.party')}
			value={value}
			valueText={m('rsv.search.partyCount', { count: value })}
			min={min}
			max={max}
			decrementLabel={t`Fewer guests`}
			incrementLabel={t`More guests`}
			onChange={onChange}
		/>
	)
}

/** The days the guest can pick, as a horizontal row of chips. */
export function DateStrip({
	days,
	selected,
	onSelect,
}: {
	days: readonly string[]
	selected: string
	onSelect: (day: string) => void
}) {
	const { locale } = useReservationText()
	return (
		<ScrollView horizontal showsHorizontalScrollIndicator={false}>
			<View className="flex-row gap-2 py-0.5" accessibilityRole="radiogroup">
				{days.map((day) => (
					<Chip
						key={day}
						role="radio"
						label={dayNumber(day)}
						sublabel={shortWeekday(day, locale)}
						accessibilityLabel={dateLabel(day, locale)}
						selected={day === selected}
						onPress={() => onSelect(day)}
					/>
				))}
			</View>
		</ScrollView>
	)
}

/** Times as chips that wrap. */
export function TimeChips({
	slots,
	disabled,
	onChoose,
}: {
	slots: readonly ReservationSlot[]
	disabled: boolean
	onChoose: (slot: ReservationSlot) => void
}) {
	return (
		<View className="flex-row flex-wrap gap-2">
			{slots.map((slot) => (
				<Chip
					key={`${slot.localMin}-${slot.serviceId ?? ''}-${slot.areaId ?? ''}`}
					label={ltr(slot.time)}
					accessibilityLabel={slot.time}
					disabled={disabled}
					onPress={() => onChoose(slot)}
				/>
			))}
		</View>
	)
}

/** One choice out of a short list (occasion, seating area), with a "none" option first. */
export function ChoiceChips({
	label,
	options,
	noneLabel,
	selected,
	onSelect,
}: {
	label: string
	options: ReadonlyArray<{ id: string; name: string }>
	noneLabel: string
	selected: string | null
	onSelect: (id: string | null) => void
}) {
	return (
		<View className="gap-2">
			<Text variant="label" nativeID={`choice-${label}`}>
				{label}
			</Text>
			<View
				className="flex-row flex-wrap gap-2"
				accessibilityRole="radiogroup"
				accessibilityLabelledBy={`choice-${label}`}
			>
				<Chip
					role="radio"
					label={noneLabel}
					selected={selected === null}
					onPress={() => onSelect(null)}
				/>
				{options.map((option) => (
					<Chip
						key={option.id}
						role="radio"
						label={option.name}
						selected={selected === option.id}
						onPress={() => onSelect(option.id)}
					/>
				))}
			</View>
		</View>
	)
}

/** What the guest owes, the cancellation terms and, when asked for, the consent box. */
export function PolicyPanel({
	policy,
	consent,
}: {
	policy: ReservationPolicy
	consent?: { checked: boolean; onChange: (checked: boolean) => void }
}) {
	const { m, locale } = useReservationText()
	const amount = (minor: number) => ltr(money(minor, policy.currency, locale))
	return (
		<Card className="gap-2.5">
			<Text>
				{policy.purpose === 'guarantee'
					? m('rsv.policy.guarantee')
					: m('rsv.policy.deposit', {
							amount: amount(policy.totalAmountMinor),
						})}
			</Text>
			{policy.freeCancelUntilMin >= 60 ? (
				<Text variant="muted">
					{m('rsv.policy.freeCancelHours', {
						count: Math.floor(policy.freeCancelUntilMin / 60),
					})}
				</Text>
			) : null}
			{policy.lateCancelFeeMinor > 0 ? (
				<Text variant="muted">
					{m('rsv.policy.lateFee', {
						amount: amount(policy.lateCancelFeeMinor),
					})}
				</Text>
			) : null}
			{policy.noShowFeeMinor > 0 ? (
				<Text variant="muted">
					{m('rsv.policy.noShowFee', { amount: amount(policy.noShowFeeMinor) })}
				</Text>
			) : null}
			{policy.terms ? <Text variant="caption">{policy.terms}</Text> : null}
			{consent ? (
				<Checkbox
					checked={consent.checked}
					onChange={consent.onChange}
					label={m('rsv.policy.consent')}
				/>
			) : null}
		</Card>
	)
}

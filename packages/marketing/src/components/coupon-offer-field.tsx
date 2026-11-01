import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useId, useState } from 'react'

/** A discount customers apply with a code, as the coupon picker lists it. */
export type CouponDiscountOption = {
	id: string
	name: string
	/** Its own codes, as typed. Empty when it only takes marketing codes. */
	codes: string[]
}

/**
 * The coupon a message carries. Mirrors `marketingOfferSchema` in
 * `@repo/discounts`, which the server checks it against.
 */
export type CouponOfferValue =
	| { mode: 'shared'; discountId: string; code: string }
	| { mode: 'unique'; discountId: string; prefix: string; validDays: number }

export const COUPON_VALID_DAYS_DEFAULT = 30
export const COUPON_VALID_DAYS_MIN = 1
export const COUPON_VALID_DAYS_MAX = 365

/**
 * The days a single-use code stays valid, from what was typed: a whole number
 * clamped to 1-365, or null when nothing usable was typed (the field then
 * keeps the last good value).
 */
export function parseCouponValidDays(text: string): number | null {
	const days = Number.parseInt(text.trim(), 10)
	if (!Number.isFinite(days)) return null
	return Math.min(COUPON_VALID_DAYS_MAX, Math.max(COUPON_VALID_DAYS_MIN, days))
}
/** Passed as a value: Lingui reads literal braces as a placeholder. */
const TAG = '{{couponCode}}'
const UNIQUE = '__unique__'
const NONE = '__none__'

export interface CouponOfferFieldProps {
	options: CouponDiscountOption[]
	value: CouponOfferValue | null
	onChange: (value: CouponOfferValue | null) => void
	/** Renders a hidden input with the value as JSON, for plain form posts. */
	name?: string
	/** Smaller controls for the automation inspector. */
	compact?: boolean
}

export function CouponOfferField({
	options,
	value,
	onChange,
	name,
	compact = false,
}: CouponOfferFieldProps) {
	const { _ } = useLingui()
	const id = useId()
	const selected = value
		? (options.find((option) => option.id === value.discountId) ?? null)
		: null
	const labelClass = compact ? 'text-xs font-medium' : undefined
	const hintClass = compact
		? 'text-muted-foreground text-[11px]'
		: 'text-muted-foreground text-xs'
	const triggerClass = compact ? 'h-11 w-full' : 'w-full'

	const hidden = name ? (
		<input
			type="hidden"
			name={name}
			value={value ? JSON.stringify(value) : ''}
		/>
	) : null

	if (options.length === 0 && !value) {
		// Nothing to choose, so no control for a label to name: a plain heading.
		return (
			<div className="space-y-1.5">
				<p className={labelClass ?? 'text-sm leading-none font-medium'}>
					{_(msg`Coupon`)}
				</p>
				<p className={hintClass}>
					{_(
						msg`To send a coupon, first create a discount that customers apply with a code.`,
					)}
				</p>
				{hidden}
			</div>
		)
	}

	function chooseDiscount(discountId: string) {
		if (discountId === NONE) {
			onChange(null)
			return
		}
		onChange({
			mode: 'unique',
			discountId,
			prefix: value?.mode === 'unique' ? value.prefix : '',
			validDays:
				value?.mode === 'unique' ? value.validDays : COUPON_VALID_DAYS_DEFAULT,
		})
	}

	function chooseCode(choice: string) {
		if (!value) return
		if (choice === UNIQUE) {
			onChange({
				mode: 'unique',
				discountId: value.discountId,
				prefix: '',
				validDays: COUPON_VALID_DAYS_DEFAULT,
			})
		} else {
			onChange({ mode: 'shared', discountId: value.discountId, code: choice })
		}
	}

	const codeChoice = value?.mode === 'shared' ? value.code : UNIQUE
	const everyoneGets = (code: string) => _(msg`Everyone gets ${code}`)

	return (
		<div className="space-y-3">
			<div className="space-y-1.5">
				<Label htmlFor={`${id}-discount`} className={labelClass}>
					{_(msg`Coupon`)}
				</Label>
				<Select
					value={value?.discountId ?? NONE}
					onValueChange={(next) => chooseDiscount(String(next))}
				>
					<SelectTrigger id={`${id}-discount`} className={triggerClass}>
						<SelectValue>
							{value
								? (selected?.name ?? _(msg`Discount no longer available`))
								: _(msg`No coupon`)}
						</SelectValue>
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NONE}>{_(msg`No coupon`)}</SelectItem>
						{options.map((option) => (
							<SelectItem key={option.id} value={option.id}>
								{option.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>

			{value ? (
				<>
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-code`} className={labelClass}>
							{_(msg`Code`)}
						</Label>
						<Select
							value={codeChoice}
							onValueChange={(next) => chooseCode(String(next))}
						>
							<SelectTrigger id={`${id}-code`} className={triggerClass}>
								<SelectValue>
									{codeChoice === UNIQUE
										? _(msg`A unique code for each customer`)
										: everyoneGets(codeChoice)}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={UNIQUE}>
									{_(msg`A unique code for each customer`)}
								</SelectItem>
								{(selected?.codes ?? []).map((code) => (
									<SelectItem key={code} value={code}>
										{everyoneGets(code)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{value.mode === 'unique' ? (
						<div className="grid grid-cols-2 gap-3">
							<div className="space-y-1.5">
								<Label htmlFor={`${id}-prefix`} className={labelClass}>
									{_(msg`Prefix (optional)`)}
								</Label>
								<Input
									id={`${id}-prefix`}
									value={value.prefix}
									maxLength={12}
									placeholder={_(msg`WELCOME`)}
									autoComplete="off"
									spellCheck={false}
									onChange={(event) =>
										onChange({
											...value,
											prefix: event.target.value
												.toUpperCase()
												.replace(/[^A-Z0-9]/g, '')
												.slice(0, 12),
										})
									}
								/>
							</div>
							<ValidDaysInput
								id={`${id}-days`}
								labelClass={labelClass}
								hintClass={hintClass}
								days={value.validDays}
								onDaysChange={(validDays) => onChange({ ...value, validDays })}
							/>
						</div>
					) : null}

					<p className={hintClass}>
						{value.mode === 'unique'
							? _(
									msg`Put ${TAG} in your message where the code should go. Each customer gets their own code. It works once and expires after the days you set.`,
								)
							: _(
									msg`Put ${TAG} in your message where the code should go. The code follows the discount's own limits.`,
								)}
					</p>
				</>
			) : null}
			{hidden}
		</div>
	)
}

/**
 * The days field keeps what is typed, so it can be cleared and retyped. A
 * usable number is passed on as it is typed; leaving the field clamps it to
 * 1-365, or puts back the last good value when it was left empty.
 */
function ValidDaysInput({
	id,
	labelClass,
	hintClass,
	days,
	onDaysChange,
}: {
	id: string
	labelClass: string | undefined
	hintClass: string
	days: number
	onDaysChange: (days: number) => void
}) {
	const { _ } = useLingui()
	const [draft, setDraft] = useState(() => String(days))
	const [shown, setShown] = useState(days)
	// A new value from outside (another discount chosen) replaces the draft.
	if (shown !== days) {
		setShown(days)
		if (parseCouponValidDays(draft) !== days) setDraft(String(days))
	}
	const hintId = `${id}-hint`
	const min = COUPON_VALID_DAYS_MIN
	const max = COUPON_VALID_DAYS_MAX
	return (
		<div className="space-y-1.5">
			<Label htmlFor={id} className={labelClass}>
				{_(msg`Valid for (days)`)}
			</Label>
			<Input
				id={id}
				type="number"
				inputMode="numeric"
				min={min}
				max={max}
				aria-describedby={hintId}
				value={draft}
				onChange={(event) => {
					const text = event.target.value
					setDraft(text)
					const parsed = parseCouponValidDays(text)
					if (parsed !== null && parsed !== days) onDaysChange(parsed)
				}}
				onBlur={() => {
					const parsed = parseCouponValidDays(draft) ?? days
					setDraft(String(parsed))
					if (parsed !== days) onDaysChange(parsed)
				}}
			/>
			<p id={hintId} className={hintClass}>
				{_(msg`From ${min} to ${max} days.`)}
			</p>
		</div>
	)
}

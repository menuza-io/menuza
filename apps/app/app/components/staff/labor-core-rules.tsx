import { Trans, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type LaborPolicyFields } from '@repo/staffing'
import { Badge } from '@repo/ui/badge'
import { Card } from '@repo/ui/card'
import {
	Field,
	FieldContent,
	FieldDescription,
	FieldLabel,
	FieldTitle,
} from '@repo/ui/field'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemFooter,
	ItemGroup,
	ItemMedia,
	ItemSeparator,
	ItemTitle,
} from '@repo/ui/item'
import { RadioGroup, RadioGroupItem } from '@repo/ui/radio-group'
import { Switch } from '@repo/ui/switch'
import { type ReactNode, useId } from 'react'
import { InlineNumber } from '#app/components/staff/labor-policy-fields.tsx'
import {
	hoursTextToMinutes,
	minutesToHoursText,
	WEEKLY_OVERTIME_PRESET,
	bpToMultiplierText,
	multiplierTextToBp,
} from '#app/utils/staffing/labor-policy-form.ts'
import {
	type LaborPresetChoice,
	type LaborPresetId,
} from '#app/utils/staffing/labor-presets.ts'

type Update = (patch: Partial<LaborPolicyFields>) => void

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

/**
 * "How strict do you want to be?" Picking a preset only fills the form in: it
 * is saved with the rest, and every value stays editable. A policy that matches
 * no preset is shown as Custom.
 */
export function PresetPicker({
	current,
	disabled,
	onChoose,
}: {
	current: LaborPresetChoice
	disabled: boolean
	onChoose: (id: LaborPresetId) => void
}) {
	const { _ } = useLingui()
	const options: Array<{
		id: LaborPresetId
		title: ReactNode
		text: ReactNode
		recommended?: boolean
	}> = [
		{
			id: 'starter',
			recommended: true,
			title: <Trans>Standard starter</Trans>,
			text: (
				<Trans>
					Reminders, not hard blocks. No overtime until you turn it on.
				</Trans>
			),
		},
		{
			id: 'strict',
			title: <Trans>Strict</Trans>,
			text: (
				<Trans>
					Only scheduled people clock in. Missing breaks are taken off.
				</Trans>
			),
		},
		{
			id: 'relaxed',
			title: <Trans>Relaxed</Trans>,
			text: (
				<Trans>Trust your team. Few alerts and no automatic deductions.</Trans>
			),
		},
	]
	const groupId = useId()
	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
				<h2 className="text-base font-medium">
					<Trans>How strict do you want to be?</Trans>
				</h2>
				{current === 'custom' ? (
					<Badge variant="secondary">
						<Trans>Custom: what you have now</Trans>
					</Badge>
				) : (
					<p className="text-muted-foreground text-sm">
						<Trans>Pick a starting point, then adjust anything below.</Trans>
					</p>
				)}
			</div>
			<RadioGroup
				value={current === 'custom' ? '' : current}
				onValueChange={(value) => onChoose(value as LaborPresetId)}
				disabled={disabled}
				aria-label={_(t`Starting point`)}
				className="grid-cols-1 sm:grid-cols-3"
			>
				{options.map((option) => {
					const id = `${groupId}-${option.id}`
					return (
						<FieldLabel key={option.id} htmlFor={id}>
							<Field orientation="horizontal">
								<FieldContent>
									<FieldTitle>
										{option.title}
										{option.recommended ? (
											<Badge variant="secondary">
												<Trans>Recommended</Trans>
											</Badge>
										) : null}
									</FieldTitle>
									<FieldDescription>{option.text}</FieldDescription>
								</FieldContent>
								<RadioGroupItem value={option.id} id={id} />
							</Field>
						</FieldLabel>
					)
				})}
			</RadioGroup>
		</section>
	)
}

// ---------------------------------------------------------------------------
// The four rules most people care about, written as sentences
// ---------------------------------------------------------------------------

function RuleRow({
	icon,
	title,
	hint,
	switchLabel,
	checked,
	onCheckedChange,
	children,
}: {
	icon: 'clock' | 'alert-triangle' | 'minus' | 'trending-up'
	title: ReactNode
	hint: ReactNode
	/** Present when the rule can be turned off. */
	switchLabel?: string
	checked?: boolean
	onCheckedChange?: (next: boolean) => void
	/** The numbers the rule uses, each in a `RuleNumber`. */
	children?: ReactNode
}) {
	return (
		<Item role="listitem" className="items-start">
			<ItemMedia variant="icon" aria-hidden="true" className="hidden sm:flex">
				<Icon name={icon} />
			</ItemMedia>
			<ItemContent>
				<ItemTitle>{title}</ItemTitle>
				<ItemDescription className="line-clamp-none text-pretty">
					{hint}
				</ItemDescription>
			</ItemContent>
			{switchLabel !== undefined ? (
				<ItemActions>
					<Switch
						checked={Boolean(checked)}
						onCheckedChange={(next) => onCheckedChange?.(Boolean(next))}
						aria-label={switchLabel}
					/>
				</ItemActions>
			) : null}
			{children ? (
				<ItemFooter>
					<div className="flex flex-wrap items-start gap-x-6 gap-y-3 sm:ps-7">
						{children}
					</div>
				</ItemFooter>
			) : null}
		</Item>
	)
}

/** A number box with a short label above it and its unit after it. */
function RuleNumber({
	label,
	unit,
	children,
}: {
	label: ReactNode
	unit: ReactNode
	children: ReactNode
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-muted-foreground text-xs font-medium">{label}</span>
			<div className="flex items-center gap-2">
				{children}
				<span className="text-muted-foreground text-sm">{unit}</span>
			</div>
		</div>
	)
}

/**
 * Track time, long shifts, automatic break deduction and weekly overtime as
 * plain sentences with the numbers editable in place. Everything else lives
 * under Advanced.
 */
export function CoreRules({
	policy,
	update,
	fieldError,
}: {
	policy: LaborPolicyFields
	update: Update
	fieldError: (path: string, exact?: boolean) => string | null
}) {
	const { _ } = useLingui()
	const auto = policy.breakRules.autoDeduction
	const autoShown = auto ?? { afterMinutes: 6 * 60, deductMinutes: 30 }
	const weekly = policy.weeklyOvertime
	const weeklyShown = weekly ?? WEEKLY_OVERTIME_PRESET
	// The boxes only parse; an out-of-range number still reaches the policy, so
	// the form's validation marks it, explains it and blocks the save. Only text
	// that is not a number at all is reverted on blur.
	const minutesText = (value: number) => String(value)
	const minutesFrom = (text: string) => {
		if (!/^\d+$/.test(text.trim())) return null
		const minutes = Number(text)
		return Number.isSafeInteger(minutes) ? minutes : null
	}
	const setAuto = (next: { afterMinutes: number; deductMinutes: number }) =>
		update({
			breakRules: { rules: policy.breakRules.rules, autoDeduction: next },
		})
	const longShiftError = fieldError('longShiftMinutes')
	// A deduction as long as the shift is a rule on the pair; mark the deduction.
	const deductError =
		fieldError('breakRules.autoDeduction.deductMinutes') ??
		fieldError('breakRules.autoDeduction', true)
	const autoAfterError = fieldError('breakRules.autoDeduction.afterMinutes')
	const weeklyThresholdError = fieldError('weeklyOvertime.thresholdMinutes')
	const problems = [
		...new Set(
			[
				longShiftError,
				deductError,
				autoAfterError,
				fieldError('breakRules.autoDeduction'),
				weeklyThresholdError,
				fieldError('weeklyOvertime'),
			].filter((message): message is string => message !== null),
		),
	]

	return (
		<div className="flex flex-col gap-2">
			<Card className="gap-0 py-0">
				<ItemGroup className="gap-0">
					<RuleRow
						icon="clock"
						title={<Trans>Tablets accept clock-ins</Trans>}
						switchLabel={_(t`Track time at this workplace`)}
						checked={policy.timeTrackingEnabled}
						onCheckedChange={(timeTrackingEnabled) =>
							update({ timeTrackingEnabled })
						}
						hint={
							<Trans>
								Turn this off and tablets here will not accept punches.
							</Trans>
						}
					></RuleRow>
					<ItemSeparator className="my-0" />
					<RuleRow
						icon="alert-triangle"
						title={<Trans>Flag long shifts for review</Trans>}
						hint={
							<Trans>
								Longer shifts are marked for review. They are not cut off.
							</Trans>
						}
					>
						<RuleNumber
							label={<Trans>Longer than</Trans>}
							unit={<Trans>hours</Trans>}
						>
							<InlineNumber
								label={_(t`Flag shifts longer than`)}
								value={policy.longShiftMinutes}
								onValueChange={(longShiftMinutes) =>
									update({ longShiftMinutes })
								}
								toText={minutesToHoursText}
								fromText={hoursTextToMinutes}
								error={longShiftError}
							/>
						</RuleNumber>
					</RuleRow>
					<ItemSeparator className="my-0" />
					<RuleRow
						icon="minus"
						title={<Trans>Deduct an unpaid break</Trans>}
						switchLabel={_(t`Deduct an unpaid break when none was recorded`)}
						checked={auto !== null}
						onCheckedChange={(on) =>
							update({
								breakRules: {
									rules: policy.breakRules.rules,
									autoDeduction: on
										? { afterMinutes: 6 * 60, deductMinutes: 30 }
										: null,
								},
							})
						}
						hint={
							<Trans>
								Only where nobody pressed Start break. Each deduction is marked
								on the time card.
							</Trans>
						}
					>
						<RuleNumber
							label={<Trans>Deduct</Trans>}
							unit={<Trans>minutes</Trans>}
						>
							<InlineNumber
								label={_(t`Deduct`)}
								value={autoShown.deductMinutes}
								onValueChange={(deductMinutes) =>
									setAuto({ ...autoShown, deductMinutes })
								}
								toText={minutesText}
								fromText={minutesFrom}
								inputMode="numeric"
								error={deductError}
								disabled={auto === null}
							/>
						</RuleNumber>
						<RuleNumber
							label={<Trans>On shifts longer than</Trans>}
							unit={<Trans>hours</Trans>}
						>
							<InlineNumber
								label={_(t`For shifts longer than`)}
								value={autoShown.afterMinutes}
								onValueChange={(afterMinutes) =>
									setAuto({ ...autoShown, afterMinutes })
								}
								toText={minutesToHoursText}
								fromText={hoursTextToMinutes}
								error={autoAfterError}
								disabled={auto === null}
							/>
						</RuleNumber>
					</RuleRow>
					<ItemSeparator className="my-0" />
					<RuleRow
						icon="trending-up"
						title={<Trans>Weekly overtime</Trans>}
						switchLabel={_(t`Weekly overtime`)}
						checked={weekly !== null}
						onCheckedChange={(on) =>
							update({
								weeklyOvertime: on ? { ...WEEKLY_OVERTIME_PRESET } : null,
							})
						}
						hint={
							<Trans>
								Time and a half is 1.5. Hours past the weekly limit are paid at
								this rate. Estimates, not payroll.
							</Trans>
						}
					>
						<RuleNumber
							label={<Trans>Pay rate</Trans>}
							unit={<Trans>times the normal rate</Trans>}
						>
							<InlineNumber
								label={_(t`Pay rate`)}
								value={weeklyShown.multiplierBp}
								onValueChange={(multiplierBp) =>
									update({ weeklyOvertime: { ...weeklyShown, multiplierBp } })
								}
								toText={bpToMultiplierText}
								fromText={multiplierTextToBp}
								disabled={weekly === null}
							/>
						</RuleNumber>
						<RuleNumber
							label={<Trans>After</Trans>}
							unit={<Trans>hours in a week</Trans>}
						>
							<InlineNumber
								label={_(t`After`)}
								value={weeklyShown.thresholdMinutes}
								onValueChange={(thresholdMinutes) =>
									update({
										weeklyOvertime: { ...weeklyShown, thresholdMinutes },
									})
								}
								toText={minutesToHoursText}
								fromText={hoursTextToMinutes}
								error={weeklyThresholdError}
								disabled={weekly === null}
							/>
						</RuleNumber>
					</RuleRow>
				</ItemGroup>
			</Card>
			{problems.map((message) => (
				<p key={message} role="alert" className="text-destructive text-sm">
					{message}
				</p>
			))}
		</div>
	)
}

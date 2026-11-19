import { type MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import { Trans, useLingui } from '@lingui/react/macro'
import {
	isTimeExpiryAllowedInRegion,
	LOYALTY_EXPIRY_MAX_MONTHS,
	LOYALTY_EXPIRY_MIN_MONTHS,
	LOYALTY_MAX_TIERS,
	LOYALTY_MULTIPLIER_MAX_BP,
	LOYALTY_MULTIPLIER_ONE_BP,
	LOYALTY_REFERRAL_MAX_POINTS,
	LOYALTY_TIER_GRACE_MAX_DAYS,
	LOYALTY_TIER_PERIOD_MAX_MONTHS,
	LOYALTY_TIER_PERIOD_MIN_MONTHS,
	LOYALTY_WELCOME_MAX_POINTS,
	type LoyaltyExpiryMode,
	type LoyaltyTierMetric,
} from '@repo/loyalty'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@repo/ui/card'
import { Icon } from '@repo/ui/icon'
import { Label } from '@repo/ui/label'
import { Switch } from '@repo/ui/switch'
import { SelectField, TextField } from '#app/components/staff/controls.tsx'

export type TierDraftRow = {
	id: string
	name: string
	threshold: string
	multiplier: string
}

export type ProgramExtensionErrors = {
	welcomePoints?: string
	tierPeriodMonths?: string
	tierGraceDays?: string
	tiers?: string
	tierRows?: Record<
		number,
		{ name?: string; threshold?: string; multiplier?: string }
	>
	expiryMonths?: string
	expiryMode?: string
	referrerPoints?: string
	friendPoints?: string
	friendDiscountAmount?: string
	friendDiscountPercent?: string
	friendDiscountMax?: string
	refMinOrder?: string
	refHoldDays?: string
	refMaxPerMember?: string
	refMaxPerMonth?: string
}

export type ProgramExtensionState = {
	welcomeEnabled: boolean
	welcomePoints: string
	welcomeAfterFirstOrder: boolean
	tiersEnabled: boolean
	tierMetric: LoyaltyTierMetric
	tierPeriodMonths: string
	tierGraceDays: string
	tierRows: TierDraftRow[]
	expiryMode: LoyaltyExpiryMode
	expiryMonths: string
	refEnabled: boolean
	refReferrerPoints: string
	refFriendPoints: string
	refDiscountType: 'none' | 'fixed' | 'percent'
	refDiscountAmount: string
	refDiscountPercent: string
	refDiscountMax: string
	refMinOrder: string
	refHoldDays: string
	refMaxPerMember: string
	refMaxPerMonth: string
}

function SwitchRow({
	id,
	label,
	hint,
	checked,
	disabled,
	onCheckedChange,
	testId,
}: {
	id: string
	label: React.ReactNode
	hint?: React.ReactNode
	checked: boolean
	disabled: boolean
	onCheckedChange: (checked: boolean) => void
	testId: string
}) {
	return (
		<div className="border-border flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
			<div className="flex flex-col gap-0.5">
				<Label htmlFor={id} className="cursor-pointer text-sm">
					{label}
				</Label>
				{hint ? (
					<span className="text-muted-foreground text-xs">{hint}</span>
				) : null}
			</div>
			<Switch
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={onCheckedChange}
				data-testid={testId}
			/>
		</div>
	)
}

export function WelcomeBonusCard({
	state,
	onChange,
	errors,
	unitLabelText,
	readOnly,
}: {
	state: ProgramExtensionState
	onChange: (patch: Partial<ProgramExtensionState>) => void
	errors: ProgramExtensionErrors
	unitLabelText: string
	readOnly: boolean
}) {
	const { t } = useLingui()
	return (
		<Card data-testid="loyalty-welcome-card">
			<CardHeader className="pb-2">
				<CardTitle className="text-base">
					<Trans>Welcome bonus</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Give new members a one-time {unitLabelText} bonus per verified phone
						number. Does not count toward tiers.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<SwitchRow
					id="loyalty-welcome-enabled"
					label={<Trans>Enable welcome bonus</Trans>}
					checked={state.welcomeEnabled}
					disabled={readOnly}
					onCheckedChange={(checked) => onChange({ welcomeEnabled: checked })}
					testId="loyalty-welcome-enabled"
				/>
				{state.welcomeEnabled ? (
					<div className="flex flex-col gap-4">
						<TextField
							label={<Trans>Welcome bonus amount</Trans>}
							hint={t`Up to ${LOYALTY_WELCOME_MAX_POINTS} ${unitLabelText}.`}
							id="loyalty-welcome-points"
							value={state.welcomePoints}
							onChange={(event) =>
								onChange({ welcomePoints: event.target.value })
							}
							error={errors.welcomePoints ?? null}
							disabled={readOnly}
							inputMode="numeric"
							placeholder="50"
							className="sm:max-w-52"
							data-testid="loyalty-welcome-points"
						/>
						<SwitchRow
							id="loyalty-welcome-after-order"
							label={<Trans>Wait until first paid order</Trans>}
							hint={
								<Trans>
									When enabled, the bonus grants once the member completes their
									first paid order (and reverses on full refund).
								</Trans>
							}
							checked={state.welcomeAfterFirstOrder}
							disabled={readOnly}
							onCheckedChange={(checked) =>
								onChange({ welcomeAfterFirstOrder: checked })
							}
							testId="loyalty-welcome-after-order"
						/>
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}

export function TiersCard({
	state,
	onChange,
	errors,
	readOnly,
	unitLabelText,
	currency,
}: {
	state: ProgramExtensionState
	onChange: (patch: Partial<ProgramExtensionState>) => void
	errors: ProgramExtensionErrors
	readOnly: boolean
	unitLabelText: string
	currency: string
}) {
	const { t } = useLingui()
	const updateRow = (index: number, patch: Partial<TierDraftRow>) => {
		onChange({
			tierRows: state.tierRows.map((row, idx) =>
				idx === index ? { ...row, ...patch } : row,
			),
		})
	}
	const addRow = () => {
		if (state.tierRows.length >= LOYALTY_MAX_TIERS) return
		const nextNum = state.tierRows.length + 1
		let candidate = `tier_${nextNum}`
		const taken = new Set(state.tierRows.map((r) => r.id))
		while (taken.has(candidate)) {
			candidate = `tier_${crypto.randomUUID().slice(0, 6)}`
		}
		onChange({
			tierRows: [
				...state.tierRows,
				{
					id: candidate,
					name: '',
					threshold: state.tierMetric === 'spend_minor' ? '100.00' : '500',
					multiplier: '1.25',
				},
			],
		})
	}
	const removeRow = (index: number) => {
		onChange({
			tierRows: state.tierRows.filter((_row, idx) => idx !== index),
		})
	}
	return (
		<Card data-testid="loyalty-tiers-card">
			<CardHeader className="pb-2">
				<CardTitle className="text-base">
					<Trans>Membership tiers</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Reward regulars with up to {LOYALTY_MAX_TIERS} tiers based on
						qualifying earnings. Spending points never lowers a member’s tier.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<SwitchRow
					id="loyalty-tiers-enabled"
					label={<Trans>Enable tiers</Trans>}
					checked={state.tiersEnabled}
					disabled={readOnly}
					onCheckedChange={(checked) => {
						const rows =
							checked && state.tierRows.length === 0
								? [
										{
											id: 'silver',
											name: 'Silver',
											threshold: '500',
											multiplier: '1.25',
										},
									]
								: state.tierRows
						onChange({ tiersEnabled: checked, tierRows: rows })
					}}
					testId="loyalty-tiers-enabled"
				/>
				{state.tiersEnabled ? (
					<div className="flex flex-col gap-4">
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
							<SelectField
								label={<Trans>Qualify by</Trans>}
								id="loyalty-tiers-metric"
								testId="loyalty-tiers-metric"
								options={[
									{
										value: 'qualifying_points',
										label: t`Qualifying ${unitLabelText}`,
									},
									{ value: 'spend_minor', label: t`Qualifying spend` },
								]}
								value={state.tierMetric}
								onValueChange={(next) =>
									onChange({ tierMetric: next as LoyaltyTierMetric })
								}
								disabled={readOnly}
							/>
							<TextField
								label={<Trans>Rolling period (months)</Trans>}
								hint={t`${LOYALTY_TIER_PERIOD_MIN_MONTHS}–${LOYALTY_TIER_PERIOD_MAX_MONTHS} months`}
								id="loyalty-tiers-period"
								value={state.tierPeriodMonths}
								onChange={(event) =>
									onChange({ tierPeriodMonths: event.target.value })
								}
								error={errors.tierPeriodMonths ?? null}
								disabled={readOnly}
								inputMode="numeric"
								data-testid="loyalty-tiers-period"
							/>
							<TextField
								label={<Trans>Downgrade grace (days)</Trans>}
								hint={t`0–${LOYALTY_TIER_GRACE_MAX_DAYS} days after review`}
								id="loyalty-tiers-grace"
								value={state.tierGraceDays}
								onChange={(event) =>
									onChange({ tierGraceDays: event.target.value })
								}
								error={errors.tierGraceDays ?? null}
								disabled={readOnly}
								inputMode="numeric"
								data-testid="loyalty-tiers-grace"
							/>
						</div>

						{errors.tiers ? (
							<p className="text-destructive text-xs">{errors.tiers}</p>
						) : null}

						<div className="flex flex-col gap-3">
							{state.tierRows.map((row, index) => {
								const rowErr = errors.tierRows?.[index] ?? {}
								return (
									<div
										key={row.id}
										className="border-border grid grid-cols-1 items-end gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_1fr_auto]"
										data-testid={`loyalty-tier-row-${index}`}
									>
										{(() => {
											const currencyCode = currency || 'USD'
											const maxMult = (
												LOYALTY_MULTIPLIER_MAX_BP / LOYALTY_MULTIPLIER_ONE_BP
											).toString()
											return (
												<>
													<TextField
														label={<Trans>Tier name</Trans>}
														id={`loyalty-tier-name-${index}`}
														value={row.name}
														onChange={(event) =>
															updateRow(index, { name: event.target.value })
														}
														error={rowErr.name ?? null}
														disabled={readOnly}
														maxLength={40}
														placeholder={t`Gold`}
														data-testid={`loyalty-tier-name-${index}`}
													/>
													<TextField
														label={
															state.tierMetric === 'spend_minor' ? (
																<Trans>Threshold ({currencyCode})</Trans>
															) : (
																<Trans>Threshold ({unitLabelText})</Trans>
															)
														}
														id={`loyalty-tier-threshold-${index}`}
														value={row.threshold}
														onChange={(event) =>
															updateRow(index, {
																threshold: event.target.value,
															})
														}
														error={rowErr.threshold ?? null}
														disabled={readOnly}
														inputMode={
															state.tierMetric === 'spend_minor'
																? 'decimal'
																: 'numeric'
														}
														data-testid={`loyalty-tier-threshold-${index}`}
													/>
													<TextField
														label={<Trans>Earn multiplier</Trans>}
														hint={t`1 to ${maxMult}×`}
														id={`loyalty-tier-multiplier-${index}`}
														value={row.multiplier}
														onChange={(event) =>
															updateRow(index, {
																multiplier: event.target.value,
															})
														}
														error={rowErr.multiplier ?? null}
														disabled={readOnly}
														inputMode="decimal"
														placeholder="1.5"
														data-testid={`loyalty-tier-multiplier-${index}`}
													/>
												</>
											)
										})()}
										<Button
											type="button"
											variant="ghost"
											size="icon-xs"
											aria-label={t`Remove tier`}
											disabled={readOnly || state.tierRows.length <= 1}
											onClick={() => removeRow(index)}
										>
											<Icon name="trash-2" className="size-4" />
										</Button>
									</div>
								)
							})}
						</div>

						{state.tierRows.length < LOYALTY_MAX_TIERS && !readOnly ? (
							<div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={addRow}
									data-testid="loyalty-tier-add"
								>
									<Icon name="plus" className="size-4" />
									<Trans>Add tier</Trans>
								</Button>
							</div>
						) : null}
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}

export function ExpiryCard({
	state,
	onChange,
	errors,
	readOnly,
	unitLabelText,
	currency,
	timeZone,
	locationAddresses,
}: {
	state: ProgramExtensionState
	onChange: (patch: Partial<ProgramExtensionState>) => void
	errors: ProgramExtensionErrors
	readOnly: boolean
	unitLabelText: string
	currency: string
	timeZone: string
	locationAddresses: readonly string[]
}) {
	const { t } = useLingui()
	const afterEarnCheck = isTimeExpiryAllowedInRegion({
		mode: 'after_earn',
		currency,
		timeZone,
		addresses: locationAddresses,
	})
	const afterEarnBlocked = !afterEarnCheck.allowed
	const options = [
		{ value: 'never', label: t`Never expire` },
		{
			value: 'after_inactivity',
			label: t`Expire after account inactivity`,
		},
		...(afterEarnBlocked && state.expiryMode !== 'after_earn'
			? []
			: [
					{
						value: 'after_earn',
						label: t`Expire after time earned`,
					},
				]),
	]
	return (
		<Card data-testid="loyalty-expiry-card">
			<CardHeader className="pb-2">
				<CardTitle className="text-base">
					<Trans>Points expiry</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Expire unused {unitLabelText} after inactivity or time earned.
						Members are warned 30 days and 7 days ahead.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{afterEarnBlocked ? (
					<Alert data-testid="loyalty-expiry-canada-notice">
						<Icon name="alert-triangle" />
						<AlertDescription>
							<Trans>
								Time-limited point expiry is prohibited in Canada. Inactivity
								expiry remains available.
							</Trans>
						</AlertDescription>
					</Alert>
				) : null}
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
					<SelectField
						label={<Trans>Expiry rule</Trans>}
						id="loyalty-expiry-mode"
						testId="loyalty-expiry-mode"
						options={options}
						value={state.expiryMode}
						onValueChange={(next) =>
							onChange({ expiryMode: next as LoyaltyExpiryMode })
						}
						error={errors.expiryMode ?? null}
						disabled={readOnly}
					/>
					{state.expiryMode !== 'never' ? (
						<TextField
							label={<Trans>Months until expiry</Trans>}
							hint={t`${LOYALTY_EXPIRY_MIN_MONTHS}–${LOYALTY_EXPIRY_MAX_MONTHS} months. Existing points get a full grace period from activation.`}
							id="loyalty-expiry-months"
							value={state.expiryMonths}
							onChange={(event) =>
								onChange({ expiryMonths: event.target.value })
							}
							error={errors.expiryMonths ?? null}
							disabled={readOnly}
							inputMode="numeric"
							placeholder="12"
							data-testid="loyalty-expiry-months"
						/>
					) : null}
				</div>
			</CardContent>
		</Card>
	)
}

export function ReferralsCard({
	state,
	onChange,
	errors,
	readOnly,
	unitLabelText,
	currency,
}: {
	state: ProgramExtensionState
	onChange: (patch: Partial<ProgramExtensionState>) => void
	errors: ProgramExtensionErrors
	readOnly: boolean
	unitLabelText: string
	currency: string
}) {
	const { t } = useLingui()
	return (
		<Card data-testid="loyalty-referrals-card">
			<CardHeader className="pb-2">
				<CardTitle className="text-base">
					<Trans>Refer a friend</Trans>
				</CardTitle>
				<CardDescription>
					<Trans>
						Let members share their referral link or code with new guests.
						Rewards grant after the friend’s qualifying paid order completes its
						hold window.
					</Trans>
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<SwitchRow
					id="loyalty-referrals-enabled"
					label={<Trans>Enable referral program</Trans>}
					checked={state.refEnabled}
					disabled={readOnly}
					onCheckedChange={(checked) => onChange({ refEnabled: checked })}
					testId="loyalty-referrals-enabled"
				/>
				{state.refEnabled ? (
					<div className="flex flex-col gap-4">
						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
							<TextField
								label={<Trans>Referrer bonus ({unitLabelText})</Trans>}
								hint={t`0–${LOYALTY_REFERRAL_MAX_POINTS}`}
								id="loyalty-ref-referrer-points"
								value={state.refReferrerPoints}
								onChange={(event) =>
									onChange({ refReferrerPoints: event.target.value })
								}
								error={errors.referrerPoints ?? null}
								disabled={readOnly}
								inputMode="numeric"
								data-testid="loyalty-ref-referrer-points"
							/>
							<TextField
								label={<Trans>Friend bonus ({unitLabelText})</Trans>}
								hint={t`0–${LOYALTY_REFERRAL_MAX_POINTS}`}
								id="loyalty-ref-friend-points"
								value={state.refFriendPoints}
								onChange={(event) =>
									onChange({ refFriendPoints: event.target.value })
								}
								error={errors.friendPoints ?? null}
								disabled={readOnly}
								inputMode="numeric"
								data-testid="loyalty-ref-friend-points"
							/>
						</div>

						<SelectField
							label={<Trans>Friend first-order discount</Trans>}
							id="loyalty-ref-discount-type"
							testId="loyalty-ref-discount-type"
							options={[
								{ value: 'none', label: t`No checkout discount` },
								{ value: 'fixed', label: t`Fixed amount off` },
								{ value: 'percent', label: t`Percentage off` },
							]}
							value={state.refDiscountType}
							onValueChange={(next) =>
								onChange({
									refDiscountType: next as 'none' | 'fixed' | 'percent',
								})
							}
							disabled={readOnly}
						/>

						{state.refDiscountType === 'fixed' ? (
							(() => {
								const currencyCode = currency || 'USD'
								return (
									<TextField
										label={<Trans>Friend discount ({currencyCode})</Trans>}
										id="loyalty-ref-discount-amount"
										value={state.refDiscountAmount}
										onChange={(event) =>
											onChange({ refDiscountAmount: event.target.value })
										}
										error={errors.friendDiscountAmount ?? null}
										disabled={readOnly}
										inputMode="decimal"
										placeholder="5.00"
										className="sm:max-w-52"
										data-testid="loyalty-ref-discount-amount"
									/>
								)
							})()
						) : state.refDiscountType === 'percent' ? (
							<div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
								<TextField
									label={<Trans>Friend discount (%)</Trans>}
									id="loyalty-ref-discount-percent"
									value={state.refDiscountPercent}
									onChange={(event) =>
										onChange({ refDiscountPercent: event.target.value })
									}
									error={errors.friendDiscountPercent ?? null}
									disabled={readOnly}
									inputMode="decimal"
									placeholder="10"
									data-testid="loyalty-ref-discount-percent"
								/>
								<TextField
									label={<Trans>Max discount cap</Trans>}
									optional
									id="loyalty-ref-discount-max"
									value={state.refDiscountMax}
									onChange={(event) =>
										onChange({ refDiscountMax: event.target.value })
									}
									error={errors.friendDiscountMax ?? null}
									disabled={readOnly}
									inputMode="decimal"
									placeholder="20.00"
									data-testid="loyalty-ref-discount-max"
								/>
							</div>
						) : null}

						<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
							<TextField
								label={<Trans>Minimum order</Trans>}
								optional
								id="loyalty-ref-min-order"
								value={state.refMinOrder}
								onChange={(event) =>
									onChange({ refMinOrder: event.target.value })
								}
								error={errors.refMinOrder ?? null}
								disabled={readOnly}
								inputMode="decimal"
								placeholder="0.00"
								data-testid="loyalty-ref-min-order"
							/>
							<TextField
								label={<Trans>Hold period (days)</Trans>}
								id="loyalty-ref-hold-days"
								value={state.refHoldDays}
								onChange={(event) =>
									onChange({ refHoldDays: event.target.value })
								}
								error={errors.refHoldDays ?? null}
								disabled={readOnly}
								inputMode="numeric"
								data-testid="loyalty-ref-hold-days"
							/>
							<TextField
								label={<Trans>Lifetime cap / member</Trans>}
								id="loyalty-ref-max-member"
								value={state.refMaxPerMember}
								onChange={(event) =>
									onChange({ refMaxPerMember: event.target.value })
								}
								error={errors.refMaxPerMember ?? null}
								disabled={readOnly}
								inputMode="numeric"
								data-testid="loyalty-ref-max-member"
							/>
							<TextField
								label={<Trans>Monthly cap / member</Trans>}
								optional
								id="loyalty-ref-max-month"
								value={state.refMaxPerMonth}
								onChange={(event) =>
									onChange({ refMaxPerMonth: event.target.value })
								}
								error={errors.refMaxPerMonth ?? null}
								disabled={readOnly}
								inputMode="numeric"
								placeholder={t`Unlimited`}
								data-testid="loyalty-ref-max-month"
							/>
						</div>
					</div>
				) : null}
			</CardContent>
		</Card>
	)
}

export function validateProgramExtensions(
	state: ProgramExtensionState,
	currency: string,
	timeZone: string,
	locationAddresses: readonly string[],
	translate: (descriptor: MessageDescriptor) => string,
	parseMoney: (value: string, bounds?: { min?: number }) => number | null,
	parseWhole: (
		value: string,
		bounds?: { min?: number; max?: number },
	) => number | null,
): ProgramExtensionErrors {
	const errors: ProgramExtensionErrors = {}
	if (state.welcomeEnabled) {
		const pts = parseWhole(state.welcomePoints, {
			min: 1,
			max: LOYALTY_WELCOME_MAX_POINTS,
		})
		if (pts === null) {
			errors.welcomePoints = translate(
				msg`Enter a whole number of points, at least 1.`,
			)
		}
	}
	if (state.tiersEnabled) {
		if (
			parseWhole(state.tierPeriodMonths, {
				min: LOYALTY_TIER_PERIOD_MIN_MONTHS,
				max: LOYALTY_TIER_PERIOD_MAX_MONTHS,
			}) === null
		) {
			errors.tierPeriodMonths = translate(
				msg`Enter a rolling period between 1 and 24 months.`,
			)
		}
		if (
			parseWhole(state.tierGraceDays, {
				min: 0,
				max: LOYALTY_TIER_GRACE_MAX_DAYS,
			}) === null
		) {
			errors.tierGraceDays = translate(msg`Enter grace days between 0 and 90.`)
		}
		if (state.tierRows.length === 0) {
			errors.tiers = translate(msg`Add at least one tier.`)
		}
		const rowErrors: NonNullable<ProgramExtensionErrors['tierRows']> = {}
		let prevThreshold = 0
		for (const [index, row] of state.tierRows.entries()) {
			const e: { name?: string; threshold?: string; multiplier?: string } = {}
			if (!row.name.trim()) {
				e.name = translate(msg`Enter a tier name.`)
			}
			const threshold =
				state.tierMetric === 'spend_minor'
					? parseMoney(row.threshold, { min: 1 })
					: parseWhole(row.threshold, { min: 1 })
			if (threshold === null) {
				e.threshold = translate(msg`Enter a positive threshold.`)
			} else {
				if (threshold <= prevThreshold) {
					e.threshold = translate(
						msg`Each tier threshold must be higher than the previous tier.`,
					)
				}
				prevThreshold = threshold
			}
			const mult = Number(row.multiplier)
			if (
				!Number.isFinite(mult) ||
				mult < 1 ||
				Math.round(mult * LOYALTY_MULTIPLIER_ONE_BP) > LOYALTY_MULTIPLIER_MAX_BP
			) {
				e.multiplier = translate(msg`Enter a multiplier from 1 to 5.`)
			}
			if (Object.keys(e).length > 0) rowErrors[index] = e
		}
		if (Object.keys(rowErrors).length > 0) errors.tierRows = rowErrors
	}
	if (state.expiryMode !== 'never') {
		if (
			parseWhole(state.expiryMonths, {
				min: LOYALTY_EXPIRY_MIN_MONTHS,
				max: LOYALTY_EXPIRY_MAX_MONTHS,
			}) === null
		) {
			errors.expiryMonths = translate(msg`Enter months between 1 and 60.`)
		}
		if (state.expiryMode === 'after_earn') {
			const check = isTimeExpiryAllowedInRegion({
				mode: 'after_earn',
				currency,
				timeZone,
				addresses: locationAddresses,
			})
			if (!check.allowed) {
				errors.expiryMode = translate(
					msg`Time-limited point expiry is not permitted in Canada. Choose inactivity expiry instead.`,
				)
			}
		}
	}
	if (state.refEnabled) {
		const rPts = parseWhole(state.refReferrerPoints, {
			min: 0,
			max: LOYALTY_REFERRAL_MAX_POINTS,
		})
		const fPts = parseWhole(state.refFriendPoints, {
			min: 0,
			max: LOYALTY_REFERRAL_MAX_POINTS,
		})
		if (rPts === null) {
			errors.referrerPoints = translate(msg`Enter a whole number of points.`)
		}
		if (fPts === null) {
			errors.friendPoints = translate(msg`Enter a whole number of points.`)
		}
		if (state.refDiscountType === 'fixed') {
			if (parseMoney(state.refDiscountAmount, { min: 1 }) === null) {
				errors.friendDiscountAmount = translate(
					msg`Enter a discount amount, like 5.00.`,
				)
			}
		} else if (state.refDiscountType === 'percent') {
			const p = Number(state.refDiscountPercent)
			if (!Number.isFinite(p) || p <= 0 || p > 100) {
				errors.friendDiscountPercent = translate(
					msg`Enter a percentage between 1 and 100.`,
				)
			}
			if (
				state.refDiscountMax.trim() !== '' &&
				parseMoney(state.refDiscountMax, { min: 1 }) === null
			) {
				errors.friendDiscountMax = translate(msg`Enter a valid amount.`)
			}
		}
		if (rPts === 0 && fPts === 0 && state.refDiscountType === 'none') {
			errors.referrerPoints = translate(
				msg`Set a referrer bonus, friend bonus, or friend discount.`,
			)
		}
		if (
			state.refMinOrder.trim() !== '' &&
			parseMoney(state.refMinOrder, { min: 0 }) === null
		) {
			errors.refMinOrder = translate(msg`Enter a valid amount.`)
		}
		if (parseWhole(state.refHoldDays, { min: 0, max: 60 }) === null) {
			errors.refHoldDays = translate(msg`Enter days between 0 and 60.`)
		}
		if (parseWhole(state.refMaxPerMember, { min: 1, max: 500 }) === null) {
			errors.refMaxPerMember = translate(msg`Enter a cap between 1 and 500.`)
		}
		if (
			state.refMaxPerMonth.trim() !== '' &&
			parseWhole(state.refMaxPerMonth, { min: 1, max: 200 }) === null
		) {
			errors.refMaxPerMonth = translate(msg`Enter a cap between 1 and 200.`)
		}
	}
	return errors
}

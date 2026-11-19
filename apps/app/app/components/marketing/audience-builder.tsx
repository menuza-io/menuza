import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	AUDIENCE_LIMITS,
	type AudienceDefinition,
	type AudienceRule,
	type AudienceRuleField,
} from '@repo/common/marketing-audiences'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'

type Compare = 'gte' | 'lte' | 'eq'

/** A new rule of a kind, with sensible starting numbers. */
function newRule(field: AudienceRuleField): AudienceRule {
	switch (field) {
		case 'orders_count':
			return { field, op: 'gte', value: 1, windowDays: 90 }
		case 'spend':
			return { field, op: 'gte', value: 5000, windowDays: 90 }
		case 'days_since_last_order':
			return { field, op: 'gte', value: 60 }
		case 'top_spenders':
			return { field, percent: 10, windowDays: 90 }
		case 'visits':
			return { field, op: 'gte', value: 1 }
		case 'days_since_last_visit':
			return { field, op: 'gte', value: 60 }
		case 'has_upcoming_reservation':
			return { field, value: true }
		case 'loyalty_member':
			return { field, value: true }
		case 'loyalty_points':
			return { field, op: 'gte', value: 100 }
		case 'loyalty_near_reward':
			return { field, withinPercent: 20 }
		case 'loyalty_tier':
			return { field, tierId: 'gold' }
		case 'phone_verified':
			return { field, value: true }
		case 'joined_within_days':
			return { field, value: 30 }
	}
}

const FIELD_ORDER: AudienceRuleField[] = [
	'orders_count',
	'spend',
	'days_since_last_order',
	'top_spenders',
	'visits',
	'days_since_last_visit',
	'has_upcoming_reservation',
	'loyalty_member',
	'loyalty_points',
	'loyalty_near_reward',
	'loyalty_tier',
	'phone_verified',
	'joined_within_days',
]

const num = (value: string, min = 0, max = 1_000_000) =>
	Math.min(max, Math.max(min, Math.floor(Number(value)) || 0))

/**
 * "All of" / "any of" rules over orders, visits, loyalty and profile (#98).
 * Money is entered in whole currency units and kept in minor units. The
 * builder never offers tags, allergies or notes: they cannot be rules.
 */
export function AudienceBuilder({
	value,
	onChange,
	disabled = false,
}: {
	value: AudienceDefinition
	onChange: (next: AudienceDefinition) => void
	disabled?: boolean
}) {
	const { _ } = useLingui()

	const fieldLabel: Record<AudienceRuleField, string> = {
		orders_count: _(msg`Number of orders`),
		spend: _(msg`Total spend`),
		days_since_last_order: _(msg`Days since last order`),
		top_spenders: _(msg`Top spenders`),
		visits: _(msg`Number of visits`),
		days_since_last_visit: _(msg`Days since last visit`),
		has_upcoming_reservation: _(msg`Has an upcoming reservation`),
		loyalty_member: _(msg`Is a loyalty member`),
		loyalty_points: _(msg`Loyalty points`),
		loyalty_near_reward: _(msg`Near a loyalty reward`),
		loyalty_tier: _(msg`Loyalty tier`),
		phone_verified: _(msg`Has a verified phone`),
		joined_within_days: _(msg`Joined recently`),
	}
	const compareLabel: Record<Compare, string> = {
		gte: _(msg`at least`),
		lte: _(msg`at most`),
		eq: _(msg`exactly`),
	}

	const setRule = (index: number, rule: AudienceRule) =>
		onChange({
			...value,
			rules: value.rules.map((existing, i) => (i === index ? rule : existing)),
		})
	const removeRule = (index: number) =>
		onChange({
			...value,
			rules: value.rules.filter((_rule, i) => i !== index),
		})

	const compareSelect = (
		rule: Extract<AudienceRule, { op: Compare }>,
		index: number,
	) => (
		<Select
			value={rule.op}
			onValueChange={(op) =>
				op && setRule(index, { ...rule, op: op as Compare })
			}
			disabled={disabled}
		>
			<SelectTrigger className="h-9 w-32">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{(['gte', 'lte', 'eq'] as const).map((op) => (
					<SelectItem key={op} value={op}>
						{compareLabel[op]}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)

	const windowSelect = (
		rule: Extract<AudienceRule, { windowDays?: number }>,
		index: number,
	) => (
		<Select
			value={rule.windowDays ? String(rule.windowDays) : 'all'}
			onValueChange={(next) => {
				if (next === null) return
				const { windowDays: _removed, ...rest } = rule as typeof rule & {
					windowDays?: number
				}
				setRule(
					index,
					(next === 'all'
						? rest
						: { ...rest, windowDays: Number(next) }) as AudienceRule,
				)
			}}
			disabled={disabled}
		>
			<SelectTrigger className="h-9 w-40">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="all">{_(msg`all time`)}</SelectItem>
				{[30, 60, 90, 180, 365].map((days) => (
					<SelectItem key={days} value={String(days)}>
						{_(msg`in the last ${days} days`)}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	)

	const yesNo = (current: boolean, onPick: (next: boolean) => void) => (
		<Select
			value={current ? 'yes' : 'no'}
			onValueChange={(next) => next && onPick(next === 'yes')}
			disabled={disabled}
		>
			<SelectTrigger className="h-9 w-24">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="yes">{_(msg`Yes`)}</SelectItem>
				<SelectItem value="no">{_(msg`No`)}</SelectItem>
			</SelectContent>
		</Select>
	)

	const numberInput = (
		current: number,
		onNumber: (next: number) => void,
		options: { min?: number; max?: number; label: string },
	) => (
		<Input
			type="number"
			aria-label={options.label}
			className="h-9 w-24"
			min={options.min ?? 0}
			max={options.max}
			value={current}
			disabled={disabled}
			onChange={(event) =>
				onNumber(num(event.target.value, options.min ?? 0, options.max))
			}
		/>
	)

	const renderRule = (rule: AudienceRule, index: number) => {
		switch (rule.field) {
			case 'orders_count':
				return (
					<>
						{compareSelect(rule, index)}
						{numberInput(
							rule.value,
							(next) => setRule(index, { ...rule, value: next }),
							{ label: _(msg`Number of orders`) },
						)}
						{windowSelect(rule, index)}
					</>
				)
			case 'spend':
				return (
					<>
						{compareSelect(rule, index)}
						{numberInput(
							Math.round(rule.value / 100),
							(next) => setRule(index, { ...rule, value: next * 100 }),
							{ label: _(msg`Amount`) },
						)}
						{windowSelect(rule, index)}
					</>
				)
			case 'days_since_last_order':
			case 'days_since_last_visit':
				return (
					<>
						{compareSelect(rule, index)}
						{numberInput(
							rule.value,
							(next) => setRule(index, { ...rule, value: next }),
							{ label: _(msg`Days`), max: 3650 },
						)}
						<span className="text-muted-foreground text-sm">
							{_(msg`days`)}
						</span>
					</>
				)
			case 'top_spenders':
				return (
					<>
						{numberInput(
							rule.percent,
							(next) =>
								setRule(index, { ...rule, percent: num(String(next), 1, 50) }),
							{ label: _(msg`Percent`), min: 1, max: 50 },
						)}
						<span className="text-muted-foreground text-sm">
							{_(msg`% by spend, in the last`)}
						</span>
						{numberInput(
							rule.windowDays,
							(next) =>
								setRule(index, {
									...rule,
									windowDays: num(String(next), 1, 730),
								}),
							{ label: _(msg`Days`), min: 1, max: 730 },
						)}
						<span className="text-muted-foreground text-sm">
							{_(msg`days`)}
						</span>
					</>
				)
			case 'visits':
			case 'loyalty_points':
				return (
					<>
						{compareSelect(rule, index)}
						{numberInput(
							rule.value,
							(next) => setRule(index, { ...rule, value: next }),
							{ label: _(msg`Number`) },
						)}
					</>
				)
			case 'has_upcoming_reservation':
			case 'loyalty_member':
			case 'phone_verified':
				return yesNo(rule.value, (next) =>
					setRule(index, { ...rule, value: next }),
				)
			case 'loyalty_near_reward':
				return (
					<>
						<span className="text-muted-foreground text-sm">
							{_(msg`within`)}
						</span>
						{numberInput(
							rule.withinPercent,
							(next) =>
								setRule(index, {
									...rule,
									withinPercent: num(String(next), 1, 90),
								}),
							{ label: _(msg`Percent`), min: 1, max: 90 },
						)}
						<span className="text-muted-foreground text-sm">
							{_(msg`% of the cheapest reward`)}
						</span>
					</>
				)
			case 'loyalty_tier':
				return (
					<Input
						aria-label={_(msg`Tier ID`)}
						className="h-9 w-40"
						value={rule.tierId}
						onChange={(event) =>
							setRule(index, { ...rule, tierId: event.target.value })
						}
						placeholder={_(msg`e.g. gold`)}
						disabled={disabled}
						maxLength={64}
					/>
				)
			case 'joined_within_days':
				return (
					<>
						<span className="text-muted-foreground text-sm">
							{_(msg`in the last`)}
						</span>
						{numberInput(
							rule.value,
							(next) =>
								setRule(index, { ...rule, value: num(String(next), 1, 730) }),
							{ label: _(msg`Days`), min: 1, max: 730 },
						)}
						<span className="text-muted-foreground text-sm">
							{_(msg`days`)}
						</span>
					</>
				)
		}
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2">
				<Label className="text-sm">
					<Trans>Guests who match</Trans>
				</Label>
				<Select
					value={value.match}
					onValueChange={(match) =>
						match && onChange({ ...value, match: match as 'all' | 'any' })
					}
					disabled={disabled}
				>
					<SelectTrigger className="h-9 w-44">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">{_(msg`all of these rules`)}</SelectItem>
						<SelectItem value="any">{_(msg`any of these rules`)}</SelectItem>
					</SelectContent>
				</Select>
			</div>

			<ul className="space-y-2">
				{value.rules.map((rule, index) => (
					<li
						key={index}
						className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
					>
						<Select
							value={rule.field}
							onValueChange={(field) =>
								field && setRule(index, newRule(field as AudienceRuleField))
							}
							disabled={disabled}
						>
							<SelectTrigger className="h-9 w-56">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{FIELD_ORDER.map((field) => (
									<SelectItem key={field} value={field}>
										{fieldLabel[field]}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						{renderRule(rule, index)}
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							className="ms-auto"
							aria-label={_(msg`Remove rule`)}
							disabled={disabled || value.rules.length <= 1}
							onClick={() => removeRule(index)}
						>
							<Icon name="trash-2" className="size-4" />
						</Button>
					</li>
				))}
			</ul>

			<Button
				type="button"
				variant="outline"
				size="sm"
				disabled={disabled || value.rules.length >= AUDIENCE_LIMITS.rules}
				onClick={() =>
					onChange({
						...value,
						rules: [...value.rules, newRule('orders_count')],
					})
				}
			>
				<Icon name="plus" className="size-4" />
				<Trans>Add a rule</Trans>
			</Button>
			<p className="text-muted-foreground text-xs">
				<Trans>
					An audience only narrows who you can message. Guests who did not agree
					to hear from you are never included, whatever the rules say.
				</Trans>
			</p>
		</div>
	)
}

export const EMPTY_AUDIENCE: AudienceDefinition = {
	match: 'all',
	rules: [newRule('orders_count')],
}

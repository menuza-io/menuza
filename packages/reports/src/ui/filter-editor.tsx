import { cn } from '@repo/ui'
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
import { Switch } from '@repo/ui/switch'
import { type ReportField } from '../catalog.ts'
import {
	type FilterCondition,
	type FilterGroup,
	isFilterGroup,
} from '../dsl.ts'

const MAX_GROUP_DEPTH = 2

const FILTER_OPERATORS: Array<{
	value: FilterCondition['operator']
	label: string
}> = [
	{ value: 'eq', label: 'is' },
	{ value: 'neq', label: 'is not' },
	{ value: 'contains', label: 'contains' },
	{ value: 'starts_with', label: 'starts with' },
	{ value: 'is_empty', label: 'is empty' },
	{ value: 'is_not_empty', label: 'is not empty' },
]

/**
 * Values an exact match can pick from. Filters compare raw values, so a
 * boolean matches "true" or "false" and an enum matches its option value.
 */
function valueChoices(
	field: ReportField | undefined,
	operator: FilterCondition['operator'],
) {
	if (!field || (operator !== 'eq' && operator !== 'neq')) return null
	if (field.type === 'boolean') {
		return [
			{ value: 'true', label: 'Yes' },
			{ value: 'false', label: 'No' },
		]
	}
	return field.options?.length ? field.options : null
}

function emptyCondition(fields: ReportField[]): FilterCondition | null {
	const field = fields[0]
	if (!field) return null
	return { field: field.id, operator: 'eq', value: '' }
}

function mapGroup(
	group: FilterGroup,
	path: number[],
	fn: (current: FilterGroup) => FilterGroup,
): FilterGroup {
	if (path.length === 0) return fn(group)
	const [head, ...rest] = path
	return {
		...group,
		conditions: group.conditions.map((item, index) => {
			if (index !== head || !isFilterGroup(item)) return item
			return mapGroup(item, rest, fn)
		}),
	}
}

function pruneEmptyGroups(group: FilterGroup, isRoot = true): FilterGroup {
	const conditions = group.conditions
		.map((item) => (isFilterGroup(item) ? pruneEmptyGroups(item, false) : item))
		.filter((item) => !isFilterGroup(item) || item.conditions.length > 0)
	if (!isRoot && conditions.length === 0) {
		return { ...group, conditions }
	}
	return { ...group, conditions }
}

export function FilterEditor({
	group,
	advanced,
	fields,
	onChange,
	onToggleAdvanced,
}: {
	group: FilterGroup
	advanced: boolean
	fields: ReportField[]
	onChange: (group: FilterGroup) => void
	onToggleAdvanced: (advanced: boolean) => void
}) {
	function addCondition(path: number[]) {
		const condition = emptyCondition(fields)
		if (!condition) return
		onChange(
			mapGroup(group, path, (current) => ({
				...current,
				conditions: [...current.conditions, condition],
			})),
		)
	}

	function addGroup(path: number[]) {
		const condition = emptyCondition(fields)
		if (!condition) return
		onChange(
			mapGroup(group, path, (current) => ({
				...current,
				conditions: [
					...current.conditions,
					{
						combinator: current.combinator === 'and' ? 'or' : 'and',
						conditions: [condition],
					},
				],
			})),
		)
	}

	function removeItem(path: number[], index: number) {
		onChange(
			pruneEmptyGroups(
				mapGroup(group, path, (current) => ({
					...current,
					conditions: current.conditions.filter(
						(_, itemIndex) => itemIndex !== index,
					),
				})),
			),
		)
	}

	function updateCondition(
		path: number[],
		index: number,
		next: FilterCondition,
	) {
		onChange(
			mapGroup(group, path, (current) => ({
				...current,
				conditions: current.conditions.map((item, itemIndex) =>
					itemIndex === index ? next : item,
				),
			})),
		)
	}

	function setCombinator(
		path: number[],
		combinator: FilterGroup['combinator'],
	) {
		onChange(
			mapGroup(group, path, (current) => ({
				...current,
				combinator,
			})),
		)
	}

	const nestingEnabled =
		advanced || group.conditions.some((item) => isFilterGroup(item))

	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<Label htmlFor="advanced-filters">Advanced</Label>
					<p className="text-muted-foreground mt-1 text-xs leading-relaxed">
						Group filters so some must all match and others can match any.
					</p>
				</div>
				<Switch
					id="advanced-filters"
					checked={nestingEnabled}
					onCheckedChange={(checked) => onToggleAdvanced(checked === true)}
				/>
			</div>
			<FilterGroupBlock
				group={group}
				path={[]}
				depth={0}
				advanced={nestingEnabled}
				fields={fields}
				onAddCondition={addCondition}
				onAddGroup={addGroup}
				onRemoveItem={removeItem}
				onUpdateCondition={updateCondition}
				onSetCombinator={setCombinator}
			/>
		</div>
	)
}

function FilterGroupBlock({
	group,
	path,
	depth,
	advanced,
	fields,
	onAddCondition,
	onAddGroup,
	onRemoveItem,
	onUpdateCondition,
	onSetCombinator,
}: {
	group: FilterGroup
	path: number[]
	depth: number
	advanced: boolean
	fields: ReportField[]
	onAddCondition: (path: number[]) => void
	onAddGroup: (path: number[]) => void
	onRemoveItem: (path: number[], index: number) => void
	onUpdateCondition: (
		path: number[],
		index: number,
		next: FilterCondition,
	) => void
	onSetCombinator: (
		path: number[],
		combinator: FilterGroup['combinator'],
	) => void
}) {
	const nested = depth > 0
	const canNest = advanced && depth < MAX_GROUP_DEPTH
	const parentPath = path.slice(0, -1)
	const ownIndex = path[path.length - 1]

	return (
		<div
			className={cn(
				'space-y-2',
				nested && 'bg-muted/30 rounded-md border py-2 pr-2 pl-3',
			)}
		>
			{advanced ? (
				<div className="flex items-center gap-2">
					<Select
						value={group.combinator}
						onValueChange={(value) => {
							if (!value) return
							onSetCombinator(path, value as FilterGroup['combinator'])
						}}
					>
						<SelectTrigger
							className="h-7 min-w-0 flex-1"
							aria-label={nested ? 'Nested group match' : 'Match'}
						>
							<SelectValue>
								{group.combinator === 'and'
									? 'Match all (AND)'
									: 'Match any (OR)'}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="and">Match all (AND)</SelectItem>
							<SelectItem value="or">Match any (OR)</SelectItem>
						</SelectContent>
					</Select>
					{nested && ownIndex !== undefined ? (
						<Button
							variant="ghost"
							size="icon-xs"
							aria-label="Remove group"
							onClick={() => onRemoveItem(parentPath, ownIndex)}
						>
							<Icon name="x" className="size-3.5" />
						</Button>
					) : null}
				</div>
			) : null}

			{group.conditions.length === 0 ? (
				<p className="text-muted-foreground text-xs leading-relaxed">
					No filters yet. Count every matching record in the timeframe.
				</p>
			) : null}

			{group.conditions.map((item, index) => {
				if (isFilterGroup(item)) {
					if (!advanced) return null
					return (
						<FilterGroupBlock
							key={`group-${path.join('.')}-${index}`}
							group={item}
							path={[...path, index]}
							depth={depth + 1}
							advanced={advanced}
							fields={fields}
							onAddCondition={onAddCondition}
							onAddGroup={onAddGroup}
							onRemoveItem={onRemoveItem}
							onUpdateCondition={onUpdateCondition}
							onSetCombinator={onSetCombinator}
						/>
					)
				}

				return (
					<FilterConditionRow
						key={`condition-${path.join('.')}-${index}-${item.field}`}
						condition={item}
						fields={fields}
						onChange={(next) => onUpdateCondition(path, index, next)}
						onRemove={() => onRemoveItem(path, index)}
					/>
				)
			})}

			<div className="flex flex-wrap gap-2">
				<Button
					variant="secondary"
					size="sm"
					disabled={fields.length === 0}
					onClick={() => onAddCondition(path)}
				>
					<Icon name="plus" className="size-3.5" />
					Filter
				</Button>
				{canNest ? (
					<Button
						variant="outline"
						size="sm"
						disabled={fields.length === 0}
						onClick={() => onAddGroup(path)}
					>
						<Icon name="folder" className="size-3.5" />
						Group
					</Button>
				) : null}
			</div>
		</div>
	)
}

function FilterConditionRow({
	condition,
	fields,
	onChange,
	onRemove,
}: {
	condition: FilterCondition
	fields: ReportField[]
	onChange: (next: FilterCondition) => void
	onRemove: () => void
}) {
	const needsValue =
		condition.operator !== 'is_empty' && condition.operator !== 'is_not_empty'
	const field = fields.find((item) => item.id === condition.field)
	const operatorLabel = FILTER_OPERATORS.find(
		(operator) => operator.value === condition.operator,
	)?.label
	const choices = valueChoices(field, condition.operator)
	const value = String(condition.value ?? '')

	return (
		<div
			className={cn(
				'space-y-2 rounded-md border p-2',
				condition.value || !needsValue ? 'border-primary/40' : 'border-border',
			)}
		>
			<div className="flex items-start gap-1">
				<div className="min-w-0 flex-1 space-y-2">
					<Select
						value={condition.field}
						onValueChange={(next) => {
							if (!next || next === condition.field) return
							const nextChoices = valueChoices(
								fields.find((item) => item.id === next),
								condition.operator,
							)
							// Free text carries over between text fields; a picked choice
							// only carries over when the new field offers it too.
							const keep = nextChoices
								? nextChoices.some((choice) => choice.value === value)
								: !choices
							onChange({
								...condition,
								field: next,
								value: keep ? condition.value : '',
							})
						}}
					>
						<SelectTrigger className="w-full" aria-label="Field">
							<SelectValue>{field?.label ?? condition.field}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{fields.map((field) => (
								<SelectItem key={field.id} value={field.id}>
									{field.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={condition.operator}
						onValueChange={(next) => {
							if (!next) return
							const operator = next as FilterCondition['operator']
							const nextChoices = valueChoices(field, operator)
							// Typed text can't stay once the value is picked from a list.
							const keep =
								!nextChoices ||
								nextChoices.some((choice) => choice.value === value)
							onChange({
								...condition,
								operator,
								value: keep ? condition.value : '',
							})
						}}
					>
						<SelectTrigger className="w-full" aria-label="Operator">
							<SelectValue>{operatorLabel ?? condition.operator}</SelectValue>
						</SelectTrigger>
						<SelectContent>
							{FILTER_OPERATORS.map((operator) => (
								<SelectItem key={operator.value} value={operator.value}>
									{operator.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{needsValue && choices ? (
						<Select
							value={value || null}
							onValueChange={(next) => {
								if (next === null) return
								onChange({ ...condition, value: next })
							}}
						>
							<SelectTrigger className="w-full" aria-label="Value">
								<SelectValue placeholder="Choose a value…">
									{value
										? (choices.find((choice) => choice.value === value)
												?.label ?? value)
										: undefined}
								</SelectValue>
							</SelectTrigger>
							<SelectContent>
								{choices.map((choice) => (
									<SelectItem key={choice.value} value={choice.value}>
										{choice.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : needsValue ? (
						<Input
							value={value}
							placeholder="Value"
							aria-label="Value"
							onChange={(event) =>
								onChange({ ...condition, value: event.target.value })
							}
						/>
					) : null}
				</div>
				<Button
					variant="ghost"
					size="icon-xs"
					aria-label="Remove filter"
					onClick={onRemove}
				>
					<Icon name="x" className="size-3.5" />
				</Button>
			</div>
		</div>
	)
}

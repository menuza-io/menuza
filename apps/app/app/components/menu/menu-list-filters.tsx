import {
	createFilterQuery,
	flattenFilterConditions,
	type FilterCondition,
	type FilterField,
	type FilterQuery,
} from '@repo/ui/filters'
import { useMemo, useState } from 'react'

export type MenuListFilterValue = string | string[]

function matchesTextOperator(
	value: string,
	operator: string,
	values: unknown[],
): boolean {
	const haystack = value.toLowerCase()
	const needle = String(values[0] ?? '').toLowerCase()

	switch (operator) {
		case 'contains':
			return haystack.includes(needle)
		case 'not_contains':
			return !haystack.includes(needle)
		case 'starts_with':
			return haystack.startsWith(needle)
		case 'ends_with':
			return haystack.endsWith(needle)
		case 'is':
			return haystack === needle
		case 'is_not':
			return haystack !== needle
		case 'empty':
			return haystack.trim().length === 0
		case 'not_empty':
			return haystack.trim().length > 0
		default:
			return true
	}
}

function matchesSelectOperator(
	value: MenuListFilterValue,
	operator: string,
	values: unknown[],
): boolean {
	const entries = (Array.isArray(value) ? value : [value]).filter(Boolean)
	const selected = values.map(String)

	switch (operator) {
		case 'is':
			return selected.length > 0 && entries.includes(selected[0] ?? '')
		case 'is_not':
			return selected.length > 0 && !entries.includes(selected[0] ?? '')
		case 'is_any_of':
			return (
				selected.length === 0 ||
				selected.some((entry) => entries.includes(entry))
			)
		case 'is_none_of':
			return (
				selected.length > 0 &&
				selected.every((entry) => !entries.includes(entry))
			)
		case 'has_any_of':
			return (
				selected.length === 0 ||
				selected.some((entry) => entries.includes(entry))
			)
		case 'has_all_of':
			return selected.every((entry) => entries.includes(entry))
		case 'has_none_of':
			return selected.every((entry) => !entries.includes(entry))
		case 'empty':
			return entries.length === 0
		case 'not_empty':
			return entries.length > 0
		default:
			return true
	}
}

function matchesMenuListCondition<T>(
	record: T,
	condition: FilterCondition,
	getFieldValue: (record: T, field: string) => MenuListFilterValue,
	selectFieldIds: Set<string>,
): boolean {
	const value = getFieldValue(record, condition.field)
	const matches = Array.isArray(value)
		? matchesSelectOperator(value, condition.operator, condition.values)
		: selectFieldIds.has(condition.field)
			? matchesSelectOperator(value, condition.operator, condition.values)
			: matchesTextOperator(value, condition.operator, condition.values)

	return condition.negated ? !matches : matches
}

export function useMenuListFilters<T>(
	records: T[],
	fields: FilterField[],
	getFieldValue: (record: T, field: string) => MenuListFilterValue,
) {
	const [filterQuery, setFilterQuery] = useState<FilterQuery>(() =>
		createFilterQuery(),
	)
	const filterConditions = useMemo(
		() => flattenFilterConditions(filterQuery),
		[filterQuery],
	)
	const selectFieldIds = useMemo(
		() =>
			new Set(
				fields
					.filter(
						(field) => field.type === 'select' || field.type === 'multiselect',
					)
					.map((field) => field.id),
			),
		[fields],
	)
	const filteredRecords = useMemo(
		() =>
			records.filter((record) =>
				filterConditions.every((condition) =>
					matchesMenuListCondition(
						record,
						condition,
						getFieldValue,
						selectFieldIds,
					),
				),
			),
		[filterConditions, getFieldValue, records, selectFieldIds],
	)

	return {
		fields,
		filterQuery,
		setFilterQuery,
		filteredRecords,
		hasFilters: filterConditions.length > 0,
	}
}

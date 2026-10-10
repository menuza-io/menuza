import {
	createFilterQuery,
	createFilterRule,
	Filters,
	flattenFilterRules,
	type FilterField,
	type FilterQuery,
} from '@repo/ui/filters'
import { useRef, useState } from 'react'
import { useSearchParams } from 'react-router'

/**
 * Single-value filter bar that mirrors the app's `Filters` toolbar but keeps
 * its state in the URL, so server loaders keep reading plain search params.
 *
 * Each field id is the URL param name. Fields should use one operator
 * (`contains` for text, `is` for select).
 */
export function UrlFilters({
	fields,
	className,
}: {
	fields: FilterField[]
	className?: string
}) {
	const [searchParams, setSearchParams] = useSearchParams()
	const idCounter = useRef(0)
	const [query, setQuery] = useState<FilterQuery>(() =>
		createFilterQuery(
			fields.flatMap((field) => {
				const value = searchParams.get(field.id)
				return value
					? [
							createFilterRule({
								id: `url-${idCounter.current++}`,
								path: [field.id],
								operator: field.defaultOperator ?? 'is',
								value,
							}),
						]
					: []
			}),
		),
	)

	function handleQueryChange(next: FilterQuery) {
		setQuery(next)
		const params = new URLSearchParams(searchParams)
		for (const field of fields) params.delete(field.id)
		for (const rule of flattenFilterRules(next)) {
			const raw = Array.isArray(rule.value) ? rule.value[0] : rule.value
			const value = typeof raw === 'string' ? raw.trim() : ''
			const key = rule.path[0]
			if (key && value) params.set(key, value)
		}
		params.set('page', '1')
		setSearchParams(params, { preventScrollReset: true })
	}

	return (
		<Filters
			fields={fields}
			query={query}
			onQueryChange={handleQueryChange}
			showClear
			className={className}
		/>
	)
}

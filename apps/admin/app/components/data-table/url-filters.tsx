import {
	createFilterQuery,
	createFilterRule,
	Filters,
	flattenFilterRules,
	type FilterField,
	type FilterQuery,
} from '@repo/ui/filters'
import { useCallback, useEffect, useRef, useState } from 'react'
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

	// Only the params this bar owns matter for syncing.
	const keyFor = (params: URLSearchParams) =>
		fields.map((field) => `${field.id}=${params.get(field.id) ?? ''}`).join('&')
	const urlKey = keyFor(searchParams)

	const queryFromUrl = useCallback(
		() =>
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
		[fields, searchParams],
	)

	const [query, setQuery] = useState<FilterQuery>(queryFromUrl)

	// The URL key this bar last wrote and is still waiting to see arrive. The
	// router applies `setSearchParams` asynchronously, so until it lands the
	// params are stale and must not be mistaken for an external change.
	const pendingKey = useRef<string | null>(null)
	const seenKey = useRef(urlKey)

	useEffect(() => {
		if (urlKey === seenKey.current) return
		seenKey.current = urlKey
		if (pendingKey.current === urlKey) {
			// Our own write landed: keep local state, including value-less drafts.
			pendingKey.current = null
			return
		}
		// Back/forward or any other external change: re-derive from the URL.
		pendingKey.current = null
		setQuery(queryFromUrl())
	}, [urlKey, queryFromUrl])

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
		const nextKey = keyFor(params)
		// A draft edit that doesn't change the URL never produces a URL change.
		pendingKey.current = nextKey === urlKey ? null : nextKey
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

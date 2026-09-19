import { useSearchParams } from 'react-router'

export function useMenuListSearch() {
	const [searchParams, setSearchParams] = useSearchParams()
	const query = searchParams.get('q') ?? ''

	function setQuery(value: string) {
		const next = new URLSearchParams(searchParams)
		if (value) next.set('q', value)
		else next.delete('q')
		setSearchParams(next, { replace: true })
	}

	function matches(...parts: Array<string | null | undefined>) {
		if (!query) return true
		const haystack = parts.filter(Boolean).join(' ').toLowerCase()
		return haystack.includes(query.toLowerCase())
	}

	return { query, setQuery, matches }
}

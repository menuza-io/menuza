import { useCallback, useMemo, useState } from 'react'

export function useMenuListSelection<T extends { id: string }>(filtered: T[]) {
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

	const toggle = useCallback((id: string, checked: boolean) => {
		setSelectedIds((prev) => {
			const next = new Set(prev)
			if (checked) next.add(id)
			else next.delete(id)
			return next
		})
	}, [])

	const selectAllFiltered = useCallback(() => {
		setSelectedIds(new Set(filtered.map((row) => row.id)))
	}, [filtered])

	const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

	const allFilteredSelected = useMemo(
		() =>
			filtered.length > 0 &&
			filtered.every((row) => selectedIds.has(row.id)),
		[filtered, selectedIds],
	)

	return {
		selectedIds: [...selectedIds],
		toggle,
		selectAllFiltered,
		clearSelection,
		allFilteredSelected,
		hasSelection: selectedIds.size > 0,
	}
}

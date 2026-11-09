/** The ids in a new walking order after moving one entry up (-1) or down (+1). */
export function moveId(
	ids: readonly string[],
	index: number,
	delta: -1 | 1,
): string[] {
	const target = index + delta
	if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) {
		return [...ids]
	}
	const next = [...ids]
	const [moved] = next.splice(index, 1)
	next.splice(target, 0, moved!)
	return next
}

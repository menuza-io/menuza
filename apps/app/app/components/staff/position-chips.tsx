import { PositionChip } from '@repo/ui/position-color'
import { type StaffPositionRow } from '#app/utils/staffing/staff-types.ts'
import { EmptyValue } from './empty-value.tsx'

/** Up to `max` position chips and a quiet "+N" for the rest. */
export function PositionChips({
	ids,
	positions,
	max = 2,
}: {
	ids: readonly string[]
	positions: ReadonlyMap<string, StaffPositionRow>
	max?: number
}) {
	const known = ids
		.map((id) => positions.get(id))
		.filter((position): position is StaffPositionRow => Boolean(position))
	if (known.length === 0) {
		return (
			<span className="text-sm">
				<EmptyValue />
			</span>
		)
	}
	const shown = known.slice(0, max)
	const rest = known.length - shown.length
	return (
		<span className="flex flex-wrap items-center gap-1">
			{shown.map((position) => (
				<PositionChip key={position.id} colorKey={position.colorKey}>
					{position.name}
				</PositionChip>
			))}
			{rest > 0 ? (
				<span className="text-muted-foreground text-xs">+{rest}</span>
			) : null}
		</span>
	)
}

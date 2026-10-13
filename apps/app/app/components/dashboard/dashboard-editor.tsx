import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type ReactNode,
} from 'react'
import {
	type BuiltInBlockData,
	type DashboardBlockPicker,
} from '#app/utils/dashboards/block-data.server.ts'
import {
	type DashboardBlock,
	type DashboardConfig,
	type GridItem,
	type PersistedBreakpoint,
} from '#app/utils/dashboards/config.ts'
import { hiddenBlockIds } from '#app/utils/dashboards/visibility.ts'
import { AddBlockDialog } from './add-block-dialog.tsx'
import { DashboardEditToolbar } from './dashboard-edit-toolbar.tsx'
import { DashboardGrid } from './dashboard-grid.tsx'
import { DashboardHeader } from './dashboard-header.tsx'
import { useDashboardEditor } from './use-dashboard-editor.ts'

/**
 * A dashboard's header and grid with its Edit layout mode. Editing is only
 * offered where the grid has columns to arrange, not in mobile mode.
 */
export function DashboardEditor({
	name,
	config,
	blockData,
	picker,
	renderBlock,
	resetConfig,
}: {
	name: ReactNode
	config: DashboardConfig
	blockData: BuiltInBlockData
	picker: DashboardBlockPicker
	renderBlock: (block: DashboardBlock) => ReactNode
	/** What "Reset to default" restores; without it there is no reset. */
	resetConfig?: () => DashboardConfig
}) {
	const editor = useDashboardEditor({ config, resetConfig })
	const { editing, stopEditing, commitLayout, addBlock, removeBlock } = editor
	const { blocks, layouts } = editor.config
	const [editable, setEditable] = useState(false)
	const hidden = useMemo(
		() =>
			// An onboarding block added since the page data loaded has no progress
			// yet. It is only offered while it would be shown, so it stays visible.
			blockData.onboarding || !picker.onboardingAvailable
				? hiddenBlockIds(blocks, blockData)
				: [],
		[blocks, blockData, picker.onboardingAvailable],
	)

	useEffect(() => {
		if (editing && !editable) stopEditing()
	}, [editable, editing, stopEditing])

	const handleLayoutCommit = useCallback(
		(breakpoint: PersistedBreakpoint, layout: GridItem[]) =>
			commitLayout(breakpoint, layout, hidden),
		[commitLayout, hidden],
	)

	return (
		<>
			<DashboardHeader
				name={name}
				actions={
					editable ? (
						<DashboardEditToolbar
							editing={editing}
							saving={editor.saving}
							saved={editor.saved}
							addBlock={
								<AddBlockDialog
									blocks={blocks}
									picker={picker}
									onAdd={addBlock}
								/>
							}
							onStartEditing={editor.startEditing}
							onStopEditing={stopEditing}
							onReset={editor.reset}
						/>
					) : null
				}
			/>
			<DashboardGrid
				blocks={blocks}
				layouts={layouts}
				hiddenBlockIds={hidden}
				renderBlock={renderBlock}
				editing={editing}
				onLayoutCommit={handleLayoutCommit}
				onRemoveBlock={removeBlock}
				onEditableChange={setEditable}
			/>
		</>
	)
}

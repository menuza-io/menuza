import { Button } from '@repo/ui/button'
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type ReactElement,
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
	type NewDashboardBlock,
	type PersistedBreakpoint,
} from '#app/utils/dashboards/config.ts'
import { hiddenBlockIds } from '#app/utils/dashboards/visibility.ts'
import { AddBlockDialog } from './add-block-dialog.tsx'
import { DashboardEditToolbar } from './dashboard-edit-toolbar.tsx'
import { DashboardEmptyState } from './dashboard-empty-state.tsx'
import { DashboardGrid } from './dashboard-grid.tsx'
import { DashboardHeader } from './dashboard-header.tsx'
import { ReportBlockOptions } from './report-block-options.tsx'
import { useDashboardEditor } from './use-dashboard-editor.ts'

const EMPTY_STATE_TRIGGER = <Button type="button" />

/**
 * A dashboard's header and grid with its Edit layout mode. Editing is only
 * offered where the grid has columns to arrange, not in mobile mode, and not
 * at all when the dashboard is `readOnly`.
 */
export function DashboardEditor({
	title,
	actions,
	readOnly = false,
	config,
	blockData,
	picker,
	renderBlock,
	blockTitle,
	resetConfig,
}: {
	/** Names the open dashboard, such as the dashboard switcher. */
	title: ReactNode
	/** Further header controls, after the edit controls. */
	actions?: ReactNode
	readOnly?: boolean
	config: DashboardConfig
	blockData: BuiltInBlockData
	picker: DashboardBlockPicker
	renderBlock: (block: DashboardBlock) => ReactNode
	blockTitle?: (block: DashboardBlock) => string | null
	/** What "Reset to default" restores; without it there is no reset. */
	resetConfig?: () => DashboardConfig
}) {
	const editor = useDashboardEditor({ config, resetConfig })
	const {
		editing,
		startEditing,
		stopEditing,
		commitLayout,
		addBlock,
		removeBlock,
	} = editor
	const { blocks, layouts } = editor.config
	const [fitsGrid, setFitsGrid] = useState(false)
	const editable = fitsGrid && !readOnly
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

	// A first block goes in from the empty state, then the layout is open for
	// arranging it.
	const addFirstBlock = useCallback(
		(block: NewDashboardBlock) => {
			addBlock(block)
			startEditing()
		},
		[addBlock, startEditing],
	)

	const addBlockDialog = (
		onAdd: (block: NewDashboardBlock) => void,
		trigger?: ReactElement,
	) => (
		<AddBlockDialog
			blocks={blocks}
			picker={picker}
			onAdd={onAdd}
			trigger={trigger}
			renderSections={(select) => (
				<ReportBlockOptions
					savedReports={picker.savedReports}
					templateGroups={picker.templateGroups}
					onSelect={select}
				/>
			)}
		/>
	)

	return (
		<>
			<DashboardHeader
				title={title}
				actions={
					<>
						{editable ? (
							<DashboardEditToolbar
								editing={editing}
								saving={editor.saving}
								saved={editor.saved}
								addBlock={addBlockDialog(addBlock)}
								onStartEditing={startEditing}
								onStopEditing={stopEditing}
								onReset={editor.reset}
							/>
						) : null}
						{actions}
					</>
				}
			/>
			{blocks.length === 0 ? (
				<DashboardEmptyState
					editing={editing}
					addBlock={
						editable
							? addBlockDialog(addFirstBlock, EMPTY_STATE_TRIGGER)
							: undefined
					}
				/>
			) : null}
			<DashboardGrid
				blocks={blocks}
				layouts={layouts}
				hiddenBlockIds={hidden}
				renderBlock={renderBlock}
				blockTitle={blockTitle}
				editing={editing}
				onLayoutCommit={handleLayoutCommit}
				onRemoveBlock={removeBlock}
				onEditableChange={setFitsGrid}
			/>
		</>
	)
}

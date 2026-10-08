import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from '@repo/ui/resizable'
import { Background, BackgroundVariant, Controls, MiniMap } from '@xyflow/react'
import { type ReactNode } from 'react'
import '@xyflow/react/dist/style.css'

export interface FlowWorkspaceProps {
	/** Persists the sidebar width per editor. */
	autoSaveId: string
	/** Palette or inspector, shown in the resizable left panel. */
	sidebar: ReactNode
	/** The `<ReactFlow>` canvas. */
	children: ReactNode
}

/** Resizable sidebar + bordered canvas card shared by the visual editors. */
export function FlowWorkspace({
	autoSaveId,
	sidebar,
	children,
}: FlowWorkspaceProps) {
	return (
		<ResizablePanelGroup
			direction="horizontal"
			autoSaveId={autoSaveId}
			className="bg-muted min-h-0 flex-1"
		>
			<ResizablePanel
				id="sidebar"
				order={1}
				defaultSize={22}
				minSize={15}
				maxSize={40}
				className="m-2 mr-0 min-w-0 rounded-lg"
			>
				<aside className="bg-background flex h-full min-w-0 flex-col overflow-hidden rounded-xl">
					{sidebar}
				</aside>
			</ResizablePanel>

			<ResizableHandle withHandle className="bg-transparent" />

			<ResizablePanel
				id="canvas"
				order={2}
				defaultSize={78}
				minSize={40}
				className="min-w-0"
			>
				<div className="bg-muted/30 h-full w-full p-2">
					{/* React Flow positions nodes, handles and the minimap in
					    left-to-right coordinates, so the canvas stays LTR in RTL locales. */}
					<div
						dir="ltr"
						className="bg-background h-full w-full overflow-hidden rounded-xl border shadow-sm"
					>
						{children}
					</div>
				</div>
			</ResizablePanel>
		</ResizablePanelGroup>
	)
}

/** Background dots, zoom controls and minimap, styled the same in every editor. */
export function FlowCanvasChrome({
	showInteractive = true,
}: {
	showInteractive?: boolean
}) {
	return (
		<>
			<Background
				variant={BackgroundVariant.Dots}
				gap={20}
				size={1}
				className="text-muted-foreground/20 opacity-20"
			/>
			<Controls
				position="bottom-right"
				showInteractive={showInteractive}
				className="bg-card overflow-hidden rounded-md border shadow-sm"
			/>
			<MiniMap
				position="bottom-left"
				zoomable
				pannable
				nodeStrokeWidth={3}
				className="bg-card/90 [&_.react-flow__minimap-mask]:fill-background/80 [&_.react-flow__minimap-node]:fill-muted-foreground/30 !hidden overflow-hidden rounded-xl border shadow-md backdrop-blur-md sm:!block"
			/>
		</>
	)
}

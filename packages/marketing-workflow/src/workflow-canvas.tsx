import {
	Background,
	BackgroundVariant,
	Controls,
	MiniMap,
	ReactFlow,
	ReactFlowProvider,
	addEdge,
	useEdgesState,
	useNodesState,
	useReactFlow,
	type Connection,
	type Edge,
	type Node,
} from '@xyflow/react'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import {
	ResizableHandle,
	ResizablePanel,
	ResizablePanelGroup,
} from '@repo/ui/resizable'
import {
	useCallback,
	useMemo,
	useRef,
	useState,
	type DragEvent,
	type MouseEvent,
	type ReactNode,
} from 'react'
import '@xyflow/react/dist/style.css'

import { edgeTypes } from './edges/index.ts'
import { NodeInspector } from './node-inspector.tsx'
import { NodePalette } from './node-palette.tsx'
import { nodeTypes } from './nodes/index.ts'
import {
	reactFlowToWorkflowGraph,
	workflowGraphToReactFlow,
} from './serialization.ts'
import {
	type JourneyStatus,
	type PaletteItem,
	type WorkflowGraph,
} from './types.ts'
import {
	validateFlowCanvas,
	type RealtimeValidationState,
} from './validation.ts'
import {
	useLocalizedPlatformWorkflowConfig,
	useLocalizedTenantWorkflowConfig,
} from './workflow-labels.ts'
import { WorkflowToolbar } from './workflow-toolbar.tsx'
import {
	PLATFORM_WORKFLOW_CONFIG,
	TENANT_WORKFLOW_CONFIG,
	WorkflowConfigProvider,
	type WorkflowConfig,
} from './workflow-config.tsx'

interface WorkflowCanvasProps {
	workflowConfig?: WorkflowConfig
	initialGraph?: WorkflowGraph | string
	journeyName: string
	journeyStatus: JourneyStatus
	/** Extra controls rendered in the toolbar (e.g. the app's AI toggle). */
	headerExtras?: ReactNode
	/** Inset the canvas so the app's docked AI panel doesn't cover it. */
	reserveAiPanelWidth?: boolean
	onSave: (graph: WorkflowGraph, name: string) => Promise<void> | void
	onPublish: (graph: WorkflowGraph, name: string) => Promise<void> | void
	onPause?: () => Promise<void> | void
	onTestRun: (customerId: string) => Promise<void> | void
	onBack: () => void
	onViewRuns?: () => void
	isSaving?: boolean
	isPublishing?: boolean
}

function WorkflowCanvasInner({
	initialGraph,
	journeyName: initialName,
	journeyStatus,
	headerExtras,
	reserveAiPanelWidth,
	onSave,
	onPublish,
	onPause,
	onTestRun,
	onBack,
	onViewRuns,
	isSaving,
	isPublishing,
}: Omit<WorkflowCanvasProps, 'workflowConfig'>) {
	const { _ } = useLingui()
	const reactFlowWrapper = useRef<HTMLDivElement>(null)
	const { screenToFlowPosition, fitView } = useReactFlow()

	const [name, setName] = useState(initialName || 'Untitled Automation')
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)

	const initialData = useMemo(() => {
		return workflowGraphToReactFlow(initialGraph)
	}, [initialGraph])

	const [nodes, setNodes, onNodesChange] = useNodesState(initialData.nodes)
	const [edges, setEdges, onEdgesChange] = useEdgesState(initialData.edges)

	const validation = useMemo<RealtimeValidationState>(() => {
		return validateFlowCanvas(nodes, edges, _)
	}, [nodes, edges, _])

	const selectedNode = useMemo(() => {
		return nodes.find((n) => n.id === selectedNodeId) || null
	}, [nodes, selectedNodeId])

	const isValidConnection = useCallback(
		(connection: Connection | Edge) => {
			if (connection.source === connection.target) return false

			const targetNode = nodes.find((n) => n.id === connection.target)
			if (targetNode && targetNode.type === 'trigger') return false

			return true
		},
		[nodes],
	)

	const onConnect = useCallback(
		(params: Connection) => {
			if (!isValidConnection(params)) return

			const newEdge: Edge = {
				...params,
				id: `edge_${params.source}_${params.target}_${Date.now()}`,
				type: 'workflow',
			}

			setEdges((eds) => addEdge(newEdge, eds))
		},
		[isValidConnection, setEdges],
	)

	const onDragOver = useCallback((event: DragEvent) => {
		event.preventDefault()
		event.dataTransfer.dropEffect = 'move'
	}, [])

	const onDrop = useCallback(
		(event: DragEvent) => {
			event.preventDefault()

			const type = event.dataTransfer.getData('application/reactflow')
			const rawData = event.dataTransfer.getData('application/reactflow-data')

			if (!type) return

			let data: Record<string, unknown> = {}
			try {
				if (rawData) data = JSON.parse(rawData) as Record<string, unknown>
			} catch {}

			const position = screenToFlowPosition({
				x: event.clientX,
				y: event.clientY,
			})

			const newNode: Node = {
				id: `node_${type}_${Date.now()}`,
				type,
				position,
				data,
			}

			setNodes((nds) => nds.concat(newNode))
			setSelectedNodeId(newNode.id)
		},
		[screenToFlowPosition, setNodes],
	)

	const handleAddNodeFromPalette = useCallback(
		(item: PaletteItem) => {
			const centerPosition = screenToFlowPosition({
				x: window.innerWidth / 2,
				y: window.innerHeight / 2,
			})

			const randomOffset = (Math.random() - 0.5) * 60
			const newNode: Node = {
				id: `node_${item.type}_${Date.now()}`,
				type: item.type,
				position: {
					x: centerPosition.x + randomOffset,
					y: centerPosition.y + randomOffset,
				},
				data: { ...item.defaultData },
			}

			setNodes((nds) => nds.concat(newNode))
			setSelectedNodeId(newNode.id)
		},
		[screenToFlowPosition, setNodes],
	)

	const handleUpdateNodeData = useCallback(
		(nodeId: string, newData: Record<string, unknown>) => {
			setNodes((nds) =>
				nds.map((node) => {
					if (node.id === nodeId) {
						return {
							...node,
							data: {
								...node.data,
								...newData,
							},
						}
					}
					return node
				}),
			)
		},
		[setNodes],
	)

	/**
	 * Apply node data and persist the journey in one step, used by the email
	 * designer's Save so an explicit save actually reaches the server (an
	 * update-only change leaves the canvas with unsaved edits).
	 */
	const handleSaveNodeData = useCallback(
		(nodeId: string, newData: Record<string, unknown>) => {
			const nextNodes = nodes.map((node) =>
				node.id === nodeId
					? { ...node, data: { ...node.data, ...newData } }
					: node,
			)
			setNodes(nextNodes)
			void onSave(reactFlowToWorkflowGraph(nextNodes, edges), name)
		},
		[nodes, edges, name, onSave, setNodes],
	)

	const handleDeleteNode = useCallback(
		(nodeId: string) => {
			setNodes((nds) => nds.filter((node) => node.id !== nodeId))
			setEdges((eds) =>
				eds.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
			)
			if (selectedNodeId === nodeId) {
				setSelectedNodeId(null)
			}
		},
		[selectedNodeId, setNodes, setEdges],
	)

	const onNodeClick = useCallback((_: MouseEvent, node: Node) => {
		setSelectedNodeId(node.id)
	}, [])

	const onPaneClick = useCallback(() => {
		setSelectedNodeId(null)
	}, [])

	const handleSave = useCallback(() => {
		const graph = reactFlowToWorkflowGraph(nodes, edges)
		void onSave(graph, name)
	}, [nodes, edges, name, onSave])

	const handlePublish = useCallback(() => {
		const graph = reactFlowToWorkflowGraph(nodes, edges)
		void onPublish(graph, name)
	}, [nodes, edges, name, onPublish])

	return (
		// Muted chrome, like the website builders: the header and surface cards
		// carry the background color, so the docked AI panel (which insets itself
		// from the viewport edges) is separated from the canvas by the backdrop.
		<div className="bg-muted flex h-full w-full flex-col overflow-hidden">
			<WorkflowToolbar
				name={name}
				onNameChange={setName}
				status={journeyStatus}
				validation={validation}
				isSaving={isSaving}
				isPublishing={isPublishing}
				onSave={handleSave}
				onPublish={handlePublish}
				onPause={onPause}
				onTestRun={onTestRun}
				onBack={onBack}
				onViewRuns={onViewRuns}
				onFitView={() => fitView({ padding: 0.2, duration: 400 })}
				headerExtras={headerExtras}
			/>

			<div
				className={cn(
					'flex min-h-0 flex-1',
					// Leave room for the app's docked AI panel.
					reserveAiPanelWidth && 'pr-107',
				)}
				ref={reactFlowWrapper}
			>
				<ResizablePanelGroup
					direction="horizontal"
					autoSaveId="marketing-automation-builder"
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
							{selectedNode ? (
								<NodeInspector
									node={selectedNode}
									onUpdateNodeData={handleUpdateNodeData}
									onSaveNodeData={handleSaveNodeData}
									onDeleteNode={handleDeleteNode}
									onClose={() => setSelectedNodeId(null)}
									errors={validation.nodeErrors[selectedNode.id] || []}
									emailDesignerHeaderExtras={headerExtras}
									emailDesignerContentClassName={
										// Docked AI panel (420px) + the same 8px gutter the
										// designer's own sections use.
										reserveAiPanelWidth ? 'lg:pr-[27.25rem]' : undefined
									}
								/>
							) : (
								<NodePalette onAddNode={handleAddNodeFromPalette} />
							)}
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
							<div className="bg-background h-full w-full overflow-hidden rounded-xl border shadow-sm">
								<ReactFlow
									nodes={nodes}
									edges={edges}
									onNodesChange={onNodesChange}
									onEdgesChange={onEdgesChange}
									onConnect={onConnect}
									isValidConnection={isValidConnection}
									onDragOver={onDragOver}
									onDrop={onDrop}
									onNodeClick={onNodeClick}
									onPaneClick={onPaneClick}
									nodeTypes={nodeTypes}
									edgeTypes={edgeTypes}
									defaultEdgeOptions={{ type: 'workflow' }}
									fitView
									defaultViewport={
										initialData.viewport || { x: 0, y: 0, zoom: 1 }
									}
									minZoom={0.2}
									maxZoom={2}
									snapToGrid
									snapGrid={[16, 16]}
									className="bg-background"
									colorMode="system"
								>
									<Background
										variant={BackgroundVariant.Dots}
										gap={20}
										size={1}
										className="text-muted-foreground/20 opacity-20"
									/>
									<Controls
										position="bottom-right"
										className="bg-card overflow-hidden rounded-md border shadow-sm"
									/>
									<MiniMap
										position="bottom-left"
										zoomable
										pannable
										nodeStrokeWidth={3}
										className="bg-card/90 [&_.react-flow__minimap-mask]:fill-background/80 [&_.react-flow__minimap-node]:fill-muted-foreground/30 !hidden overflow-hidden rounded-xl border shadow-md backdrop-blur-md sm:!block"
									/>
								</ReactFlow>
							</div>
						</div>
					</ResizablePanel>
				</ResizablePanelGroup>
			</div>
		</div>
	)
}

function resolveLocalizedWorkflowConfig(
	workflowConfigProp: WorkflowConfig | undefined,
	localizedTenant: WorkflowConfig,
	localizedPlatform: WorkflowConfig,
): WorkflowConfig {
	if (workflowConfigProp === PLATFORM_WORKFLOW_CONFIG) {
		return localizedPlatform
	}
	if (
		workflowConfigProp === undefined ||
		workflowConfigProp === TENANT_WORKFLOW_CONFIG
	) {
		return localizedTenant
	}
	return workflowConfigProp
}

export function WorkflowCanvas({
	workflowConfig: workflowConfigProp,
	...props
}: WorkflowCanvasProps) {
	const localizedTenant = useLocalizedTenantWorkflowConfig()
	const localizedPlatform = useLocalizedPlatformWorkflowConfig()

	const workflowConfig = useMemo(
		() =>
			resolveLocalizedWorkflowConfig(
				workflowConfigProp,
				localizedTenant,
				localizedPlatform,
			),
		[workflowConfigProp, localizedTenant, localizedPlatform],
	)

	return (
		<WorkflowConfigProvider config={workflowConfig}>
			<ReactFlowProvider>
				<WorkflowCanvasInner {...props} />
			</ReactFlowProvider>
		</WorkflowConfigProvider>
	)
}

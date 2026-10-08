import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import {
	FlowCanvasChrome,
	FlowWorkspace,
	onFlowDragOver,
	readFlowDragData,
	useFlowColorMode,
} from '@repo/flow-editor'
import {
	FLOW_NODE_TYPES,
	FlowGraphSchema,
	validateFlowGraph,
	type FlowGraph,
	type FlowNodeData,
	type FlowNodeType,
	type FlowValidationIssue,
} from '@repo/phone-agent'
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from '@repo/ui/alert-dialog'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from '@repo/ui/popover'
import {
	ReactFlow,
	addEdge,
	useEdgesState,
	useNodesState,
	useReactFlow,
	useUpdateNodeInternals,
	type Connection,
	type Edge,
} from '@xyflow/react'
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type DragEvent,
	type ReactNode,
} from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import {
	useConfirmBlocker,
	useDirtyBeforeUnload,
} from '#app/utils/navigation-guards.ts'
import { FLOW_STEP_META } from './flow-meta.ts'
import {
	FlowEditorContext,
	graphToReactFlow,
	hasDuplicateMenuKeys,
	randomId,
	reactFlowToGraph,
	remapMenuOptionEdges,
	type FlowEditorContextValue,
	type FlowEditorEdge,
	type FlowEditorNode,
} from './flow-model.ts'
import { flowEdgeTypes, flowNodeTypes } from './flow-nodes.tsx'
import { NodeInspector } from './node-inspector.tsx'
import { NodePalette } from './node-palette.tsx'

export type FlowEditorIntent = 'save' | 'publish' | 'reset'

export type FlowEditorProps = {
	initialGraph: FlowGraph
	/** JSON of the last graph the server accepted, used for dirty checks. */
	savedJson: string
	readOnly: boolean
	backHref: string
	testHref: string
	published: { version: number; publishedAt: Date | null } | null
	draftDiffersFromPublished: boolean
	pendingIntent: FlowEditorIntent | null
	/** Issues the server returned for the last publish attempt. */
	serverIssues: { issues: FlowValidationIssue[]; at: number } | null
	onSave: (graph: FlowGraph) => void
	/** Saves the canvas as the draft, then opens `testHref`. */
	onSaveAndTest: (graph: FlowGraph) => void
	onPublish: (graph: FlowGraph) => void
	onReset: () => void
}

/** Canonical JSON for a stored graph, matching what the editor serializes. */
export function canonicalGraphJson(graph: FlowGraph) {
	const { nodes, edges } = graphToReactFlow(graph)
	return JSON.stringify(reactFlowToGraph(nodes, edges, () => ''))
}

function groupIssues(issues: FlowValidationIssue[], key: 'nodeId' | 'edgeId') {
	const map = new Map<string, FlowValidationIssue[]>()
	for (const issue of issues) {
		const id = issue[key]
		if (!id) continue
		map.set(id, [...(map.get(id) ?? []), issue])
	}
	return map
}

// Interpolated so Lingui keeps the braces instead of reading a placeholder.
const BUSINESS_TOKEN = '{business}'

/** Starting content for a step added from the palette. */
function newStepData(
	type: FlowNodeType,
	_: (descriptor: MessageDescriptor) => string,
): Partial<FlowNodeData> {
	switch (type) {
		case 'play_message':
			return { message: _(msg`Thanks for calling ${BUSINESS_TOKEN}.`) }
		case 'keypad_menu':
			return {
				message: _(msg`To speak with our team, press 1.`),
				options: [{ key: '1', label: _(msg`Speak with our team`) }],
				repeat: 2,
			}
		case 'text_link':
			return {
				message: _(msg`We just sent you a text with a link to our website.`),
			}
		case 'transfer':
			return { message: _(msg`Please hold while we connect you.`) }
		case 'voicemail':
			return {
				message: _(
					msg`Please leave your name, number, and message after this, then press pound or hang up.`,
				),
			}
		case 'hang_up':
			return { message: _(msg`Thanks for calling. Goodbye!`) }
		default:
			return {}
	}
}

export function FlowEditor({
	initialGraph,
	savedJson,
	readOnly,
	backHref,
	testHref,
	published,
	draftDiffersFromPublished,
	pendingIntent,
	serverIssues,
	onSave,
	onSaveAndTest,
	onPublish,
	onReset,
}: FlowEditorProps) {
	const { _, i18n } = useLingui()
	const { screenToFlowPosition, fitView, getNode } = useReactFlow<
		FlowEditorNode,
		FlowEditorEdge
	>()
	const updateNodeInternals = useUpdateNodeInternals()
	const colorMode = useFlowColorMode()
	const canvasRef = useRef<HTMLDivElement>(null)

	const initial = useMemo(() => graphToReactFlow(initialGraph), [initialGraph])
	const [nodes, setNodes, onNodesChange] = useNodesState<FlowEditorNode>(
		initial.nodes,
	)
	const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEditorEdge>(
		initial.edges,
	)
	const [issuesOpen, setIssuesOpen] = useState(false)
	const [resetOpen, setResetOpen] = useState(false)

	const fallbackLabel = useCallback(
		(type: FlowNodeType) => _(FLOW_STEP_META[type].defaultLabel),
		[_],
	)

	const graph = useMemo(
		() => reactFlowToGraph(nodes, edges, fallbackLabel),
		[nodes, edges, fallbackLabel],
	)
	const graphJson = useMemo(() => JSON.stringify(graph), [graph])
	const dirty = graphJson !== savedJson
	// Keyed by content so dragging a node doesn't re-render every node and edge
	// through the context when the issues themselves haven't changed.
	const issuesJson = useMemo(
		() => JSON.stringify(validateFlowGraph(graph)),
		[graph],
	)
	const issues = useMemo(
		() => JSON.parse(issuesJson) as FlowValidationIssue[],
		[issuesJson],
	)

	useDirtyBeforeUnload(dirty)
	useConfirmBlocker(
		({ currentLocation, nextLocation }) =>
			dirty && currentLocation.pathname !== nextLocation.pathname,
		_(msg`You have unsaved changes to the call flow. Leave without saving?`),
	)

	useEffect(() => {
		if (serverIssues?.issues.length) setIssuesOpen(true)
	}, [serverIssues])

	const nodeTypeKey = nodes.map((node) => `${node.id}:${node.type}`).join('|')
	const nodeTypeById = useMemo(
		() =>
			new Map(
				nodeTypeKey
					.split('|')
					.filter(Boolean)
					.map((entry) => {
						const index = entry.lastIndexOf(':')
						return [
							entry.slice(0, index),
							entry.slice(index + 1) as FlowNodeType,
						] as const
					}),
			),
		[nodeTypeKey],
	)

	const selectEdge = useCallback(
		(edgeId: string) => {
			setNodes((current) =>
				current.map((node) =>
					node.selected ? { ...node, selected: false } : node,
				),
			)
			setEdges((current) =>
				current.map((edge) => ({ ...edge, selected: edge.id === edgeId })),
			)
		},
		[setEdges, setNodes],
	)

	const selectNode = useCallback(
		(nodeId: string) => {
			setEdges((current) =>
				current.map((edge) =>
					edge.selected ? { ...edge, selected: false } : edge,
				),
			)
			setNodes((current) =>
				current.map((node) => ({ ...node, selected: node.id === nodeId })),
			)
			void fitView({ nodes: [{ id: nodeId }], duration: 300, maxZoom: 1.2 })
		},
		[fitView, setEdges, setNodes],
	)

	const clearSelection = useCallback(() => {
		setNodes((current) =>
			current.map((node) =>
				node.selected ? { ...node, selected: false } : node,
			),
		)
		setEdges((current) =>
			current.map((edge) =>
				edge.selected ? { ...edge, selected: false } : edge,
			),
		)
	}, [setEdges, setNodes])

	const deleteEdge = useCallback(
		(edgeId: string) => {
			setEdges((current) => current.filter((edge) => edge.id !== edgeId))
		},
		[setEdges],
	)

	const contextValue = useMemo<FlowEditorContextValue>(
		() => ({
			readOnly,
			issuesByNode: groupIssues(issues, 'nodeId'),
			issuesByEdge: groupIssues(issues, 'edgeId'),
			deleteEdge,
		}),
		[readOnly, issues, deleteEdge],
	)

	const selectedNode = nodes.find((node) => node.selected) ?? null

	const isValidConnection = useCallback(
		(connection: Connection | Edge) => {
			if (readOnly) return false
			if (connection.source === connection.target) return false
			const sourceType = nodeTypeById.get(connection.source)
			const targetType = nodeTypeById.get(connection.target)
			if (!sourceType || !targetType) return false
			if (targetType === 'start') return false
			if (sourceType === 'hang_up' || sourceType === 'ai_agent') return false
			// Every output (keypad option, Open, No answer...) leads to one step.
			const handle = connection.sourceHandle ?? null
			return !edges.some(
				(edge) =>
					edge.source === connection.source &&
					(edge.sourceHandle ?? null) === handle,
			)
		},
		[edges, nodeTypeById, readOnly],
	)

	const onConnect = useCallback(
		(connection: Connection) => {
			if (!isValidConnection(connection)) return
			const edge: FlowEditorEdge = {
				id: randomId('edge'),
				source: connection.source,
				target: connection.target,
				sourceHandle: connection.sourceHandle ?? null,
				type: 'flow',
				data: {},
			}
			setEdges((current) => addEdge(edge, current))
		},
		[isValidConnection, setEdges],
	)

	const addNode = useCallback(
		(type: FlowNodeType, dropPosition?: { x: number; y: number }) => {
			if (readOnly || type === 'start') return
			const rect = canvasRef.current?.getBoundingClientRect()
			const center = screenToFlowPosition({
				x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
				y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
			})
			const jitter = () => Math.round((Math.random() - 0.5) * 80)
			const position = dropPosition ?? {
				x: center.x - 140 + jitter(),
				y: center.y - 40 + jitter(),
			}
			const data: FlowNodeData = {
				label: _(FLOW_STEP_META[type].defaultLabel),
				...newStepData(type, _),
			}
			const node: FlowEditorNode = {
				id: randomId(type),
				type,
				position,
				data,
				selected: true,
			}
			setEdges((current) =>
				current.map((edge) =>
					edge.selected ? { ...edge, selected: false } : edge,
				),
			)
			setNodes((current) => [
				...current.map((n) => (n.selected ? { ...n, selected: false } : n)),
				node,
			])
		},
		[_, readOnly, screenToFlowPosition, setEdges, setNodes],
	)

	const onDrop = useCallback(
		(event: DragEvent) => {
			event.preventDefault()
			const dropped = readFlowDragData(event)
			const type = FLOW_NODE_TYPES.find((value) => value === dropped?.type)
			if (!type) return
			addNode(
				type,
				screenToFlowPosition({ x: event.clientX, y: event.clientY }),
			)
		},
		[addNode, screenToFlowPosition],
	)

	const updateNode = useCallback(
		(nodeId: string, patch: Partial<FlowNodeData>) => {
			if (patch.options) {
				const nextOptions = patch.options
				if (hasDuplicateMenuKeys(nextOptions)) return
				const previousOptions = getNode(nodeId)?.data.options ?? []
				setEdges((current) =>
					remapMenuOptionEdges(current, nodeId, previousOptions, nextOptions),
				)
			}
			setNodes((current) =>
				current.map((node) =>
					node.id === nodeId
						? { ...node, data: { ...node.data, ...patch } }
						: node,
				),
			)
			// Option handles are keyed by the menu key, so React Flow has to
			// re-measure them or edges keep pointing at the old handle positions.
			if (patch.options) updateNodeInternals(nodeId)
		},
		[getNode, setEdges, setNodes, updateNodeInternals],
	)

	const deleteNode = useCallback(
		(nodeId: string) => {
			setNodes((current) =>
				current.filter((node) => node.id !== nodeId || node.type === 'start'),
			)
			setEdges((current) =>
				current.filter(
					(edge) =>
						nodeTypeById.get(nodeId) === 'start' ||
						(edge.source !== nodeId && edge.target !== nodeId),
				),
			)
		},
		[nodeTypeById, setEdges, setNodes],
	)

	const checkSchema = () => {
		const result = FlowGraphSchema.safeParse(graph)
		if (result.success) return result.data
		const first = result.error.issues[0]
		toast.error(_(msg`This call flow can't be saved yet`), {
			description: first
				? `${first.path.join('.')}: ${first.message}`
				: undefined,
		})
		return null
	}

	const handleSave = () => {
		const parsed = checkSchema()
		if (parsed) onSave(graph)
	}

	const handleSaveAndTest = () => {
		const parsed = checkSchema()
		if (parsed) onSaveAndTest(graph)
	}

	const handlePublish = () => {
		if (issues.length) {
			setIssuesOpen(true)
			toast.error(_(msg`Fix the issues in the call flow before publishing.`))
			return
		}
		const parsed = checkSchema()
		if (parsed) onPublish(graph)
	}

	const busy = pendingIntent !== null
	const listedIssues = issues.length ? issues : (serverIssues?.issues ?? [])

	const publishedVersion = published?.version
	const issueCount = listedIssues.length
	let status: ReactNode
	if (pendingIntent === 'save') status = <Trans>Saving…</Trans>
	else if (pendingIntent === 'publish') status = <Trans>Publishing…</Trans>
	else if (pendingIntent === 'reset') status = <Trans>Resetting…</Trans>
	else if (dirty) status = <Trans>Unsaved changes</Trans>
	else if (published && !draftDiffersFromPublished) {
		status = <Trans>Published v{publishedVersion}</Trans>
	} else if (published) {
		status = <Trans>Draft saved · v{publishedVersion} is live</Trans>
	} else {
		status = <Trans>Draft saved · not published yet</Trans>
	}

	return (
		<FlowEditorContext.Provider value={contextValue}>
			<div className="bg-muted flex h-full w-full flex-col overflow-hidden">
				<header className="bg-background flex flex-wrap items-center gap-3 border-b px-3 py-2">
					<Button
						variant="ghost"
						size="icon-sm"
						render={<Link to={backHref} />}
						aria-label={_(msg`Back to phone agent`)}
					>
						<Icon name="arrow-left" />
					</Button>
					<div className="min-w-0 flex-1">
						<h1 className="text-foreground truncate text-sm font-semibold">
							<Trans>Call flow</Trans>
						</h1>
						<p
							className="text-muted-foreground truncate text-xs"
							aria-live="polite"
							title={
								published?.publishedAt
									? i18n.date(published.publishedAt, {
											dateStyle: 'medium',
											timeStyle: 'short',
										})
									: undefined
							}
						>
							{status}
						</p>
					</div>

					{readOnly ? (
						<Badge variant="secondary">
							<Trans>View only</Trans>
						</Badge>
					) : null}

					<Popover open={issuesOpen} onOpenChange={setIssuesOpen}>
						<PopoverTrigger
							render={
								<Button
									variant={listedIssues.length ? 'destructive' : 'ghost'}
									size="sm"
								/>
							}
						>
							<Icon name={listedIssues.length ? 'alert-triangle' : 'check'} />
							{listedIssues.length ? (
								<Trans>{issueCount} to fix</Trans>
							) : (
								<Trans>Ready</Trans>
							)}
						</PopoverTrigger>
						<PopoverContent align="end" className="w-80">
							<PopoverHeader>
								<PopoverTitle>
									{listedIssues.length ? (
										<Trans>Fix before publishing</Trans>
									) : (
										<Trans>No issues found</Trans>
									)}
								</PopoverTitle>
								<PopoverDescription>
									{listedIssues.length ? (
										<Trans>Select an issue to jump to its step.</Trans>
									) : (
										<Trans>This call flow is ready to publish.</Trans>
									)}
								</PopoverDescription>
							</PopoverHeader>
							{listedIssues.length ? (
								<ul className="max-h-72 space-y-1 overflow-y-auto">
									{listedIssues.map((issue, index) => (
										<li key={`${issue.code}-${index}`}>
											<button
												type="button"
												className="hover:bg-muted flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-start text-xs"
												onClick={() => {
													if (issue.nodeId) selectNode(issue.nodeId)
													else if (issue.edgeId) selectEdge(issue.edgeId)
													setIssuesOpen(false)
												}}
											>
												<Icon
													name="alert-triangle"
													size="xs"
													className="text-destructive mt-0.5 shrink-0"
												/>
												<span className="text-foreground">{issue.message}</span>
											</button>
										</li>
									))}
								</ul>
							) : null}
						</PopoverContent>
					</Popover>

					{dirty && !readOnly ? (
						// A test call runs the saved draft, so save the canvas first.
						<Button
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={handleSaveAndTest}
						>
							<Icon name="play" />
							<Trans>Save and test</Trans>
						</Button>
					) : (
						<Button variant="outline" size="sm" render={<Link to={testHref} />}>
							<Icon name="play" />
							<Trans>Test this draft</Trans>
						</Button>
					)}

					{readOnly ? null : (
						<>
							<Button
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={() => setResetOpen(true)}
							>
								<Icon name="undo-2" />
								{published ? (
									<Trans>Reset to published</Trans>
								) : (
									<Trans>Reset to default</Trans>
								)}
							</Button>
							<Button
								variant="outline"
								size="sm"
								disabled={busy || !dirty}
								onClick={handleSave}
							>
								<Trans>Save draft</Trans>
							</Button>
							<Button size="sm" disabled={busy} onClick={handlePublish}>
								<Icon name="send" />
								<Trans>Publish</Trans>
							</Button>
						</>
					)}
				</header>

				<FlowWorkspace
					autoSaveId="phone-agent-flow-editor"
					sidebar={
						selectedNode ? (
							<NodeInspector
								key={selectedNode.id}
								node={selectedNode}
								issues={contextValue.issuesByNode.get(selectedNode.id) ?? []}
								readOnly={readOnly}
								onUpdate={updateNode}
								onDelete={deleteNode}
								onClose={clearSelection}
							/>
						) : (
							<NodePalette readOnly={readOnly} onAdd={addNode} />
						)
					}
				>
					<div ref={canvasRef} className="h-full w-full">
						<ReactFlow<FlowEditorNode, FlowEditorEdge>
							nodes={nodes}
							edges={edges}
							onNodesChange={onNodesChange}
							onEdgesChange={onEdgesChange}
							onConnect={onConnect}
							isValidConnection={isValidConnection}
							onDragOver={onFlowDragOver}
							onDrop={onDrop}
							nodeTypes={flowNodeTypes}
							edgeTypes={flowEdgeTypes}
							defaultEdgeOptions={{ type: 'flow' }}
							nodesDraggable={!readOnly}
							nodesConnectable={!readOnly}
							deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
							fitView
							fitViewOptions={{ padding: 0.2 }}
							minZoom={0.2}
							maxZoom={2}
							snapToGrid
							snapGrid={[16, 16]}
							className="bg-background"
							colorMode={colorMode}
						>
							<FlowCanvasChrome showInteractive={false} />
						</ReactFlow>
					</div>
				</FlowWorkspace>
			</div>

			<AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{published ? (
								<Trans>Reset to the published call flow?</Trans>
							) : (
								<Trans>Reset to the default call flow?</Trans>
							)}
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								This replaces your draft, including unsaved changes. It can't be
								undone.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Cancel</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => {
								setResetOpen(false)
								onReset()
							}}
						>
							<Trans>Reset draft</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</FlowEditorContext.Provider>
	)
}

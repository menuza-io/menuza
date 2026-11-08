import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers'
import type {
	MarketingJourneyWorkflowEnv,
	MarketingJourneyWorkflowParams,
	WorkflowGraph,
	WorkflowNode,
	DelayNodeData,
	ConditionNodeData,
} from './types'

/**
 * tenant-api answers 409 while another attempt holds a step's five-minute
 * processing lease (it may be sending right now). The retries must outlast
 * that lease, so a step whose attempt died before sending is reclaimed and
 * sent instead of failing the run: 30 s, 1, 2, 4 and 8 minutes.
 */
export const ACTION_STEP_RETRIES = {
	limit: 5,
	delay: '30 seconds',
	backoff: 'exponential',
} as const

export class MarketingJourneyWorkflow extends WorkflowEntrypoint<
	MarketingJourneyWorkflowEnv,
	MarketingJourneyWorkflowParams
> {
	private getTenantApiBase(
		params: MarketingJourneyWorkflowParams,
		env: MarketingJourneyWorkflowEnv,
	): string {
		if (params.tenantApiUrl && params.tenantApiUrl.trim().length > 0) {
			return params.tenantApiUrl.replace(/\/$/, '')
		}

		const isKsa = (params.dataRegion || '').toLowerCase() === 'ksa'
		const defaultUrl = isKsa
			? env.TENANT_API_URL_KSA || 'http://localhost:3009'
			: env.TENANT_API_URL || 'http://localhost:3007'

		return defaultUrl.replace(/\/$/, '')
	}

	private normalizeGraph(
		rawGraph: WorkflowGraph | string | undefined | null,
	): WorkflowGraph {
		if (!rawGraph) {
			return { nodes: [], edges: [] }
		}

		let parsed: any = rawGraph
		if (typeof rawGraph === 'string') {
			try {
				parsed = JSON.parse(rawGraph)
			} catch {
				return { nodes: [], edges: [] }
			}
		}

		if (!parsed || typeof parsed !== 'object') {
			return { nodes: [], edges: [] }
		}

		return {
			nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
			edges: Array.isArray(parsed.edges) ? parsed.edges : [],
			viewport: parsed.viewport,
		}
	}

	async run(
		event: WorkflowEvent<MarketingJourneyWorkflowParams>,
		step: WorkflowStep,
	): Promise<{
		status: 'completed' | 'cancelled' | 'failed'
		executedSteps: number
	}> {
		const params = event.payload
		const env = this.env

		const orgId = params.orgId || params.tenantId || ''
		const journeyId = params.journeyId || ''
		const runId =
			params.runId ||
			params.journeyInstanceId ||
			(event as { instanceId?: string }).instanceId ||
			'unknown-run'
		const customerId = params.customerId || ''
		const tenantApiBase = this.getTenantApiBase(params, env)

		const graph = this.normalizeGraph(params.graph || params.journeyGraph)

		if (!graph.nodes || graph.nodes.length === 0) {
			await step.do(`complete-${runId}`, async () => {
				await fetch(`${tenantApiBase}/api/journeys/complete-run`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${env.INTERNAL_COMMAND_TOKEN}`,
					},
					body: JSON.stringify({
						orgId,
						runId,
						status: 'completed',
					}),
				}).catch(() => {})
			})
			return { status: 'completed', executedSteps: 0 }
		}

		// Find start / trigger root node
		let startNode: WorkflowNode | undefined = graph.nodes.find(
			(n) => n.type === 'trigger',
		)

		if (!startNode) {
			// If no explicit trigger node, look for node with in-degree 0
			const targetIds = new Set((graph.edges || []).map((e) => e.target))
			startNode =
				graph.nodes.find((n) => !targetIds.has(n.id)) || graph.nodes[0]
		}

		let currentNodeId: string | null = startNode?.id || null
		let stepCount = 0
		// tenant-api answers `halted` once the journey is paused or the run has
		// ended: nothing was sent and the run stops there (tenant-api already
		// marked it cancelled).
		let halted = false
		const visited = new Set<string>()
		const maxSteps = 500

		try {
			while (currentNodeId && stepCount < maxSteps) {
				const node = graph.nodes.find((n) => n.id === currentNodeId)
				if (!node) {
					break
				}

				visited.add(currentNodeId)
				stepCount++
				let branchHandle: string | null = null

				switch (node.type) {
					case 'trigger': {
						await step.do(`step-${node.id}-trigger`, async () => {
							return {
								nodeId: node.id,
								triggerType:
									(node.data as { triggerType?: string })?.triggerType ||
									params.triggerEvent ||
									'manual',
								triggeredAt: new Date().toISOString(),
							}
						})
						break
					}

					case 'delay': {
						const delayData = (node.data || {}) as DelayNodeData
						const duration = delayData.duration ?? delayData.delayValue ?? 1
						const unit = delayData.unit ?? delayData.delayUnit ?? 'minutes'
						const durationString = `${duration} ${unit}`

						// Durable sleep across Cloudflare Workers infrastructure
						await step.sleep(`delay-${node.id}`, durationString as any)
						break
					}

					case 'action_email':
					case 'action_sms':
					case 'action':
					case 'email':
					case 'sms': {
						let nodeType: string = node.type
						if (nodeType === 'action') {
							const channel = (node.data as { channel?: string })?.channel
							nodeType = channel === 'sms' ? 'action_sms' : 'action_email'
						} else if (nodeType === 'email') {
							nodeType = 'action_email'
						} else if (nodeType === 'sms') {
							nodeType = 'action_sms'
						}

						const actionResult = await step.do(
							`action-${node.id}`,
							{
								retries: ACTION_STEP_RETRIES,
								timeout: '2 minutes',
							},
							async () => {
								const res = await fetch(
									`${tenantApiBase}/api/journeys/execute-step`,
									{
										method: 'POST',
										headers: {
											'Content-Type': 'application/json',
											Authorization: `Bearer ${env.INTERNAL_COMMAND_TOKEN}`,
										},
										body: JSON.stringify({
											orgId,
											journeyId,
											runId,
											customerId,
											nodeId: node.id,
											nodeType,
											config: node.data || {},
										}),
									},
								)

								if (!res.ok) {
									const errorText = await res.text().catch(() => '')
									throw new Error(
										`Action step execution (${node.id}) failed with HTTP ${res.status}: ${errorText}`,
									)
								}

								return (await res.json()) as {
									success: boolean
									executionId?: string
									status?: string
									messageId?: string
								}
							},
						)
						if (actionResult?.status === 'halted') halted = true
						break
					}

					case 'condition': {
						const conditionData = (node.data || {}) as ConditionNodeData
						const evalResult = await step.do(
							`eval-condition-${node.id}`,
							{
								retries: { limit: 2, delay: '5 seconds' },
								timeout: '1 minute',
							},
							async () => {
								// A transport error or a 5xx throws so the step is retried:
								// returning a value would be recorded as this step's
								// answer for good. After the last retry the step throws,
								// and the run ends as failed below instead of taking a
								// branch nobody evaluated.
								const res = await fetch(
									`${tenantApiBase}/api/journeys/evaluate-condition`,
									{
										method: 'POST',
										headers: {
											'Content-Type': 'application/json',
											Authorization: `Bearer ${env.INTERNAL_COMMAND_TOKEN}`,
										},
										body: JSON.stringify({
											orgId,
											journeyId,
											runId,
											customerId,
											nodeId: node.id,
											condition: conditionData,
										}),
									},
								)

								if (
									res.status >= 500 ||
									res.status === 408 ||
									res.status === 429
								) {
									const errorText = await res.text().catch(() => '')
									throw new Error(
										`Condition evaluation (${node.id}) failed with HTTP ${res.status}: ${errorText}`,
									)
								}

								if (!res.ok) {
									// A definitive refusal (unknown customer or run, bad
									// condition): fail closed to the "false" branch.
									return { result: false, halted: false }
								}

								const data = (await res.json()) as {
									result?: boolean
									halted?: boolean
								}
								return {
									result: data.result === true,
									halted: data.halted === true,
								}
							},
						)

						if (evalResult.halted) {
							halted = true
							break
						}
						branchHandle = evalResult.result ? 'true' : 'false'
						break
					}
				}

				if (halted) break

				// Resolve next node in graph
				const outgoingEdges = (graph.edges || []).filter(
					(e) => e.source === currentNodeId,
				)

				if (outgoingEdges.length === 0) {
					currentNodeId = null
				} else if (branchHandle) {
					const matchingEdge = outgoingEdges.find((e) => {
						const handle = (e.sourceHandle || '').toLowerCase()
						if (branchHandle === 'true') {
							return (
								handle === 'true' ||
								handle === 'yes' ||
								handle === '1' ||
								handle === 'success'
							)
						} else {
							return (
								handle === 'false' ||
								handle === 'no' ||
								handle === '0' ||
								handle === 'failure'
							)
						}
					})
					currentNodeId = matchingEdge
						? matchingEdge.target
						: outgoingEdges[0]?.target || null
				} else {
					currentNodeId = outgoingEdges[0]?.target || null
				}

				if (currentNodeId && visited.has(currentNodeId)) {
					// Cycle detected; terminate traversal safely
					break
				}
			}

			if (halted) {
				return { status: 'cancelled', executedSteps: stepCount }
			}

			// Finalize successful workflow run
			await step.do(`complete-${runId}`, async () => {
				const res = await fetch(`${tenantApiBase}/api/journeys/complete-run`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${env.INTERNAL_COMMAND_TOKEN}`,
					},
					body: JSON.stringify({
						orgId,
						runId,
						status: 'completed',
					}),
				})

				if (!res.ok) {
					const errorText = await res.text().catch(() => '')
					console.warn(
						`Failed to record complete-run (${res.status}): ${errorText}`,
					)
				}

				return { success: true }
			})

			return { status: 'completed', executedSteps: stepCount }
		} catch (error) {
			// Finalize failed workflow run
			try {
				await step.do(`fail-${runId}`, async () => {
					await fetch(`${tenantApiBase}/api/journeys/complete-run`, {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${env.INTERNAL_COMMAND_TOKEN}`,
						},
						body: JSON.stringify({
							orgId,
							runId,
							status: 'failed',
							errorMessage:
								error instanceof Error ? error.message : String(error),
						}),
					}).catch(() => {})
				})
			} catch {}

			throw error
		}
	}
}

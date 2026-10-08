import { msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type FlowGraph, type FlowValidationIssue } from '@repo/phone-agent'
import { ReactFlowProvider } from '@xyflow/react'
import { useEffect, useState } from 'react'
import { useFetcher, useLoaderData, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import {
	FlowEditor,
	canonicalGraphJson,
	type FlowEditorIntent,
} from '#app/components/phone-agent/flow-editor/flow-canvas.tsx'
import {
	type action,
	type FlowActionResult,
	type loader,
} from './flow.server.ts'

export { action, loader } from './flow.server.ts'

export default function PhoneAgentFlowRoute() {
	const { _ } = useLingui()
	const { orgSlug } = useParams()
	const data = useLoaderData<typeof loader>()
	const fetcher = useFetcher<typeof action>()
	const navigate = useNavigate()
	const testHref = `/${orgSlug}/phone-agent/test?flow=draft`
	const [testAfterSave, setTestAfterSave] = useState(false)

	const [editorKey, setEditorKey] = useState(0)
	const [initialGraph, setInitialGraph] = useState<FlowGraph>(data.draftGraph)
	const [savedJson, setSavedJson] = useState(() =>
		canonicalGraphJson(data.draftGraph),
	)
	const [serverIssues, setServerIssues] = useState<{
		issues: FlowValidationIssue[]
		at: number
	} | null>(null)
	const [pending, setPending] = useState<{
		intent: FlowEditorIntent
		json?: string
		previousData: unknown
		thenTest?: boolean
	} | null>(null)

	useEffect(() => {
		if (fetcher.state !== 'idle' || !fetcher.data || !pending) return
		// Ignore the previous submission's result until this one settles.
		if (fetcher.data === pending.previousData) return
		const submitted = pending
		setPending(null)
		const result = fetcher.data as FlowActionResult
		if (!result.ok) {
			if (result.issues?.length) {
				setServerIssues({ issues: result.issues, at: Date.now() })
			}
			toast.error(result.error)
			return
		}
		setServerIssues(null)
		switch (result.intent) {
			case 'save':
				if (submitted.json) setSavedJson(submitted.json)
				toast.success(_(msg`Draft saved`))
				if (submitted.thenTest) setTestAfterSave(true)
				break
			case 'publish': {
				if (submitted.json) setSavedJson(submitted.json)
				const version = result.version
				toast.success(_(msg`Published version ${version}`))
				break
			}
			case 'reset':
				setInitialGraph(result.graph)
				setSavedJson(canonicalGraphJson(result.graph))
				setEditorKey((key) => key + 1)
				toast.success(_(msg`Draft reset`))
				break
		}
	}, [_, fetcher.data, fetcher.state, pending])

	// Navigates in a later commit than the save result, once the editor has
	// re-rendered with the new saved graph, so its leave warning doesn't fire.
	useEffect(() => {
		if (!testAfterSave) return
		setTestAfterSave(false)
		void navigate(testHref)
	}, [navigate, testAfterSave, testHref])

	const submit = (
		intent: FlowEditorIntent,
		graph?: FlowGraph,
		thenTest = false,
	) => {
		setPending({
			intent,
			json: graph ? JSON.stringify(graph) : undefined,
			previousData: fetcher.data,
			thenTest,
		})
		void fetcher.submit(graph ? { intent, graph } : { intent }, {
			method: 'POST',
			encType: 'application/json',
		})
	}

	return (
		<div className="bg-muted fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden">
			<ReactFlowProvider key={editorKey}>
				<FlowEditor
					initialGraph={initialGraph}
					savedJson={savedJson}
					readOnly={!data.canUpdate}
					backHref={`/${orgSlug}/phone-agent`}
					testHref={testHref}
					published={data.published}
					draftDiffersFromPublished={data.draftDiffersFromPublished}
					pendingIntent={
						fetcher.state === 'idle' ? null : (pending?.intent ?? null)
					}
					serverIssues={serverIssues}
					onSave={(graph) => submit('save', graph)}
					onSaveAndTest={(graph) => submit('save', graph, true)}
					onPublish={(graph) => submit('publish', graph)}
					onReset={() => submit('reset')}
				/>
			</ReactFlowProvider>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}

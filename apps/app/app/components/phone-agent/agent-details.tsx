import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type PhoneAgentSettings } from '@repo/phone-agent'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from '@repo/ui/collapsible'
import { Icon } from '@repo/ui/icon'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { useEffect, useState } from 'react'
import { useFetcher, useLocation, useParams } from 'react-router'
import { type loader as detailsLoader } from '#app/routes/_app+/$orgSlug_+/phone-agent+/details.server.ts'
import { formatDateTime } from './call-data.ts'
import { useVerticalLabels } from './vertical-labels.ts'

function useDetailsFetcher() {
	return useFetcher<typeof detailsLoader>()
}

type DetailsData = NonNullable<ReturnType<typeof useDetailsFetcher>['data']>
type HistoryEntry = DetailsData['history'][number]

const SETTING_LABELS: Record<keyof PhoneAgentSettings, MessageDescriptor> = {
	enabled: msg`Agent on or off`,
	agentName: msg`Agent name`,
	languages: msg`Languages`,
	voiceId: msg`Voice`,
	greeting: msg`Greeting`,
	closing: msg`Closing`,
	recordCalls: msg`Call recording`,
	recordingRetentionDays: msg`Recording retention`,
	autoEscalate: msg`Staff transfers`,
	escalationPhone: msg`Staff phone`,
	afterHoursMode: msg`After-hours calls`,
	maxCallMinutes: msg`Maximum call length`,
	faq: msg`FAQ answers`,
	pronunciations: msg`Pronunciations`,
	keyterms: msg`Key terms`,
	phrases: msg`Phrases`,
	contacts: msg`Transfer contacts`,
	transferCases: msg`Transfer cases`,
	transfers: msg`Transfer options`,
	notifications: msg`Staff alerts`,
	safety: msg`On/off switches`,
	tags: msg`Tags`,
	followUp: msg`Follow-up`,
	csatEnabled: msg`Call ratings`,
	business: msg`Business details`,
	vertical: msg`Business type settings`,
}

function settingLabel(
	key: string,
	translate: (descriptor: MessageDescriptor) => string,
) {
	const descriptor = (SETTING_LABELS as Record<string, MessageDescriptor>)[key]
	return descriptor ? translate(descriptor) : key
}

/**
 * The assistant's instructions and the change history, folded away at the
 * bottom of the Agent page and loaded only when opened.
 */
export function AgentDetails() {
	const { orgSlug = '' } = useParams()
	const location = useLocation()
	const [open, setOpen] = useState(location.hash === '#details')
	const [query, setQuery] = useState<{ scope?: string; state?: string }>({})
	const fetcher = useDetailsFetcher()
	const search = new URLSearchParams(
		Object.entries(query).filter((entry): entry is [string, string] =>
			Boolean(entry[1]),
		),
	).toString()
	const href = `/${orgSlug}/phone-agent/details${search ? `?${search}` : ''}`
	const { load } = fetcher
	useEffect(() => {
		if (open) void load(href)
	}, [open, href, load])
	const data = fetcher.data

	return (
		<Collapsible open={open} onOpenChange={setOpen}>
			<section id="details" className="flex scroll-mt-6 flex-col gap-6">
				<CollapsibleTrigger
					render={
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="-ms-2 self-start"
						/>
					}
				>
					<Icon name={open ? 'chevron-down' : 'chevron-right'} />
					<Trans>Behind the scenes</Trans>
				</CollapsibleTrigger>
				<CollapsibleContent>
					{data ? (
						<AnnotatedLayout>
							<PromptPreview
								preview={data.preview}
								scopes={data.scopes}
								setParam={(key, value) =>
									setQuery((current) => ({ ...current, [key]: value }))
								}
							/>
							<HistorySection history={data.history} />
						</AnnotatedLayout>
					) : (
						<p role="status" className="text-muted-foreground text-sm">
							<Trans>Loading…</Trans>
						</p>
					)}
				</CollapsibleContent>
			</section>
		</Collapsible>
	)
}

function PromptPreview({
	preview,
	scopes,
	setParam,
}: {
	preview: DetailsData['preview']
	scopes: DetailsData['scopes']
	setParam: (key: 'scope' | 'state', value: string) => void
}) {
	const { _ } = useLingui()
	const { scope } = useVerticalLabels()
	const states = [
		{ value: 'open', label: _(msg`While open`) },
		{ value: 'closed', label: _(msg`While closed`) },
	]
	const state = preview ? (preview.isOpen ? 'open' : 'closed') : 'open'

	return (
		<AnnotatedSection
			title={<Trans>What the assistant is told</Trans>}
			description={
				<Trans>
					The instructions the AI assistant gets at the start of a call, built
					from your settings, answers, and training rules. Saved changes show up
					here.
				</Trans>
			}
		>
			<Card>
				<CardContent className="flex flex-col gap-4">
					{preview ? (
						<>
							<div className="flex flex-wrap gap-3">
								{scope && scopes.length > 1 && preview.scopeId ? (
									<Select
										value={preview.scopeId}
										items={scopes.map((item) => ({
											value: item.id,
											label: item.name,
										}))}
										onValueChange={(value) => {
											if (value) setParam('scope', String(value))
										}}
									>
										<SelectTrigger aria-label={scope.label} className="w-48">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{scopes.map((item) => (
												<SelectItem key={item.id} value={item.id}>
													{item.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								) : null}
								<Select
									value={state}
									items={states}
									onValueChange={(value) => {
										if (value) setParam('state', String(value))
									}}
								>
									<SelectTrigger
										aria-label={_(msg`Business hours`)}
										className="w-40"
									>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{states.map((item) => (
											<SelectItem key={item.value} value={item.value}>
												{item.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() =>
										void navigator.clipboard?.writeText(preview.text)
									}
								>
									<Trans>Copy</Trans>
								</Button>
							</div>
							<pre
								className="bg-muted text-foreground max-h-96 overflow-auto rounded-md p-4 text-xs whitespace-pre-wrap"
								tabIndex={0}
								aria-label={_(msg`Assistant instructions`)}
							>
								{preview.text}
							</pre>
						</>
					) : (
						<p className="text-muted-foreground text-sm">
							<Trans>
								Add your business details to see what the assistant is told.
							</Trans>
						</p>
					)}
				</CardContent>
			</Card>
		</AnnotatedSection>
	)
}

function HistorySection({ history }: { history: HistoryEntry[] }) {
	const { _, i18n } = useLingui()

	function describe(entry: HistoryEntry) {
		if (entry.kind === 'flow') {
			const version = entry.version
			return version != null
				? _(msg`Published call flow version ${version}`)
				: _(msg`Published the call flow`)
		}
		if (entry.kind === 'training') {
			const title = entry.title ?? ''
			switch (entry.change) {
				case 'deleted':
					return _(msg`Deleted training rule "${title}"`)
				case 'activated':
					return _(msg`Turned on training rule "${title}"`)
				case 'deactivated':
					return _(msg`Turned off training rule "${title}"`)
				default:
					return _(msg`Saved training rule "${title}"`)
			}
		}
		const sections = entry.keys.map((key) => settingLabel(key, _)).join(', ')
		return _(msg`Changed ${sections}`)
	}

	return (
		<AnnotatedSection
			title={<Trans>Change history</Trans>}
			description={
				<Trans>
					Who changed the phone agent and when. Shows the last 50 changes.
				</Trans>
			}
		>
			<Card>
				<CardContent>
					{history.length ? (
						<ol className="flex flex-col divide-y">
							{history.map((entry) => (
								<li
									key={entry.id}
									className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
								>
									<div className="flex flex-wrap items-center gap-2 text-sm">
										<Badge variant="outline">
											{entry.kind === 'flow' ? (
												<Trans>Call flow</Trans>
											) : entry.kind === 'training' ? (
												<Trans>Training</Trans>
											) : (
												<Trans>Settings</Trans>
											)}
										</Badge>
										<span>{describe(entry)}</span>
									</div>
									<p className="text-muted-foreground text-xs">
										{entry.userName ?? _(msg`Someone`)} ·{' '}
										{formatDateTime(entry.createdAt, i18n.locale)}
									</p>
								</li>
							))}
						</ol>
					) : (
						<p className="text-muted-foreground text-sm">
							<Trans>No changes recorded yet.</Trans>
						</p>
					)}
				</CardContent>
			</Card>
		</AnnotatedSection>
	)
}

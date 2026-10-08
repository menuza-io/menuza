import { type MessageDescriptor } from '@lingui/core'
import { Trans, msg } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { type PhoneAgentSettings } from '@repo/phone-agent'
import { AnnotatedLayout, AnnotatedSection } from '@repo/ui/annotated-layout'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Card, CardContent } from '@repo/ui/card'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@repo/ui/select'
import { Separator } from '@repo/ui/separator'
import { Switch } from '@repo/ui/switch'
import { useState } from 'react'
import { useLoaderData, useSearchParams } from 'react-router'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { BusinessDetailsSection } from '#app/components/phone-agent/business-details-section.tsx'
import { formatDateTime } from '#app/components/phone-agent/call-data.ts'
import {
	SettingsSaveBar,
	useSettingsForm,
} from '#app/components/phone-agent/settings-page.tsx'
import { useVerticalLabels } from '#app/components/phone-agent/vertical-labels.ts'
import { phoneAgentVerticalUi } from '#app/components/phone-agent/vertical-ui.tsx'
import { phoneAgentVertical } from '#app/utils/phone-agent/vertical.ts'
import { type Route } from './+types/advanced.ts'

export { action, loader } from './advanced.server.ts'

type LoaderData = Route.ComponentProps['loaderData']
type HistoryEntry = LoaderData['history'][number]

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
	safety: msg`Safety switches`,
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

export default function PhoneAgentAdvanced() {
	const { _ } = useLingui()
	const data = useLoaderData<LoaderData>()
	const { canUpdate } = data
	const [safety, setSafety] = useState(data.safety)
	const [csatEnabled, setCsatEnabled] = useState(data.csatEnabled)
	const [business, setBusiness] = useState(data.business)
	const [vertical, setVertical] = useState<Record<string, unknown>>(
		data.vertical,
	)
	const editsBusiness = !data.providesBusinessProfile
	const VerticalSection = phoneAgentVerticalUi.SettingsSection
	const editsVertical = Boolean(VerticalSection && phoneAgentVertical.settings)
	const form = useSettingsForm({
		saved: {
			safety: data.safety,
			csatEnabled: data.csatEnabled,
			business: data.business,
			vertical: data.vertical,
		},
		versions: data.versions,
		draft: { safety, csatEnabled, business, vertical },
		reset: (saved) => {
			setSafety(saved.safety)
			setCsatEnabled(saved.csatEnabled)
			setBusiness(saved.business)
			setVertical(saved.vertical)
		},
		canUpdate,
	})
	const { pending, save, fieldErrors } = form
	const disabled = !canUpdate || pending
	const verticalFieldErrors = Object.fromEntries(
		Object.entries(fieldErrors)
			.filter(([key]) => key.startsWith('vertical.'))
			.map(([key, value]) => [key.slice('vertical.'.length), value]),
	)

	return (
		<div className="flex flex-col gap-8">
			<PageHeader
				title={<Trans>Advanced</Trans>}
				description={
					<Trans>
						Safety switches, call ratings, business settings, and what changed
						recently.
					</Trans>
				}
			/>
			<form
				className="flex flex-col gap-8"
				onSubmit={(event) => {
					event.preventDefault()
					save({
						safety,
						csatEnabled,
						...(editsBusiness ? { business } : {}),
						...(editsVertical ? { vertical } : {}),
					})
				}}
			>
				<AnnotatedLayout>
					<AnnotatedSection
						title={<Trans>Safety switches</Trans>}
						description={
							<Trans>
								Use these if something goes wrong. They take effect on the next
								call.
							</Trans>
						}
					>
						<Card>
							<CardContent className="flex flex-col gap-5">
								<div className="flex items-center justify-between gap-4">
									<div className="flex flex-col gap-1">
										<Label htmlFor="safety-calling">
											<Trans>Pause the AI assistant</Trans>
										</Label>
										<p className="text-muted-foreground text-xs">
											<Trans>
												Calls go straight to your business line. If no line is
												known, callers hear an apology.
											</Trans>
										</p>
									</div>
									<Switch
										id="safety-calling"
										checked={safety.callingDisabled}
										disabled={disabled}
										onCheckedChange={(checked) =>
											setSafety((current) => ({
												...current,
												callingDisabled: checked,
											}))
										}
									/>
								</div>
								<div className="flex items-center justify-between gap-4">
									<div className="flex flex-col gap-1">
										<Label htmlFor="safety-transfers">
											<Trans>Pause transfers</Trans>
										</Label>
										<p className="text-muted-foreground text-xs">
											<Trans>
												The agent takes a message instead of transferring, even
												when callers press 0.
											</Trans>
										</p>
									</div>
									<Switch
										id="safety-transfers"
										checked={safety.transfersDisabled}
										disabled={disabled}
										onCheckedChange={(checked) =>
											setSafety((current) => ({
												...current,
												transfersDisabled: checked,
											}))
										}
									/>
								</div>
								{!data.enabled ? (
									<p className="text-muted-foreground text-xs">
										<Trans>
											The agent is off, so these have no effect yet.
										</Trans>
									</p>
								) : null}
							</CardContent>
						</Card>
					</AnnotatedSection>

					{editsBusiness ? (
						<BusinessDetailsSection
							value={business}
							onChange={setBusiness}
							disabled={disabled}
							fieldErrors={fieldErrors}
						/>
					) : null}

					{VerticalSection && editsVertical ? (
						<VerticalSection
							value={vertical}
							onChange={setVertical}
							disabled={disabled}
							data={data.verticalData}
							fieldErrors={verticalFieldErrors}
						/>
					) : null}

					<AnnotatedSection
						title={<Trans>Call ratings</Trans>}
						description={
							<Trans>
								Ask callers to rate the call from 1 to 5 before it ends. Ratings
								and the caller's mood appear on the Calls page and in Reports.
							</Trans>
						}
					>
						<Card>
							<CardContent>
								<div className="flex items-center justify-between gap-4">
									<Label htmlFor="csat-enabled">
										<Trans>Ask for a rating</Trans>
									</Label>
									<Switch
										id="csat-enabled"
										checked={csatEnabled}
										disabled={disabled}
										onCheckedChange={setCsatEnabled}
									/>
								</div>
							</CardContent>
						</Card>
					</AnnotatedSection>
				</AnnotatedLayout>
				<SettingsSaveBar
					canUpdate={canUpdate}
					form={form}
					label={<Trans>Save changes</Trans>}
				/>
			</form>

			<Separator />

			<AnnotatedLayout>
				<PromptPreview preview={data.preview} scopes={data.scopes} />
				<HistorySection history={data.history} />
			</AnnotatedLayout>
		</div>
	)
}

function PromptPreview({
	preview,
	scopes,
}: {
	preview: LoaderData['preview']
	scopes: LoaderData['scopes']
}) {
	const { _ } = useLingui()
	const { scope } = useVerticalLabels()
	const [searchParams, setSearchParams] = useSearchParams()
	const states = [
		{ value: 'open', label: _(msg`While open`) },
		{ value: 'closed', label: _(msg`While closed`) },
	]
	const state = preview ? (preview.isOpen ? 'open' : 'closed') : 'open'

	function setParam(key: string, value: string) {
		const next = new URLSearchParams(searchParams)
		next.set(key, value)
		setSearchParams(next, { preventScrollReset: true, replace: true })
	}

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
				? _(msg`Published phone menu version ${version}`)
				: _(msg`Published the phone menu`)
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
												<Trans>Phone menu</Trans>
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

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}

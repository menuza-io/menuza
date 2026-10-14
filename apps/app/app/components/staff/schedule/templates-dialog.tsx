import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemTitle,
} from '@repo/ui/item'
import { Skeleton } from '@repo/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'
import { TextField } from '#app/components/staff/controls.tsx'
import { SwitchField } from '#app/components/staff/switch-field.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffQuery } from '#app/hooks/use-staff-client.ts'
import {
	applyTemplate,
	createTemplate,
	deleteTemplate,
} from '#app/utils/staffing/schedule-api.ts'
import { describeScheduleError } from '#app/utils/staffing/schedule-errors.ts'
import {
	EMPTY_SCOPE,
	scopeFromState,
	type ScopeState,
} from '#app/utils/staffing/schedule-form.ts'
import {
	templatesSchema,
	type ScheduleWeek,
} from '#app/utils/staffing/schedule-types.ts'
import { type StaffClient } from '#app/utils/staffing/staff-client.ts'
import { describeCopyResult } from './copy-week-dialog.tsx'
import { ScopePicker } from './scope-picker.tsx'

/**
 * Weekly templates for one scope: save this week's shifts under a name, and
 * apply a saved template to this week. Applying adds drafts and never removes
 * shifts that are already there.
 */
export function TemplatesDialog({
	open,
	onClose,
	client,
	ready,
	scopeId,
	week,
	locale,
	canWrite,
	initialTab,
	onDone,
}: {
	open: boolean
	onClose: () => void
	client: StaffClient
	ready: boolean
	scopeId: string
	week: ScheduleWeek
	locale: string
	canWrite: boolean
	initialTab: 'apply' | 'save'
	onDone: () => void
}) {
	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						<Trans>Templates</Trans>
					</DialogTitle>
					<DialogDescription>
						<Trans>Reuse a pattern of shifts week after week.</Trans>
					</DialogDescription>
				</DialogHeader>
				{open ? (
					<Body
						client={client}
						ready={ready}
						scopeId={scopeId}
						week={week}
						locale={locale}
						canWrite={canWrite}
						initialTab={initialTab}
						onClose={onClose}
						onDone={onDone}
					/>
				) : null}
			</DialogContent>
		</Dialog>
	)
}

function Body({
	client,
	ready,
	scopeId,
	week,
	locale,
	canWrite,
	initialTab,
	onClose,
	onDone,
}: Omit<Parameters<typeof TemplatesDialog>[0], 'open'>) {
	const { _ } = useLingui()
	const [tab, setTab] = useState<'apply' | 'save'>(initialTab)
	const templates = useStaffQuery(
		client,
		ready ? `/templates?scopeId=${encodeURIComponent(scopeId)}` : null,
		templatesSchema,
	)
	const action = useStaffAction(describeScheduleError)
	const [keep, setKeep] = useState(true)
	const [name, setName] = useState('')
	const [scope, setScope] = useState<ScopeState>(EMPTY_SCOPE)
	const [keepAssignments, setKeepAssignments] = useState(true)
	const [nameError, setNameError] = useState<string | null>(null)
	const [removing, setRemoving] = useState<string | null>(null)
	const deleteLabel = (templateName: string) =>
		_(t`Delete template ${templateName}`)

	async function apply(id: string) {
		const result = await action.run(() =>
			applyTemplate(client, id, {
				weekStart: week.weekStart,
				assignments: keep ? 'keep' : 'open',
			}),
		)
		if (!result.ok) return
		toast.success(describeCopyResult(result.value))
		onDone()
		onClose()
	}

	async function remove(id: string) {
		const result = await action.run(() => deleteTemplate(client, id))
		setRemoving(null)
		if (result.ok) templates.reload()
	}

	async function save(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const trimmed = name.trim()
		const resolved = scopeFromState(scope)
		if (trimmed === '') {
			setNameError(_(t`Give the template a name.`))
			return
		}
		setNameError(null)
		if (!resolved) {
			setNameError(_(t`Choose which shifts to save.`))
			return
		}
		const result = await action.run(() =>
			createTemplate(client, {
				scopeId,
				name: trimmed,
				fromWeekStart: week.weekStart,
				scope: resolved,
				keepAssignments,
			}),
		)
		if (!result.ok) return
		toast.success(_(t`Template saved.`))
		setName('')
		templates.reload()
		setTab('apply')
	}

	return (
		<Tabs
			value={tab}
			onValueChange={(next) => setTab(next as 'apply' | 'save')}
		>
			<TabsList>
				<TabsTrigger value="apply">
					<Trans>Use a template</Trans>
				</TabsTrigger>
				{canWrite ? (
					<TabsTrigger value="save">
						<Trans>Save this week</Trans>
					</TabsTrigger>
				) : null}
			</TabsList>
			{action.error ? (
				<Alert variant="destructive" className="mt-3">
					<AlertDescription>{action.error}</AlertDescription>
				</Alert>
			) : null}
			<TabsContent value="apply" className="mt-4 flex flex-col gap-4">
				<SwitchField
					label={<Trans>Keep who works each shift</Trans>}
					description={
						<Trans>Turn off to add every shift as an open shift.</Trans>
					}
					checked={keep}
					onCheckedChange={setKeep}
				/>
				{templates.loading ? (
					<Skeleton className="h-24 w-full" />
				) : templates.error ? (
					<Alert variant="destructive">
						<AlertDescription>
							<Trans>We could not load your templates. Try again.</Trans>
						</AlertDescription>
					</Alert>
				) : templates.data && templates.data.length > 0 ? (
					<ul className="flex flex-col gap-2">
						{templates.data.map((template) => (
							<Item key={template.id} variant="outline" render={<li />}>
								<ItemContent>
									<ItemTitle>{template.name}</ItemTitle>
									<ItemDescription>
										{plural(template.slotCount, {
											one: '# shift',
											other: '# shifts',
										})}
									</ItemDescription>
								</ItemContent>
								<ItemActions>
									{canWrite ? (
										<Button
											size="sm"
											type="button"
											disabled={action.pending}
											onClick={() => void apply(template.id)}
										>
											<Trans>Add to this week</Trans>
										</Button>
									) : null}
									{canWrite ? (
										removing === template.id ? (
											<Button
												size="sm"
												type="button"
												variant="destructive"
												disabled={action.pending}
												onClick={() => void remove(template.id)}
											>
												<Trans>Delete</Trans>
											</Button>
										) : (
											<Button
												type="button"
												variant="ghost"
												size="icon"
												aria-label={deleteLabel(template.name)}
												onClick={() => setRemoving(template.id)}
											>
												<Icon name="trash-2" />
											</Button>
										)
									) : null}
								</ItemActions>
							</Item>
						))}
					</ul>
				) : (
					<p className="text-muted-foreground border-border rounded-lg border border-dashed p-4 text-sm">
						<Trans>
							No templates yet. Save a week you like and it will show up here.
						</Trans>
					</p>
				)}
			</TabsContent>
			{canWrite ? (
				<TabsContent value="save" className="mt-4">
					<form onSubmit={save} noValidate className="flex flex-col gap-5">
						<TextField
							label={<Trans>Template name</Trans>}
							value={name}
							maxLength={60}
							onChange={(event) => setName(event.target.value)}
							error={nameError}
						/>
						<ScopePicker
							value={scope}
							onChange={setScope}
							week={week}
							locale={locale}
						/>
						<SwitchField
							label={<Trans>Keep who works each shift</Trans>}
							description={
								<Trans>Turn off to save every shift as an open shift.</Trans>
							}
							checked={keepAssignments}
							onCheckedChange={setKeepAssignments}
						/>
						<Button
							type="submit"
							className="h-11 self-end"
							disabled={action.pending}
						>
							<Trans>Save template</Trans>
						</Button>
					</form>
				</TabsContent>
			) : null}
		</Tabs>
	)
}

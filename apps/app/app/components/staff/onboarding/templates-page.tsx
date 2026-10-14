import { Trans, plural, t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { useDirection } from '@repo/ui'
import { Alert, AlertDescription } from '@repo/ui/alert'
import { Badge } from '@repo/ui/badge'
import { Button } from '@repo/ui/button'
import { Icon } from '@repo/ui/icon'
import {
	Item,
	ItemActions,
	ItemContent,
	ItemDescription,
	ItemGroup,
	ItemTitle,
} from '@repo/ui/item'
import { PageHeader } from '@repo/ui/page-header'
import { Sheet, SheetContent } from '@repo/ui/sheet'
import { Skeleton } from '@repo/ui/skeleton'
import { useState } from 'react'
import { toast } from 'sonner'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useStaffAction } from '#app/hooks/use-staff-action.ts'
import { useStaffClient, useStaffQuery } from '#app/hooks/use-staff-client.ts'
import { archiveOnboardingTemplate } from '#app/utils/staffing/onboarding-api.ts'
import { describeOnboardingError } from '#app/utils/staffing/onboarding-errors.ts'
import {
	templatesSchema,
	type OnboardingTemplate,
} from '#app/utils/staffing/onboarding-types.ts'
import {
	emptyDraftTask,
	templateToDraft,
	type TemplateDraft,
} from '#app/utils/staffing/onboarding-view.ts'
import { describeStaffError } from '#app/utils/staffing/staff-errors.ts'
import { useOnboardingLabels } from './onboarding-labels.ts'
import { RemoveDialog } from './remove-dialog.tsx'
import { TemplateEditor } from './template-editor.tsx'

type Editing = { id: string | null; draft: TemplateDraft } | null

/**
 * Hiring > Onboarding: the checklist templates. One of them can be the default,
 * which is copied onto every person hired from Applicants; without one, new
 * hires get the built-in starter list. Templates hold no personal data, so
 * this is the one onboarding screen that does not depend on who is on the team.
 */
export function OnboardingTemplatesPage({
	canWrite,
}: {
	/** Needs permission to update hiring and access to every workplace. */
	canWrite: boolean
}) {
	const { _ } = useLingui()
	const direction = useDirection()
	const labels = useOnboardingLabels()
	const { client, ready, unavailable } = useStaffClient('hiring')
	const query = useStaffQuery(
		client,
		ready ? '/onboarding/templates' : null,
		templatesSchema,
	)
	const [editing, setEditing] = useState<Editing>(null)
	const [toArchive, setToArchive] = useState<OnboardingTemplate | null>(null)
	const archive = useStaffAction(describeOnboardingError)
	const templates = query.data?.templates ?? []

	function startNew(fromStarter: boolean) {
		setEditing({
			id: null,
			draft: {
				name: '',
				isDefault: templates.length === 0,
				tasks: fromStarter
					? labels.builtinStarter().map((item, index) =>
							emptyDraftTask({
								title: item.title,
								type:
									item.key === 'confirm_contact' ? 'review_profile' : 'custom',
								dueInDays: ['0', '3', '3', '3', '7'][index] ?? '3',
							}),
						)
					: [emptyDraftTask()],
			},
		})
	}

	async function confirmArchive() {
		if (!toArchive) return
		const result = await archive.run(() =>
			archiveOnboardingTemplate(client, toArchive.id),
		)
		if (result.ok) {
			setToArchive(null)
			query.reload()
			toast.success(_(t`Template removed.`))
		}
	}

	return (
		<div className="flex flex-col gap-6">
			<PageHeader
				title={_(t`Onboarding`)}
				headingLevel="h2"
				size="section"
				description={_(
					t`Checklists for new hires. Pick one to add automatically when you hire someone.`,
				)}
				actions={
					canWrite ? (
						<Button onClick={() => startNew(templates.length === 0)}>
							<Icon name="plus" />
							<Trans>New template</Trans>
						</Button>
					) : null
				}
			/>

			{unavailable ? (
				<Alert variant="destructive">
					<AlertDescription>
						<Trans>
							We could not confirm your access to staff data. Reload the page to
							try again.
						</Trans>
					</AlertDescription>
				</Alert>
			) : query.error && !query.data ? (
				<Alert variant="destructive">
					<AlertDescription>
						{describeStaffError(query.error, _)}
					</AlertDescription>
					<Button
						className="mt-2 justify-self-start"
						variant="outline"
						onClick={query.reload}
					>
						<Trans>Try again</Trans>
					</Button>
				</Alert>
			) : query.loading || !ready ? (
				<div role="status" className="flex flex-col gap-3">
					<span className="sr-only">
						<Trans>Loading templates</Trans>
					</span>
					<Skeleton className="h-14 w-full" />
					<Skeleton className="h-14 w-full" />
				</div>
			) : templates.length === 0 ? (
				<EmptyState
					title={
						<>
							<Trans>New hires get a starter checklist</Trans>
						</>
					}
					description={
						<>
							<Trans>
								Five tasks for the first week: confirm contact details, add an
								emergency contact, share the house rules, set up their clock-in
								PIN and add them to the schedule. Make a template to use your
								own.
							</Trans>
						</>
					}
					icons={['file-text', 'user-plus', 'circle-check']}
				>
					{canWrite ? (
						<>
							<Button onClick={() => startNew(true)}>
								<Trans>Start from the starter list</Trans>
							</Button>
							<Button variant="outline" onClick={() => startNew(false)}>
								<Trans>Start blank</Trans>
							</Button>
						</>
					) : null}
				</EmptyState>
			) : (
				<ItemGroup>
					{templates.map((template) => {
						const templateName = template.name
						return (
							<Item key={template.id} variant="outline" render={<li />}>
								<ItemContent>
									<ItemTitle>
										{template.name}
										{template.isDefault ? (
											<Badge variant="secondary">
												<Trans>Added to new hires</Trans>
											</Badge>
										) : null}
									</ItemTitle>
									<ItemDescription>
										{plural(template.tasks.length, {
											one: '# task',
											other: '# tasks',
										})}
									</ItemDescription>
								</ItemContent>
								{canWrite ? (
									<ItemActions>
										<Button
											variant="outline"
											size="sm"
											onClick={() =>
												setEditing({
													id: template.id,
													draft: templateToDraft(template),
												})
											}
										>
											<Trans>Edit</Trans>
										</Button>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label={_(t`Remove template ${templateName}`)}
											onClick={() => setToArchive(template)}
										>
											<Icon name="trash-2" />
										</Button>
									</ItemActions>
								) : null}
							</Item>
						)
					})}
				</ItemGroup>
			)}

			{!canWrite && !query.loading ? (
				<p className="text-muted-foreground max-w-prose text-sm text-pretty">
					<Trans>
						Templates apply to every workplace, so changing them needs
						permission to update hiring and access to all workplaces.
					</Trans>
				</p>
			) : null}

			<Sheet
				open={editing !== null}
				onOpenChange={(open) => {
					if (!open) setEditing(null)
				}}
			>
				<SheetContent
					side={direction === 'rtl' ? 'left' : 'right'}
					className="flex w-full flex-col gap-0 data-[side=left]:sm:max-w-xl data-[side=right]:sm:max-w-xl"
				>
					{editing ? (
						<TemplateEditor
							client={client}
							templateId={editing.id}
							initial={editing.draft}
							onSaved={() => {
								setEditing(null)
								query.reload()
								toast.success(_(t`Template saved.`))
							}}
						/>
					) : null}
				</SheetContent>
			</Sheet>

			<RemoveDialog
				open={toArchive !== null}
				title={<Trans>Remove this template?</Trans>}
				description={
					<Trans>
						New hires will no longer get it. Checklists already added to people
						stay as they are.
					</Trans>
				}
				pending={archive.pending}
				error={archive.error}
				onConfirm={() => void confirmArchive()}
				onClose={() => setToArchive(null)}
			/>
		</div>
	)
}

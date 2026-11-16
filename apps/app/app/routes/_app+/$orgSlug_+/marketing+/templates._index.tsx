import { msg, Trans } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { getDomainUrl } from '@repo/common'
import {
	EmailPreview,
	EmailTemplateThumbnail,
	useEmailTemplateErrors,
	type SavedEmailTemplate,
} from '@repo/marketing'
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
import { Button } from '@repo/ui/button'
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@repo/ui/dialog'
import { Input } from '@repo/ui/input'
import { Label } from '@repo/ui/label'
import { PageHeader } from '@repo/ui/page-header'
import { useEffect, useState } from 'react'
import {
	data,
	useFetcher,
	useLoaderData,
	type ActionFunctionArgs,
	type LoaderFunctionArgs,
} from 'react-router'
import { EmptyState } from '#app/components/empty-state.tsx'
import { useHasPermission } from '#app/hooks/use-organization-permissions.ts'
import { previewEmail } from '#app/utils/email/designer.server.ts'
import {
	deleteEmailTemplate,
	duplicateEmailTemplate,
	EMAIL_TEMPLATE_LIMIT,
	listEmailTemplates,
	renameEmailTemplate,
} from '#app/utils/marketing/email-templates.server.ts'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	ORG_PERMISSIONS,
	requireAnyUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

/**
 * Marketing, Templates (#154): the restaurant's own saved email layouts.
 * Reading needs a campaign or automation read permission; renaming,
 * duplicating and deleting need an update permission of either area. Control
 * plane only: templates hold blocks, never guests.
 */

async function orgIdOf(request: Request, orgSlug: string | undefined) {
	return (
		(await requireUserOrganization(request, orgSlug, { id: true })) as {
			id: string
		}
	).id
}

export async function loader({ request, params }: LoaderFunctionArgs) {
	const orgId = await orgIdOf(request, params.orgSlug)
	await requireAnyUserWithOrganizationPermission(request, orgId, [
		ORG_PERMISSIONS.READ_CAMPAIGN_ANY,
		ORG_PERMISSIONS.READ_AUTOMATION_ANY,
	])
	return { templates: await listEmailTemplates(orgId) }
}

const ERROR_STATUS = {
	template_limit_reached: 409,
	template_name_taken: 409,
	template_not_found: 404,
	invalid_name: 400,
	invalid_blocks: 400,
} as const

export async function action({ request, params }: ActionFunctionArgs) {
	const orgId = await orgIdOf(request, params.orgSlug)
	const userId = await requireAnyUserWithOrganizationPermission(
		request,
		orgId,
		[
			ORG_PERMISSIONS.UPDATE_CAMPAIGN_ANY,
			ORG_PERMISSIONS.UPDATE_AUTOMATION_ANY,
		],
	)
	const formData = await request.formData()
	const intent = formData.get('intent')
	const id = String(formData.get('id') ?? '')

	if (intent === 'email_preview') {
		return previewEmail({
			organizationId: orgId,
			blocks: formData.get('blocks'),
			subject: '',
			baseUrl: getDomainUrl(request),
			offer: null,
		})
	}

	const result =
		intent === 'rename'
			? await renameEmailTemplate({
					organizationId: orgId,
					id,
					name: formData.get('name'),
				})
			: intent === 'duplicate'
				? await duplicateEmailTemplate({ organizationId: orgId, userId, id })
				: intent === 'delete'
					? await deleteEmailTemplate({ organizationId: orgId, id })
					: null
	if (!result) return data({ error: 'invalid_intent' }, { status: 400 })
	return result.ok
		? { ok: true as const }
		: data({ error: result.error }, { status: ERROR_STATUS[result.error] })
}

function TemplateCard({
	template,
	canManage,
}: {
	template: SavedEmailTemplate
	canManage: boolean
}) {
	const { _ } = useLingui()
	const fetcher = useFetcher<{ ok?: boolean; error?: string }>()
	const errorText = useEmailTemplateErrors()
	const [previewOpen, setPreviewOpen] = useState(false)
	const [renameOpen, setRenameOpen] = useState(false)
	const [deleteOpen, setDeleteOpen] = useState(false)
	const [name, setName] = useState(template.name)
	const previewFetcher = useFetcher<{ html?: string }>()

	useEffect(() => {
		if (fetcher.data?.ok) {
			setRenameOpen(false)
			setDeleteOpen(false)
		}
	}, [fetcher.data])

	const busy = fetcher.state !== 'idle'
	const submit = (values: Record<string, string>) =>
		fetcher.submit({ id: template.id, ...values }, { method: 'post' })

	return (
		<div className="border-border space-y-3 rounded-xl border p-3">
			<EmailTemplateThumbnail blocks={template.blocks} />
			<div className="min-w-0">
				<p className="truncate text-sm font-medium">{template.name}</p>
				<p className="text-muted-foreground text-xs">
					{new Date(template.updatedAt).toLocaleDateString()}
				</p>
			</div>
			{fetcher.data?.error && !renameOpen ? (
				<p role="alert" className="text-destructive text-xs">
					{errorText(fetcher.data.error)}
				</p>
			) : null}
			<div className="flex flex-wrap gap-1.5">
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => {
						setPreviewOpen(true)
						void previewFetcher.submit(
							{
								intent: 'email_preview',
								blocks: JSON.stringify(template.blocks),
							},
							{ method: 'post' },
						)
					}}
				>
					<Trans>Preview</Trans>
				</Button>
				{canManage ? (
					<>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => {
								setName(template.name)
								setRenameOpen(true)
							}}
						>
							<Trans>Rename</Trans>
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							disabled={busy}
							onClick={() => submit({ intent: 'duplicate' })}
						>
							<Trans>Duplicate</Trans>
						</Button>
						<Button
							type="button"
							size="sm"
							variant="outline"
							className="text-destructive"
							onClick={() => setDeleteOpen(true)}
						>
							<Trans>Delete</Trans>
						</Button>
					</>
				) : null}
			</div>

			<Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
				<DialogContent className="gap-3 sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>{template.name}</DialogTitle>
						<DialogDescription>
							<Trans>
								This is the layout only. Names, coupons and dishes fill in when
								you use it.
							</Trans>
						</DialogDescription>
					</DialogHeader>
					<div className="h-[60vh] overflow-hidden rounded-lg">
						<EmailPreview
							html={previewFetcher.data?.html ?? ''}
							loading={previewFetcher.state !== 'idle'}
							framed={false}
						/>
					</div>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							<Trans>Close</Trans>
						</DialogClose>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={renameOpen} onOpenChange={setRenameOpen}>
				<DialogContent className="gap-4 sm:max-w-md">
					<DialogHeader>
						<DialogTitle>
							<Trans>Rename template</Trans>
						</DialogTitle>
					</DialogHeader>
					<div className="space-y-2">
						<Label htmlFor={`rename-${template.id}`}>
							<Trans>Template name</Trans>
						</Label>
						<Input
							id={`rename-${template.id}`}
							value={name}
							maxLength={80}
							onChange={(event) => setName(event.target.value)}
							placeholder={_(msg`Weekly newsletter`)}
						/>
						{fetcher.data?.error ? (
							<p role="alert" className="text-destructive text-sm">
								{errorText(fetcher.data.error)}
							</p>
						) : null}
					</div>
					<DialogFooter>
						<DialogClose render={<Button variant="outline" />}>
							<Trans>Cancel</Trans>
						</DialogClose>
						<Button
							type="button"
							disabled={busy || name.trim().length === 0}
							onClick={() => submit({ intent: 'rename', name })}
						>
							<Trans>Rename</Trans>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<Trans>Delete this template?</Trans>
						</AlertDialogTitle>
						<AlertDialogDescription>
							<Trans>
								Broadcasts and automations already made from it keep their
								design.
							</Trans>
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							<Trans>Keep it</Trans>
						</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() => submit({ intent: 'delete' })}
						>
							<Trans>Delete</Trans>
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

export default function TemplatesIndexRoute() {
	const { _ } = useLingui()
	const { templates } = useLoaderData<typeof loader>()
	const count = templates.length
	const limit = EMAIL_TEMPLATE_LIMIT
	const hasPermission = useHasPermission()
	const canManage =
		hasPermission('update:campaign:any') ||
		hasPermission('update:automation:any')

	return (
		<div className="space-y-8">
			<PageHeader
				title={_(msg`Templates`)}
				description={_(
					msg`Your saved email layouts. Start a broadcast or an automation email from one in the email designer.`,
				)}
			/>
			{templates.length === 0 ? (
				<EmptyState
					title={_(msg`No templates yet`)}
					description={_(
						msg`Design an email, then choose Templates, Save this design as a template.`,
					)}
					icons={['mail', 'send', 'file-text']}
				/>
			) : (
				<>
					<p className="text-muted-foreground text-sm">
						<Trans>
							{count} of {limit} templates
						</Trans>
					</p>
					<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
						{templates.map((template) => (
							<TemplateCard
								key={template.id}
								template={template}
								canManage={canManage}
							/>
						))}
					</div>
				</>
			)}
		</div>
	)
}

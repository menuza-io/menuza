import { Trans } from '@lingui/macro'
import { SheetHeader, SheetTitle } from '@repo/ui/sheet'
import { lazy, Suspense } from 'react'
import { useLoaderData, type LoaderFunctionArgs } from 'react-router'
import { requireUserOrganization } from '#app/utils/organization/loader.server.ts'
import {
	requireUserWithOrganizationPermission,
	ORG_PERMISSIONS,
} from '#app/utils/organization/permissions.server.ts'

// Lazy load the heavy rich text editor
const OrgNoteEditor = lazy(() =>
	import('./__org-note-editor.tsx').then((m) => ({ default: m.OrgNoteEditor })),
)

export { action } from './__org-note-editor.server.tsx'

export async function loader({ request, params }: LoaderFunctionArgs) {
	// Verify user is authenticated AND is a member of the organization
	const organization = await requireUserOrganization(request, params.orgSlug, {
		id: true,
	})

	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		ORG_PERMISSIONS.CREATE_NOTE_OWN,
	)

	return { organizationId: organization.id }
}

export default function NewNote() {
	const { organizationId } = useLoaderData<typeof loader>()
	return (
		<>
			<SheetHeader className="border-b">
				<SheetTitle>
					<Trans>Create New Note</Trans>
				</SheetTitle>
			</SheetHeader>

			<section
				className="flex min-h-0 flex-1 flex-col"
				aria-labelledby="new-note-title"
				tabIndex={-1}
			>
				<Suspense
					fallback={
						<div className="flex flex-1 items-center justify-center">
							<div className="bg-muted/50 h-48 w-full animate-pulse rounded-lg" />
						</div>
					}
				>
					<OrgNoteEditor organizationId={organizationId} />
				</Suspense>
			</section>
		</>
	)
}

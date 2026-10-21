import { invariantResponse } from '@epic-web/invariant'
import { Trans } from '@lingui/macro'
import { requireUserId } from '@repo/auth'
import { db, eq, Organization } from '@repo/database'
import { SheetHeader, SheetTitle } from '@repo/ui/sheet'
import { lazy, Suspense } from 'react'
import { ENV } from 'varlock/env'
import { GeneralErrorBoundary } from '#app/components/error-boundary.tsx'
import { userHasOrgAccess } from '#app/utils/organization/organizations.server.ts'
import {
	ORG_PERMISSIONS,
	requireUserWithOrganizationPermission,
} from '#app/utils/organization/permissions.server.ts'

// Lazy load the heavy rich text editor
const OrgNoteEditor = lazy(() =>
	import('./__org-note-editor.tsx').then((m) => ({ default: m.OrgNoteEditor })),
)

export { action } from './__org-note-editor.server.tsx'

export async function loader({
	params,
	request,
}: {
	params: { orgSlug: string; noteId: string }
	request: Request
}) {
	const userId = await requireUserId(request)
	const orgSlug = params.orgSlug

	// Get the organization ID
	const [organization] = await db
		.select({ id: Organization.id })
		.from(Organization)
		.where(eq(Organization.slug, orgSlug))
		.limit(1)

	invariantResponse(organization, 'Organization not found', { status: 404 })

	// Check if the user has access to this organization
	await userHasOrgAccess(request, organization.id)

	const noteRow = await db.query.OrganizationNote.findFirst({
		columns: {
			id: true,
			title: true,
			content: true,
			priority: true,
			tags: true,
			createdById: true,
		},
		with: {
			organizationNoteUploads: {
				columns: {
					id: true,
					type: true,
					altText: true,
					objectKey: true,
				},
			},
		},
		where: (note, { and, eq }) =>
			and(eq(note.id, params.noteId), eq(note.organizationId, organization.id)),
	})
	invariantResponse(noteRow, 'Not found', { status: 404 })

	// Same rule as the save action: editing needs the update permission for
	// your own note or for any note, so a note you cannot edit never loads.
	await requireUserWithOrganizationPermission(
		request,
		organization.id,
		noteRow.createdById === userId
			? ORG_PERMISSIONS.UPDATE_NOTE_OWN
			: ORG_PERMISSIONS.UPDATE_NOTE_ANY,
	)

	const { createdById: ignoredCreatedById, ...noteColumns } = noteRow
	const note = { ...noteColumns, uploads: noteRow.organizationNoteUploads }
	return {
		note,
		organizationId: organization.id,
		mediaTransformBaseUrl: ENV.MEDIA_TRANSFORM_BASE_URL?.trim() || null,
	}
}

type NoteEditProps = {
	loaderData: {
		note: {
			id: string
			title: string
			content: string
			priority?: string | null
			tags?: string | null
			uploads: Array<{
				id: string
				type: string
				altText: string | null
				objectKey: string
			}>
		}
		organizationId: string
		mediaTransformBaseUrl: string | null
	}
	actionData?: { result: any }
}

export default function NoteEdit({ loaderData, actionData }: NoteEditProps) {
	return (
		<>
			<SheetHeader className="border-b">
				<SheetTitle>
					<Trans>Edit Note</Trans>
				</SheetTitle>
			</SheetHeader>

			<section
				className="flex min-h-0 flex-1 flex-col"
				aria-labelledby="edit-note-title"
				tabIndex={-1}
			>
				<Suspense
					fallback={
						<div className="flex flex-1 items-center justify-center">
							<div className="bg-muted/50 h-48 w-full animate-pulse rounded-lg" />
						</div>
					}
				>
					<OrgNoteEditor
						note={loaderData.note}
						actionData={actionData}
						organizationId={loaderData.organizationId}
						mediaTransformBaseUrl={loaderData.mediaTransformBaseUrl}
					/>
				</Suspense>
			</section>
		</>
	)
}

export function ErrorBoundary() {
	return (
		<GeneralErrorBoundary
			statusHandlers={{
				404: ({ params }) => {
					const noteId = params.noteId
					return (
						<p>
							<Trans>No note with the id "{noteId}" exists</Trans>
						</p>
					)
				},
			}}
		/>
	)
}

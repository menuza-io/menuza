import { Trans } from '@lingui/macro'
import { Button } from '@repo/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu'
import { Icon } from '@repo/ui/icon'
import { Link, useParams } from 'react-router'
import { useHasPermission } from '#app/hooks/use-organization-permissions.ts'

/**
 * Org-scoped "New" menu in the top bar; only on organization routes. Each
 * item is shown only when the destination's loader would let the member in;
 * those loaders stay the source of truth. Icon-only below `md`.
 */
export function WorkspaceHeaderActions() {
	// From the matched `$orgSlug` route, not the path: `/security` and
	// `/profile` share this layout but are not organizations.
	const { orgSlug } = useParams()
	const hasPermission = useHasPermission()
	if (!orgSlug) return null

	// notes.new requires create:note:own; settings/members requires
	// read:member:any and inviting requires create:member:any. reports/new
	// only requires membership, so the menu always has at least that item.
	const canCreateNote = hasPermission('create:note:own')
	const canInviteMember =
		hasPermission('read:member:any') && hasPermission('create:member:any')

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						variant="outline"
						size="sm"
						className="max-md:size-7 max-md:px-0"
					>
						<Icon name="plus" />
						<span className="sr-only md:not-sr-only">
							<Trans>New</Trans>
						</span>
						<Icon
							name="chevron-down"
							className="text-muted-foreground hidden size-3.5 md:block"
						/>
					</Button>
				}
			/>
			<DropdownMenuContent align="end" sideOffset={6} className="min-w-48">
				{canCreateNote ? (
					<DropdownMenuItem render={<Link to={`/${orgSlug}/notes/new`} />}>
						<Icon name="sticky-note" />
						<Trans>New note</Trans>
					</DropdownMenuItem>
				) : null}
				<DropdownMenuItem render={<Link to={`/${orgSlug}/reports/new`} />}>
					<Icon name="file-text" />
					<Trans>New report</Trans>
				</DropdownMenuItem>
				{canInviteMember ? (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuItem
							render={<Link to={`/${orgSlug}/settings/members`} />}
						>
							<Icon name="user-plus" />
							<Trans>Invite member</Trans>
						</DropdownMenuItem>
					</>
				) : null}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

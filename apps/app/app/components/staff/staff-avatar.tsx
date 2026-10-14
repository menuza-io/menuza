import { Avatar, AvatarFallback } from '@repo/ui/avatar'
import { staffInitials } from '#app/utils/staffing/staff-format.ts'

/** Initials in a quiet circle. Decorative: the name always sits next to it. */
export function StaffAvatar({
	name,
	size = 'default',
}: {
	name: string
	size?: 'default' | 'sm' | 'lg'
}) {
	return (
		<Avatar size={size} aria-hidden="true">
			<AvatarFallback className="bg-muted text-muted-foreground text-xs font-medium">
				{staffInitials(name)}
			</AvatarFallback>
		</Avatar>
	)
}

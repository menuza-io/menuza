import { t } from '@lingui/macro'
import { useLingui } from '@lingui/react'
import { cn } from '@repo/ui'
import { BasePhotoUpload } from '#app/components/settings/base-photo-upload.tsx'
import { OrganizationPhotoForm } from '#app/components/settings/organization-photo-form.tsx'

export const uploadOrgPhotoActionIntent = 'upload-org-photo'
export const deleteOrgPhotoActionIntent = 'delete-org-photo'

interface OrganizationPhotoProps {
	organization: {
		name: string
		slug: string
		image?: {
			objectKey: string
			id: string
		} | null
	}
	size?: 'small' | 'normal'
}

export function OrganizationPhoto({
	organization,
	size = 'normal',
}: OrganizationPhotoProps) {
	const { _ } = useLingui()

	function getOrgImgSrc(objectKey?: string | null) {
		return objectKey
			? `/resources/images?objectKey=${encodeURIComponent(objectKey)}`
			: ''
	}

	return (
		<BasePhotoUpload
			imgSrc={getOrgImgSrc(organization.image?.objectKey)}
			alt={organization.name}
			showAvatarChars={true}
			dialogTitle={_(t`Update Organization Logo`)}
			imgClassName={cn(
				'bg-primary h-full w-full rounded-md object-contain',
				!organization.image?.objectKey &&
					'flex items-center justify-center p-4 text-6xl',
			)}
			renderForm={({ setIsOpen, selectedFile }) => (
				<OrganizationPhotoForm
					setIsOpen={setIsOpen}
					selectedFile={selectedFile}
				/>
			)}
			size={size}
		/>
	)
}

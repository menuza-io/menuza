import { Ionicons } from '@expo/vector-icons'
import { Trans, useLingui } from '@lingui/react/macro'
import { CameraView, useCameraPermissions } from 'expo-camera'
import * as ImagePicker from 'expo-image-picker'
import React, { useRef, useState } from 'react'
import {
	ActivityIndicator,
	Image,
	Modal,
	Pressable,
	Text,
	View,
	useWindowDimensions,
} from 'react-native'
import {
	CAPTURE_OPTIONS,
	type CapturedPhoto,
	type PreparedPhoto,
	preparePhoto,
} from '../../lib/photo-queue/prepare'
import { Button } from '../ui'

export interface CaptureDish {
	id: string
	name: string
}

interface PhotoCaptureModalProps {
	dish: CaptureDish | null
	onClose: () => void
	/** Receives the resized, re-encoded photo (the original is never queued). */
	onUse: (dish: CaptureDish, photo: PreparedPhoto) => Promise<void> | void
}

/**
 * Camera with a square guide and two tips, then "Retake" or "Use this
 * photo". The library works too. Pictures are taken with `exif: false`
 * and re-encoded before use (see `preparePhoto`).
 */
export function PhotoCaptureModal({
	dish,
	onClose,
	onUse,
}: PhotoCaptureModalProps) {
	const { t } = useLingui()
	const { width } = useWindowDimensions()
	const camera = useRef<InstanceType<typeof CameraView> | null>(null)
	const [permission, requestPermission] = useCameraPermissions()
	const [taken, setTaken] = useState<CapturedPhoto | null>(null)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const guide = Math.round(width * 0.84)
	const previewHeight = Math.round((width * 4) / 3)

	const close = () => {
		setTaken(null)
		setError(null)
		setBusy(false)
		onClose()
	}

	const takePicture = async () => {
		if (busy || !camera.current) return
		setBusy(true)
		setError(null)
		try {
			const picture = await camera.current.takePictureAsync(CAPTURE_OPTIONS)
			setTaken({
				uri: picture.uri,
				width: picture.width,
				height: picture.height,
			})
		} catch {
			setError(t`The photo could not be taken. Try again.`)
		} finally {
			setBusy(false)
		}
	}

	const chooseFromLibrary = async () => {
		if (busy) return
		setError(null)
		try {
			const result = await ImagePicker.launchImageLibraryAsync({
				mediaTypes: ['images'],
				allowsMultipleSelection: false,
				...CAPTURE_OPTIONS,
			})
			const asset = result.assets?.[0]
			if (result.canceled || !asset) return
			setTaken({ uri: asset.uri, width: asset.width, height: asset.height })
		} catch {
			setError(t`The photo could not be opened. Try again.`)
		}
	}

	const acceptPhoto = async () => {
		if (!dish || !taken || busy) return
		setBusy(true)
		setError(null)
		try {
			const prepared = await preparePhoto(taken)
			await onUse(dish, prepared)
			close()
		} catch {
			setError(t`The photo could not be saved. Try again.`)
			setBusy(false)
		}
	}

	return (
		<Modal
			visible={dish !== null}
			animationType="slide"
			presentationStyle="fullScreen"
			onRequestClose={close}
		>
			<View className="flex-1 bg-black">
				<View className="flex-row items-center justify-between px-4 pt-14 pb-3">
					<Pressable
						onPress={close}
						accessibilityRole="button"
						accessibilityLabel={t`Close camera`}
						hitSlop={12}
					>
						<Ionicons name="close" size={28} color="#fff" />
					</Pressable>
					<Text
						className="ms-3 me-8 flex-1 text-center text-base font-medium text-white"
						numberOfLines={1}
					>
						{dish?.name}
					</Text>
				</View>

				{taken ? (
					<View className="flex-1 items-center justify-center">
						<Image
							source={{ uri: taken.uri }}
							style={{ width: guide, height: guide }}
							resizeMode="cover"
							accessibilityLabel={t`Preview of the photo`}
						/>
					</View>
				) : permission?.granted ? (
					<View className="flex-1 items-center justify-center">
						<View style={{ width, height: previewHeight }}>
							<CameraView
								ref={camera}
								style={{ width, height: previewHeight }}
								facing="back"
								animateShutter
							/>
							<View
								pointerEvents="none"
								className="absolute inset-0 items-center justify-center"
							>
								<View
									className="rounded-xl border-2 border-white/90"
									style={{ width: guide, height: guide }}
								/>
							</View>
						</View>
						<View className="mt-4 px-6">
							<Text className="text-center text-sm text-white">
								<Trans>Light from the side</Trans>
							</Text>
							<Text className="mt-1 text-center text-sm text-white">
								<Trans>Fill the frame</Trans>
							</Text>
						</View>
					</View>
				) : (
					<View className="flex-1 items-center justify-center px-8">
						<Ionicons name="camera-outline" size={48} color="#fff" />
						<Text className="mt-4 text-center text-base text-white">
							{permission && !permission.canAskAgain ? (
								<Trans>
									Camera access is turned off. You can turn it on in your
									phone's settings, or choose a photo from your library.
								</Trans>
							) : (
								<Trans>
									Allow the camera to take a photo of this dish, or choose a
									photo from your library.
								</Trans>
							)}
						</Text>
						{(!permission || permission.canAskAgain) && (
							<Button className="mt-4" onPress={() => void requestPermission()}>
								<Trans>Allow camera</Trans>
							</Button>
						)}
					</View>
				)}

				{error && (
					<Text
						className="px-6 pb-2 text-center text-sm text-red-300"
						accessibilityLiveRegion="polite"
					>
						{error}
					</Text>
				)}

				<View className="flex-row items-center justify-around px-6 pt-4 pb-10">
					{taken ? (
						<>
							<Button
								variant="outline"
								onPress={() => setTaken(null)}
								disabled={busy}
							>
								<Trans>Retake</Trans>
							</Button>
							<Button onPress={() => void acceptPhoto()} loading={busy}>
								<Trans>Use this photo</Trans>
							</Button>
						</>
					) : (
						<>
							<Pressable
								onPress={() => void chooseFromLibrary()}
								accessibilityRole="button"
								className="items-center"
							>
								<Ionicons name="images-outline" size={28} color="#fff" />
								<Text className="mt-1 text-xs text-white">
									<Trans>Choose from library</Trans>
								</Text>
							</Pressable>
							{permission?.granted ? (
								<Pressable
									onPress={() => void takePicture()}
									disabled={busy}
									accessibilityRole="button"
									accessibilityLabel={t`Take photo`}
									className="h-[72px] w-[72px] items-center justify-center rounded-full border-4 border-white"
								>
									{busy ? (
										<ActivityIndicator color="#fff" />
									) : (
										<View className="h-14 w-14 rounded-full bg-white" />
									)}
								</Pressable>
							) : (
								<View className="h-[72px] w-[72px]" />
							)}
							<View className="w-16" />
						</>
					)}
				</View>
			</View>
		</Modal>
	)
}

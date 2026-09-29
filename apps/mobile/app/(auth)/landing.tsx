import { Trans, useLingui } from '@lingui/react/macro'
import { useRouter } from 'expo-router'
import React, { useState, useRef } from 'react'
import {
	View,
	Text,
	Pressable,
	ScrollView,
	Dimensions,
	StatusBar,
	type NativeSyntheticEvent,
	type NativeScrollEvent,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'

const { width } = Dimensions.get('window')

interface OnboardingSlide {
	id: number
	title: string
	subtitle: string
	emoji: string
	bgClass: string
}

export default function LandingScreen() {
	const { t } = useLingui()

	const slides: OnboardingSlide[] = [
		{
			id: 1,
			title: t`The easiest way to...`,
			subtitle: t`Track what you eat 🍎`,
			emoji: '🍎',
			bgClass: 'bg-primary/10',
		},
		{
			id: 2,
			title: t`The easiest way to...`,
			subtitle: t`Build amazing apps ⚡`,
			emoji: '⚡',
			bgClass: 'bg-accent',
		},
		{
			id: 3,
			title: t`The easiest way to...`,
			subtitle: t`Ship faster 🚀`,
			emoji: '🚀',
			bgClass: 'bg-primary/5',
		},
	]
	const router = useRouter()
	const [currentIndex, setCurrentIndex] = useState(0)
	const scrollViewRef = useRef<ScrollView>(null)
	const insets = useSafeAreaInsets()

	const handleGetStarted = () => {
		router.push('/(auth)/sign-up')
	}

	const handleSignIn = () => {
		router.push('/(auth)/sign-in')
	}

	const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
		const slideSize = width
		const index = Math.round(event.nativeEvent.contentOffset.x / slideSize)
		setCurrentIndex(index)
	}

	return (
		<View className="bg-background flex-1">
			<StatusBar
				barStyle="light-content"
				backgroundColor="transparent"
				translucent
			/>

			{/* Header */}
			<View
				className="bg-background z-10 flex-row items-center justify-between px-5 pb-2"
				style={{ paddingTop: Math.max(insets.top, 16) }}
			>
				<View
					className="flex-1 items-center"
					accessibilityElementsHidden={true}
				>
					<View className="bg-primary h-6 w-6 rounded-full" />
				</View>
				<Pressable
					onPress={handleSignIn}
					className="min-h-11 items-center justify-center px-3 py-2"
					accessibilityRole="link"
					accessibilityLabel={t`Sign in`}
				>
					<Text className="text-muted-foreground text-base font-medium">
						<Trans>Sign in</Trans>
					</Text>
				</Pressable>
			</View>

			{/* Carousel */}
			<View className="flex-1 justify-center">
				<ScrollView
					ref={scrollViewRef}
					horizontal
					pagingEnabled
					showsHorizontalScrollIndicator={false}
					onScroll={handleScroll}
					scrollEventThrottle={16}
					className="flex-1"
				>
					{slides.map((slide) => (
						<View
							key={slide.id}
							className={`items-center justify-center px-10 ${slide.bgClass}`}
							style={{ width }}
						>
							<View
								className="bg-card items-center justify-center rounded-2xl shadow-lg"
								style={{
									width: width * 0.7,
									height: width * 0.7,
									shadowColor: '#000',
									shadowOffset: { width: 0, height: 4 },
									shadowOpacity: 0.1,
									shadowRadius: 12,
									elevation: 5,
								}}
							>
								<Text className="text-7xl">{slide.emoji}</Text>
							</View>
						</View>
					))}
				</ScrollView>
			</View>

			{/* Content */}
			<View
				className="items-center px-8 pt-6"
				style={{ paddingBottom: Math.max(insets.bottom, 20) + 30 }}
			>
				<Text className="text-foreground mb-2 text-center text-2xl">
					{slides[currentIndex].title}
				</Text>
				<Text className="text-muted-foreground mb-8 text-center text-base">
					{slides[currentIndex].subtitle}
				</Text>

				{/* Page Indicators */}
				<View
					className="mb-10 flex-row items-center justify-center"
					accessible={true}
					accessibilityLabel={t`Page ${currentIndex + 1} of ${slides.length}`}
				>
					{slides.map((_, index) => (
						<View
							key={index}
							className={`mx-1 h-2 w-2 rounded-full ${
								index === currentIndex ? 'bg-foreground' : 'bg-border'
							}`}
						/>
					))}
				</View>

				{/* Get Started Button */}
				<Pressable
					className="bg-primary w-full items-center rounded-3xl px-8 py-4"
					onPress={handleGetStarted}
					accessibilityRole="button"
					accessibilityLabel={t`Get Started`}
				>
					<Text className="text-primary-foreground text-base">
						<Trans>Get Started</Trans>
					</Text>
				</Pressable>
			</View>
		</View>
	)
}

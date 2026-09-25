import { useRouter } from 'expo-router'
import React from 'react'
import {
	View,
	Text,
	TouchableOpacity,
	ScrollView,
	Dimensions,
} from 'react-native'
import { Screen, Button } from '../../components/ui'

const { width, height } = Dimensions.get('window')

export default function WelcomeScreen() {
	const router = useRouter()

	const handleGetStarted = () => {
		router.push('/(auth)/sign-up')
	}

	const handleSignIn = () => {
		router.push('/(auth)/sign-in')
	}

	return (
		<Screen className="bg-muted">
			<ScrollView
				contentContainerClassName="grow px-6"
				showsVerticalScrollIndicator={false}
			>
				{/* Hero Section */}
				<View
					className="items-center pb-12"
					style={{ paddingTop: height * 0.1 }}
				>
					<View
						className="bg-primary mb-8 h-24 w-24 items-center justify-center rounded-full"
						style={{
							shadowColor: '#667eea',
							shadowOffset: { width: 0, height: 8 },
							shadowOpacity: 0.3,
							shadowRadius: 16,
							elevation: 8,
						}}
					>
						<Text className="text-5xl">🚀</Text>
					</View>
					<Text className="text-foreground mb-4 text-center text-3xl leading-10 font-bold">
						Welcome to{'\n'}
						<Text className="text-primary">Epic Stack</Text>
					</Text>
					<Text className="text-muted-foreground px-4 text-center text-lg leading-7">
						The fastest way to build and ship production-ready apps
					</Text>
				</View>

				{/* Features Grid */}
				<View className="mb-12 flex-row flex-wrap justify-between">
					<FeatureCard
						icon="⚡"
						title="Fast Development"
						description="Pre-configured tools and patterns"
					/>
					<FeatureCard
						icon="🔒"
						title="Secure"
						description="Built-in authentication & security"
					/>
					<FeatureCard
						icon="📱"
						title="Mobile First"
						description="Optimized for mobile experience"
					/>
					<FeatureCard
						icon="🎨"
						title="Beautiful UI"
						description="Modern design system included"
					/>
				</View>

				{/* CTA Section */}
				<View className="pb-8">
					<Button onPress={handleGetStarted} className="mb-6">
						Get Started
					</Button>

					<View className="flex-row items-center justify-center">
						<Text className="text-muted-foreground text-base">
							Already have an account?{' '}
						</Text>
						<TouchableOpacity onPress={handleSignIn} accessibilityRole="link">
							<Text className="text-primary text-base">
								Sign In
							</Text>
						</TouchableOpacity>
					</View>
				</View>
			</ScrollView>
		</Screen>
	)
}

interface FeatureCardProps {
	icon: string
	title: string
	description: string
}

function FeatureCard({ icon, title, description }: FeatureCardProps) {
	return (
		<View
			className="bg-card mb-4 items-center rounded-2xl p-5"
			style={{
				width: (width - 64) / 2,
				shadowColor: '#000',
				shadowOffset: { width: 0, height: 2 },
				shadowOpacity: 0.1,
				shadowRadius: 8,
				elevation: 3,
			}}
		>
			<Text className="mb-3 text-3xl">{icon}</Text>
			<Text className="text-foreground mb-2 text-center text-base">
				{title}
			</Text>
			<Text className="text-muted-foreground text-center text-sm leading-5">
				{description}
			</Text>
		</View>
	)
}

---
name: Operator mobile companion
description: Adaptive guidance for the operator's smaller-screen workflows
---

# Design System: Operator Mobile Companion

## Overview

**Creative North Star: "The essential companion"**

This Expo app gives operators fast access to sign-in, onboarding, organizations,
a dashboard, profile, and settings. It complements rather than reproduces the
full web workspace. Follow the root `DESIGN.md` while keeping the shipped iOS
and Android presentation coherent.

## Colors

The mobile semantic theme lives in `app/global.css`. Keep its roles aligned in
purpose with the operator app, while allowing a downstream project to choose its
own values. Convey errors and progress in text, not appearance alone.

## Typography

Use clear screen titles, short action labels, field labels, and readable help
text. Allow Arabic and accessibility text sizes to change wrapping and screen
height.

## Layout

`components/ui/screen.tsx` handles screen framing and safe areas. Favor a single
clear task per screen, reachable actions, keyboard avoidance, and a navigable
tab structure. Fit content to small devices without reducing tap targets.

## Components

Reuse the mobile screen, button, card, input, OTP input, loading overlay, error
banner, and toast components. Use platform status-bar and keyboard behavior
where necessary; do not create two unrelated visual systems. Label unavailable
web-only settings honestly instead of implying a working control.

## Do's and Don'ts

### Do:

- **Do** pair loading and error feedback with accessible announcements and the
  existing haptic cues.
- **Do** preserve organization context when switching accounts or returning to
  the dashboard.

### Don't:

- **Don't** copy browser-specific components or storefront customer login flows
  into this app.

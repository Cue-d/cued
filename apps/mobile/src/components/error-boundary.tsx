/**
 * Error boundary component with retry functionality.
 *
 * Task 13.3: Add error boundary with retry.
 * Catches React errors and displays friendly error message with retry button.
 */

import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { View, Text, Pressable } from "react-native";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional fallback component to render on error */
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary that catches React errors and displays a retry UI.
 *
 * Usage:
 * ```tsx
 * <ErrorBoundary>
 *   <YourComponent />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log error for debugging
    console.error("ErrorBoundary caught an error:", error);
    console.error("Component stack:", errorInfo.componentStack);
  }

  handleRetry = async (): Promise<void> => {
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback } = this.props;

    if (hasError) {
      // Custom fallback if provided
      if (fallback) {
        return fallback;
      }

      // Default error UI
      return (
        <View className="flex-1 items-center justify-center p-6 bg-background">
          <SymbolView
            name="exclamationmark.triangle.fill"
            size={64}
            tintColor="#FF3B30"
          />

          <Text className="text-foreground text-xl font-semibold mt-6 text-center">
            Something went wrong
          </Text>

          <Text className="text-muted-foreground text-base mt-2 text-center">
            An unexpected error occurred. Please try again.
          </Text>

          {__DEV__ && error && (
            <View className="mt-4 p-3 bg-muted rounded-lg max-w-full">
              <Text
                className="text-destructive text-xs font-mono"
                numberOfLines={4}
              >
                {error.message}
              </Text>
            </View>
          )}

          <Pressable
            onPress={this.handleRetry}
            className="mt-6 px-6 py-3 bg-primary rounded-xl active:opacity-80"
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text className="text-white text-base font-semibold">
              Try Again
            </Text>
          </Pressable>
        </View>
      );
    }

    return children;
  }
}

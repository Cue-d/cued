/**
 * CardStack component for displaying stacked swipeable cards
 *
 * Shows up to 3 cards stacked with progressive scale/offset.
 * Only the top card is interactive.
 */

import { type ReactNode } from "react";
import Animated, {
  FadeIn,
  FadeOut,
  Layout,
} from "react-native-reanimated";
import { SwipeableCard, type SwipeDirection } from "./swipeable-card";
import { View } from "@/tw";

// Number of visible cards in the stack
const VISIBLE_CARDS = 3;

// Scale reduction per card in stack (1 - index * SCALE_OFFSET)
const SCALE_OFFSET = 0.04;

// Vertical offset per card in stack (index * Y_OFFSET)
const Y_OFFSET = 8;

export interface CardStackItem {
  id: string;
}

export interface CardStackProps<T extends CardStackItem> {
  /** Array of action items to display */
  actions: T[];
  /** Total count of actions (may be more than visible) */
  totalCount: number;
  /** Callback when user swipes a card */
  onSwipe: (item: T, direction: SwipeDirection) => void;
  /** Render function for card content */
  renderCard: (item: T, index: number) => ReactNode;
  /** Optional trigger to programmatically swipe the top card */
  triggerSwipe?: SwipeDirection | null;
}

export function CardStack<T extends CardStackItem>({
  actions,
  totalCount,
  onSwipe,
  renderCard,
  triggerSwipe,
}: CardStackProps<T>): React.JSX.Element {
  // Show only top VISIBLE_CARDS
  const visibleCards = actions.slice(0, VISIBLE_CARDS);

  const handleSwipe = (item: T, direction: SwipeDirection): void => {
    onSwipe(item, direction);
  };

  return (
    <View className="flex-1 items-center justify-center px-4">
      {/* Header with count */}
      {totalCount > 0 && (
        <View className="absolute top-4 left-4 z-50">
          <Animated.Text
            className="text-lg font-semibold text-sf-label"
            entering={FadeIn}
            exiting={FadeOut}
          >
            {totalCount} Left
          </Animated.Text>
        </View>
      )}

      {/* Card stack */}
      <View className="relative w-full max-w-md aspect-[3/4]">
        {visibleCards.map((item, index) => {
          const isTopCard = index === 0;
          const scale = 1 - index * SCALE_OFFSET;
          const translateY = index * Y_OFFSET;
          const zIndex = VISIBLE_CARDS - index;

          return (
            <Animated.View
              key={item.id}
              className="absolute inset-0"
              style={{
                zIndex,
                transform: [{ scale }, { translateY }],
              }}
              entering={FadeIn.duration(200)}
              exiting={FadeOut.duration(200)}
              layout={Layout.springify()}
            >
              <SwipeableCard
                onSwipe={(direction) => handleSwipe(item, direction)}
                disabled={!isTopCard}
                triggerSwipe={isTopCard ? triggerSwipe : null}
                className="w-full h-full bg-sf-secondaryBg rounded-2xl shadow-lg overflow-hidden"
              >
                {renderCard(item, index)}
              </SwipeableCard>
            </Animated.View>
          );
        })}
      </View>
    </View>
  );
}

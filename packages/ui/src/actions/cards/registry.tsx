/**
 * Card Registry - Maps action types to their card components.
 */

import * as React from "react";
import { RespondCard, FollowUpCard, SendMessageCard } from "./message-card";
import { ResolveContactCardWrapper } from "./resolve-contact-card-wrapper";
import { Card, CardContent } from "../../components/ui/card";
import type { ActionCardProps, ActionCardComponent } from "../types";

/**
 * Fallback component for unknown action types.
 */
function UnknownActionCard({ action, className }: ActionCardProps) {
  return (
    <Card className={className}>
      <CardContent className="flex items-center justify-center h-full">
        <p className="text-muted-foreground">
          Unknown action type: {action.type}
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Registry mapping action types to their card components.
 */
const CARD_REGISTRY: Record<string, ActionCardComponent> = {
  respond: RespondCard,
  follow_up: FollowUpCard,
  send_message: SendMessageCard,
  resolve_contact: ResolveContactCardWrapper,
};

/**
 * Get the card component for an action type.
 */
export function getCardComponent(
  actionType: string
): ActionCardComponent | undefined {
  return CARD_REGISTRY[actionType];
}

/**
 * Render an action card using the registry.
 * Returns a fallback component for unknown action types.
 */
export function renderActionCard(props: ActionCardProps): React.ReactNode {
  const CardComponent = CARD_REGISTRY[props.action.type] ?? UnknownActionCard;
  return <CardComponent key={props.action._id} {...props} />;
}

/**
 * Check if an action type has a registered card component.
 */
export function hasCardComponent(actionType: string): boolean {
  return actionType in CARD_REGISTRY;
}

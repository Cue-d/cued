import {
  buildNormalizedRawEventSchema,
  type ProviderRawEventInput,
} from "../../../core/types/provider.js";
import type { CanonicalProjectionSnapshot } from "../replay-snapshot.js";

export type ProjectionReplayFixture = {
  name: string;
  events: ProviderRawEventInput[];
  assert?: (snapshot: CanonicalProjectionSnapshot) => void;
};

export function fixtureEvent(input: ProviderRawEventInput): ProviderRawEventInput {
  return {
    ...input,
    normalizedSchema: buildNormalizedRawEventSchema(input.entityKind, input.eventKind),
    provenance: {
      adapterVersion: "projection-replay-fixture@1",
    },
  };
}

import { contactsLinkedInReplayFixtures } from "./contacts-linkedin.js";
import type { ProjectionReplayFixture } from "./shared.js";
import { slackReplayFixtures } from "./slack.js";

export type { ProjectionReplayFixture } from "./shared.js";

export const replayFixtures: ProjectionReplayFixture[] = [
  ...contactsLinkedInReplayFixtures,
  ...slackReplayFixtures,
];

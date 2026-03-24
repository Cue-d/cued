import { contactsLinkedInReplayFixtures } from "./contacts-linkedin.js";
import { imessageReplayFixtures } from "./imessage.js";
import type { ProjectionReplayFixture } from "./shared.js";
import { signalReplayFixtures } from "./signal.js";
import { slackReplayFixtures } from "./slack.js";
import { whatsappReplayFixtures } from "./whatsapp.js";

export type { ProjectionReplayFixture } from "./shared.js";

export const replayFixtures: ProjectionReplayFixture[] = [
  ...contactsLinkedInReplayFixtures,
  ...imessageReplayFixtures,
  ...signalReplayFixtures,
  ...slackReplayFixtures,
  ...whatsappReplayFixtures,
];

import { test, expect } from "bun:test";
import {
  INTERNAL_TO_WEBHOOK,
  RETRY_SCHEDULE_MS,
  WEBHOOK_EVENT_TYPES,
  isWebhookEventType,
  retryScheduleMs,
} from "../events.js";

test("every internal mapping targets a subscribable type, and ping is not one", () => {
  expect(Object.values(INTERNAL_TO_WEBHOOK).sort()).toEqual([...WEBHOOK_EVENT_TYPES].sort());
  expect(INTERNAL_TO_WEBHOOK.comment_notification).toBeUndefined();
  expect(isWebhookEventType("comment.mentioned")).toBe(true);
  expect(isWebhookEventType("ping")).toBe(false);
});

test("the retry schedule gives 8 attempts and honours the test override", () => {
  expect(RETRY_SCHEDULE_MS.length + 1).toBe(8);
  expect(retryScheduleMs({})).toBe(RETRY_SCHEDULE_MS);
  expect(retryScheduleMs({ AGENT_FS_WEBHOOK_RETRY_SCHEDULE_MS: "1500, 1500,1500" })).toEqual([1500, 1500, 1500]);
  expect(retryScheduleMs({ AGENT_FS_WEBHOOK_RETRY_SCHEDULE_MS: "1000,abc" })).toBe(RETRY_SCHEDULE_MS);
  expect(retryScheduleMs({ AGENT_FS_WEBHOOK_RETRY_SCHEDULE_MS: "" })).toBe(RETRY_SCHEDULE_MS);
});

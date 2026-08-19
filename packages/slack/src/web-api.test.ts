import { describe, expect, it } from "vitest";

import { SlackApiError, slackChannelIdSchema } from "./types.js";
import { SlackWebApiClient, type SlackFetch } from "./web-api.js";

describe("SlackWebApiClient", () => {
  it("sends authenticated JSON and normalizes Slack messages", async () => {
    const requests: { url: string; authorization?: string; body: unknown }[] = [];
    const fetch: SlackFetch = (url, init) => {
      requests.push({
        url,
        ...(init.headers.authorization === undefined
          ? {}
          : { authorization: init.headers.authorization }),
        body: JSON.parse(init.body) as unknown,
      });
      return Promise.resolve(
        jsonResponse({
          ok: true,
          channel: "C012345",
          ts: "1700000000.000001",
          message: {
            ts: "1700000000.000001",
            text: "hello",
            metadata: {
              event_type: "thor_task_surface",
              event_payload: { projectItemId: "PVTI_42" },
            },
          },
        }),
      );
    };
    const client = new SlackWebApiClient("xoxb-secret", {
      baseUrl: "https://slack.test/api/",
      fetch,
    });

    const message = await client.postMessage({
      channelId: slackChannelIdSchema.parse("C012345"),
      text: "hello",
      metadata: {
        eventType: "thor_task_surface",
        eventPayload: { projectItemId: "PVTI_42" },
      },
      blocks: [
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: "Cancel agent",
              actionId: "thor_cancel",
              style: "danger",
            },
          ],
        },
      ],
    });

    expect(message).toMatchObject({
      channelId: "C012345",
      text: "hello",
      metadata: {
        eventType: "thor_task_surface",
        eventPayload: { projectItemId: "PVTI_42" },
      },
    });
    expect(requests).toEqual([
      {
        url: "https://slack.test/api/chat.postMessage",
        authorization: "Bearer xoxb-secret",
        body: {
          channel: "C012345",
          text: "hello",
          metadata: {
            event_type: "thor_task_surface",
            event_payload: { projectItemId: "PVTI_42" },
          },
          blocks: [
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "Cancel agent" },
                  action_id: "thor_cancel",
                  style: "danger",
                },
              ],
            },
          ],
        },
      },
    ]);
  });

  it("classifies Slack rate limits with Retry-After", async () => {
    const fetch: SlackFetch = () =>
      Promise.resolve(jsonResponse({ ok: false, error: "rate_limited" }, 429, "2.5"));
    const client = new SlackWebApiClient("xoxb-secret", { fetch });

    const error = await client.getConversation(slackChannelIdSchema.parse("C012345")).then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(SlackApiError);
    expect(error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 2500,
    });
  });
});

function jsonResponse(body: unknown, status = 200, retryAfter?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null;
      },
    },
    json: () => Promise.resolve(body),
  };
}

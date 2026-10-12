import { describe, expect, it, vi } from "vitest";
import { upsertComment } from "../src/comment";

const marker = "<!-- skein-report:v1 -->";

describe("upsertComment", () => {
  it("updates the existing marked comment instead of creating a new one", async () => {
    const octokitLike = {
      listComments: vi.fn().mockResolvedValue([{ id: 42, body: `${marker}\nold` }, { id: 7, body: "human comment" }]),
      updateComment: vi.fn().mockResolvedValue(undefined),
      createComment: vi.fn().mockResolvedValue(undefined),
    };
    await upsertComment(octokitLike, 123, `${marker}\nnew`);
    expect(octokitLike.updateComment).toHaveBeenCalledWith(42, `${marker}\nnew`);
    expect(octokitLike.createComment).not.toHaveBeenCalled();
  });

  it("creates the comment when none marked exists", async () => {
    const octokitLike = {
      listComments: vi.fn().mockResolvedValue([{ id: 7, body: "human comment" }]),
      updateComment: vi.fn(),
      createComment: vi.fn().mockResolvedValue(undefined),
    };
    await upsertComment(octokitLike, 123, `${marker}\nnew`);
    expect(octokitLike.createComment).toHaveBeenCalledWith(123, `${marker}\nnew`);
    expect(octokitLike.updateComment).not.toHaveBeenCalled();
  });
});

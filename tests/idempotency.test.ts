import { describe, expect, it, vi } from "vitest";
import { createStore } from "../src/store/store.js";
import { IdempotencyService } from "../src/services/idempotency.js";
import { ApiError } from "../src/lib/errors.js";

function newService() {
  return new IdempotencyService(createStore({ kind: "memory", path: "" }));
}

describe("IdempotencyService", () => {
  it("executes once and replays the stored result", async () => {
    const service = newService();
    const produce = vi.fn(async () => ({ status: 201, body: { id: "E1" } }));

    const first = await service.run("c1", "key-1", "hash-1", produce);
    const second = await service.run("c1", "key-1", "hash-1", produce);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual({ id: "E1" });
    expect(produce).toHaveBeenCalledTimes(1);
  });

  it("conflicts when the same key is reused with a different body", async () => {
    const service = newService();
    await service.run("c1", "key-1", "hash-1", async () => ({ status: 201, body: {} }));

    await expect(
      service.run("c1", "key-1", "hash-2", async () => ({ status: 201, body: {} })),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("serializes concurrent calls with the same key", async () => {
    const service = newService();
    let executions = 0;
    const produce = async () => {
      executions += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { status: 201, body: { n: executions } };
    };

    const [a, b] = await Promise.all([
      service.run("c1", "same", "h", produce),
      service.run("c1", "same", "h", produce),
    ]);

    expect(executions).toBe(1);
    expect(a.body).toEqual(b.body);
    expect([a.replayed, b.replayed].filter(Boolean)).toHaveLength(1);
  });

  it("scopes keys per connection", async () => {
    const service = newService();
    const produce = vi.fn(async () => ({ status: 201, body: {} }));
    await service.run("c1", "key", "h", produce);
    await service.run("c2", "key", "h", produce);
    expect(produce).toHaveBeenCalledTimes(2);
  });
});

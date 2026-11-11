import { test } from "node:test";
import assert from "node:assert/strict";
import { STATUSES, TransitionError, canTransition, transition } from "../lib/status";

test("the review path", () => {
  assert.equal(transition("submitted", "review", "admin"), "in_review");
  assert.equal(transition("in_review", "publish", "admin"), "published");
  assert.equal(transition("in_review", "request_changes", "admin"), "changes_requested");
  assert.equal(transition("in_review", "reject", "admin"), "rejected");
  assert.equal(transition("submitted", "publish", "admin"), "published");
  assert.equal(transition("changes_requested", "resubmit", "author"), "submitted");
  assert.equal(transition("submitted", "edit", "author"), "submitted");
  assert.equal(transition("published", "unpublish", "admin"), "unpublished");
  assert.equal(transition("unpublished", "republish", "admin"), "published");
});

test("authors withdraw, admins don't; nobody revives final states", () => {
  for (const from of ["submitted", "in_review", "changes_requested", "published"] as const) assert.equal(transition(from, "withdraw", "author"), "withdrawn");
  assert.throws(() => transition("submitted", "withdraw", "admin"), TransitionError);
  assert.throws(() => transition("submitted", "publish", "author"), TransitionError);
  for (const action of ["review", "publish", "request_changes", "reject", "resubmit", "edit", "withdraw", "republish"] as const) {
    assert.equal(canTransition("rejected", action, "admin") || canTransition("rejected", action, "author"), false, action);
    assert.equal(canTransition("withdrawn", action, "admin") || canTransition("withdrawn", action, "author"), false, action);
  }
  assert.throws(() => transition("published", "publish", "admin"), TransitionError);
  assert.throws(() => transition("in_review", "edit", "author"), TransitionError);
  assert.throws(() => transition("changes_requested", "publish", "admin"), TransitionError);
});

test("every status is reachable from submitted", () => {
  const seen = new Set<string>(["submitted"]);
  const actions = ["review", "publish", "request_changes", "reject", "resubmit", "edit", "withdraw", "unpublish", "republish"] as const;
  for (let i = 0; i < 5; i++)
    for (const from of [...seen])
      for (const a of actions)
        for (const actor of ["admin", "author"] as const) if (canTransition(from as never, a, actor)) seen.add(transition(from as never, a, actor));
  assert.deepEqual([...seen].sort(), [...STATUSES].sort());
});

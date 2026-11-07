import { and, asc, eq } from "drizzle-orm";
import { monotonicFactory } from "ulidx";
import { bots, type Bot } from "../db/schema.ts";
import type { YuiDatabase } from "../db/index.ts";
import { DEFAULT_BOT_PERSONA } from "../../shared/app.ts";

// Bot store (multi-bot harness, AD-6 revision): pure-DB CRUD scoped to the
// session user in SQL — the same rule as conversations/store.ts. Bots are
// immutable after creation (no edit path in v1); deleting one cascades its
// threads at the FK level. The persona fallback lives here so every consumer
// (engine route, turn writer) resolves it through ONE seam.

// Monotonic ULIDs: two bots created in the same millisecond stay ordered by
// creation time (the (userId, createdAt) index order must match the list
// order clients render).
const newUlid = monotonicFactory();

export type NewBot = {
  name: string;
  /** Full system-prompt replacement; '' means "default persona at prompt time". */
  persona: string;
};

/**
 * A user's bots in creation order (createdAt asc, id asc tiebreaker) — the
 * order the client renders in the shortcut row. Users without bots get [].
 */
export function listBots(db: YuiDatabase, userId: string): Bot[] {
  return db
    .select()
    .from(bots)
    .where(eq(bots.userId, userId))
    .orderBy(asc(bots.createdAt), asc(bots.id))
    .all();
}

/**
 * Bot `botId` owned by `userId`, or null when it does not exist OR belongs to
 * someone else — callers map both null cases to one identical 404 so the
 * existence of another user's bot never leaks (convention everywhere else).
 */
export function getBotById(db: YuiDatabase, userId: string, botId: string): Bot | null {
  return (
    db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
      .get() ?? null
  );
}

/** Insert one bot owned by `userId`; id and timestamps are minted here. */
export function insertBot(db: YuiDatabase, userId: string, input: NewBot): Bot {
  const now = Date.now();
  const row: Bot = {
    id: newUlid(),
    userId,
    name: input.name,
    persona: input.persona,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(bots).values(row).run();
  return row;
}

/** Delete bot `botId` owned by `userId`; true when a row was removed. */
export function deleteBot(db: YuiDatabase, userId: string, botId: string): boolean {
  const result = db
    .delete(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
    .run();
  return result.changes > 0;
}

/**
 * The persona the engine must run for this bot: the stored persona, or
 * DEFAULT_BOT_PERSONA when it is empty/whitespace. Never returns an empty
 * string — a persona-less bot still fully replaces the engine's default
 * coding-agent prompt (the fallback IS the replacement).
 */
export function resolveBotPersona(bot: { persona: string }): string {
  const persona = bot.persona.trim();
  return persona.length > 0 ? bot.persona : DEFAULT_BOT_PERSONA;
}

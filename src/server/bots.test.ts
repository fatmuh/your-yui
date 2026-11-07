import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Hono } from "hono";
import { ulid } from "ulidx";
import { createApp } from "./app.ts";
import { createDatabase, migrateDatabase, type YuiDatabase } from "./db/index.ts";
import { bots, messages, threads } from "./db/schema.ts";
import { SESSION_COOKIE } from "./auth/cookies.ts";
import { upsertProviderConfig } from "./providers/store.ts";
import { startMockOpenAI, type MockOpenAI } from "../../tests/helpers/mock-openai.ts";
import { postTurn, registerUser } from "../../tests/helpers/api.ts";
import { readSse } from "../../tests/helpers/sse.ts";
import { DEFAULT_BOT_PERSONA } from "../shared/app.ts";
import { resolveBotPersona } from "./bots/store.ts";

// Multi-bot harness proof (epic: bots): per-user bot CRUD behind the session
// gate with pre-write validation, identical foreign-vs-unknown 404s
// (anti-enumeration), cross-user list isolation, and the DELETE cascade that
// removes the bot's threads and their messages. Then the turn↔bot binding:
// `botId` is required when `threadId` is omitted, a rejected bind leaves
// NOTHING behind, a created thread carries threads.bot_id AND the GET
// /api/threads projection, and the resolved persona (stored, or
// DEFAULT_BOT_PERSONA for an empty one) reaches the provider request body —
// the full-replacement system prompt. Finally, migration 0005 is replayed
// over a hand-built 0000–0004 database to prove the "Yui" backfill: one bot
// per threaded user, threads re-bound, no bots for thread-less users.

const KEY_B64 = randomBytes(32).toString("base64");

const tmpRoot = mkdtempSync(join(tmpdir(), "yui-bots-test-"));

const openDbs: YuiDatabase[] = [];
const openMocks: MockOpenAI[] = [];
let fileSeq = 0;

function makeApp(): { app: Hono; db: YuiDatabase } {
  const db = createDatabase(join(tmpRoot, `bots-${++fileSeq}.db`));
  migrateDatabase(db);
  openDbs.push(db);
  return { app: createApp("dist", db), db };
}

/** Disposable KEK active for the whole file (persona turns run the adapter). */
let previousKey: string | undefined;

beforeAll(() => {
  previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = KEY_B64;
});

afterEach(() => {
  while (openDbs.length > 0) {
    openDbs.pop()?.$client.close();
  }
});

afterAll(async () => {
  while (openMocks.length > 0) {
    await openMocks.pop()?.close();
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  if (previousKey === undefined) {
    delete process.env.APP_ENCRYPTION_KEY;
  } else {
    process.env.APP_ENCRYPTION_KEY = previousKey;
  }
});

type BotDto = { id: string; name: string; persona: string; createdAt: string };

const JSON_HEADERS = { "content-type": "application/json" };

async function getBots(app: Hono, token: string | undefined): Promise<Response> {
  return app.request("/api/bots", {
    headers: token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

async function createBot(app: Hono, token: string | undefined, body: unknown): Promise<Response> {
  return app.request("/api/bots", {
    method: "POST",
    headers: token === undefined
      ? JSON_HEADERS
      : { cookie: `${SESSION_COOKIE}=${token}`, ...JSON_HEADERS },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function botById(app: Hono, token: string, botId: string): Promise<Response> {
  return app.request(`/api/bots/${botId}`, { headers: { cookie: `${SESSION_COOKIE}=${token}` } });
}

async function deleteBotById(app: Hono, token: string | undefined, botId: string): Promise<Response> {
  return app.request(`/api/bots/${botId}`, {
    method: "DELETE",
    headers: token === undefined ? {} : { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

/** Read one bot's DTO via the API (201/200 body), asserting the status. */
async function createBotOk(app: Hono, token: string, body: unknown): Promise<BotDto> {
  const res = await createBot(app, token, body);
  expect(res.status).toBe(201);
  return (await res.json()) as BotDto;
}

function seedConfig(db: YuiDatabase, userId: string, mock: MockOpenAI, apiKey: string) {
  return upsertProviderConfig(db, {
    userId,
    kind: "openai-compatible",
    baseUrl: mock.baseUrl,
    modelId: "mock-model",
    apiKey,
  });
}

describe("GET/POST /api/bots", () => {
  it("new user → []; POST stores name TRIMMED with a ULID id and ISO createdAt; list returns creation order", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "bot-pemilik");

    const empty = await getBots(app, user.token);
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual([]);

    const first = await createBotOk(app, user.token, {
      name: "  Travel Planner  ",
      persona: "You plan trips and nothing else.",
    });
    expect(first.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first.name).toBe("Travel Planner");
    expect(first.persona).toBe("You plan trips and nothing else.");
    // DB epoch-ms → ISO-8601 UTC at the API edge (spine convention).
    expect(Number.isNaN(Date.parse(first.createdAt))).toBe(false);
    expect(first.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

    // (createdAt asc, id asc) — the order the client renders the shortcut row.
    const second = await createBotOk(app, user.token, { name: "Study Buddy" });
    const third = await createBotOk(app, user.token, { name: "Chef" });
    const list = await getBots(app, user.token);
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual([first, second, third]);
  });

  it("persona omitted or null → stored EMPTY (the default is resolved at prompt time, never stored expanded)", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "bot-tanpa-persona");

    const omitted = await createBotOk(app, user.token, { name: "Plain" });
    expect(omitted.persona).toBe("");
    const nullPersona = await createBotOk(app, user.token, { name: "Nullish", persona: null });
    expect(nullPersona.persona).toBe("");

    // The GET by id view is the same stored shape.
    const view = await botById(app, user.token, omitted.id);
    expect(view.status).toBe(200);
    await expect(view.json()).resolves.toEqual(omitted);
  });

  it("401 envelope without a session on all four endpoints; the store stays empty", async () => {
    const { app, db } = makeApp();
    const owner = await registerUser(app, "bot-ber-sesi");
    const created = await createBotOk(app, owner.token, { name: "Milik orang" });

    const list = await getBots(app, undefined);
    expect(list.status).toBe(401);
    await expect(list.json()).resolves.toEqual({
      error: { code: "unauthorized", message: expect.any(String) },
    });
    const post = await createBot(app, undefined, { name: "Menyusup" });
    expect(post.status).toBe(401);
    const single = await app.request(`/api/bots/${created.id}`);
    expect(single.status).toBe(401);
    const removed = await deleteBotById(app, undefined, created.id);
    expect(removed.status).toBe(401);

    expect(db.select().from(bots).all()).toHaveLength(1);
  });
});

describe("POST /api/bots — pre-write validation", () => {
  it("bad names and personas → 400 invalid_request, nothing written", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "bot-validasi");

    const badBodies: unknown[] = [
      {},
      { name: "" },
      { name: "   " },
      { name: 42 },
      { name: "a".repeat(65) },
      { name: "Panjang tepat", persona: 42 },
      { name: "Panjang tepat", persona: "p".repeat(8_001) },
      ["not", "an", "object"],
      "a plain string",
    ];
    for (const body of badBodies) {
      const res = await createBot(app, user.token, body);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: { code: "invalid_request", message: expect.any(String) },
      });
    }

    // Malformed JSON body → the same 400 envelope.
    const malformed = await createBot(app, user.token, "{bukan-json");
    expect(malformed.status).toBe(400);

    expect(db.select().from(bots).all()).toEqual([]);
  });

  it("boundary values are accepted: name of exactly 64 chars, persona of exactly 8,000 chars", async () => {
    const { app } = makeApp();
    const user = await registerUser(app, "bot-batas");

    const edge = await createBotOk(app, user.token, {
      name: "n".repeat(64),
      persona: "p".repeat(8_000),
    });
    expect(edge.name).toHaveLength(64);
    expect(edge.persona).toHaveLength(8_000);
  });
});

describe("GET/DELETE /api/bots/:id — isolation + cascade", () => {
  it("foreign vs unknown id: IDENTICAL 404 bodies for GET (no existence leak)", async () => {
    const { app } = makeApp();
    const owner = await registerUser(app, "bot-pemilik-id");
    const stranger = await registerUser(app, "bot-penginta-id");
    const owned = await createBotOk(app, owner.token, { name: "Rahasia" });

    const foreign = await botById(app, stranger.token, owned.id);
    expect(foreign.status).toBe(404);
    const foreignBody = await foreign.json();

    const unknown = await botById(app, stranger.token, ulid());
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.json();

    expect(foreignBody).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    expect(unknownBody).toEqual(foreignBody);
  });

  it("cross-user list isolation: each list shows only its owner's bots", async () => {
    const { app } = makeApp();
    const userA = await registerUser(app, "bot-a");
    const userB = await registerUser(app, "bot-b");
    const botA = await createBotOk(app, userA.token, { name: "Milik A" });
    await createBotOk(app, userB.token, { name: "Milik B 1" });
    await createBotOk(app, userB.token, { name: "Milik B 2" });

    const listA = await getBots(app, userA.token);
    await expect((await listA.json()) as BotDto[]).toEqual([botA]);
    const listB = await getBots(app, userB.token);
    expect(((await listB.json()) as BotDto[]).map((bot) => bot.name)).toEqual(["Milik B 1", "Milik B 2"]);
  });

  it("DELETE own bot → 204, gone from the list; a foreign DELETE is the identical 404 and removes nothing", async () => {
    const { app } = makeApp();
    const owner = await registerUser(app, "bot-penghapus");
    const stranger = await registerUser(app, "bot-penghalang");
    const owned = await createBotOk(app, owner.token, { name: "Untuk dihapus" });

    const foreign = await deleteBotById(app, stranger.token, owned.id);
    expect(foreign.status).toBe(404);
    const unknown = await deleteBotById(app, stranger.token, ulid());
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(await foreign.json());
    // The failed deletes removed nothing: the bot is still in the owner's list.
    const stillThere = await getBots(app, owner.token);
    await expect((await stillThere.json()) as BotDto[]).toEqual([owned]);

    const removed = await deleteBotById(app, owner.token, owned.id);
    expect(removed.status).toBe(204);
    const after = await getBots(app, owner.token);
    await expect(after.json()).resolves.toEqual([]);
    const again = await deleteBotById(app, owner.token, owned.id);
    expect(again.status).toBe(404);
  });

  it("DELETE cascades: the bot's threads AND their messages vanish; another bot's thread survives", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "bot-kaskade");
    const doomed = await createBotOk(app, user.token, { name: "Doomed" });
    const keeper = await createBotOk(app, user.token, { name: "Keeper" });
    const base = Date.UTC(2026, 10, 7, 9, 0, 0);

    const doomedThread = ulid();
    const keeperThread = ulid();
    db.insert(threads).values([
      { id: doomedThread, userId: user.userId, botId: doomed.id, title: "Hilang", createdAt: base, updatedAt: base },
      { id: keeperThread, userId: user.userId, botId: keeper.id, title: "Bertahan", createdAt: base, updatedAt: base },
    ]).run();
    db.insert(messages).values([
      { id: ulid(), threadId: doomedThread, role: "user", text: "pesan hilang", createdAt: base },
      { id: ulid(), threadId: keeperThread, role: "user", text: "pesan bertahan", createdAt: base },
    ]).run();

    const removed = await deleteBotById(app, user.token, doomed.id);
    expect(removed.status).toBe(204);

    expect(db.select().from(bots).all().map((bot) => bot.id)).toEqual([keeper.id]);
    expect(db.select().from(threads).all().map((thread) => thread.id)).toEqual([keeperThread]);
    expect(db.select().from(messages).all().map((message) => message.threadId)).toEqual([keeperThread]);
  });
});

describe("resolveBotPersona (unit)", () => {
  it("empty or whitespace persona → DEFAULT_BOT_PERSONA verbatim; a real persona passes through unchanged", () => {
    expect(resolveBotPersona({ persona: "" })).toBe(DEFAULT_BOT_PERSONA);
    expect(resolveBotPersona({ persona: "   \n\t " })).toBe(DEFAULT_BOT_PERSONA);
    const custom = "You are a laconic chess coach.";
    expect(resolveBotPersona({ persona: custom })).toBe(custom);
  });
});

describe("turn ↔ bot binding (POST /api/engine/turn)", () => {
  it("no threadId and no botId → 400 invalid_request BEFORE any write", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "bot-wajib");

    const res = await postTurn(app, user.token, { content: "Halo" });
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      error: { code: "invalid_request", message: expect.any(String) },
    });

    // Wrong shape is also a 400 (never a silent ignore).
    const shaped = await postTurn(app, user.token, { content: "Halo", botId: 42 });
    expect(shaped.status).toBe(400);

    expect(db.select().from(threads).all()).toEqual([]);
    expect(db.select().from(messages).all()).toEqual([]);
  });

  it("foreign vs unknown botId (new-thread turn): IDENTICAL 404 envelopes, nothing written", async () => {
    const { app, db } = makeApp();
    const stranger = await registerUser(app, "bot-orang-lain");
    const user = await registerUser(app, "bot-pemilik-giliran");
    const foreignBot = await createBotOk(app, stranger.token, { name: "Bot orang lain" });

    const foreign = await postTurn(app, user.token, { content: "Boleh?", botId: foreignBot.id });
    expect(foreign.status).toBe(404);
    const foreignBody = await foreign.json();

    const unknown = await postTurn(app, user.token, { content: "Boleh?", botId: ulid() });
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.json();

    expect(foreignBody).toEqual({ error: { code: "not_found", message: expect.any(String) } });
    expect(unknownBody).toEqual(foreignBody);

    // Rejected BEFORE any write: no thread, no message for the caller.
    expect(db.select().from(threads).all()).toEqual([]);
    expect(db.select().from(messages).all()).toEqual([]);
  });

  it("existing-thread turn: the thread's OWN bot governs; a mismatching body botId is a 400, never a silent switch", async () => {
    const { app, db } = makeApp();
    const user = await registerUser(app, "bot-mismatch");
    const rightBot = await createBotOk(app, user.token, { name: "Bot benar" });
    const otherBot = await createBotOk(app, user.token, { name: "Bot lain" });
    const base = Date.now();
    const threadId = ulid();
    db.insert(threads).values({
      id: threadId,
      userId: user.userId,
      botId: rightBot.id,
      title: "Thread terikat",
      createdAt: base,
      updatedAt: base,
    }).run();

    const mismatch = await postTurn(app, user.token, { threadId, botId: otherBot.id, content: "Halo" });
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toEqual({
      error: { code: "invalid_request", message: expect.any(String) },
    });
    // The rejection is pre-write: the thread still has exactly no messages.
    expect(db.select().from(messages).all()).toEqual([]);
  });

  it("new-thread turn binds the thread to the bot and the CUSTOM persona reaches the provider body", async () => {
    const { app, db } = makeApp();
    const reply = "Balasan tiruan untuk giliran ber-bot.";
    const mock = await startMockOpenAI({ replyText: reply });
    openMocks.push(mock);
    const user = await registerUser(app, "bot-persona-custom");
    seedConfig(db, user.userId, mock, "sk-live-bot-persona-1111aaaa");
    const persona = "You are Chef Yui. You only discuss cooking, recipes, and kitchen tools.";
    const bot = await createBotOk(app, user.token, { name: "Chef", persona });

    const { events } = await readSse(
      await postTurn(app, user.token, { content: "What is for dinner?", botId: bot.id }),
    );
    const sequence = events.map((frame) => frame.event);
    expect(sequence[0]).toBe("thread.updated");
    expect(sequence[sequence.length - 1]).toBe("turn.settled");
    expect(sequence).not.toContain("error");
    const threadId = String(events[0].data.threadId);

    // FULL-REPLACEMENT persona: the bot's persona text — not the engine's
    // default coding-agent prompt — is what the provider received.
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].body).toContain(persona);
    expect(mock.requests[0].body).toContain("What is for dinner?");
    expect(mock.requests[0].body).not.toContain(DEFAULT_BOT_PERSONA);

    // The thread row is bound at creation and the binding is visible on the
    // thread list projection (the client keys its bot↔thread mapping on it).
    const bound = db.select().from(threads).all();
    expect(bound).toHaveLength(1);
    expect(bound[0].botId).toBe(bot.id);
    const list = await app.request("/api/threads", { headers: { cookie: `${SESSION_COOKIE}=${user.token}` } });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as Array<{ id: string; botId: string | null }>;
    expect(listBody.map((thread) => [thread.id, thread.botId])).toEqual([[threadId, bot.id]]);
  });

  it("empty-persona bot: the turn runs with DEFAULT_BOT_PERSONA as the replacement prompt", async () => {
    const { app, db } = makeApp();
    const reply = "Balasan tiruan untuk persona bawaan.";
    const mock = await startMockOpenAI({ replyText: reply });
    openMocks.push(mock);
    const user = await registerUser(app, "bot-persona-bawaan");
    seedConfig(db, user.userId, mock, "sk-live-bot-default-2222bbbb");
    const bot = await createBotOk(app, user.token, { name: "Assistant" });

    const { events } = await readSse(
      await postTurn(app, user.token, { content: "Hello there", botId: bot.id }),
    );
    expect(events.map((frame) => frame.event)).toContain("message.final");

    // The fallback persona IS the replacement: verbatim on the wire, and the
    // engine's default coding-agent prompt is gone.
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0].body).toContain(DEFAULT_BOT_PERSONA);
  });
});

// The production upgrade path for live data: a database that already sits at
// migration 0004 (the drizzle ledger's last row = 0004's journal `when`)
// receives exactly ONE new migration — 0005. Its backfill must leave no
// orphaned threads: every threaded user gets one deterministic "Yui" bot with
// the default persona, all their threads re-bind to it, and thread-less users
// get nothing. The ledger row is built by hand with drizzle's own comparison
// key (created_at = folderMillis of 0004), so migrateDatabase applies 0005 and
// nothing else.
describe("migration 0005 — backfill over a live 0004 database", () => {
  it("applies only 0005: one backfilled Yui bot per threaded user, threads re-bound, no bot for thread-less users", () => {
    const db = createDatabase(join(tmpRoot, `bots-backfill-${++fileSeq}.db`));
    openDbs.push(db);
    const migrationsFolder = join(import.meta.dirname, "db", "migrations");

    // Replay 0000–0004 by hand. `--> statement-breakpoint` lines are SQL
    // comments, so each file's full text can be exec'd as-is.
    const preBots = [
      "0000_wild_thunderbolt_ross",
      "0001_whole_bedlam",
      "0002_nasty_paper_doll",
      "0003_even_stardust",
      "0004_serious_captain_stacy",
    ];
    for (const tag of preBots) {
      db.$client.exec(readFileSync(join(migrationsFolder, `${tag}.sql`), "utf8"));
    }

    // Hand-built ledger row that mirrors drizzle's own bookkeeping: the hash
    // of the last applied file and created_at = that migration's journal
    // `when` (the ONLY value the migrator compares against).
    const lastAppliedSql = readFileSync(join(migrationsFolder, "0004_serious_captain_stacy.sql"), "utf8");
    const lastAppliedWhen = 1_794_030_605_403; // journal entry idx 4
    db.$client.exec(
      `CREATE TABLE IF NOT EXISTS __drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
    );
    db.$client
      .prepare(`INSERT INTO __drizzle_migrations ("hash", "created_at") VALUES (?, ?)`)
      .run(createHash("sha256").update(lastAppliedSql).digest("hex"), lastAppliedWhen);

    // Live data: two users with threads (different oldest-thread timestamps),
    // one user with no threads at all. Seeded with RAW SQL — drizzle's typed
    // inserts always emit every column (bot_id included), and this database
    // deliberately predates that column.
    const base = Date.UTC(2026, 10, 1, 8, 0, 0);
    const userA = "01JCUSERUSERUSERUSERUSERUSA";
    const userB = "01JCUSERUSERUSERUSERUSERUSB";
    const userC = "01JCUSERUSERUSERUSERUSERUSC";
    const seedUser = (id: string, username: string, at: number) =>
      db.$client
        .prepare(`INSERT INTO users ("id", "username", "password_hash", "created_at", "updated_at") VALUES (?, ?, ?, ?, ?)`)
        .run(id, username, "x", at, at);
    seedUser(userA, "threaded-a", base);
    seedUser(userB, "threaded-b", base + 100);
    seedUser(userC, "thread-less", base + 200);
    const seedThread = (id: string, userId: string, at: number) =>
      db.$client
        .prepare(`INSERT INTO threads ("id", "user_id", "created_at", "updated_at") VALUES (?, ?, ?, ?)`)
        .run(id, userId, at, at);
    seedThread("01JCTHRDATHRDATHRDATHRDA01", userA, base + 1_000);
    seedThread("01JCTHRDATHRDATHRDATHRDA02", userA, base + 5_000);
    seedThread("01JCTHRDATHRDATHRDATHRDB01", userB, base + 3_000);

    // The upgrade: only 0005 applies (its journal `when` is greater than the
    // hand-built ledger row; 0000–0004 are all ≤ it).
    expect(() => migrateDatabase(db)).not.toThrow();

    const botRows = db.select().from(bots).all();
    expect(botRows.map((bot) => bot.userId).sort()).toEqual([userA, userB].sort());
    // Thread-less user C never gets a bot.
    expect(botRows.find((bot) => bot.userId === userC)).toBeUndefined();

    const botA = botRows.find((bot) => bot.userId === userA)!;
    const botB = botRows.find((bot) => bot.userId === userB)!;
    // Deterministic id ('backfill-yui-' || user id): cannot collide with the
    // uppercase Crockford ULIDs the app mints, and the UPDATE below targeted it.
    expect(botA.id).toBe(`backfill-yui-${userA}`);
    expect(botB.id).toBe(`backfill-yui-${userB}`);
    expect(botA.name).toBe("Yui");
    expect(botA.persona).toBe(DEFAULT_BOT_PERSONA);
    expect(botB.persona).toBe(DEFAULT_BOT_PERSONA);
    // Timestamps take the user's OLDEST thread so the backfill sorts ahead of
    // any bot created later (COALESCE(MIN(threads.created_at), …)).
    expect(botA.createdAt).toBe(base + 1_000);
    expect(botA.updatedAt).toBe(base + 1_000);
    expect(botB.createdAt).toBe(base + 3_000);

    // Every pre-existing thread is re-bound to its user's backfilled bot —
    // no orphan survives, and the FK cascade can do its job from now on.
    const threadRows = db.select().from(threads).all();
    expect(threadRows).toHaveLength(3);
    for (const thread of threadRows) {
      expect(thread.botId).toBe(`backfill-yui-${thread.userId}`);
    }

    // Ledger: exactly one row was added (0005), and re-running is a no-op.
    const ledger = db.$client
      .prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at")
      .all() as Array<{ hash: string; created_at: number }>;
    expect(ledger).toHaveLength(2);
    const appliedHash = createHash("sha256")
      .update(readFileSync(join(migrationsFolder, "0005_wakeful_maverick.sql"), "utf8"))
      .digest("hex");
    expect(ledger[1]).toEqual({ hash: appliedHash, created_at: 1_794_043_895_136 });
    expect(() => migrateDatabase(db)).not.toThrow();
    expect(db.select().from(bots).all()).toHaveLength(2);
  });
});

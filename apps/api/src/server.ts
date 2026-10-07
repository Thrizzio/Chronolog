import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { asc, desc, eq, inArray, and, lt, gt } from "drizzle-orm";
import { db } from "./db/client.js";
import { activities, activity_allocations, timeBlocks, users } from "./db/schema.js";
import { getGoogleAuthUrl, getGoogleTokens, getGoogleUser } from "./auth/google.js";
import { createSession, getSessionUserId, deleteSession } from "./auth/session.js";
import { getIncompleteTasks, completeTasks, getTaskLists, getTasksFromList } from "./services/google/tasks.js";
import { listEvents } from "./services/google/calendar.js";
import { calculateEffectiveBlock, calculateAllocationDurations } from "./services/timeCalculations.js";
import {
  ensurePomodoroTable,
  getCurrentPlan,
  startPlan,
  pausePlan,
  resumePlan,
  nextPhase,
  skipPhase,
  cancelPlan,
} from "./services/pomodoroService.js";

import { createServer } from "node:http";
import { setupWebSocketServer, broadcastToUser } from "./ws.js";

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(cors({
  origin: process.env.WEB_URL ?? "http://localhost:5173",
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (_request, response) => {
  response.json({ status: "ok", service: "chronolog-api" });
});


async function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  const sessionId = req.cookies.chronolog_session;
  if (!sessionId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const userId = await getSessionUserId(sessionId);
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.locals.userId = userId;
  next();
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────


//this will redirect to google
app.get("/auth/google", (req, res) => {
  res.redirect(getGoogleAuthUrl());
});


//endpoint run by google as this is our redirect URI
app.get("/auth/google/callback", async (req, res) => {
  const code = (req.query.code as string)?.trim();
  const routePath = req.originalUrl.split("?")[0];
  console.log(`[Auth/Callback] Route hit: "${routePath}", code present: ${Boolean(code)}`);

  //so after auth , the code is sent as a part of the redirect URI
  if (!code) {
    res.status(400).send("No code provided");
    return;
  }

  try {
    const tokens = await getGoogleTokens(code);
    const googleUser = await getGoogleUser(tokens.id_token, tokens.access_token);

    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    let [user] = await db.select().from(users).where(eq(users.googleId, googleUser.id));
    if (!user) {//if no user exists we create the user
      [user] = await db.insert(users).values({
        googleId: googleUser.id,
        email: googleUser.email,
        name: googleUser.name,
        avatarUrl: googleUser.picture,
        googleAccessToken: tokens.access_token,
        googleRefreshToken: tokens.refresh_token ?? null,
        googleTokenExpiresAt: expiresAt,
      }).returning();
    } else {//if user exists we update the user
      [user] = await db.update(users).set({
        name: googleUser.name,
        avatarUrl: googleUser.picture,
        googleAccessToken: tokens.access_token,
        googleTokenExpiresAt: expiresAt,
        ...(tokens.refresh_token ? { googleRefreshToken: tokens.refresh_token } : {}),
      }).where(eq(users.id, user.id)).returning();
    }

    const sessionId = await createSession(user.id);

    res.cookie("chronolog_session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    console.log(`[Auth/Callback] User authenticated successfully: id=${user.id}`);
    res.redirect(process.env.WEB_URL ?? "http://localhost:5173");
  } catch (error) {
    console.error("[Auth/Callback] Authentication failed:", error instanceof Error ? error.message : error);
    res.status(500).send("Authentication failed");
  }
});

app.post("/auth/mobile/google", async (req, res) => {
  const { code, redirectUri } = req.body ?? {};
  if (!code || typeof code !== "string") {
    res.status(400).json({ error: "Missing or invalid authorization code" });
    return;
  }

  try {
    // For Android mobile serverAuthCode exchange, Google requires redirect_uri to be "" (empty string)
    const targetRedirectUri = redirectUri !== undefined ? redirectUri : "";
    const tokens = await getGoogleTokens(code, targetRedirectUri);

    // Explicitly log whether a refresh_token was returned by Google
    if (tokens.refresh_token) {
      console.log(`[Auth/Mobile] Token exchange successful. refresh_token received: YES (length: ${tokens.refresh_token.length})`);
    } else {
      console.log("[Auth/Mobile] Token exchange successful. refresh_token received: NO (undefined/null)");
    }

    const googleUser = await getGoogleUser(tokens.id_token, tokens.access_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    let [user] = await db.select().from(users).where(eq(users.googleId, googleUser.id));
    if (!user) {
      [user] = await db.insert(users).values({
        googleId: googleUser.id,
        email: googleUser.email,
        name: googleUser.name,
        avatarUrl: googleUser.picture,
        googleAccessToken: tokens.access_token,
        googleRefreshToken: tokens.refresh_token ?? null,
        googleTokenExpiresAt: expiresAt,
      }).returning();
      console.log(`[Auth/Mobile] Registered new user id=${user.id}, email=${user.email}, hasRefreshToken=${Boolean(user.googleRefreshToken)}`);
    } else {
      // Existing user: NEVER overwrite existing stored refresh token with null
      [user] = await db.update(users).set({
        name: googleUser.name,
        avatarUrl: googleUser.picture,
        googleAccessToken: tokens.access_token,
        googleTokenExpiresAt: expiresAt,
        ...(tokens.refresh_token ? { googleRefreshToken: tokens.refresh_token } : {}),
      }).where(eq(users.id, user.id)).returning();
      console.log(`[Auth/Mobile] Updated existing user id=${user.id}, email=${user.email}, hasRefreshToken=${Boolean(user.googleRefreshToken)}`);
    }

    const sessionId = await createSession(user.id);

    res.cookie("chronolog_session", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      path: "/",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    // Deliver user profile only; sessionId is sent exclusively via Set-Cookie header
    res.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        trackingStartedAt: user.trackingStartedAt,
        selectedTaskListId: user.selectedTaskListId,
      },
    });
  } catch (error) {
    console.error("[Auth/Mobile] Authentication failed:", error);
    res.status(500).json({ error: "Authentication failed" });
  }
});



app.get("/auth/me", requireAuth, async (req, res) => {
  const userId = res.locals.userId;
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  res.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    trackingStartedAt: user.trackingStartedAt,
    selectedTaskListId: user.selectedTaskListId
  });
});

app.post("/auth/logout", async (req, res) => {
  const sessionId = req.cookies.chronolog_session;
  if (sessionId) {
    await deleteSession(sessionId);
  }
  res.clearCookie("chronolog_session");
  res.json({ success: true });
});

// ─── Activities ───────────────────────────────────────────────────────────────

app.get("/activities", requireAuth, async (_request, response) => {
  const userId = response.locals.userId;
  const rows = await db
    .select()
    .from(activities)
    .where(eq(activities.userId, userId))
    .orderBy(asc(activities.createdAt));
  response.json(rows);
});

app.post("/activities", requireAuth, async (request, response) => {
  const userId = response.locals.userId;
  const name = typeof request.body.name === "string" ? request.body.name.trim() : "";
  const color = typeof request.body.color === "string" ? request.body.color.trim() : "";

  if (!name) {
    response.status(400).json({ error: "Activity name is required." });
    return;
  }
  if (!color) {
    response.status(400).json({ error: "Activity color is required." });
    return;
  }

  const [activity] = await db.insert(activities).values({ userId, name, color }).returning();
  response.status(201).json(activity);
});

// ─── Tasks ────────────────────────────────────────────────────────────────────

app.get("/tasks/lists", requireAuth, async (req, res) => {
  const userId = res.locals.userId;
  try {
    const lists = await getTaskLists(userId);
    res.json(lists);
  } catch (error) {
    console.error("Failed to fetch task lists:", error);
    res.status(500).json({ error: "Could not fetch task lists from Google." });
  }
});



app.get("/tasks", requireAuth, async (req, res) => {
  const userId = res.locals.userId;
  try {
    // Get user's selected task list
    const [user] = await db.select().from(users).where(eq(users.id, userId));

    // If no list selected, return empty array
    if (!user.selectedTaskListId) {
      res.json([]);
      return;
    }

    const tasks = await getTasksFromList(userId, user.selectedTaskListId);
    res.json(tasks);
  } catch (error) {
    console.error("Failed to fetch tasks:", error);
    res.status(500).json({ error: "Could not fetch tasks from Google." });
  }
});

app.post("/settings/task-list", requireAuth, async (req, res) => {
  const userId = res.locals.userId;
  const taskListId = typeof req.body.taskListId === "string" ? req.body.taskListId.trim() : "";

  if (!taskListId) {
    res.status(400).json({ error: "taskListId is required." });
    return;
  }

  try {
    await db
      .update(users)
      .set({ selectedTaskListId: taskListId })
      .where(eq(users.id, userId));

    res.json({ success: true });
  } catch (error) {
    console.error("Failed to update task list preference:", error);
    res.status(500).json({ error: "Could not save task list preference." });
  }
});

app.post("/tasks/complete", requireAuth, async (req, res) => {
  const userId = res.locals.userId;
  const taskIds = Array.isArray(req.body.taskIds) ? req.body.taskIds : [];

  if (taskIds.length === 0) {
    res.status(400).json({ error: "taskIds array is required." });
    return;
  }

  try {
    await completeTasks(userId, taskIds);
    broadcastToUser(userId, "task.completed", { taskIds });
    res.json({ success: true });
  } catch (error) {
    console.error("Failed to complete tasks:", error);
    res.status(500).json({ error: "Could not complete tasks in Google." });
  }
});

// ─── Tracking State ──────────────────────────────────────────────────────────

app.post("/tracking/start", requireAuth, async (req, res) => {
  const userId = res.locals.userId;
  const now = new Date();

  await db
    .update(users)
    .set({ trackingStartedAt: now })
    .where(eq(users.id, userId));

  broadcastToUser(userId, "tracking.started", {
    trackingStartedAt: now.toISOString(),
  });

  res.json({ trackingStartedAt: now });
});

app.post("/tracking/reset", requireAuth, async (req, res) => {
  const userId = res.locals.userId;

  await db
    .update(users)
    .set({ trackingStartedAt: null })
    .where(eq(users.id, userId));

  broadcastToUser(userId, "tracking.reset", {
    trackingStartedAt: null,
  });

  res.json({ success: true, trackingStartedAt: null });
});

// ─── Time blocks  ─────────────────────────────────────────────────────────────

/**
 * POST /log-session
 *
 * Body: { allocations: Array<{ activityId: number; percentage: number }>, completedTaskIds?: string[] }
 *
 * The backend is solely responsible for determining time.
 *  - start_time = end_time of the most recently created time block, OR
 *                 the server time of this very request if no block exists yet
 *  - end_time   = current server time (captured once at request start)
 *
 * On success returns the full time block with all allocations and their activity.
 * Also handles Google Tasks integration gracefully.
 */
app.post("/log-session", requireAuth, async (request, response) => {
  // ── 1. Parse and validate input ────────────────────────────────────────────
  const userId = response.locals.userId;

  const rawAllocations: unknown = request.body.allocations;

  if (!Array.isArray(rawAllocations) || rawAllocations.length === 0) {
    response.status(400).json({ error: "allocations must be a non-empty array." });
    return;
  }

  type RawAlloc = { activityId: unknown; percentage: unknown };
  const allocs = rawAllocations as RawAlloc[];

  // All entries must have integer activityId > 0 and integer percentage 0–100
  for (const alloc of allocs) {
    const id = Number(alloc.activityId);
    const pct = Number(alloc.percentage);

    if (!Number.isInteger(id) || id <= 0) {
      response.status(400).json({ error: `Invalid activityId: ${String(alloc.activityId)}.` });
      return;
    }
    if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
      response.status(400).json({ error: `Percentage must be an integer between 0 and 100. Got ${String(alloc.percentage)}.` });
      return;
    }
  }

  const typedAllocs = allocs.map((a) => ({
    activityId: Number(a.activityId),
    percentage: Number(a.percentage),
  }));

  // Percentages must sum to exactly 100
  const totalPct = typedAllocs.reduce((sum, a) => sum + a.percentage, 0);
  if (totalPct !== 100) {
    response.status(400).json({
      error: `Allocation percentages must sum to 100. Got ${totalPct}.`,
    });
    return;
  }

  // All activityIds must exist in the DB and belong to the user
  const activityIds = typedAllocs.map((a) => a.activityId);
  const foundActivities = await db
    .select({ id: activities.id, name: activities.name, color: activities.color })
    .from(activities)
    .where(and(
      eq(activities.userId, userId),
      inArray(activities.id, activityIds)
    ));

  if (foundActivities.length !== activityIds.length) {
    const foundIds = new Set(foundActivities.map((a) => a.id));
    const missing = activityIds.filter((id) => !foundIds.has(id));
    response.status(404).json({ error: `Activity IDs not found or access denied: ${missing.join(", ")}.` });
    return;
  }

  const activityMap = Object.fromEntries(foundActivities.map((a) => [a.id, a]));

  // ── 2. Determine time boundaries (server side only) ────────────────────────

  const endTime = new Date(); // captured once — single source of truth for "now"

  // Fetch tracking state for THIS user
  const [currentUser] = await db
    .select({ trackingStartedAt: users.trackingStartedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Fallback to endTime if trackingStartedAt is null
  const startTime = currentUser?.trackingStartedAt ? currentUser.trackingStartedAt : endTime;
  const { elapsedSeconds } = calculateEffectiveBlock(startTime, endTime);

  // ── 3. Compute duration_seconds per allocation ────────────────────────────
  //
  // Computed in memory only — stored column is `percentage`.
  // Sum is guaranteed to equal elapsedSeconds by giving remainder to the
  // largest allocation via calculateAllocationDurations.
  const durations = calculateAllocationDurations(elapsedSeconds, typedAllocs);

  // ── 4. Persist inside a transaction ───────────────────────────────────────

  try {
    const result = await db.transaction(async (tx) => {
      // Insert time block
      const [block] = await tx
        .insert(timeBlocks)
        .values({ userId, startTime, endTime })
        .returning();

      // Insert all allocations
      const insertedAllocations = await tx
        .insert(activity_allocations)
        .values(
          typedAllocs.map((a) => ({
            timeBlockId: block.id,
            activityId: a.activityId,
            percentage: a.percentage,
          })),
        )
        .returning();

      // Update the user's tracking state to immediately begin the next contiguous block
      await tx
        .update(users)
        .set({ trackingStartedAt: endTime })
        .where(eq(users.id, userId));

      return { block, insertedAllocations };
    });

    // ── 5. Complete Google Tasks (Secondary) ──────────────────────────────
    // Task completion is now handled separately via POST /tasks/complete

    // ── 6. Build enriched response ────────────────────────────────────────

    const durationMap = Object.fromEntries(
      durations.map((d) => [d.activityId, d.durationSeconds]),
    );

    const createdBlock = {
      id: result.block.id,
      startTime: result.block.startTime,
      endTime: result.block.endTime,
      createdAt: result.block.createdAt,
      elapsedSeconds,
      allocations: result.insertedAllocations.map((alloc) => ({
        id: alloc.id,
        activityId: alloc.activityId,
        percentage: alloc.percentage,
        durationSeconds: durationMap[alloc.activityId] ?? 0,
        activity: activityMap[alloc.activityId],
      })),
    };

    broadcastToUser(userId, "time-block.created", {
      block: createdBlock,
      trackingStartedAt: endTime.toISOString(),
    });

    response.status(201).json({
      success: true,
      block: createdBlock,
    });
  } catch (err) {
    console.error("Failed to create time block:", err);
    response.status(500).json({ error: "Could not save time block. Please try again." });
  }
});

// ─── GET /google/calendar ─────────────────────────────────────────────────────

app.get("/google/calendar", requireAuth, async (req, res) => {
  const userId = res.locals.userId;
  const start = req.query.start as string;
  const end = req.query.end as string;

  if (!start || !end) {
    res.status(400).json({ error: "start and end query parameters are required" });
    return;
  }

  try {
    const events = await listEvents(userId, start, end);
    res.json(events);
  } catch (err) {
    console.error("Failed to fetch calendar events:", err);
    res.status(500).json({ error: "Could not load calendar events" });
  }
});

// ─── GET /time-blocks ────────────────────────────────────────────────────────
//
// Returns all time blocks with their allocations and activity details.
// A single three-way join avoids N+1.  Rows are grouped in memory.
// Ordered newest first (desc by start_time).

app.get("/time-blocks", requireAuth, async (request, response) => {
  const userId = response.locals.userId;
  const rawStart = (request.query.startDate ?? request.query.start) as string | undefined;
  const rawEnd = (request.query.endDate ?? request.query.end) as string | undefined;

  const windowStart = rawStart ? new Date(rawStart) : undefined;
  const windowEnd = rawEnd ? new Date(rawEnd) : undefined;
  const hasWindow = Boolean(
    windowStart && windowEnd && !isNaN(windowStart.getTime()) && !isNaN(windowEnd.getTime())
  );

  try {
    const whereCondition = hasWindow
      ? and(
          eq(timeBlocks.userId, userId),
          lt(timeBlocks.startTime, windowEnd!),
          gt(timeBlocks.endTime, windowStart!)
        )
      : eq(timeBlocks.userId, userId);

    // One query — left join so a block with no allocations still appears
    const rows = await db
      .select({
        blockId: timeBlocks.id,
        blockStartTime: timeBlocks.startTime,
        blockEndTime: timeBlocks.endTime,
        blockCreatedAt: timeBlocks.createdAt,
        allocId: activity_allocations.id,
        allocPct: activity_allocations.percentage,
        actId: activities.id,
        actName: activities.name,
        actColor: activities.color,
      })
      .from(timeBlocks)
      .where(whereCondition)
      .leftJoin(
        activity_allocations,
        eq(activity_allocations.timeBlockId, timeBlocks.id),
      )
      .leftJoin(
        activities,
        eq(activities.id, activity_allocations.activityId),
      )
      .orderBy(desc(timeBlocks.startTime));

    // Group flat rows → hierarchical blocks
    type TempBlock = {
      id: number;
      startTime: Date;
      endTime: Date;
      createdAt: Date;
      elapsedSeconds: number;
      rawAllocations: Array<{
        id: number;
        activityId: number;
        percentage: number;
        activity: { id: number; name: string; color: string };
      }>;
    };

    const blockMap = new Map<number, TempBlock>();

    for (const row of rows) {
      if (!blockMap.has(row.blockId)) {
        const { effectiveStart, effectiveEnd, elapsedSeconds } = calculateEffectiveBlock(
          row.blockStartTime,
          row.blockEndTime,
          hasWindow ? windowStart : undefined,
          hasWindow ? windowEnd : undefined,
        );

        blockMap.set(row.blockId, {
          id: row.blockId,
          startTime: effectiveStart,
          endTime: effectiveEnd,
          createdAt: row.blockCreatedAt,
          elapsedSeconds,
          rawAllocations: [],
        });
      }

      // A block might legitimately have no allocations (left join returns nulls)
      if (row.allocId !== null && row.actId !== null) {
        const block = blockMap.get(row.blockId)!;
        block.rawAllocations.push({
          id: row.allocId,
          activityId: row.actId,
          percentage: row.allocPct ?? 0,
          activity: { id: row.actId, name: row.actName!, color: row.actColor! },
        });
      }
    }

    // Distribute allocation durations using the shared helper
    const result = Array.from(blockMap.values()).map((block) => {
      const distributed = calculateAllocationDurations(
        block.elapsedSeconds,
        block.rawAllocations.map((a) => ({ activityId: a.activityId, percentage: a.percentage })),
      );
      const durationMap = new Map(distributed.map((d) => [d.activityId, d.durationSeconds]));

      return {
        id: block.id,
        startTime: block.startTime,
        endTime: block.endTime,
        createdAt: block.createdAt,
        elapsedSeconds: block.elapsedSeconds,
        allocations: block.rawAllocations.map((a) => ({
          id: a.id,
          activityId: a.activityId,
          percentage: a.percentage,
          durationSeconds: durationMap.get(a.activityId) ?? 0,
          activity: a.activity,
        })),
      };
    });

    // Already in desc(startTime) order from the query; Map preserves insertion order
    response.json(result);
  } catch (err) {
    console.error("Failed to fetch time blocks:", err);
    response.status(500).json({ error: "Could not fetch time blocks." });
  }
});

// ─── GET /time-summary ────────────────────────────────────────────────────────
//
// Computes daily time summary for the authenticated user within [startDate, endDate).
// Reuses calculateEffectiveBlock and calculateAllocationDurations so cross-midnight
// blocks are split accurately and integer remainder is handled canonically.
// Accounts for the user's currently active tracking session if running.

app.get("/time-summary", requireAuth, async (request, response) => {
  const userId = response.locals.userId;

  const rawStart = (request.query.startDate ?? request.query.start) as string | undefined;
  const rawEnd = (request.query.endDate ?? request.query.end) as string | undefined;

  let windowStart: Date;
  let windowEnd: Date;

  if (rawStart && rawEnd) {
    windowStart = new Date(rawStart);
    windowEnd = new Date(rawEnd);
  } else {
    // Default to today's local UTC representation
    const now = new Date();
    windowStart = new Date(now);
    windowStart.setHours(0, 0, 0, 0);
    windowEnd = new Date(windowStart);
    windowEnd.setDate(windowEnd.getDate() + 1);
  }

  if (isNaN(windowStart.getTime()) || isNaN(windowEnd.getTime()) || windowStart >= windowEnd) {
    response.status(400).json({ error: "Invalid startDate or endDate query parameters." });
    return;
  }

  try {
    // 1. Fetch finalized time blocks overlapping the window
    const rows = await db
      .select({
        blockId: timeBlocks.id,
        blockStartTime: timeBlocks.startTime,
        blockEndTime: timeBlocks.endTime,
        allocPct: activity_allocations.percentage,
        actId: activities.id,
        actName: activities.name,
        actColor: activities.color,
      })
      .from(timeBlocks)
      .where(
        and(
          eq(timeBlocks.userId, userId),
          lt(timeBlocks.startTime, windowEnd),
          gt(timeBlocks.endTime, windowStart)
        )
      )
      .innerJoin(
        activity_allocations,
        eq(activity_allocations.timeBlockId, timeBlocks.id)
      )
      .innerJoin(
        activities,
        eq(activities.id, activity_allocations.activityId)
      );

    // Group allocations by block
    type BlockSummary = {
      blockStartTime: Date;
      blockEndTime: Date;
      allocations: Array<{
        activityId: number;
        percentage: number;
        name: string;
        color: string;
      }>;
    };

    const blocksMap = new Map<number, BlockSummary>();

    for (const row of rows) {
      if (!blocksMap.has(row.blockId)) {
        blocksMap.set(row.blockId, {
          blockStartTime: row.blockStartTime,
          blockEndTime: row.blockEndTime,
          allocations: [],
        });
      }
      blocksMap.get(row.blockId)!.allocations.push({
        activityId: row.actId,
        percentage: row.allocPct,
        name: row.actName,
        color: row.actColor,
      });
    }

    // 2. Aggregate activity durations across blocks
    const activityTotals = new Map<
      number,
      { id: number; name: string; color: string; totalSeconds: number }
    >();
    let finalizedSeconds = 0;

    for (const block of blocksMap.values()) {
      const { elapsedSeconds } = calculateEffectiveBlock(
        block.blockStartTime,
        block.blockEndTime,
        windowStart,
        windowEnd
      );

      finalizedSeconds += elapsedSeconds;

      const distributed = calculateAllocationDurations(
        elapsedSeconds,
        block.allocations.map((a) => ({ activityId: a.activityId, percentage: a.percentage }))
      );

      const durationMap = new Map(distributed.map((d) => [d.activityId, d.durationSeconds]));

      for (const alloc of block.allocations) {
        const duration = durationMap.get(alloc.activityId) ?? 0;
        if (!activityTotals.has(alloc.activityId)) {
          activityTotals.set(alloc.activityId, {
            id: alloc.activityId,
            name: alloc.name,
            color: alloc.color,
            totalSeconds: 0,
          });
        }
        activityTotals.get(alloc.activityId)!.totalSeconds += duration;
      }
    }

    // 3. Inspect actively running/current tracking block for user
    const [user] = await db
      .select({ trackingStartedAt: users.trackingStartedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    let activeTrackingSeconds = 0;
    let hasActiveTracking = false;
    let activeTrackingStartedAt: string | null = null;

    if (user?.trackingStartedAt) {
      hasActiveTracking = true;
      activeTrackingStartedAt = user.trackingStartedAt.toISOString();
      const now = new Date();
      const { elapsedSeconds: activeSeconds } = calculateEffectiveBlock(
        user.trackingStartedAt,
        now,
        windowStart,
        windowEnd
      );
      activeTrackingSeconds = activeSeconds;
    }

    const totalTrackedSeconds = finalizedSeconds + activeTrackingSeconds;

    // Format activity list sorted by total duration descending
    const sortedActivities = Array.from(activityTotals.values())
      .filter((a) => a.totalSeconds > 0)
      .sort((a, b) => b.totalSeconds - a.totalSeconds)
      .map((a) => ({
        ...a,
        percentage:
          totalTrackedSeconds > 0
            ? Math.round((a.totalSeconds / totalTrackedSeconds) * 100)
            : 0,
      }));

    response.json({
      startDate: windowStart.toISOString(),
      endDate: windowEnd.toISOString(),
      totalTrackedSeconds,
      finalizedSeconds,
      activeTrackingSeconds,
      hasActiveTracking,
      activeTrackingStartedAt,
      activities: sortedActivities,
    });
  } catch (err) {
    console.error("Failed to generate time summary:", err);
    response.status(500).json({ error: "Could not generate time summary." });
  }
});

// ─── Pomodoro Focus Routes ───────────────────────────────────────────────────

app.get("/pomodoro/current", requireAuth, async (_req, res) => {
  const userId = res.locals.userId as number;
  try {
    const plan = await getCurrentPlan(userId);
    res.json({ plan });
  } catch (error) {
    console.error("Failed to get current pomodoro plan:", error);
    res.status(500).json({ error: "Could not retrieve pomodoro plan." });
  }
});

app.post("/pomodoro/start", requireAuth, async (req, res) => {
  const userId = res.locals.userId as number;
  try {
    const plan = await startPlan(userId, req.body);
    broadcastToUser(userId, "pomodoro.updated", { plan });
    res.status(201).json({ plan });
  } catch (error) {
    console.error("Failed to start pomodoro plan:", error);
    res.status(500).json({ error: "Could not start pomodoro plan." });
  }
});

app.post("/pomodoro/pause", requireAuth, async (req, res) => {
  const userId = res.locals.userId as number;
  try {
    const plan = await pausePlan(userId, req.body?.planId);
    broadcastToUser(userId, "pomodoro.updated", { plan });
    res.json({ plan });
  } catch (error) {
    console.error("Failed to pause pomodoro plan:", error);
    res.status(500).json({ error: "Could not pause pomodoro plan." });
  }
});

app.post("/pomodoro/resume", requireAuth, async (req, res) => {
  const userId = res.locals.userId as number;
  try {
    const plan = await resumePlan(userId, req.body?.planId);
    broadcastToUser(userId, "pomodoro.updated", { plan });
    res.json({ plan });
  } catch (error) {
    console.error("Failed to resume pomodoro plan:", error);
    res.status(500).json({ error: "Could not resume pomodoro plan." });
  }
});

app.post("/pomodoro/next", requireAuth, async (req, res) => {
  const userId = res.locals.userId as number;
  try {
    const plan = await nextPhase(userId, req.body?.planId);
    broadcastToUser(userId, "pomodoro.updated", { plan });
    res.json({ plan });
  } catch (error) {
    console.error("Failed to advance pomodoro phase:", error);
    res.status(500).json({ error: "Could not advance pomodoro phase." });
  }
});

app.post("/pomodoro/skip", requireAuth, async (req, res) => {
  const userId = res.locals.userId as number;
  try {
    const plan = await skipPhase(userId, req.body?.planId);
    broadcastToUser(userId, "pomodoro.updated", { plan });
    res.json({ plan });
  } catch (error) {
    console.error("Failed to skip pomodoro phase:", error);
    res.status(500).json({ error: "Could not skip pomodoro phase." });
  }
});

app.post("/pomodoro/cancel", requireAuth, async (req, res) => {
  const userId = res.locals.userId as number;
  try {
    const plan = await cancelPlan(userId, req.body?.planId);
    broadcastToUser(userId, "pomodoro.updated", { plan });
    res.json({ plan });
  } catch (error) {
    console.error("Failed to cancel pomodoro plan:", error);
    res.status(500).json({ error: "Could not cancel pomodoro plan." });
  }
});

// ─── Server ───────────────────────────────────────────────────────────────────

const server = createServer(app);
setupWebSocketServer(server);

ensurePomodoroTable().catch((err) => {
  console.error("Failed to ensure pomodoro table:", err);
});

server.listen(port, () => {
  console.log(`Chronolog API is running on http://localhost:${port}`);
});

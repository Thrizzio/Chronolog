import assert from "node:assert/strict";
import {
  calculatePauseTransition,
  calculateResumeTransition,
  calculateNextTransition,
  calculateCancelTransition,
  advancePlanToTime,
  type PomodoroPlanState,
} from "./pomodoroService.js";

console.log("Running pomodoroService state machine and time accounting tests...\n");

function createMockPlan(overrides: Partial<PomodoroPlanState> = {}): PomodoroPlanState {
  return {
    status: "focus",
    currentPhase: "focus",
    currentSession: 1,
    totalSessions: 4,
    focusDurationSeconds: 1500, // 25 min
    shortBreakDurationSeconds: 300, // 5 min
    longBreakDurationSeconds: 900, // 15 min
    longBreakInterval: 4,
    autoStartBreaks: true,
    autoStartFocus: true,
    phaseStartedAt: new Date("2026-09-24T10:00:00.000Z"),
    phaseEndsAt: new Date("2026-09-24T10:25:00.000Z"),
    pausedAt: null,
    pausedRemainingSeconds: null,
    totalFocusSeconds: 0,
    totalBreakSeconds: 0,
    totalPausedSeconds: 0,
    completedSessions: 0,
    completedAt: null,
    ...overrides,
  };
}

// ── Test 1: Pause active focus session ─────────────────────────────────────────
{
  const plan = createMockPlan();
  const pauseTime = new Date("2026-09-24T10:10:00.000Z"); // 10 minutes in (600s elapsed)

  const updates = calculatePauseTransition(plan, pauseTime);
  assert.equal(updates.status, "paused", "Status should be paused");
  assert.equal(updates.pausedRemainingSeconds, 900, "15 minutes (900s) remaining");
  assert.equal(updates.totalFocusSeconds, 600, "Focus time should accumulate 600s");
  assert.equal(updates.totalBreakSeconds, 0, "Break time should remain 0s");
  console.log("✓ Test 1 passed: Pause active focus session accounts time correctly");
}

// ── Test 2: Resume paused session ─────────────────────────────────────────────
{
  const plan = createMockPlan({
    status: "paused",
    phaseStartedAt: null,
    phaseEndsAt: null,
    pausedAt: new Date("2026-09-24T10:10:00.000Z"),
    pausedRemainingSeconds: 900,
    totalFocusSeconds: 600,
    totalBreakSeconds: 0,
    totalPausedSeconds: 0,
  });

  const resumeTime = new Date("2026-09-24T10:15:00.000Z"); // paused for 5 minutes (300s)

  const updates = calculateResumeTransition(plan, resumeTime);
  assert.equal(updates.status, "focus", "Status should resume to focus");
  assert.equal(updates.totalPausedSeconds, 300, "Paused time should accumulate 300s");
  assert.equal(
    updates.phaseEndsAt?.toISOString(),
    "2026-09-24T10:30:00.000Z",
    "phaseEndsAt should extend by remaining 900s from resume time"
  );
  console.log("✓ Test 2 passed: Resume paused session accounts paused time and sets phaseEndsAt");
}

// ── Test 3: Paused time NEVER counts as focus or break ────────────────────────
{
  const plan = createMockPlan({
    status: "paused",
    pausedAt: new Date("2026-09-24T10:10:00.000Z"),
    pausedRemainingSeconds: 900,
    totalFocusSeconds: 600,
    totalBreakSeconds: 120,
    totalPausedSeconds: 50,
  });

  const resumeTime = new Date("2026-09-24T10:30:00.000Z"); // paused for 20 minutes (1200s)
  const updates = calculateResumeTransition(plan, resumeTime);

  // Focus and break are untouched by pause duration
  assert.equal(updates.totalPausedSeconds, 1250, "Paused time accumulated 1200s + 50s");
  console.log("✓ Test 3 passed: Paused duration is strictly segregated from focus/break totals");
}

// ── Test 4: Focus -> Short Break (manual start when autoStartBreaks = false) ──
{
  const plan = createMockPlan({
    completedSessions: 0,
    autoStartBreaks: false,
  });

  const finishTime = new Date("2026-09-24T10:25:00.000Z");
  const updates = calculateNextTransition(plan, finishTime);

  assert.equal(updates.completedSessions, 1, "Completed sessions should increment to 1");
  assert.equal(updates.currentPhase, "shortBreak", "Current phase should be shortBreak");
  assert.equal(updates.status, "paused", "Status should be paused when autoStartBreaks is false");
  assert.equal(updates.pausedRemainingSeconds, 300, "Break remaining should default to 300s (5m)");
  console.log("✓ Test 4 passed: Transition to shortBreak pauses waiting for user start");
}

// ── Test 5: Focus -> Short Break (auto start when autoStartBreaks = true) ─────
{
  const plan = createMockPlan({
    completedSessions: 0,
    autoStartBreaks: true,
  });

  const finishTime = new Date("2026-09-24T10:25:00.000Z");
  const updates = calculateNextTransition(plan, finishTime);

  assert.equal(updates.completedSessions, 1);
  assert.equal(updates.currentPhase, "shortBreak");
  assert.equal(updates.status, "shortBreak", "Status should immediately start shortBreak");
  assert.equal(
    updates.phaseEndsAt?.toISOString(),
    "2026-09-24T10:30:00.000Z",
    "phaseEndsAt should be 5 minutes after finishTime"
  );
  console.log("✓ Test 5 passed: Transition to shortBreak auto-starts when enabled");
}

// ── Test 6: Short Break -> Next Focus session ─────────────────────────────────
{
  const plan = createMockPlan({
    currentPhase: "shortBreak",
    status: "shortBreak",
    currentSession: 1,
    completedSessions: 1,
    phaseStartedAt: new Date("2026-09-24T10:25:00.000Z"),
    phaseEndsAt: new Date("2026-09-24T10:30:00.000Z"),
    autoStartFocus: true,
  });

  const breakDoneTime = new Date("2026-09-24T10:30:00.000Z");
  const updates = calculateNextTransition(plan, breakDoneTime);

  assert.equal(updates.currentSession, 2, "Session number should advance to 2");
  assert.equal(updates.currentPhase, "focus");
  assert.equal(updates.status, "focus");
  assert.equal(
    updates.phaseEndsAt?.toISOString(),
    "2026-09-24T10:55:00.000Z",
    "New focus endsAt should be 25m after breakDoneTime"
  );
  console.log("✓ Test 6 passed: Short break transitions to session 2 focus");
}

// ── Test 7: Long break triggered on interval (session 4) ──────────────────────
{
  const plan = createMockPlan({
    currentSession: 4,
    completedSessions: 3, // completing 4th session now
    longBreakInterval: 4,
    longBreakDurationSeconds: 900, // 15m
    totalSessions: 6,
    autoStartBreaks: true,
  });

  const finishTime = new Date("2026-09-24T12:00:00.000Z");
  const updates = calculateNextTransition(plan, finishTime);

  assert.equal(updates.completedSessions, 4);
  assert.equal(updates.currentPhase, "longBreak", "4th session completion triggers longBreak");
  assert.equal(
    updates.phaseEndsAt?.toISOString(),
    "2026-09-24T12:15:00.000Z",
    "longBreak endsAt should be 15m (900s) later"
  );
  console.log("✓ Test 7 passed: Long break interval correctly triggered on session 4");
}

// ── Test 8: Plan completion after totalSessions ───────────────────────────────
{
  const plan = createMockPlan({
    currentSession: 4,
    completedSessions: 3,
    totalSessions: 4,
    phaseStartedAt: new Date("2026-09-24T12:00:00.000Z"),
    phaseEndsAt: new Date("2026-09-24T12:25:00.000Z"),
    totalFocusSeconds: 4500,
  });

  const finalDoneTime = new Date("2026-09-24T12:25:00.000Z");
  const updates = calculateNextTransition(plan, finalDoneTime);

  assert.equal(updates.completedSessions, 4);
  assert.equal(updates.status, "completed", "Status must become completed");
  assert.equal(updates.completedAt?.toISOString(), finalDoneTime.toISOString());
  assert.equal(updates.totalFocusSeconds, 6000, "Total focus seconds reached 4 * 1500s = 6000s");
  console.log("✓ Test 8 passed: Plan successfully marks completed with total duration");
}

// ── Test 9: Cancel plan records final time ────────────────────────────────────
{
  const plan = createMockPlan({
    phaseStartedAt: new Date("2026-09-24T10:00:00.000Z"),
    totalFocusSeconds: 100,
  });

  const cancelTime = new Date("2026-09-24T10:10:00.000Z"); // 600s elapsed
  const updates = calculateCancelTransition(plan, cancelTime);

  assert.equal(updates.status, "cancelled");
  assert.equal(updates.totalFocusSeconds, 700, "Total focus accounts 100 + 600 = 700s");
  assert.equal(updates.completedAt?.toISOString(), cancelTime.toISOString());
  console.log("✓ Test 9 passed: Cancel plan finalizes status and recorded time");
}

// ── Test 10: focus -> short break (natural time expiration) ───────────────────
{
  const plan = createMockPlan({
    currentSession: 1,
    completedSessions: 0,
    totalSessions: 4,
    autoStartBreaks: true,
    phaseStartedAt: new Date("2026-09-24T10:00:00.000Z"),
    phaseEndsAt: new Date("2026-09-24T10:25:00.000Z"),
    shortBreakDurationSeconds: 300,
  });

  const now = new Date("2026-09-24T10:25:00.000Z"); // Exactly when focus finishes
  const { plan: advanced, changed } = advancePlanToTime(plan, now);

  assert.equal(changed, true, "Plan should advance when boundary reached");
  assert.equal(advanced.status, "shortBreak", "Status should be shortBreak");
  assert.equal(advanced.currentPhase, "shortBreak", "Phase should be shortBreak");
  assert.equal(advanced.currentSession, 2, "Session indicator should advance to 2 for 'Next: Session 2 of 4'");
  assert.equal(advanced.completedSessions, 1, "Completed sessions incremented to 1");
  assert.equal(advanced.phaseStartedAt?.toISOString(), "2026-09-24T10:25:00.000Z");
  assert.equal(advanced.phaseEndsAt?.toISOString(), "2026-09-24T10:30:00.000Z");
  assert.equal(advanced.totalFocusSeconds, 1500, "1500s of focus recorded");
  console.log("✓ Test 10 passed: Natural transition focus -> short break with correct session number and countdown");
}

// ── Test 11: focus -> long break on interval ─────────────────────────────────
{
  const plan = createMockPlan({
    currentSession: 4,
    completedSessions: 3,
    totalSessions: 6,
    longBreakInterval: 4,
    longBreakDurationSeconds: 900,
    autoStartBreaks: true,
    phaseStartedAt: new Date("2026-09-24T12:00:00.000Z"),
    phaseEndsAt: new Date("2026-09-24T12:25:00.000Z"),
  });

  const now = new Date("2026-09-24T12:25:00.000Z");
  const { plan: advanced, changed } = advancePlanToTime(plan, now);

  assert.equal(changed, true);
  assert.equal(advanced.status, "longBreak");
  assert.equal(advanced.currentPhase, "longBreak");
  assert.equal(advanced.currentSession, 5, "Session indicator advances to 5 for 'Next: Session 5 of 6'");
  assert.equal(advanced.completedSessions, 4);
  assert.equal(advanced.phaseEndsAt?.toISOString(), "2026-09-24T12:40:00.000Z"); // +15 min
  console.log("✓ Test 11 passed: Natural transition focus -> long break on configured interval");
}

// ── Test 12: break -> next focus session ──────────────────────────────────────
{
  const plan = createMockPlan({
    status: "shortBreak",
    currentPhase: "shortBreak",
    currentSession: 2,
    completedSessions: 1,
    totalSessions: 4,
    focusDurationSeconds: 1500,
    autoStartFocus: true,
    phaseStartedAt: new Date("2026-09-24T10:25:00.000Z"),
    phaseEndsAt: new Date("2026-09-24T10:30:00.000Z"),
  });

  const now = new Date("2026-09-24T10:30:00.000Z");
  const { plan: advanced, changed } = advancePlanToTime(plan, now);

  assert.equal(changed, true);
  assert.equal(advanced.status, "focus");
  assert.equal(advanced.currentPhase, "focus");
  assert.equal(advanced.currentSession, 2, "Session indicator remains Session 2 of 4");
  assert.equal(advanced.phaseStartedAt?.toISOString(), "2026-09-24T10:30:00.000Z");
  assert.equal(advanced.phaseEndsAt?.toISOString(), "2026-09-24T10:55:00.000Z");
  console.log("✓ Test 12 passed: Natural transition break -> next focus with countdown reset");
}

// ── Test 13: final focus -> completed (never leaves timer at 00:00) ───────────
{
  const plan = createMockPlan({
    currentSession: 4,
    completedSessions: 3,
    totalSessions: 4,
    phaseStartedAt: new Date("2026-09-24T12:00:00.000Z"),
    phaseEndsAt: new Date("2026-09-24T12:25:00.000Z"),
  });

  const now = new Date("2026-09-24T12:25:01.000Z");
  const { plan: advanced, changed } = advancePlanToTime(plan, now);

  assert.equal(changed, true);
  assert.equal(advanced.status, "completed", "Status is completed");
  assert.equal(advanced.completedSessions, 4);
  assert.equal(advanced.phaseEndsAt, null, "phaseEndsAt is cleared");
  assert.equal(advanced.completedAt?.toISOString(), "2026-09-24T12:25:00.000Z");
  console.log("✓ Test 13 passed: Final focus completes cleanly without sticking at 00:00");
}

// ── Test 14: pause/resume around a phase boundary ─────────────────────────────
{
  // Plan paused with 10 seconds remaining
  const plan = createMockPlan({
    status: "paused",
    currentPhase: "focus",
    currentSession: 1,
    completedSessions: 0,
    pausedRemainingSeconds: 10,
    pausedAt: new Date("2026-09-24T10:24:50.000Z"),
    phaseStartedAt: null,
    phaseEndsAt: null,
  });

  // Time passes while paused (say 15 minutes pass)
  const whilePausedTime = new Date("2026-09-24T10:40:00.000Z");
  const { plan: advancedWhilePaused, changed: changedWhilePaused } = advancePlanToTime(plan, whilePausedTime);
  assert.equal(changedWhilePaused, false, "Paused session should not auto-advance boundaries");
  assert.equal(advancedWhilePaused.status, "paused");

  // User resumes at 10:40:00
  const resumeUpdates = calculateResumeTransition(plan, whilePausedTime);
  const resumedPlan: PomodoroPlanState = { ...plan, ...resumeUpdates };
  assert.equal(resumedPlan.status, "focus");
  assert.equal(resumedPlan.phaseEndsAt?.toISOString(), "2026-09-24T10:40:10.000Z", "phaseEndsAt is resume time + 10s");

  // 10 seconds later, timer expires and advances naturally into break
  const expireTime = new Date("2026-09-24T10:40:10.000Z");
  const { plan: afterExpire, changed: afterExpireChanged } = advancePlanToTime(resumedPlan, expireTime);
  assert.equal(afterExpireChanged, true);
  assert.equal(afterExpire.status, "shortBreak");
  assert.equal(afterExpire.currentSession, 2);
  assert.equal(afterExpire.phaseEndsAt?.toISOString(), "2026-09-24T10:45:10.000Z");
  console.log("✓ Test 14 passed: Pause and resume around phase boundary behaves correctly");
}

// ── Test 15: reconnect / backgrounding when phase(s) expire ───────────────────
{
  // User starts session 1 at 10:00:00, then backgrounds app for 35 minutes
  const plan = createMockPlan({
    currentSession: 1,
    completedSessions: 0,
    totalSessions: 4,
    focusDurationSeconds: 1500, // 25 min (ends 10:25)
    shortBreakDurationSeconds: 300, // 5 min (ends 10:30)
    phaseStartedAt: new Date("2026-09-24T10:00:00.000Z"),
    phaseEndsAt: new Date("2026-09-24T10:25:00.000Z"),
  });

  const reopenTime = new Date("2026-09-24T10:35:00.000Z"); // 35 minutes later: 5 mins into Focus Session 2
  const { plan: advanced, changed } = advancePlanToTime(plan, reopenTime);

  assert.equal(changed, true);
  assert.equal(advanced.status, "focus", "Derived status is focus");
  assert.equal(advanced.currentPhase, "focus");
  assert.equal(advanced.currentSession, 2, "Derived session is Session 2");
  assert.equal(advanced.completedSessions, 1, "Completed 1 focus session");
  assert.equal(advanced.phaseStartedAt?.toISOString(), "2026-09-24T10:30:00.000Z");
  assert.equal(advanced.phaseEndsAt?.toISOString(), "2026-09-24T10:55:00.000Z");
  assert.equal(advanced.totalFocusSeconds, 1500, "1500s from session 1 recorded");
  assert.equal(advanced.totalBreakSeconds, 300, "300s from short break recorded");

  // If user reopens after 4 hours (entire plan elapsed):
  const muchLater = new Date("2026-09-24T14:00:00.000Z");
  const { plan: fullyDone } = advancePlanToTime(plan, muchLater);
  assert.equal(fullyDone.status, "completed");
  assert.equal(fullyDone.completedSessions, 4);
  console.log("✓ Test 15 passed: Reconnect/backgrounding accurately derives active phase or completed state from timestamps");
}

// ── Test 16: correct session number and phase displayed across full lifecycle ─
{
  let current = createMockPlan({
    currentSession: 1,
    completedSessions: 0,
    totalSessions: 3,
    focusDurationSeconds: 1500,
    shortBreakDurationSeconds: 300,
    phaseStartedAt: new Date("2026-09-24T10:00:00.000Z"),
    phaseEndsAt: new Date("2026-09-24T10:25:00.000Z"),
  });

  // 1. Focus session 1
  assert.equal(current.currentSession, 1);
  assert.equal(current.currentPhase, "focus");

  // 2. Transition to Break 1
  current = advancePlanToTime(current, new Date("2026-09-24T10:25:00.000Z")).plan;
  assert.equal(current.currentPhase, "shortBreak");
  assert.equal(current.currentSession, 2, "During break, currentSession is 2 for 'Next: Session 2 of 3'");
  assert.equal(current.completedSessions, 1);

  // 3. Transition to Focus session 2
  current = advancePlanToTime(current, new Date("2026-09-24T10:30:00.000Z")).plan;
  assert.equal(current.currentPhase, "focus");
  assert.equal(current.currentSession, 2, "During focus, currentSession is 2 for 'Session 2 of 3'");
  assert.equal(current.completedSessions, 1);

  // 4. Transition to Break 2
  current = advancePlanToTime(current, new Date("2026-09-24T10:55:00.000Z")).plan;
  assert.equal(current.currentPhase, "shortBreak");
  assert.equal(current.currentSession, 3, "During break, currentSession is 3 for 'Next: Session 3 of 3'");
  assert.equal(current.completedSessions, 2);

  // 5. Transition to Focus session 3
  current = advancePlanToTime(current, new Date("2026-09-24T11:00:00.000Z")).plan;
  assert.equal(current.currentPhase, "focus");
  assert.equal(current.currentSession, 3, "During focus, currentSession is 3 for 'Session 3 of 3'");
  assert.equal(current.completedSessions, 2);

  // 6. Transition to Final Complete
  current = advancePlanToTime(current, new Date("2026-09-24T11:25:00.000Z")).plan;
  assert.equal(current.status, "completed");
  assert.equal(current.completedSessions, 3);
  console.log("✓ Test 16 passed: Correct session number and phase maintained through every transition");
}

// ── Test 17: Focus -> break transition with custom durations ──────────────────
{
  const t0 = new Date("2026-09-24T10:00:00.000Z");
  const customFocusSeconds = 2100; // 35 min
  const customShortBreakSeconds = 420; // 7 min
  const customLongBreakSeconds = 1500; // 25 min

  const plan: PomodoroPlanState = createMockPlan({
    focusDurationSeconds: customFocusSeconds,
    shortBreakDurationSeconds: customShortBreakSeconds,
    longBreakDurationSeconds: customLongBreakSeconds,
    longBreakInterval: 4,
    autoStartBreaks: true,
    autoStartFocus: true,
    phaseStartedAt: t0,
    phaseEndsAt: new Date(t0.getTime() + customFocusSeconds * 1000), // 10:35:00
  });

  // Advance exactly when 35m focus ends
  const atFocusEnd = new Date("2026-09-24T10:35:00.000Z");
  const res = advancePlanToTime(plan, atFocusEnd);

  assert.equal(res.changed, true);
  assert.equal(res.plan.status, "shortBreak");
  assert.equal(res.plan.currentPhase, "shortBreak");
  assert.equal(res.plan.currentSession, 2);
  assert.equal(res.plan.completedSessions, 1);
  assert.equal(res.plan.totalFocusSeconds, 2100);
  assert.equal(
    res.plan.phaseEndsAt?.toISOString(),
    new Date("2026-09-24T10:42:00.000Z").toISOString(),
    "Break ends after custom 7 min (420s)"
  );
  console.log("✓ Test 17 passed: Focus -> break transition with custom durations");
}

// ── Test 18: Break -> focus transition with custom durations ──────────────────
{
  const t0 = new Date("2026-09-24T10:35:00.000Z");
  const customFocusSeconds = 2100; // 35 min
  const customShortBreakSeconds = 420; // 7 min
  const customLongBreakSeconds = 1500; // 25 min

  const breakPlan: PomodoroPlanState = createMockPlan({
    status: "shortBreak",
    currentPhase: "shortBreak",
    currentSession: 2,
    totalSessions: 4,
    focusDurationSeconds: customFocusSeconds,
    shortBreakDurationSeconds: customShortBreakSeconds,
    longBreakDurationSeconds: customLongBreakSeconds,
    longBreakInterval: 4,
    autoStartBreaks: true,
    autoStartFocus: true,
    phaseStartedAt: t0,
    phaseEndsAt: new Date(t0.getTime() + customShortBreakSeconds * 1000), // 10:42:00
    totalFocusSeconds: 2100,
    completedSessions: 1,
  });

  // Advance when 7m break ends
  const atBreakEnd = new Date("2026-09-24T10:42:00.000Z");
  const res = advancePlanToTime(breakPlan, atBreakEnd);

  assert.equal(res.changed, true);
  assert.equal(res.plan.status, "focus");
  assert.equal(res.plan.currentPhase, "focus");
  assert.equal(res.plan.currentSession, 2);
  assert.equal(res.plan.completedSessions, 1);
  assert.equal(res.plan.totalBreakSeconds, 420);
  assert.equal(
    res.plan.phaseEndsAt?.toISOString(),
    new Date("2026-09-24T11:17:00.000Z").toISOString(),
    "Focus ends after custom 35 min (2100s)"
  );
  console.log("✓ Test 18 passed: Break -> focus transition with custom durations");
}

// ── Test 19: Focus -> long break transition with custom long break duration ───
{
  const t0 = new Date("2026-09-24T10:00:00.000Z");
  const customFocusSeconds = 1800; // 30 min
  const customShortBreakSeconds = 300; // 5 min
  const customLongBreakSeconds = 1200; // 20 min

  const plan: PomodoroPlanState = createMockPlan({
    status: "focus",
    currentPhase: "focus",
    currentSession: 2,
    totalSessions: 4,
    focusDurationSeconds: customFocusSeconds,
    shortBreakDurationSeconds: customShortBreakSeconds,
    longBreakDurationSeconds: customLongBreakSeconds,
    longBreakInterval: 2, // long break on session 2
    autoStartBreaks: true,
    autoStartFocus: true,
    phaseStartedAt: t0,
    phaseEndsAt: new Date(t0.getTime() + customFocusSeconds * 1000), // 10:30:00
    totalFocusSeconds: 1800,
    totalBreakSeconds: 300,
    completedSessions: 1,
  });

  const atFocusEnd = new Date("2026-09-24T10:30:00.000Z");
  const res = advancePlanToTime(plan, atFocusEnd);

  assert.equal(res.changed, true);
  assert.equal(res.plan.status, "longBreak");
  assert.equal(res.plan.currentPhase, "longBreak");
  assert.equal(res.plan.currentSession, 3);
  assert.equal(res.plan.completedSessions, 2);
  assert.equal(
    res.plan.phaseEndsAt?.toISOString(),
    new Date("2026-09-24T10:50:00.000Z").toISOString(),
    "Long break ends after custom 20 min (1200s)"
  );
  console.log("✓ Test 19 passed: Focus -> long break with custom long break duration");
}

console.log("\nAll pomodoro service tests passed successfully!\n");

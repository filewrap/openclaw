import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  OpenClawPluginApi,
  OpenClawPluginServiceContextV2,
  OpenClawPluginGatewayEvents,
} from "openclaw/plugin-sdk/plugin-entry";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { registerBrowserPlugin } from "../plugin-registration.js";
import {
  interceptStoreActions,
  useBrowserDashboardTestHarness,
} from "./browser-dashboard.test-harness.js";
import { handleBrowserGatewayRequest } from "./gateway/browser-request.js";

const browser = vi.hoisted(() => ({
  open: vi.fn(),
  tabs: vi.fn(),
  ownership: vi.fn(),
  closeOwned: vi.fn(),
  page: vi.fn(),
}));
// mock-isolation: Drive dashboard lifetime through synthetic tabs without opening a browser.
vi.mock("./browser/client.js", () => ({ browserOpenTab: browser.open, browserTabs: browser.tabs }));
vi.mock("./browser/cdp.helpers.js", () => ({
  resolveCdpTabOwnership: browser.ownership,
  closeTrackedCdpTarget: browser.closeOwned,
}));

// These Playwright entry points are exercised only by the close-ordering cases.
vi.mock("./browser/pw-session-connection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/pw-session-connection.js")>()),
  getPageForTargetId: browser.page,
}));
vi.mock("./browser/pw-session-page-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser/pw-session-page-target.js")>()),
  isConnectionScopedPage: () => false,
}));
beforeEach(() => void browser.page.mockReset());

import {
  inspectBrowserDashboard,
  reconcileBrowserDashboards,
  requestBrowserDashboard,
  stopBrowserDashboard,
  assertBrowserDashboardTargetCurrent,
} from "./browser-dashboard.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./browser/constants.js";
import { closePageByTargetIdViaPlaywright } from "./browser/pw-session-actions.js";
import { closePageViaPlaywright } from "./browser/pw-tools-core.snapshot.js";
import { registerBrowserTabRoutes } from "./browser/routes/tabs.js";
import {
  createBrowserRouteApp,
  createBrowserRouteResponse,
} from "./browser/routes/test-helpers.js";
import type { BrowserRouteContext } from "./browser/server-context.js";
import { makeBrowserProfile } from "./browser/server-context.test-harness.js";
import {
  closeTrackedBrowserTabsForSessions as closeSessionTabs,
  sweepTrackedBrowserTabs,
  trackSessionBrowserTab,
} from "./browser/session-tab-registry.js";
import { durableOwnership } from "./browser/session-tab-registry.sqlite.test-helpers.js";
import {
  dispatchBrowserTabClose,
  getBrowserSessionTabStore,
  parseBrowserDashboardStopIntent,
  parseBrowserSessionTabRecord,
  readBrowserDashboardTabs as dashboardTabs,
} from "./browser/session-tab-store.js";

const sessionKey = "agent:main:browser-dashboard-proof";
const request = { sessionKey, agentId: "main", name: "service" };
const changedEvent = [
  "dashboard_changed",
  { sessionKey, name: "service", instanceId: "instance-one" },
  { scope: "operator.admin" },
];

function barrier() {
  const entered = createDeferred<void>();
  const released = createDeferred<void>();
  return {
    entered: entered.promise,
    released: released.promise,
    release: released.resolve,
    block: () => {
      entered.resolve();
      return released.promise;
    },
  };
}

describe("Browser dashboard lifetime", () => {
  const fixture = useBrowserDashboardTestHarness(browser, sessionKey);

  const trackTab = (targetId: string) =>
    trackSessionBrowserTab({
      sessionKey,
      targetId,
      profile: "openclaw",
      ownership: durableOwnership(targetId),
    });

  const boardSnapshot = () => structuredClone({ sessionKey, widgets: fixture.widgets });
  const openDashboard = () => requestBrowserDashboard(request);
  const stopDashboard = () => stopBrowserDashboard(request);
  const resumeDashboard = (signal?: AbortSignal) =>
    requestBrowserDashboard({ ...request, resume: true }, { signal });
  const storeEntries = () => getBrowserSessionTabStore().entries();
  const targetIds = () => fixture.tabs.map((tab) => tab.targetId);

  function failClose(reason: string) {
    browser.closeOwned.mockResolvedValueOnce({ status: "unavailable", reason });
  }

  it("shares one HTTP target across simultaneous views, plugin reload, idle sweep, and transcript reset", async () => {
    const [first, second] = await Promise.all([
      openDashboard(),
      requestBrowserDashboard({ sessionKey, name: "service" }),
    ]);
    expect(first.browserTab).toEqual({ target: "host", profile: "openclaw", targetId: "target-1" });
    expect(second.browserTab).toEqual(first.browserTab);
    expect(browser.open).toHaveBeenCalledExactlyOnceWith(
      undefined,
      "http://service.example/",
      expect.objectContaining({ profile: "openclaw", managedOnly: true }),
    );
    await fixture.installRuntime();
    expect((await openDashboard()).browserTab).toEqual(first.browserTab);
    await sweepTrackedBrowserTabs({
      idleMs: 1,
      maxTabsPerSession: 1,
      now: Date.now() + 86_400_000,
    });
    await closeSessionTabs({ sessionKeys: [sessionKey] });
    expect(targetIds()).toEqual(["target-1"]);
    const ordinaryClose = vi.fn(async () => {});
    await expect(dispatchBrowserTabClose("target-1", "openclaw", ordinaryClose)).rejects.toThrow(
      /belongs to dashboard service/,
    );
    expect(ordinaryClose).not.toHaveBeenCalled();
    expect(browser.closeOwned).not.toHaveBeenCalled();
  });

  it.each(["cold", "warm"] as const)(
    "persists %s Stop across reload and resumes only on request",
    async (state) => {
      if (state === "warm") {
        await openDashboard();
      }
      expect((await stopDashboard()).paused).toBe(true);
      expect(fixture.tabs).toEqual([]);
      expect((await inspectBrowserDashboard(request)).paused).toBe(true);
      if (state === "cold") {
        const store = getBrowserSessionTabStore();
        await store.register("dashboard-stop:forged", (await store.entries())[0]?.value);
      }
      await sweepTrackedBrowserTabs({
        idleMs: 1,
        maxTabsPerSession: 1,
        now: Date.now() + 86_400_000,
      });
      expect(await storeEntries()).toHaveLength(1);
      await fixture.installRuntime();
      expect((await openDashboard()).paused).toBe(true);
      expect(browser.open).toHaveBeenCalledTimes(state === "cold" ? 0 : 1);
      if (state === "cold") {
        expect(await dashboardTabs()).toEqual([]);
        expect((await storeEntries())[0]?.value).toMatchObject({
          kind: "dashboard-stop",
        });
      }
      const resumed = await resumeDashboard();
      expect(resumed.browserTab?.targetId).toBe(state === "cold" ? "target-1" : "target-2");
      expect(resumed.paused).toBe(false);
      expect(fixture.widgets[0]?.props).toEqual({ url: "http://service.example/" });
      expect(await storeEntries()).toHaveLength(1);
    },
  );

  it("preserves stopped intent after Resume cancellation", async () => {
    await openDashboard();
    await stopDashboard();
    const controller = new AbortController();
    const error = new Error("Resume cancelled");
    browser.open.mockImplementationOnce(async () => {
      const tab = fixture.openedTab();
      fixture.readBoard.mockImplementationOnce(async () => boardSnapshot());
      fixture.readBoard.mockImplementationOnce(async () => {
        controller.abort(error);
        return boardSnapshot();
      });
      return tab;
    });
    await expect(resumeDashboard(controller.signal)).rejects.toThrow(error.message);
    expect(fixture.tabs).toEqual([]);
    expect((await inspectBrowserDashboard(request)).paused).toBe(true);
    expect((await openDashboard()).paused).toBe(true);
    expect(browser.open).toHaveBeenCalledTimes(2);
    expect(await storeEntries()).toHaveLength(1);
    expect((await resumeDashboard()).paused).toBe(false);
  });

  it.each(["cold", "warm"] as const)(
    "prefers an active target while %s stopped-marker retirement retries",
    async (state) => {
      if (state === "warm") {
        await openDashboard();
      }
      await stopDashboard();
      let advanced = false;
      const retirement = interceptStoreActions((store) => ({
        ...store,
        compareAndApply: async (key, comparison, intent) => {
          if (intent.action === "delete" && !advanced) {
            advanced = true;
            const current = await store.lookup(key);
            const tab = parseBrowserSessionTabRecord(current);
            const stop = parseBrowserDashboardStopIntent(key, current);
            assert(tab || stop, "Expected the Stop record selected for retirement");
            await store.register(
              key,
              tab ? { ...tab, lastUsedAt: tab.lastUsedAt + 1 } : { ...stop, stopId: randomUUID() },
            );
          }
          return await store.compareAndApply(key, comparison, intent);
        },
      }));
      let resumed;
      try {
        resumed = await resumeDashboard();
      } finally {
        retirement.mockRestore();
      }
      expect(await storeEntries()).toHaveLength(2);
      expect((await inspectBrowserDashboard(request)).browserTab).toEqual(resumed.browserTab);
      expect((await openDashboard()).browserTab).toEqual(resumed.browserTab);
      await sweepTrackedBrowserTabs({ ordinaryCleanup: false });
      expect(await storeEntries()).toHaveLength(1);
      expect(targetIds()).toEqual([resumed.browserTab?.targetId]);
    },
  );

  it.each([
    ["cold", "registration"],
    ["stopping", "registration"],
    ["warm", "Stop retirement"],
  ] as const)(
    "keeps the committed resumed target when %s cancellation follows %s",
    async (state, phase) => {
      if (state !== "cold") {
        await openDashboard();
      }
      if (state === "stopping") {
        failClose("browser-identity-lookup-failed");
        await expect(stopDashboard()).rejects.toThrow(/paused/);
      } else {
        await stopDashboard();
      }
      browser.closeOwned.mockClear();
      const controller = new AbortController();
      const error = new Error(`caller cancelled after ${phase}`);
      const retirement = interceptStoreActions((store) => ({
        ...store,
        compareAndApply: async (key, comparison, intent) => {
          const result = await store.compareAndApply(key, comparison, intent);
          if (
            result.status === "applied" &&
            (phase === "registration"
              ? intent.action === "set" &&
                parseBrowserSessionTabRecord(intent.value)?.dashboard?.state === "active"
              : intent.action === "delete")
          ) {
            controller.abort(error);
          }
          return result;
        },
      }));
      try {
        await expect(resumeDashboard(controller.signal)).rejects.toThrow(error.message);
      } finally {
        retirement.mockRestore();
      }
      const resumed = await inspectBrowserDashboard(request);
      expect(resumed.paused).toBe(false);
      expect(targetIds()).toEqual([resumed.browserTab?.targetId]);
      expect(await storeEntries()).toHaveLength(phase === "registration" ? 2 : 1);
      expect(browser.closeOwned.mock.calls.map(([args]) => args.nativeTargetId)).toEqual(
        state === "stopping" ? ["target-1"] : [],
      );
      await sweepTrackedBrowserTabs({ ordinaryCleanup: false });
      expect(await storeEntries()).toHaveLength(1);
      expect(targetIds()).toEqual([resumed.browserTab?.targetId]);
    },
  );

  it("preserves a newer cold Stop when an older reconciliation finishes", async () => {
    await stopDashboard();
    fixture.widgets[0]!.props.url = "http://updated.example/";
    const reading = barrier();
    fixture.readBoard.mockImplementationOnce(async () => {
      const snapshot = boardSnapshot();
      await reading.block();
      return snapshot;
    });
    const reconciling = sweepTrackedBrowserTabs({ ordinaryCleanup: false });
    try {
      await Promise.race([
        reading.entered,
        reconciling.then(() => {
          throw new Error("Cold-intent cleanup skipped the definition lookup");
        }),
      ]);
      await stopDashboard();
      const retained = await storeEntries();
      reading.release();
      await reconciling;
      expect(await storeEntries()).toEqual(retained);
    } finally {
      reading.release();
      await reconciling;
    }
    await fixture.installRuntime();
    expect((await openDashboard()).paused).toBe(true);
    expect(browser.open).not.toHaveBeenCalled();
  });

  it("reconciles invalid URL definitions even when ordinary tab cleanup is disabled", async () => {
    await openDashboard();
    fixture.widgets[0]!.props.url = "ftp://service.example/";
    await expect(sweepTrackedBrowserTabs({ ordinaryCleanup: false })).resolves.toBe(1);
    expect(fixture.tabs).toEqual([]);
    expect(await dashboardTabs()).toEqual([]);
    expect(browser.closeOwned).toHaveBeenCalledOnce();
    await expect(openDashboard()).rejects.toThrow(/widget_put/);
  });

  it.each(["board", "reconcile intents"] as const)(
    "retains a target when authoritative %s lookup is unavailable",
    async (source) => {
      await openDashboard();
      const error = new Error(`${source} unavailable`);
      let remainingReads = source === "reconcile intents" ? 2 : 1;
      const storeRead =
        source !== "board"
          ? interceptStoreActions((store) => ({
              ...store,
              entries: async () => {
                if (--remainingReads === 0) {
                  throw error;
                }
                return await store.entries();
              },
            }))
          : undefined;
      if (source === "board") {
        fixture.readBoard.mockRejectedValueOnce(error);
      }
      const onWarn = vi.fn();
      try {
        const cleanup = source.startsWith("reconcile")
          ? reconcileBrowserDashboards({ onWarn })
          : sweepTrackedBrowserTabs({ ordinaryCleanup: false, onWarn });
        if (source !== "board") {
          await expect(cleanup).rejects.toBe(error);
          expect(onWarn).not.toHaveBeenCalled();
        } else {
          await expect(cleanup).resolves.toBe(0);
          expect(onWarn).toHaveBeenCalledWith(
            expect.stringContaining("Could not reconcile Browser dashboard service"),
          );
        }
        expect(fixture.tabs).toHaveLength(1);
        expect(browser.closeOwned).not.toHaveBeenCalled();
      } finally {
        storeRead?.mockRestore();
      }
      expect(await dashboardTabs()).toHaveLength(1);
    },
  );

  it.each(["ownership", "reachability"] as const)(
    "preserves the live page when its %s probe is unavailable",
    async (probe) => {
      const opened = await openDashboard();
      const retainedPage = fixture.tabs[0]!;
      retainedPage.url = "http://service.example/unfinished-work";
      retainedPage.title = "Unsubmitted draft";
      const retainedRows = await dashboardTabs();
      if (probe === "ownership") {
        browser.ownership.mockResolvedValueOnce({
          status: "non-durable",
          reason: "browser-identity-lookup-failed",
        });
      } else {
        browser.tabs.mockResolvedValueOnce({ running: false, tabs: [] });
      }
      await expect(openDashboard()).rejects.toThrow(/Retry.*existing tab has been kept/);
      expect(fixture.tabs).toEqual([retainedPage]);
      expect(browser.closeOwned.mock.calls.map(([args]) => args.nativeTargetId)).toEqual(
        probe === "ownership" ? [] : ["target-2"],
      );
      expect(await dashboardTabs()).toEqual(retainedRows);
      expect((await openDashboard()).browserTab).toEqual(opened.browserTab);
      expect(browser.open).toHaveBeenCalledTimes(probe === "ownership" ? 1 : 2);
      expect(retainedPage.url).toBe("http://service.example/unfinished-work");
    },
  );

  it("preserves Gateway invocation cancellation while opening a dashboard without a WebSocket client", async () => {
    const allocation = barrier();
    browser.open.mockImplementationOnce(async () => {
      await allocation.block();
      return fixture.openedTab();
    });
    const controller = new AbortController();
    const respond = vi.fn();
    const opening = handleBrowserGatewayRequest({
      params: { target: "host", method: "POST", path: "/dashboard", body: request },
      respond: respond as never,
      context: {} as never,
      client: null,
      req: { type: "req", id: "dashboard-in-process", method: "browser.request" },
      isWebchatConnect: () => false,
      signal: controller.signal,
    });
    await allocation.entered;
    controller.abort(new Error("agent turn cancelled"));
    allocation.release();
    await opening;
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("agent turn cancelled") }),
    );
    expect(fixture.tabs).toEqual([]);
    expect(await dashboardTabs()).toEqual([]);
  });

  it.each(["replacement", "stopped", "missing target"] as const)(
    "recovers from browser %s while preserving unrelated pages",
    async (condition) => {
      await openDashboard();
      if (condition === "replacement") {
        fixture.browserInstance = "browser-two";
      } else {
        fixture.browserRunning = condition !== "stopped";
        fixture.tabs = [];
      }
      const recovered = await resumeDashboard();
      expect(recovered.browserTab?.targetId).toBe("target-2");
      expect(fixture.browserRunning).toBe(true);
      expect(targetIds()).toEqual(
        condition === "replacement" ? ["target-1", "target-2"] : ["target-2"],
      );
      expect(await dashboardTabs()).toHaveLength(1);
      expect((await dashboardTabs())[0]?.browserInstanceFingerprint).toBe(fixture.browserInstance);
    },
  );

  it("rejects a native dashboard request when the browser instance changes behind the same target ID", async () => {
    await openDashboard();
    const saved = await inspectBrowserDashboard(request);
    fixture.browserInstance = "browser-two";
    const profile = makeBrowserProfile({ cdpUrl: "http://127.0.0.1:19991", cdpPort: 19991 });
    const isReachable = vi.fn(async () => true);
    const listTabs = vi.fn(async () => fixture.tabs);
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserTabRoutes(app, {
      forProfile: () => ({ profile, isReachable, listTabs }),
    } as unknown as BrowserRouteContext);
    const response = createBrowserRouteResponse();
    await getHandlers.get("/tabs")!(
      {
        params: {},
        query: { profile: "openclaw", managedOnly: true },
        assertCurrent: (actualProfile) =>
          assertBrowserDashboardTargetCurrent(saved, "main", {}, actualProfile),
      },
      response.res,
    );
    expect(response.statusCode).toBe(500);
    expect(response.body).toMatchObject({
      error: expect.stringContaining("browser instance changed"),
    });
    expect(browser.ownership).toHaveBeenLastCalledWith(
      expect.objectContaining({ cdpUrl: profile.cdpUrl, nativeTargetId: "target-1" }),
    );
    expect([isReachable.mock.calls, listTabs.mock.calls]).toEqual([[], []]);
  });

  it("reports a failed new-tab cleanup without retaining speculative recovery state", async () => {
    browser.open.mockImplementationOnce(async () => {
      const tab = fixture.openedTab();
      fixture.widgets = [];
      return tab;
    });
    failClose("target-close-failed");
    await expect(openDashboard()).rejects.toThrow(/close its newly opened tab manually/);
    expect(fixture.tabs).toHaveLength(1);
    expect(await dashboardTabs()).toEqual([]);
    expect(browser.closeOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeTargetId: "target-1",
        expectedProfileFingerprint: "profile-one",
        expectedBrowserInstanceFingerprint: "browser-one",
      }),
    );
  });

  it("retains cleanup after long idle time when removal temporarily fails", async () => {
    await openDashboard();
    const clock = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + BROWSER_TAB_UNREACHABLE_RETIRE_MS * 2);
    try {
      failClose("target-close-failed");
      fixture.widgets = [];
      await expect(sweepTrackedBrowserTabs({ ordinaryCleanup: false })).resolves.toBe(0);
      expect(targetIds()).toEqual(["target-1"]);
      expect(await dashboardTabs()).toEqual([
        expect.objectContaining({
          nativeTargetId: "target-1",
          cleanupAttemptToken: expect.any(String),
          dashboard: expect.objectContaining({
            state: "released",
          }),
        }),
      ]);
      await expect(sweepTrackedBrowserTabs({ ordinaryCleanup: false })).resolves.toBe(1);
      expect(fixture.tabs).toEqual([]);
      expect(await dashboardTabs()).toEqual([]);
    } finally {
      clock.mockRestore();
    }
  });

  it("publishes changed lifetimes and drains board-change cleanup through the existing service events", async () => {
    const serviceScope = new AsyncLocalStorage<string>();
    const services: Parameters<OpenClawPluginApi["registerService"]>[0][] = [];
    let boardChanged: Parameters<OpenClawPluginGatewayEvents["onSessionsChanged"]>[0] | undefined;
    const emit = vi.fn();
    const unsubscribe = vi.fn();
    const on = vi.fn();
    registerBrowserPlugin(
      createTestPluginApi({
        id: "browser",
        name: "Browser",
        source: "test",
        rootDir: fixture.stateDir,
        config: {},
        on,
        runtime: {
          state: {
            openKeyedStore: (options: OpenKeyedStoreOptions) =>
              createPluginStateKeyedStoreForTests("browser", options),
          },
          gateway: fixture.gateway,
        } as unknown as PluginRuntime,
        registerService: (value) => {
          services.push(value);
        },
      }),
    );
    const scheduler = createTestPluginServiceScheduler();
    onTestFinished(() => scheduler.stop());
    const context: OpenClawPluginServiceContextV2 = {
      scheduler,
      config: {},
      stateDir: fixture.stateDir,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      gatewayEvents: {
        emit,
        onSessionsChanged: (handler) => {
          boardChanged = handler;
          return unsubscribe;
        },
      },
    };
    const service = services[0];
    assert(service, "Browser service was not registered");
    await serviceScope.run("browser-service-instance", async () => await service.start(context));
    const sessionEnd = on.mock.calls.find(([name]) => name === "session_end")?.[1];
    assert(sessionEnd, "Browser session_end hook was not registered");
    const sessionContext = { agentId: "main", sessionId: "dashboard-proof", sessionKey };
    await stopDashboard();
    await sessionEnd({ ...sessionContext, reason: "reset" }, sessionContext);
    expect(await storeEntries()).toHaveLength(1);
    const savedWidgets = fixture.widgets;
    fixture.widgets = [];
    await sessionEnd({ ...sessionContext, reason: "deleted" }, sessionContext);
    expect(await storeEntries()).toEqual([]);
    fixture.widgets = savedWidgets;
    await stopDashboard();
    fixture.widgets = [];
    const store = getBrowserSessionTabStore();
    expect(await store.entries()).toHaveLength(1);
    const removed = createDeferred<void>();
    const retirement = interceptStoreActions((action) => ({
      ...action,
      compareAndApply: async (key, comparison, intent) => {
        const result = await action.compareAndApply(key, comparison, intent);
        if (intent.action === "delete" && result.status === "applied") {
          removed.resolve();
        }
        return result;
      },
    }));
    try {
      boardChanged?.({ sessionKey, agentId: "main", reason: "board" });
      await removed.promise;
    } finally {
      retirement.mockRestore();
    }
    expect(await store.entries()).toEqual([]);
    expect(browser.open).not.toHaveBeenCalled();
    fixture.widgets = savedWidgets;
    emit.mockClear();
    await openDashboard();
    await openDashboard();
    expect(await stopDashboard()).toMatchObject({ paused: true, stopping: false });
    await resumeDashboard();
    expect(emit.mock.calls).toEqual(Array.from({ length: 4 }, () => changedEvent));
    failClose("target-close-failed");
    await expect(stopDashboard()).rejects.toThrow(/could not close/);
    expect(await inspectBrowserDashboard(request)).toMatchObject({ paused: true, stopping: true });
    emit.mockClear();
    await expect(sweepTrackedBrowserTabs({ ordinaryCleanup: false })).resolves.toBe(1);
    expect(await inspectBrowserDashboard(request)).toMatchObject({ paused: true, stopping: false });
    expect(emit.mock.calls).toEqual([changedEvent]);
    await resumeDashboard();
    const opening = barrier();
    let cleanupScope: string | undefined;
    browser.closeOwned.mockImplementationOnce(async () => {
      cleanupScope = serviceScope.getStore();
      await opening.block();
      fixture.tabs = [];
      return { status: "closed" };
    });
    fixture.widgets = [];
    boardChanged?.({ sessionKey, agentId: "main", reason: "board" });
    await opening.entered;
    let stopped = false;
    const stopping = Promise.resolve(service.stop?.(context)).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(unsubscribe).toHaveBeenCalledOnce();
    opening.release();
    await stopping;
    expect(cleanupScope).toBe("browser-service-instance");
    expect(await dashboardTabs()).toEqual([]);
    expect(fixture.tabs).toEqual([]);
  });

  it("refuses a retained dashboard whose storage hash changes during ownership lookup", async () => {
    await openDashboard();
    const tab = (await dashboardTabs())[0];
    assert(tab?.dashboard, "Expected the registered dashboard tab");
    const { storageKey, ...record } = tab;
    browser.ownership.mockImplementationOnce(async () => {
      await getBrowserSessionTabStore().register(storageKey, {
        ...record,
        profileFingerprint: "changed-profile",
      });
      return {
        status: "durable",
        nativeTargetId: tab.nativeTargetId,
        profileFingerprint: tab.profileFingerprint,
        browserInstanceFingerprint: tab.browserInstanceFingerprint,
      };
    });
    await expect(openDashboard()).rejects.toThrow("Dashboard tab stopped during this operation");
    expect(browser.open).toHaveBeenCalledOnce();
    expect(browser.closeOwned).not.toHaveBeenCalled();
  });

  it("refuses a user browser profile before attaching or opening any tab", async () => {
    fixture.widgets[0]!.props.profile = "user";
    await expect(openDashboard()).rejects.toThrow(/requires a local managed profile/);
    expect([browser.open.mock.calls, browser.tabs.mock.calls]).toEqual([[], []]);
  });

  it.each([
    { identity: "known", order: "close-first" },
    { identity: "unidentified", order: "close-first" },
    { identity: "known", order: "registration-first" },
    { identity: "unidentified", order: "registration-first" },
    { identity: "known", order: "preparation-first" },
    { identity: "unidentified", order: "preparation-first" },
  ] as const)(
    "orders $identity Playwright close and dashboard retention when $order",
    async ({ identity, order }) => {
      const registration = barrier();
      const mutationPrepared = createDeferred<void>();
      const closeRequested = createDeferred<void>();
      const targetOpen = barrier();
      const finishClose = createDeferred<void>();
      let remainingReads = identity === "known" ? 1 : 2;
      let closeStarted = false;
      let holdMutation = order === "registration-first";
      const observer = interceptStoreActions((store) => ({
        ...store,
        entries: async () => {
          const entries = await store.entries();
          if (order === "close-first" && closeStarted && --remainingReads === 0) {
            await registration.block();
          }
          return entries;
        },
        observe: async (key) => {
          const result = await store.observe(key);
          mutationPrepared.resolve();
          if (holdMutation) {
            holdMutation = false;
            await registration.released;
          }
          return result;
        },
      }));
      const close = vi.fn(async () => {
        await finishClose.promise;
        fixture.tabs = fixture.tabs.filter((tab) => tab.targetId !== "target-1");
      });
      browser.page.mockImplementation(async () => {
        expect(targetIds()).toContain("target-1");
        closeRequested.resolve();
        return { close };
      });
      if (order !== "registration-first") {
        browser.open.mockImplementationOnce(async () => {
          const tab = fixture.openedTab();
          if (order === "close-first") {
            await targetOpen.block();
          } else {
            fixture.readBoard.mockImplementationOnce(async () => {
              await registration.block();
              return structuredClone({ sessionKey, widgets: fixture.widgets });
            });
          }
          return tab;
        });
      }
      const cdpUrl = "http://127.0.0.1:9222";
      const closePage = () =>
        identity === "known"
          ? closePageByTargetIdViaPlaywright({ cdpUrl, targetId: "target-1" })
          : closePageViaPlaywright({ cdpUrl });
      let closing: Promise<void> | undefined;
      let opened = false;
      const opening = openDashboard().then((result) => {
        opened = true;
        return result;
      });
      try {
        if (order === "close-first") {
          await targetOpen.entered;
          expect(targetIds()).toEqual(["target-1"]);
          closeStarted = true;
          closing = closePage();
          await registration.entered;
          targetOpen.release();
        }
        if (order === "preparation-first") {
          await registration.entered;
          closing = closePage();
          await closeRequested.promise;
        } else {
          await mutationPrepared.promise;
        }
        if (order === "registration-first") {
          closing = closePage();
          await closeRequested.promise;
        }
        await trackTab("ordinary-tab");
        expect(opened).toBe(false);
        expect(await dashboardTabs()).toEqual([]);
        if (order === "close-first") {
          registration.release();
          await expect(opening).rejects.toThrow("close was dispatched during registration");
          expect(close).toHaveBeenCalledOnce();
          finishClose.resolve();
          await closing;
          expect(fixture.tabs).toEqual([]);
          expect(await dashboardTabs()).toEqual([]);
        } else {
          expect(close).not.toHaveBeenCalled();
          registration.release();
          await opening;
          finishClose.resolve();
          await expect(closing).rejects.toThrow(/dashboard|retained/);
          expect(close).not.toHaveBeenCalled();
          expect(opened).toBe(true);
          expect(targetIds()).toEqual(["target-1"]);
          expect((await dashboardTabs())[0]?.nativeTargetId).toBe("target-1");
        }
      } finally {
        registration.release();
        targetOpen.release();
        finishClose.resolve();
        await Promise.allSettled([closing, opening]);
        observer.mockRestore();
      }
    },
  );

  it.each([
    { state: "active tab", changed: "caller", cleanupKind: "lifecycle", phase: "board" },
    { state: "Stop intent", changed: "caller", cleanupKind: "lifecycle", phase: "board" },
    { state: "active tab", changed: "prepared", cleanupKind: "lifecycle", phase: "board" },
    { state: "Stop intent", changed: "prepared", cleanupKind: "lifecycle", phase: "board" },
    { state: "active tab", changed: "runtime", cleanupKind: "lifecycle", phase: "board" },
    { state: "Stop intent", changed: "runtime", cleanupKind: "sweep", phase: "board" },
    { state: "active tab", changed: "runtime", cleanupKind: "lifecycle", phase: "store" },
    { state: "active tab", changed: "runtime", cleanupKind: "reconcile", phase: "store" },
    { state: "Stop intent", changed: "runtime", cleanupKind: "reconcile", phase: "intents" },
  ] as const)(
    "preserves a dashboard $state and successor tabs when $changed changes during $cleanupKind $phase read",
    async ({ state, changed, cleanupKind, phase }) => {
      if (state === "active tab") {
        await openDashboard();
      } else {
        await stopDashboard();
      }
      fixture.widgets = [];
      const reading = barrier();
      let remainingReads = phase === "intents" ? 2 : 1;
      const storeRead =
        phase !== "board"
          ? interceptStoreActions((store) => ({
              ...store,
              entries: async () => {
                if (--remainingReads === 0) {
                  await reading.block();
                }
                return await store.entries();
              },
            }))
          : undefined;
      if (phase === "board") {
        fixture.readBoard.mockImplementationOnce(async () => {
          await reading.block();
          return { sessionKey, widgets: [] };
        });
      }
      let current = true;
      const closeTab = vi.fn(async () => {});
      const currency = {
        isCurrent: () => changed === "prepared" || current,
        ...(changed === "prepared" ? { prepareCurrent: async () => current } : {}),
      };
      const cleanup =
        cleanupKind === "lifecycle"
          ? closeSessionTabs({
              sessionKeys: [sessionKey],
              ...currency,
              closeTab,
            })
          : cleanupKind === "sweep"
            ? sweepTrackedBrowserTabs({
                ordinaryCleanup: false,
                ...currency,
                closeTab,
              })
            : reconcileBrowserDashboards(currency);
      try {
        await reading.entered;
        if (changed === "runtime") {
          await fixture.installRuntime();
        } else {
          current = false;
        }
        await trackTab("successor-tab");
        const retained = await storeEntries();
        reading.release();
        if (changed === "runtime") {
          await expect(cleanup).rejects.toThrow("Browser session tab store owner changed");
        } else {
          await expect(cleanup).resolves.toBe(0);
        }
        expect(await storeEntries()).toEqual(retained);
        expect([closeTab.mock.calls, browser.closeOwned.mock.calls]).toEqual([[], []]);

        await expect(closeSessionTabs({ sessionKeys: [sessionKey], closeTab })).resolves.toBe(
          state === "active tab" ? 2 : 1,
        );
        expect(await storeEntries()).toEqual([]);
      } finally {
        reading.release();
        storeRead?.mockRestore();
        await Promise.allSettled([cleanup]);
      }
    },
  );

  it("retires a claimed dashboard tab after the cleanup caller changes", async () => {
    await openDashboard();
    fixture.widgets = [];
    const closing = barrier();
    let current = true;
    const closeTab = vi.fn(async () => await closing.block());
    const cleanup = closeSessionTabs({
      sessionKeys: [sessionKey],
      isCurrent: () => current,
      prepareCurrent: async () => current,
      closeTab,
    });
    try {
      await Promise.race([closing.entered, cleanup]);
      expect(closeTab).toHaveBeenCalledOnce();
      current = false;
      closing.release();
      await expect(cleanup).resolves.toBe(1);
      expect(await storeEntries()).toEqual([]);
    } finally {
      closing.release();
      await cleanup;
    }
  });

  it.each(["definition updated", "stop after resume", "stop after normal open"] as const)(
    "keeps shared materialization failures scoped when %s",
    async (failure) => {
      const openingGate = barrier();
      const followerRead = createDeferred<void>();
      const cancelInitiator = failure === "stop after resume";
      browser.open.mockImplementation(async () => {
        await setImmediate();
        return fixture.openedTab();
      });
      browser.open.mockImplementationOnce(async () => {
        await openingGate.block();
        return fixture.openedTab();
      });
      const initiator = new AbortController();
      const opening = requestBrowserDashboard(request, { signal: initiator.signal });
      await openingGate.entered;
      if (failure === "definition updated") {
        fixture.widgets[0]!.props.url = "http://updated.example/";
        fixture.widgets[0]!.revision += 1;
      }
      fixture.readBoard.mockImplementationOnce(async () => {
        followerRead.resolve();
        return structuredClone({ sessionKey, widgets: fixture.widgets });
      });
      const waiting = requestBrowserDashboard({ ...request, resume: cancelInitiator });
      const settled = Promise.allSettled([opening, waiting]);
      await followerRead.promise;
      await setImmediate();
      const stopCall = failure.startsWith("stop ") ? stopDashboard() : undefined;
      if (cancelInitiator) {
        initiator.abort(new Error("initiator cancelled"));
      }
      openingGate.release();
      const results = await settled;
      if (stopCall) {
        expect((await stopCall).paused).toBe(true);
        expect(results[0].status).toBe(cancelInitiator ? "rejected" : "fulfilled");
        expect(results[1].status).toBe("fulfilled");
        expect(fixture.tabs).toEqual([]);
        expect((await dashboardTabs()).some((tab) => tab.dashboard?.state === "active")).toBe(
          false,
        );
        expect((await resumeDashboard()).paused).toBe(false);
        expect(fixture.tabs).toHaveLength(1);
        return;
      }
      expect(results[0]).toMatchObject({
        status: "rejected",
        reason: { message: expect.stringContaining("changed during this operation") },
      });
      expect(results[1]).toMatchObject({
        status: "fulfilled",
        value: {
          browserTab: { targetId: "target-2" },
          url: "http://updated.example/",
          revision: 2,
        },
      });
      expect(browser.open).toHaveBeenCalledTimes(2);
      expect(targetIds()).toEqual(["target-2"]);
      expect(browser.open).toHaveBeenLastCalledWith(
        undefined,
        "http://updated.example/",
        expect.objectContaining({ profile: "openclaw" }),
      );
    },
  );

  it("resolves the current definition after a failed queued open", async () => {
    const openingGate = barrier();
    const backendError = new Error("Chrome startup failed");
    browser.open.mockImplementationOnce(async () => {
      await openingGate.block();
      throw backendError;
    });
    const opening = openDashboard();
    await openingGate.entered;
    const originalUrl = fixture.widgets[0]!.props.url;
    const updatedUrl = "http://updated.example/";
    fixture.widgets[0]!.props.url = updatedUrl;
    const waiting = openDashboard();
    const following = openDashboard();
    const settled = Promise.allSettled([opening, waiting, following]);
    await setImmediate();
    fixture.readBoard.mockImplementation(async () => {
      if ((await dashboardTabs()).some((tab) => tab.dashboard?.url === updatedUrl)) {
        fixture.widgets[0]!.props.url = originalUrl;
      }
      return structuredClone({ sessionKey, widgets: fixture.widgets });
    });
    openingGate.release();
    const results = await settled;
    expect(results[0]).toEqual({ status: "rejected", reason: backendError });
    expect(results.slice(1)).toMatchObject([
      { status: "fulfilled", value: { url: updatedUrl } },
      { status: "fulfilled", value: { url: originalUrl } },
    ]);
    expect(browser.open).toHaveBeenCalledTimes(3);
    expect(fixture.tabs.map((tab) => tab.url)).toEqual([originalUrl]);
  });
});

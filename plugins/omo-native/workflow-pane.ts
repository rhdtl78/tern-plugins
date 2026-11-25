import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { add, InputStream, node, record, Surface, surface, type Input, type Op } from "./surface";
import { workflowGraphMinWidth, type graph } from "./workflow";

/** The daemon launches the companion by argv. Only this chat's private socket carries its view. */
export async function launchWorkflowPane(tern: string, pane: string, token: string, signal: AbortSignal, onInput: (input: Input) => void,
  onReady: (frame: (...ops: Op[]) => void) => void, onClose: () => void) {
  const dir = await mkdtemp(join(tmpdir(), "tern-workflow-"));
  const path = join(dir, "view.sock");
  let active: Socket | undefined;
  let ready = false;
  let done = false;
  let launch: ReturnType<typeof Bun.spawn> | undefined;
  const lifetime = Promise.withResolvers<void>();
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => { sockets.delete(socket); if (socket === active) finish(); });
    const lines = createInterface({ input: socket, crlfDelay: Infinity });
    lines.on("line", line => {
      if (done || line.length > 65536) { socket.destroy(); return; }
      if (socket !== active) {
        if (active || line !== token) { socket.destroy(); return; }
        active = socket;
        clearTimeout(timeout);
        socket.write(JSON.stringify({ authenticated: true,
          daemon: process.env.TERN_DAEMON_SOCKET, config: process.env.TERN_CONFIG_DIR }) + "\n");
        return;
      }
      if (!ready) {
        if (line !== "ready") { socket.destroy(); return; }
        ready = true;
        onReady((...ops) => { if (!done && active === socket) socket.write(JSON.stringify(ops) + "\n"); });
        return;
      }
      let value: unknown;
      try { value = JSON.parse(line); } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        socket.destroy(); return;
      }
      const input = record(value);
      if (input.kind === "event") onInput({ kind: "event", value: record(input.value) });
      if ((input.kind === "key" || input.kind === "paste") && typeof input.value === "string") {
        onInput({ kind: input.kind, value: input.value });
      }
    });
  });
  const timer = () => finish();
  const timeout = setTimeout(timer, 5000);
  function finish() {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    signal.removeEventListener("abort", finish);
    for (const socket of sockets) socket.destroy();
    launch?.kill();
    server.close(() => {
      void Promise.resolve(launch?.exited).then(() => rm(dir, { force: true, recursive: true }))
        .then(() => { onClose(); lifetime.resolve(); }, error => { onClose(); lifetime.reject(error); });
    });
  }
  signal.addEventListener("abort", finish, { once: true });
  if (signal.aborted) { finish(); return lifetime.promise; }
  server.once("error", finish);
  server.listen(path, () => {
    if (done) { server.close(); return; }
    launch = Bun.spawn([tern, "split", pane, "right", "--", process.execPath,
      process.argv[1] ?? "", "--workflow-pane", path, token, pane, `w${process.env.TERN_WINDOW_KEY ?? ""}`, tern],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", timeout: 4500 });
    void launch.exited.then(code => { if (code !== 0) finish(); });
  });
  return lifetime.promise;
}

const validPane = (id: string) => /^[1-9]\d{0,15}$/.test(id) && Number.isSafeInteger(Number(id));

async function sizeWorkflow(tern: string, screen: Surface, marker: string, token: string, chat: string, windowKey: string,
  cellWidth: unknown, daemon: unknown, config: unknown) {
  const pane = process.env.TERN_PANE;
  if (!pane || !validPane(pane) || !validPane(chat) || pane === chat ||
      (process.env.TERN_WINDOW_KEY ?? "") !== windowKey) return;
  const cell = typeof cellWidth === "number" && cellWidth >= 3 && cellWidth <= 64 ? cellWidth : 8;
  const end = performance.now() + 2900;
  const env = { ...process.env,
    ...(typeof daemon === "string" ? { TERN_DAEMON_SOCKET: daemon } : {}),
    ...(typeof config === "string" ? { TERN_CONFIG_DIR: config } : {}) };
  const ctl = async (command: string) => {
    if (performance.now() >= end) return {};
    try {
      const proc = Bun.spawn([tern, "ctl", command], { env, stdin: "ignore", stdout: "pipe", stderr: "ignore",
        timeout: Math.max(1, Math.ceil(end - performance.now())) });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return code === 0 ? record(JSON.parse(out)) : {};
    } catch (error) {
      if (error instanceof Error) return {};
      throw error;
    }
  };
  // Measure the rendered outer cards at the untouched 50/50 split, not the TSP grid.
  const selector = `section.tn-pane:has([data-id=${marker}])`;
  await Bun.sleep(250); // Let the native split animation settle before sampling its rect.
  for (let i = 0; i < 10 && performance.now() < end; i++) {
    const [tree, stats] = await Promise.all([ctl(`tree ${selector}`), ctl("stats")]);
    const rect = Array.isArray(tree.nodes) && tree.nodes.length === 1 ? record(tree.nodes[0]).rect : undefined;
    const [left, top, width, height] = Array.isArray(rect) ? rect : [];
    if (typeof left !== "number" || typeof top !== "number" || typeof height !== "number" ||
        typeof width !== "number" || !Number.isFinite(width) || width <= 0) {
      await Bun.sleep(32); continue;
    }
    if (left < 0 || width < 320 || Math.abs(width - 420) <= 1) return;
    // Tern changes the ratio in terminal cells, using the inner split span.
    const span = width * 2;
    const cells = (420 - width) * (span - 26) / (span * cell);
    if (!Number.isFinite(cells) || Math.abs(cells) > 4096) return;
    screen.frame(["set", "workflow-sizing", { text: `${token}:${chat}:${pane}:${windowKey}:${cells.toFixed(6)}` }]);
    // The UI thread checks the paired markers and the original split ratio again.
    // No correction follows this request: the divider belongs to the user afterward.
    const [x, y] = Array.isArray(stats.pointer) ? stats.pointer : [];
    const atDivider = typeof x === "number" && typeof y === "number" &&
      Math.abs(left - x) <= 8 && y >= top && y <= top + height;
    if (stats.ok && stats.drag === null && !atDivider) {
      const result = await ctl("plugins run plugin.omo-native.size-workflow");
      if (result.ok) await Bun.sleep(260); // Let the native divider finish moving before revealing the body.
    }
    return;
  }
}

export function workflowCompanion(path: string, token: string, chat: string, windowKey: string, tern: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  const screen = new Surface();
  const input = new InputStream();
  let socket: Socket | undefined;
  let viewport: Input | undefined;
  let theme: Input | undefined;
  let authenticated = false;
  let ready = false;
  let escape: ReturnType<typeof setTimeout>;
  let menuOpen = false;
  const timeout = setTimeout(stop, 4000);
  function stop() {
    clearTimeout(timeout); clearTimeout(escape);
    socket?.destroy(); process.stdin.pause(); process.stdin.setRawMode(false);
    screen.send("x", { id: surface, keep: false });
    process.exit(0);
  }
  function event(i: Input) {
    if (i.kind === "event" && !socket && i.value.r === "hello" && i.value.v === 1) {
      screen.negotiate(i.value);
      const cellWidth = record(i.value.cell).w;
      const graphAllowed = Array.isArray(i.value.features) && i.value.features.includes("blobs") &&
        Array.isArray(i.value.kinds) && i.value.kinds.includes("image");
      viewport = { kind: "event", value: { ev: "resize", cols: i.value.cols, cell: i.value.cell } };
      if (typeof i.value.dark === "boolean") theme = { kind: "event", value: { ev: "theme", dark: i.value.dark } };
      let lastBlob = "";
      let graphMounted = false;
      let placement = "";
      const marker = `workflowSizing${token}`;
      screen.send("o", { id: surface, mode: "screen", title: "Workflow", closable: true });
      // Tern 0.9.32 may omit pane resize events. Measure against the graph's
      // parent width, not the window: below the threshold the native list remains.
      screen.send("s", { sf: surface, name: "workflow-graph", css:
        `[data-id='workflow-content'] { --wf-space: .5em; --wf-caption: .875em; }
         [data-id='workflow'] .sf-text, [data-id='workflow-title'] { font-family: -apple-system, system-ui, sans-serif; }
         [data-id='workflow-heading'], [data-role='workflow-subheading'], [data-id='workflow-detail-heading'] { font-weight: 600; }
         [data-id='workflow-heading'] { font-size: 1.15em; }
         [data-id='workflow-summary'], [data-id^='workflow-upstream-'] { font-size: var(--wf-caption); color: var(--t2); }
         [data-id^='workflow-upstream-'] { padding-left: 1em; }
         [data-id='workflow-inspector'], [data-id='workflow-result'] { border-top: 1px solid var(--l2); padding-top: var(--wf-space); }
         [data-id='workflow-detail-bar'] { align-items: center; justify-content: space-between; }
         [data-id='workflow-detail-close'] { color: var(--t2); }
         [data-id='workflow-layout'] { width: 100%; align-items: flex-start; gap: 0; }
         [data-id='workflow-usage-split'] { align-items: center; }
         [data-id='workflow-usage-chart'] { flex: none; width: auto; }
         [data-id='workflow-usage-chart'] .leg { display: none; }
         [data-id='workflow-usage-table'] { min-width: 0; }
         [data-id='workflow-fallback'] { width: 100%; overflow: hidden; }
         [data-id='workflow-graph'] { position: relative; width: 100%; overflow: hidden; }
         [data-id='workflow-edges'] { width: 100%; pointer-events: none; }
         .sf-button[data-role^='workflow-'] { color: var(--t2); background: transparent; box-shadow: none; border: 1px solid transparent; }
         .sf-button[data-role='workflow-card'], .sf-button[data-role='workflow-card'][aria-pressed='true'] { position: absolute; background: transparent; border-color: var(--l2); overflow: hidden; box-shadow: none; }
         .sf-button[data-role='workflow-card']::before { content: ''; position: absolute; inset: 0 auto 0 0; width: .22em; background: var(--wf-state); }
         .sf-button[data-role='workflow-step'], .sf-button[data-role='workflow-neighbor'] { max-width: 100%; white-space: normal; text-align: left; min-height: 2.25em; height: auto; overflow-wrap: anywhere; }
         .sf-button[data-role='workflow-step'] { min-width: 16em; }
         [data-role='workflow-caption'] { position: absolute; box-sizing: border-box; justify-content: center; padding: 0 .8em; overflow: hidden; pointer-events: none; }
         [data-role='workflow-caption'] * { pointer-events: none; }
         [data-role='workflow-title'] { font-weight: bold; line-height: 1.15; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
         [data-role='workflow-meta'] { color: var(--t2); font-size: .875em; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
         .sf-button[data-role^='workflow-'][aria-pressed='true'] { border-color: var(--t2); }
         [data-role='workflow-meta']:last-child::before { content: '• '; color: var(--wf-state); }
         [data-id='workflow-controls'] { width: 100%; align-items: center; }
         [data-id='workflow-controls'] { justify-content: space-between; }
         [data-id='workflow'] { min-height: 0; overflow-y: auto; }
         [data-role='workflow-bar'] { background: var(--raise); border-top: 1px solid var(--l2); border-bottom: 1px solid var(--l2); border-left: .22em solid var(--accent); align-items: center; min-width: 0; }
         [data-role='workflow-activity-group'] { min-width: 0; padding-inline: .5em; }
         [data-role='workflow-activity-header'] { justify-content: space-between; align-items: baseline; margin-bottom: .125em; }
         [data-role='workflow-activity-row'] { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: .65em; row-gap: .125em; padding-block: .35em; align-items: baseline; }
         [data-role='workflow-activity-name'] { min-width: 0; line-height: 1.3; white-space: normal; overflow-wrap: anywhere; }
         [data-role='workflow-activity-status'] { font-size: .875em; white-space: nowrap; justify-self: end; }
         [data-role='workflow-activity-meta'], [data-role='workflow-activity-ref'] { color: var(--t2); font-size: .875em; font-variant-numeric: tabular-nums; }
         [data-role='workflow-activity-ref'] { grid-column: 1 / -1; justify-self: end; min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
         .sf-button[data-role='workflow-fold'], .sf-button[data-role='workflow-fold'][aria-pressed='true'] { color: var(--t1); background: transparent; border-color: transparent; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
         [data-id='workflow-time'], [data-id^='workflow-layer-'], [data-id='workflow-no-todo'], [data-role='workflow-bar'] .sf-text { color: var(--t2); font-size: .875em; }
         [data-id='workflow-run-picker'] { margin-left: auto; max-width: 60%; min-width: 0; }
         [data-id='workflow-sizing'] { height: 0; overflow: hidden; opacity: 0; }` });
      screen.frame(add(surface, node("main", "col", {}, [
        node(marker, "col", {}, [node("workflow-sizing", "text")]),
      ])));
      const reveal = () => {
        if (!socket || socket.destroyed) return;
        screen.frame(["del", marker], add("main", node("workflow-controls", "row", { gap: "sm" }, [
          node("workflow-title", "text", { spans: [{ t: "Workflow", s: "strong" }], grow: 1 }),
          node("workflow-close", "button", { text: "×", aria: "Close workflow", title: "Close workflow",
            variant: "quiet", actions: { click: "close" } }),
        ])));
        ready = true;
        socket.write("ready\n");
        if (viewport) socket.write(JSON.stringify(viewport) + "\n");
        if (theme) socket.write(JSON.stringify(theme) + "\n");
      };
      socket = createConnection(path);
      socket.once("connect", () => socket?.write(token + "\n"));
      socket.on("error", stop).on("close", stop);
      createInterface({ input: socket, crlfDelay: Infinity }).on("line", line => {
        if (!authenticated) {
          let reply: ReturnType<typeof record>;
          try { reply = record(JSON.parse(line)); } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            stop(); return;
          }
          if (reply.authenticated !== true) { stop(); return; }
          authenticated = true;
          // Sizing has its own deadline; a slow or hidden window must not close an authenticated pane.
          clearTimeout(timeout);
          void sizeWorkflow(tern, screen, marker, token, chat, windowKey, cellWidth, reply.daemon, reply.config).then(reveal);
          return;
        }
        const ops: unknown = JSON.parse(line);
        if (!Array.isArray(ops) || !ops.every(Array.isArray)) return;
        for (const op of ops) {
          if (op[0] !== "graph") {
            if (op[0] === "set" && op[1] === "workflow-run-picker") menuOpen = record(op[2]).open === true;
            if (op[0] === "del" && (op[1] === "workflow-content" || op[1] === "workflow")) graphMounted = false;
            screen.frame(op); continue;
          }
          const model: ReturnType<typeof graph> = op[1];
          if (!graphAllowed || !model || model.svg.length > 8000) {
            if (graphMounted) screen.frame(["del", "workflow-graph"]);
            if (placement) screen.send("s", { sf: surface, name: "workflow-placement", css:
              "[data-id='workflow-graph-anchor'] { width: 0; } [data-id='workflow-fallback'] { width: 100%; }" });
            placement = "";
            graphMounted = false;
            continue;
          }
          const { svg, cards, width, height } = model;
          const id = createHash("sha256").update(svg).digest("hex");
          if (id !== lastBlob) {
            process.stdout.write(`\x1b_tsp;b;mime=image/svg+xml;${Buffer.from(svg).toString("base64")}\x1b\\`);
            lastBlob = id;
          }
          // Tern shrinks an SVG to fit but doesn't enlarge it beyond its intrinsic width.
          const ink = (status: string) => status === "completed" ? "--ok" :
            ["failed", "blocked", "cancelled", "canceled"].includes(status) ? "--bad" : status === "running" ? "--accent" : "--t2";
          const graphWidth = `clamp(0px, calc((100% - ${workflowGraphMinWidth - 1}px) * 500), 100%)`;
          const css = `[data-id='workflow-graph-anchor'] { width: ${graphWidth}; min-width: 0; overflow: hidden; }
            [data-id='workflow-fallback'] { width: calc(100% - ${graphWidth}); min-width: 0; overflow: hidden; }
            [data-id='workflow-graph'] { max-width: ${width}px; align-self: center; }\n` +
            cards.map(c => `[data-id='${c.id}'], [data-id='${c.id}-caption'] { --wf-state: var(${ink(c.status)}); left: ${100 * c.left / width}%; top: ${100 * c.top / height}%; min-width: ${100 * c.width / width}%; width: ${100 * c.width / width}%; height: ${100 * c.height / height}%; }`).join("\n");
          if (css !== placement) {
            screen.send("s", { sf: surface, name: "workflow-placement", css });
            placement = css;
          }
          const caption = (c: typeof cards[number]) => node(`${c.id}-caption`, "col", { role: "workflow-caption" }, [
            node(`${c.id}-title`, "text", { role: "workflow-title", text: c.label }),
            node(`${c.id}-route`, "text", { role: "workflow-meta", text: c.route, hidden: !c.route }),
            node(`${c.id}-state`, "text", { role: "workflow-meta", text: c.state }),
          ]);
          if (graphMounted) screen.frame(["set", "workflow-edges", { blob: id }],
            ...cards.flatMap((c): Op[] => [["set", c.id, c.props], ...caption(c).c.map(n => ["set", n.id, n.p])]));
          else screen.frame(add("workflow-graph-anchor", node("workflow-graph", "col", {}, [
            node("workflow-edges", "image", { blob: id, alt: "Dependency arrows", actions: { click: "ignore" } }),
            ...cards.flatMap(c => [node(c.id, "button", c.props), caption(c)]),
          ])));
          graphMounted = true;
        }
      });
      return;
    }
    if (i.kind === "event" && i.value.ev === "theme" && typeof i.value.dark === "boolean") {
      theme = i;
      if (ready) socket?.write(JSON.stringify(i) + "\n");
      return;
    }
    if (i.kind === "event" && i.value.sf !== surface) return;
    if (i.kind === "event" && i.value.ev === "resize") viewport = i;
    if (i.kind === "event" && i.value.ev === "ack") { screen.ack(i.value.s); return; }
    if (i.kind === "event" && i.value.ev === "gone") { stop(); return; }
    if (ready && i.kind === "event") {
      const e = i.value;
      if (e.id === "workflow-run-picker" && (e.ev === "change" || e.ev === "toggle")) {
        if (e.ev === "toggle") menuOpen = e.open === true;
        i = { kind: "event", value: { ...e, ev: "action", act: "select-run" } };
      }
    }
    if (ready && menuOpen && i.kind === "key" && (i.value === "\x1b" || i.value === "\x1b[27u"))
      i = { kind: "event", value: { ev: "action", id: "workflow-run-picker", act: "select-run", open: false } };
    if (i.kind === "key" && ["\x1b", "\x1b[27u", "\x07", "\x1b[103;5u"].includes(i.value)) { stop(); return; }
    if (ready) socket?.write(JSON.stringify(i) + "\n");
  }
  process.stdin.setRawMode(true).setEncoding("utf8").on("data", (chunk: string) => {
    clearTimeout(escape); input.feed(chunk).forEach(event);
    if (chunk.endsWith("\x1b")) escape = setTimeout(() => input.feed("", true).forEach(event), 40);
  }).once("end", stop).resume();
  screen.send("q", { q: "hello", app: "omo.workflow", v: [1], features: ["edit"] });
  process.stdout.write("\x1b[c\x1b[?2004h\x1b[>1u");
}

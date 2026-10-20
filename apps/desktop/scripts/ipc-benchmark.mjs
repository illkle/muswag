// Measures what moving song rows from main to a renderer costs in Electron itself, in several wire
// formats: the round trip until the renderer holds row objects, and the longest stall of main's and of
// the renderer's event loop meanwhile. Every request reads the rows from SQLite again, as the app would.
//
//   pnpm exec electron scripts/ipc-benchmark.mjs <library.db> [sizes] [formats]
//
// The library files of `packages/tests`' songs benchmark have enough songs for every size.
import { app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess } from "electron";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

// `MAIN_ONLY_SONG_COLUMNS` of @muswag/model: the columns the mirror leaves out.
const OMITTED = new Set(
  "isDir bitRate bookmarkPosition contentType coverArt created genre isVideo originalHeight originalWidth parent path size suffix transcodedContentType transcodedSuffix type bpm comment sortName musicBrainzId genres albumArtists displayAlbumArtist contributors displayComposer moods replayGain explicitStatus".split(
    " ",
  ),
);

const [file, sizesArgument, formatsArgument] = process.argv.slice(2).filter((argument) => !argument.startsWith("-") && argument !== ".");
if (!file) {
  console.error("Usage: electron scripts/ipc-benchmark.mjs <library.db> [sizes] [formats]");
  process.exit(1);
}
const sizes = (sizesArgument ?? "100,1000,10000,25000,100000,250000").split(",").map(Number);
const formats = (formatsArgument ?? "objects,plain-objects,columns,json,chunks,utility-json").split(",");
const CHUNK = 10_000;

// Shared by main and the utility process: the queries for each format.
const sqlSource = String.raw`
const columnsOf = (db, omitted) => db.prepare("PRAGMA table_info(songs)").all().map(({ name }) => name).filter((name) => !omitted.has(name));
const queries = (db, omitted) => {
  const columns = columnsOf(db, omitted);
  const list = columns.map((name) => '"' + name + '"').join(", ");
  const object = "json_object(" + columns.map((name) => "'" + name + "', " + (name === "artists" ? "json(\"artists\")" : '"' + name + '"')).join(", ") + ")";
  const order = " ORDER BY titleSortKey, id";
  const arrays = db.prepare("SELECT " + list + " FROM songs" + order + " LIMIT ?");
  arrays.setReturnArrays(true);
  return {
    columns,
    // What the mirror does today: a JSON object per row, parsed in main.
    objects: (count) => db.prepare("SELECT json_object(" + columns.map((name) => "'" + name + "', \"" + name + "\"").join(", ") + ") AS value FROM songs" + order + " LIMIT ?").all(count).map(({ value }) => { const row = JSON.parse(value); if (typeof row.artists === "string") row.artists = JSON.parse(row.artists); return row; }),
    // Plain columns, which the driver turns into objects itself.
    plainObjects: (count, after) => {
      const rows = after
        ? db.prepare("SELECT " + list + " FROM songs WHERE (titleSortKey, id) > (?, ?)" + order + " LIMIT ?").all(after.titleSortKey, after.id, count)
        : db.prepare("SELECT " + list + " FROM songs" + order + " LIMIT ?").all(count);
      for (const row of rows) if (typeof row.artists === "string") row.artists = JSON.parse(row.artists);
      return rows;
    },
    // One array per column.
    columnar: (count) => {
      const rows = arrays.all(count);
      const values = columns.map(() => new Array(rows.length));
      for (let r = 0; r < rows.length; r++) { const row = rows[r]; for (let c = 0; c < columns.length; c++) values[c][r] = row[c]; }
      return { columns, values };
    },
    // The whole result as one JSON text, which SQLite writes.
    json: (count) => db.prepare("SELECT json_group_array(" + object + ") AS value FROM (SELECT * FROM songs" + order + " LIMIT ?)").get(count).value,
  };
};
`;
const { queries } = new Function(`${sqlSource}; return { queries };`)();

const db = new DatabaseSync(file, { readOnly: true });
const sql = queries(db, OMITTED);
const available = db.prepare(`SELECT count(*) AS count FROM songs`).get().count;

// The longest stall of main's event loop since `resetStall`.
let mainStall = 0;
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  mainStall = Math.max(mainStall, now - lastTick);
  lastTick = now;
}, 1);
const resetStall = () => {
  lastTick = performance.now();
  mainStall = 0;
};

ipcMain.handle("available", () => available);
ipcMain.handle("reset-stall", () => resetStall());
ipcMain.handle("main-stall", () => mainStall);
ipcMain.handle("objects", (_event, count) => sql.objects(count));
ipcMain.handle("plain-objects", (_event, count, after) => sql.plainObjects(count, after));
ipcMain.handle("columns", (_event, count) => sql.columnar(count));
ipcMain.handle("json", (_event, count) => sql.json(count));
ipcMain.handle("done", (_event, results) => {
  console.log(JSON.stringify(results));
  console.table(results);
  app.quit();
});

// A utility process reads the rows and hands them to the renderer through a port of their own, so main
// does no work for them at all.
const utilityScript = join(tmpdir(), "muswag-ipc-benchmark-utility.mjs");
writeFileSync(
  utilityScript,
  `import { DatabaseSync } from "node:sqlite";
${sqlSource}
const db = new DatabaseSync(${JSON.stringify(file)}, { readOnly: true });
const sql = queries(db, new Set(${JSON.stringify([...OMITTED])}));
process.parentPort.on("message", ({ ports: [port] }) => {
  port.on("message", ({ data: { id, count } }) => port.postMessage({ id, value: sql.json(count) }));
  port.start();
});
`,
);

const renderer = String.raw`
const { ipcRenderer } = require("electron");
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
// The longest stall of this page's event loop since the last reset: how long it could not paint or answer input.
let stall = 0;
let last = performance.now();
setInterval(() => {
  const now = performance.now();
  stall = Math.max(stall, now - last);
  last = now;
}, 1);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

const port = window.utilityPort;
let nextId = 0;
const fromUtility = async (count) => {
  const utility = await port;
  const id = nextId++;
  return new Promise((resolve) => {
    const listener = ({ data }) => {
      if (data.id !== id) return;
      utility.removeEventListener("message", listener);
      resolve(data.value);
    };
    utility.addEventListener("message", listener);
    utility.postMessage({ id, count });
  });
};

const fromColumns = ({ columns, values }) => {
  const rows = new Array(values[0]?.length ?? 0);
  for (let r = 0; r < rows.length; r++) { const row = {}; for (let c = 0; c < columns.length; c++) row[columns[c]] = values[c][r]; rows[r] = row; }
  const artists = columns.indexOf("artists");
  if (artists !== -1) for (const row of rows) if (typeof row.artists === "string") row.artists = JSON.parse(row.artists);
  return rows;
};

const load = {
  objects: (count) => ipcRenderer.invoke("objects", count),
  "plain-objects": (count) => ipcRenderer.invoke("plain-objects", count),
  columns: async (count) => fromColumns(await ipcRenderer.invoke("columns", count)),
  json: async (count) => JSON.parse(await ipcRenderer.invoke("json", count)),
  chunks: async (count) => {
    const rows = [];
    while (rows.length < count) {
      const last = rows.at(-1);
      const chunk = await ipcRenderer.invoke("plain-objects", Math.min(${CHUNK}, count - rows.length), last && { titleSortKey: last.titleSortKey, id: last.id });
      for (const row of chunk) rows.push(row);
    }
    return rows;
  },
  "utility-json": async (count) => JSON.parse(await fromUtility(count)),
};

(async () => {
  const results = [];
  const available = await ipcRenderer.invoke("available");
  for (const format of ${JSON.stringify(formats)}) {
    for (const count of ${JSON.stringify(sizes)}) {
      if (count > available) continue;
      await load[format](count);
      const trips = [], rendererStalls = [], mainStalls = [];
      for (let i = 0; i < (count <= 1000 ? 30 : count >= 100000 ? 3 : 5); i++) {
        await ipcRenderer.invoke("reset-stall");
        await tick();
        stall = 0;
        last = performance.now();
        const started = performance.now();
        const rows = await load[format](count);
        trips.push(performance.now() - started);
        if (rows.length !== count || typeof rows[0].title !== "string") throw new Error(format + ": short or malformed read");
        await tick();
        rendererStalls.push(stall);
        mainStalls.push(await ipcRenderer.invoke("main-stall"));
      }
      results.push({ format, rows: count, "until the renderer has rows ms": +median(trips).toFixed(1), "longest main stall ms": +median(mainStalls).toFixed(1), "longest renderer stall ms": +median(rendererStalls).toFixed(1) });
    }
  }
  await ipcRenderer.invoke("done", results);
})().catch((error) => ipcRenderer.invoke("done", [{ error: String(error && error.stack || error) }]));
`;

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 200, height: 200, x: 0, y: 0, show: true, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await window.loadURL("data:text/html,<!doctype html><title>ipc benchmark</title>");

  // The page listens for its port before it is sent.
  await window.webContents.executeJavaScript(
    `window.utilityPort = new Promise((resolve) => require("electron").ipcRenderer.once("utility-port", (event) => { const [port] = event.ports; port.start(); resolve(port); })); 0`,
  );
  const child = utilityProcess.fork(utilityScript);
  const { port1, port2 } = new MessageChannelMain();
  child.postMessage(null, [port1]);
  window.webContents.postMessage("utility-port", null, [port2]);

  void window.webContents.executeJavaScript(renderer);
});

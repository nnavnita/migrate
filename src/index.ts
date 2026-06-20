import "@logseq/libs";
import type {
  SettingSchemaDesc,
  BlockEntity,
  PageEntity,
} from "@logseq/libs/dist/LSPlugin";

type FilterMode = "all" | "exclude-tagged" | "only-tagged";
type MoveStyle = "move" | "move-with-ref";
type Marker = "TODO" | "DOING" | "LATER" | "NOW";

interface Settings {
  enabled: boolean;
  filterMode: FilterMode;
  filterTag: string;
  moveStyle: MoveStyle;
  markers: string;
  lastMigratedDate: string;
}

const settingsSchema: SettingSchemaDesc[] = [
  {
    key: "enabled",
    type: "boolean",
    default: true,
    title: "Enable auto-migration",
    description: "Run migration automatically when today's journal opens.",
  },
  {
    key: "filterMode",
    type: "enum",
    default: "all",
    enumChoices: ["all", "exclude-tagged", "only-tagged"],
    enumPicker: "select",
    title: "Filter mode",
    description:
      "all = migrate everything. exclude-tagged = skip blocks containing the tag. only-tagged = only migrate blocks containing the tag.",
  },
  {
    key: "filterTag",
    type: "string",
    default: "migrate",
    title: "Filter hashtag (without #)",
    description:
      "Hashtag used by exclude-tagged / only-tagged modes. Match is case-insensitive.",
  },
  {
    key: "moveStyle",
    type: "enum",
    default: "move",
    enumChoices: ["move", "move-with-ref"],
    enumPicker: "select",
    title: "Move style",
    description:
      "move = cut block, paste into today. move-with-ref = move block + leave a ((block-ref)) where it came from.",
  },
  {
    key: "markers",
    type: "string",
    default: "TODO,DOING,LATER,NOW",
    title: "Markers to migrate",
    description: "Comma-separated list. Default: TODO,DOING,LATER,NOW",
  },
  {
    key: "lastMigratedDate",
    type: "string",
    default: "",
    title: "Last migrated journal-day (auto)",
    description: "Internal. Do not edit.",
  },
];

const VALID_MARKERS: Marker[] = ["TODO", "DOING", "LATER", "NOW"];

function todayJournalDay(): number {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return Number(`${y}${m}${day}`);
}

function parseMarkers(raw: string): Marker[] {
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s): s is Marker => VALID_MARKERS.includes(s as Marker));
}

function hasHashtag(content: string, tag: string): boolean {
  const re = new RegExp(`(^|\\s)#${escapeRegex(tag)}(\\b|$)`, "i");
  return re.test(content);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findUndoneBlocks(
  markers: Marker[],
  todayDay: number,
): Promise<BlockEntity[]> {
  const markerSet = `#{${markers.map((m) => `"${m}"`).join(" ")}}`;
  const query = `
    [:find (pull ?b [*])
     :where
       [?b :block/marker ?m]
       [(contains? ${markerSet} ?m)]
       [?b :block/page ?p]
       [?p :block/journal? true]
       [?p :block/journal-day ?d]
       [(< ?d ${todayDay})]]
  `;
  console.info("[migrate] query", { todayDay, markers });
  const res = (await logseq.DB.datascriptQuery(query)) as
    | BlockEntity[][]
    | null;
  console.info("[migrate] query result rows:", res?.length ?? 0);
  if (!res) return [];
  return res.flat();
}

async function findJournalByDay(day: number): Promise<PageEntity | null> {
  const query = `
    [:find (pull ?p [*])
     :where
       [?p :block/journal? true]
       [?p :block/journal-day ${day}]]
  `;
  const res = (await logseq.DB.datascriptQuery(query)) as
    | PageEntity[][]
    | null;
  const page = res?.[0]?.[0];
  return page ?? null;
}

async function ensureTodayJournal(): Promise<PageEntity | null> {
  const todayDay = todayJournalDay();
  let page = await findJournalByDay(todayDay);
  if (page) return page;

  const cfg = await logseq.App.getUserConfigs();
  const fmt: string = cfg.preferredDateFormat ?? "yyyy-MM-dd";
  const title = formatDate(new Date(), fmt);
  console.info("[migrate] no journal found by day; creating", { title });
  await logseq.Editor.createPage(
    title,
    {},
    { journal: true, redirect: false, createFirstBlock: true },
  );
  page = await findJournalByDay(todayDay);
  if (!page) {
    console.warn("[migrate] created page but journal-day query still empty", {
      title,
    });
  }
  return page;
}

function formatDate(d: Date, fmt: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const day = d.getDate();
  const map: Record<string, string> = {
    yyyy: String(d.getFullYear()),
    MMMM: d.toLocaleDateString("en-US", { month: "long" }),
    MMM: d.toLocaleDateString("en-US", { month: "short" }),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    do: day + ordinalSuffix(day),
    dd: pad(day),
    d: String(day),
    EEEE: d.toLocaleDateString("en-US", { weekday: "long" }),
    EEE: d.toLocaleDateString("en-US", { weekday: "short" }),
    o: ordinalSuffix(day),
  };
  return fmt.replace(/yyyy|MMMM|MMM|MM|M|do|dd|d|EEEE|EEE|o/g, (k) => map[k] ?? k);
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

async function migrate(): Promise<{
  moved: number;
  skipped: number;
  reason?: string;
}> {
  const s = (logseq.settings ?? {}) as unknown as Settings;
  const enabled = s.enabled ?? true;
  if (!enabled) {
    console.info("[migrate] disabled in settings");
    return { moved: 0, skipped: 0, reason: "disabled" };
  }

  const todayDay = todayJournalDay();
  if (s.lastMigratedDate === String(todayDay)) {
    console.info("[migrate] already ran today", { todayDay });
    return { moved: 0, skipped: 0, reason: "already-ran" };
  }

  const markers = parseMarkers(s.markers ?? "TODO,DOING,LATER,NOW");
  if (markers.length === 0) {
    console.info("[migrate] no valid markers configured");
    return { moved: 0, skipped: 0, reason: "no-markers" };
  }

  const todayPage = await ensureTodayJournal();
  if (!todayPage) {
    console.warn("[migrate] could not resolve today's journal page");
    return { moved: 0, skipped: 0, reason: "no-today-page" };
  }
  console.info("[migrate] today page", {
    id: todayPage.id,
    name: todayPage.name,
  });

  const blocks = await findUndoneBlocks(markers, todayDay);
  console.info("[migrate] undone blocks pre-filter:", blocks.length);

  const filterMode = (s.filterMode ?? "all") as FilterMode;
  const filterTag = s.filterTag ?? "migrate";
  const filtered = blocks.filter((b) => {
    if (b.page?.id === todayPage.id) return false;
    const content = b.content ?? "";
    if (filterMode === "exclude-tagged") return !hasHashtag(content, filterTag);
    if (filterMode === "only-tagged") return hasHashtag(content, filterTag);
    return true;
  });
  console.info("[migrate] blocks to migrate:", filtered.length);

  let moved = 0;
  let skipped = 0;

  const tree = await logseq.Editor.getPageBlocksTree(todayPage.name);
  const anchor = tree?.[tree.length - 1];
  const moveStyle = (s.moveStyle ?? "move") as MoveStyle;

  let prevUuid: string | undefined = anchor?.uuid;

  console.info("[migrate] anchor", { anchorUuid: anchor?.uuid, moveStyle });
  for (const b of filtered) {
    const content = b.content ?? "";
    console.info("[migrate] processing", {
      uuid: b.uuid,
      content: content.slice(0, 60),
      pageId: b.page?.id,
      prevUuid,
    });
    try {
      if (moveStyle === "move-with-ref") {
        const refContent = `((${b.uuid}))`;
        let inserted: BlockEntity | null = null;
        if (prevUuid) {
          inserted = await logseq.Editor.insertBlock(prevUuid, refContent, {
            sibling: true,
          });
        } else {
          inserted = await logseq.Editor.appendBlockInPage(
            todayPage.name,
            refContent,
          );
        }
        if (inserted) prevUuid = inserted.uuid;
        moved++;
      } else {
        let inserted: BlockEntity | null = null;
        if (prevUuid) {
          console.info("[migrate] insertBlock copy", {
            target: prevUuid,
            len: content.length,
          });
          inserted = await logseq.Editor.insertBlock(prevUuid, content, {
            sibling: true,
          });
        } else {
          console.info("[migrate] appendBlockInPage copy");
          inserted = await logseq.Editor.appendBlockInPage(
            todayPage.name,
            content,
          );
        }
        if (!inserted) {
          console.warn("[migrate] insert returned null, leaving source intact");
          skipped++;
          continue;
        }
        const verify = await logseq.Editor.getBlock(inserted.uuid);
        if (!verify || verify.page?.id !== todayPage.id) {
          console.warn(
            "[migrate] post-insert verify failed, leaving source intact",
            { insertedUuid: inserted.uuid, verifyPageId: verify?.page?.id },
          );
          skipped++;
          continue;
        }
        await logseq.Editor.removeBlock(b.uuid);
        prevUuid = inserted.uuid;
        moved++;
      }
    } catch (e) {
      console.error("[migrate] failed for block", b.uuid, e);
      skipped++;
    }
  }

  console.info("[migrate] done", { moved, skipped });
  if (moved > 0) {
    await logseq.updateSettings({ lastMigratedDate: String(todayDay) });
  }
  return { moved, skipped };
}

async function runWithToast(opts: { verbose?: boolean } = {}) {
  try {
    const { moved, skipped, reason } = await migrate();
    if (moved > 0 || skipped > 0) {
      logseq.UI.showMsg(
        `Migrate: moved ${moved}${skipped ? `, skipped ${skipped}` : ""}`,
        skipped ? "warning" : "success",
      );
    } else if (opts.verbose) {
      logseq.UI.showMsg(
        `Migrate: nothing to move${reason ? ` (${reason})` : ""}`,
        "info",
      );
    }
  } catch (e) {
    console.error("[migrate]", e);
    logseq.UI.showMsg(`Migrate failed: ${String(e)}`, "error");
  }
}

function main() {
  logseq.useSettingsSchema(settingsSchema);
  console.info("[migrate] plugin loaded");

  logseq.App.onRouteChanged(({ path }) => {
    if (!path) return;
    if (/\/page\//.test(path) || path === "/" || /journals/i.test(path)) {
      console.info("[migrate] route change trigger", path);
      void runWithToast();
    }
  });

  logseq.App.onCurrentGraphChanged(() => void runWithToast());

  logseq.Editor.registerSlashCommand("Migrate undone now", async () => {
    await logseq.updateSettings({ lastMigratedDate: "" });
    await runWithToast({ verbose: true });
  });

  logseq.App.registerCommandPalette(
    { key: "migrate-run-now", label: "Migrate: run now" },
    async () => {
      await logseq.updateSettings({ lastMigratedDate: "" });
      await runWithToast({ verbose: true });
    },
  );

  setTimeout(() => void runWithToast(), 800);
}

logseq.ready(main).catch(console.error);

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
  const res = (await logseq.DB.datascriptQuery(query)) as
    | BlockEntity[][]
    | null;
  if (!res) return [];
  return res.flat();
}

async function ensureTodayJournal(): Promise<PageEntity | null> {
  const cfg = await logseq.App.getUserConfigs();
  const fmt: string = cfg.preferredDateFormat ?? "yyyy-MM-dd";
  const title = formatDate(new Date(), fmt);
  let page = await logseq.Editor.getPage(title);
  if (!page) {
    page = await logseq.Editor.createPage(
      title,
      {},
      { journal: true, redirect: false, createFirstBlock: true },
    );
  }
  return page;
}

function formatDate(d: Date, fmt: string): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const map: Record<string, string> = {
    yyyy: String(d.getFullYear()),
    MM: pad(d.getMonth() + 1),
    M: String(d.getMonth() + 1),
    dd: pad(d.getDate()),
    d: String(d.getDate()),
    EEEE: d.toLocaleDateString("en-US", { weekday: "long" }),
    EEE: d.toLocaleDateString("en-US", { weekday: "short" }),
    MMMM: d.toLocaleDateString("en-US", { month: "long" }),
    MMM: d.toLocaleDateString("en-US", { month: "short" }),
    o: ordinalSuffix(d.getDate()),
  };
  return fmt.replace(/yyyy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|o/g, (k) => map[k] ?? k);
}

function ordinalSuffix(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

async function migrate(): Promise<{ moved: number; skipped: number }> {
  const s = logseq.settings as unknown as Settings;
  if (!s.enabled) return { moved: 0, skipped: 0 };

  const todayDay = todayJournalDay();
  if (s.lastMigratedDate === String(todayDay)) {
    return { moved: 0, skipped: 0 };
  }

  const markers = parseMarkers(s.markers);
  if (markers.length === 0) return { moved: 0, skipped: 0 };

  const todayPage = await ensureTodayJournal();
  if (!todayPage) return { moved: 0, skipped: 0 };

  const blocks = await findUndoneBlocks(markers, todayDay);

  const filtered = blocks.filter((b) => {
    if (b.page?.id === todayPage.id) return false;
    const content = b.content ?? "";
    if (s.filterMode === "exclude-tagged") return !hasHashtag(content, s.filterTag);
    if (s.filterMode === "only-tagged") return hasHashtag(content, s.filterTag);
    return true;
  });

  let moved = 0;
  let skipped = 0;

  const tree = await logseq.Editor.getPageBlocksTree(todayPage.name);
  const anchor = tree?.[tree.length - 1];

  let prevUuid: string | undefined = anchor?.uuid;

  for (const b of filtered) {
    try {
      if (s.moveStyle === "move-with-ref") {
        const refContent = `((${b.uuid}))`;
        if (prevUuid) {
          await logseq.Editor.insertBlock(prevUuid, refContent, {
            sibling: true,
          });
        } else {
          await logseq.Editor.appendBlockInPage(todayPage.name, refContent);
        }
        moved++;
      } else {
        if (prevUuid) {
          await logseq.Editor.moveBlock(b.uuid, prevUuid, { before: false });
        } else {
          const fallback = await logseq.Editor.appendBlockInPage(
            todayPage.name,
            b.content,
          );
          if (fallback) {
            prevUuid = fallback.uuid;
            await logseq.Editor.removeBlock(b.uuid);
          }
        }
        moved++;
      }
      const refreshed = await logseq.Editor.getBlock(b.uuid);
      if (refreshed) prevUuid = refreshed.uuid;
    } catch (e) {
      console.error("[migrate] failed for block", b.uuid, e);
      skipped++;
    }
  }

  await logseq.updateSettings({ lastMigratedDate: String(todayDay) });
  return { moved, skipped };
}

async function runWithToast() {
  try {
    const { moved, skipped } = await migrate();
    if (moved > 0 || skipped > 0) {
      logseq.UI.showMsg(
        `Migrate: moved ${moved}${skipped ? `, skipped ${skipped}` : ""}`,
        skipped ? "warning" : "success",
      );
    }
  } catch (e) {
    console.error("[migrate]", e);
    logseq.UI.showMsg(`Migrate failed: ${String(e)}`, "error");
  }
}

function main() {
  logseq.useSettingsSchema(settingsSchema);

  logseq.App.onRouteChanged(({ path }) => {
    if (!path) return;
    if (/\/page\//.test(path) || path === "/" || /journals/i.test(path)) {
      void runWithToast();
    }
  });

  logseq.App.onCurrentGraphChanged(() => void runWithToast());

  logseq.Editor.registerSlashCommand("Migrate undone now", async () => {
    await logseq.updateSettings({ lastMigratedDate: "" });
    await runWithToast();
  });

  logseq.App.registerCommandPalette(
    { key: "migrate-run-now", label: "Migrate: run now" },
    async () => {
      await logseq.updateSettings({ lastMigratedDate: "" });
      await runWithToast();
    },
  );

  void runWithToast();
}

logseq.ready(main).catch(console.error);

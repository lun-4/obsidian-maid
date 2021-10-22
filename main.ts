import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  Editor,
  MarkdownView,
  EditorPosition,
  ListItemCache,
  TFile
} from "obsidian";

const PRIO_REGEX = /%prio=(\d+)/g;
const MARKDOWN_LIST_ELEMENT_REGEX = /[-+*]?(?: \d+\.)? \[(.)\]/g;
const MAID_TASK_CLOSE_METADATA = / \(Done at \d\d\d\d-\d\d-\d\d\)/g;

function doneString(dateObj: Date): string {
  const dateString =
    dateObj.getFullYear() +
    "-" +
    ("0" + (dateObj.getMonth() + 1)).slice(-2) +
    "-" +
    ("0" + dateObj.getDate()).slice(-2);

  return ` (Done at ${dateString})`;
}

function addDateToEditor(
  editor: Editor,
  cursor: EditorPosition,
  wantedLine: string,
  wantedDate: Date
) {
  const datePosition = {
    line: cursor.line,
    ch: wantedLine.length
  };

  // putting the same position on both 'from' and 'to' parameters leads
  // to the replaceRange inserting text instead.
  editor.replaceRange(doneString(wantedDate), datePosition, datePosition);
}

function removeDateToEditor(
  editor: Editor,
  cursor: EditorPosition,
  dateMatch: any
) {
  const datePositionStart = {
    line: cursor.line,
    ch: dateMatch.index
  };
  const datePositionEnd = {
    line: cursor.line,
    ch: dateMatch.index + dateMatch[0].length
  };

  editor.replaceRange("", datePositionStart, datePositionEnd);
}

interface PriorityMap {
  [key: number]: number;
}

function getPriority(
  lineNumber: number,
  priorities: PriorityMap,
  listItems: ListItemCache[],
  settings: MaidPluginSettings,
  editor: Editor,
  view: MarkdownView
): number {
  const fileData = view.data;
  // find ourselves from our line number
  const listData = listItems.find((x) => x.position.start.line === lineNumber);

  const pos = listData.position;
  const listEntry = fileData.substring(pos.start.offset, pos.end.offset);

  // test if we have a priority set
  const match = listEntry.matchAll(PRIO_REGEX).next().value;
  if (match) {
    return parseInt(match[1], 10);
  } else {
    if (!settings.priorityInheritance) return settings.defaultPriority;

    // listData.parent can either be positive or negative.
    // if it's positive, we're a child of another task,
    // and the value is the line number of the parent.
    //
    // if it's negative, we're in a root level list,
    // so we should return the default priority.
    if (listData.parent > 0) {
      // because we're going down the tasks top-to-bottom,
      // our parent should already be in the priority list
      return getPriority(
        listData.parent,
        priorities,
        listItems,
        settings,
        editor,
        view
      );
    } else {
      return settings.defaultPriority;
    }
  }
}

interface MaidPluginSettings {
  defaultPriority: number;
  priorityInheritance: boolean;

  statusBarEnabled: boolean;
  statusBarActivity: boolean;
  statusBarDoneToday: boolean;
  statusBarRemaining: boolean;
}

const DEFAULT_SETTINGS: MaidPluginSettings = {
  defaultPriority: 0,
  priorityInheritance: true,

  statusBarEnabled: true,
  statusBarActivity: true,
  statusBarDoneToday: true,
  statusBarRemaining: true
};

class MaidSettingTab extends PluginSettingTab {
  plugin: MaidPlugin;

  constructor(app: App, plugin: MaidPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    let { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Default task priority")
      .setDesc(
        "The default task priority to use when there isn't one set. Set to 0 to disable."
      )
      .addText((text) =>
        text
          .setValue(this.plugin.settings.defaultPriority.toString())
          .onChange(async (value) => {
            const parsedValue = parseInt(value);
            this.plugin.settings.defaultPriority = isNaN(parsedValue)
              ? 0
              : parsedValue;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Task priority inheritance")
      .setDesc(
        "When a task has no priority, it'll inherit from its parent. When disabled, it'll instead use the default task priority."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.priorityInheritance)
          .onChange(async (value) => {
            this.plugin.settings.priorityInheritance = value;
            await this.plugin.saveSettings();
          })
      );

    containerEl.createEl("h3", { text: "Status bar" });

    new Setting(containerEl)
      .setName("Enable status bar")
      .setDesc("Whether to show the status bar in the bottom right.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.statusBarEnabled)
          .onChange(async (value) => {
            this.plugin.settings.statusBarEnabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Recent task activity")
      .setDesc("ASCII character graph of recent task activity.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.statusBarActivity)
          .onChange(async (value) => {
            this.plugin.settings.statusBarActivity = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Tasks done today")
      .setDesc("Shows how many tasks you've completed today.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.statusBarDoneToday)
          .onChange(async (value) => {
            this.plugin.settings.statusBarDoneToday = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Tasks remaining")
      .setDesc("Shows how many tasks yet to be completed.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.statusBarRemaining)
          .onChange(async (value) => {
            this.plugin.settings.statusBarRemaining = value;
            await this.plugin.saveSettings();
          });
      });
  }
}

export default class MaidPlugin extends Plugin {
  settings: MaidPluginSettings;
  statusBarItemEl: HTMLElement;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new MaidSettingTab(this.app, this));

    this.statusBarItemEl = this.addStatusBarItem();
    // gets rid of the tiny whitespace it makes when first enabled
    this.statusBarItemEl.addClass("maid-status-bar-hidden");

    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile) => {
        this.refreshStatusBar(file);
      })
    );

    this.registerEvent(
      this.app.vault.on("modify", (file: TFile) => {
        this.refreshStatusBar(file);
      })
    );

    this.addCommand({
      id: "roll-task",
      name: "Roll random task by priority",
      hotkeys: [{ modifiers: ["Ctrl"], key: "g" }],
      editorCallback: (editor: Editor, view: MarkdownView) => {
        const cachedMetadata = this.app.metadataCache.getFileCache(view.file);
        const listItems = cachedMetadata.listItems;

        const priorities: PriorityMap = {};
        for (const listData of cachedMetadata.listItems) {
          const pos = listData.position;
          const lineNumber = pos.start.line;

          // this assumes that there's one task per line.
          // if someone manages to get more than one task on a line, this will break!
          priorities[lineNumber] = getPriority(
            lineNumber,
            priorities,
            listItems,
            this.settings,
            editor,
            view
          );
        }

        let prio_pairs: Array<Array<number>> = Object.entries(priorities)
          .map((x) => [parseInt(x[0]), x[1]]) // Object.entries makes the key a string?
          .filter((x) => {
            // shortcircuit checks because regex computing is expensive
            // and precious
            const isNegativeWeight = x[1] < 0;
            if (isNegativeWeight) return false;

            const line = editor.getLine(x[0]);
            const taskMatch = line
              .trim()
              .matchAll(MARKDOWN_LIST_ELEMENT_REGEX)
              .next().value;
            if (!taskMatch) return false;

            const isFinishedTask = taskMatch[1] !== " ";
            if (isFinishedTask) return false;

            return true;
          });

        let total_prio = prio_pairs.map((x) => x[1]).reduce((a, b) => a + b);
        if (total_prio < 1) return;

        let index = Math.floor(Math.random() * total_prio);
        let choice: number = null;

        for (const pair of prio_pairs) {
          let [line_index, priority] = pair as Array<number>;
          if (priority > index) {
            choice = line_index;
            break;
          }
          index -= priority;
        }

        if (choice !== null) editor.setCursor(choice);
      }
    });

    this.addCommand({
      id: "toggle-task-completeness",
      name: "Toggle completeness of a task",
      hotkeys: [{ modifiers: ["Ctrl"], key: "m" }],
      editorCallback: (editor: Editor, view: MarkdownView) => {
        const cursor = editor.getCursor();

        const wantedLine = editor.getLine(cursor.line);
        const firstMatch = wantedLine
          .matchAll(MARKDOWN_LIST_ELEMENT_REGEX)
          .next().value;
        if (!firstMatch) return;

        let replaceWith = firstMatch[1] === " " ? "x" : " ";
        const charPosition: EditorPosition = {
          line: cursor.line,
          ch: firstMatch.index + 3
        };
        const charPositionEnd: EditorPosition = {
          line: cursor.line,
          ch: firstMatch.index + 4
        };
        editor.replaceRange(replaceWith, charPosition, charPositionEnd);

        const dateMatchIterValue = wantedLine
          .matchAll(MAID_TASK_CLOSE_METADATA)
          .next();
        const dateMatch = dateMatchIterValue.value;

        if (replaceWith == "x" && !dateMatch) {
          const now = new Date();
          addDateToEditor(editor, cursor, wantedLine, now);
        } else if (replaceWith == " " && dateMatchIterValue.value) {
          removeDateToEditor(editor, cursor, dateMatch);
        }
      }
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  tasksDoneInDay(fileContent: string, day: Date): number {
    const nowDoneString = doneString(day);
    const doneRegex = new RegExp(
      // need to replace as () by themselves would be considered a
      // regex capturing group, and we don't want that
      nowDoneString.replace("(", "\\(").replace(")", "\\)"),
      "g"
    );
    const doneCount = [...fileContent.matchAll(doneRegex)].length;
    return doneCount;
  }

  async drawActivity(file: TFile, statusBarItems: string[]) {
    const fileContent = await file.vault.cachedRead(file);
    const dateOffsetedBy = (days: number) => {
      let d = new Date();
      d.setDate(d.getDate() - days);
      return d;
    };
    const taskDoneAmounts = [...Array(7).keys()]
      .map((offset: number) => dateOffsetedBy(offset))
      .map((taskDate) => {
        return this.tasksDoneInDay(fileContent, taskDate);
      })
      .reverse();

    const maxTasksDone = Math.max(...taskDoneAmounts);

    // calculate ratios between task done and maxTasksDone, select block
    // character based on that ratio
    const blockCharacters = taskDoneAmounts
      .map((taskDoneCount) => taskDoneCount / maxTasksDone)
      .map((ratio) => {
        if (ratio > 0.9) return "█";
        if (ratio > 0.7) return "▇";
        if (ratio > 0.5) return "▆";
        if (ratio > 0.4) return "▅";
        if (ratio > 0.3) return "▃";
        if (ratio > 0.2) return "▂";
        if (ratio > 0.1) return "▁";
        return " ";
      })
      .join("");

    // because of how we calculate these two, this check has to be at the bottom
    if (this.settings.statusBarActivity)
      statusBarItems.push(`|${blockCharacters}|`);
    if (this.settings.statusBarDoneToday) {
      const tasksDoneToday = taskDoneAmounts[taskDoneAmounts.length - 1];
      statusBarItems.push(`[${tasksDoneToday} today]`);
    }
  }

  async drawDoneLeft(file: TFile, statusBarItems: string[]) {
    if (!this.settings.statusBarRemaining) return;
    const fileContent = await file.vault.cachedRead(file);
    const cachedMetadata = this.app.metadataCache.getFileCache(file);

    const itemsLeft = cachedMetadata.listItems.filter((x) => {
      const listEntry = fileContent.substring(
        x.position.start.offset,
        x.position.end.offset
      );
      const match = listEntry.matchAll(MARKDOWN_LIST_ELEMENT_REGEX).next()
        .value;
      if (!match) return false;

      return match[1] === " ";
    }).length;

    statusBarItems.push(`[${itemsLeft} left]`);
  }

  async refreshStatusBar(file: TFile) {
    this.statusBarItemEl.addClass("maid-status-bar");
    if (!this.settings.statusBarEnabled) {
      this.statusBarItemEl.addClass("maid-status-bar-hidden");
      return;
    } else {
      this.statusBarItemEl.removeClass("maid-status-bar-hidden");
    }

    let statusBarItems: string[] = [];
    await this.drawActivity(file, statusBarItems);
    await this.drawDoneLeft(file, statusBarItems);

    this.statusBarItemEl.setText(statusBarItems.join(" "));
  }
}

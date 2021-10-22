import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  Editor,
  MarkdownView,
  EditorPosition,
  ListItemCache
} from "obsidian";

const PRIO_REGEX = /%prio=(\d+)/g;
const MARKDOWN_LIST_ELEMENT_REGEX = /- \[([x ]?)\]/g;
const MAID_TASK_CLOSE_METADATA = / \(Done at \d\d\d\d-\d\d-\d\d\)/g;

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
  const wantedDateAsString =
    wantedDate.getFullYear() +
    "-" +
    ("0" + (wantedDate.getMonth() + 1)).slice(-2) +
    "-" +
    ("0" + wantedDate.getDate()).slice(-2);

  // putting the same position on both 'from' and 'to' parameters leads
  // to the replaceRange inserting text instead.
  editor.replaceRange(
    ` (Done at ${wantedDateAsString})`,
    datePosition,
    datePosition
  );
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
    const priority = parseInt(match[1], 10);
    const lineNumber = pos.start.line;
    return priority;
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
}

const DEFAULT_SETTINGS: MaidPluginSettings = {
  defaultPriority: 0,
  priorityInheritance: true
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
  }
}

export default class MaidPlugin extends Plugin {
  settings: MaidPluginSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new MaidSettingTab(this.app, this));

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
            const line = editor.getLine(x[0]);

            const isFinishedTask = line.includes("- [x]");
            const isNegativeWeight = x[1] < 0;
            const isNotTask = !line.trim().match(MARKDOWN_LIST_ELEMENT_REGEX);

            return !(isFinishedTask || isNegativeWeight || isNotTask);
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
        const fileData = view.data;
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
}

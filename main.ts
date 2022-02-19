import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  Editor,
  MarkdownView,
  EditorPosition,
  ListItemCache,
  TFile,
  TAbstractFile,
  Modal,
} from "obsidian";

const PRIO_REGEX = /%prio=(\d+)/g;
const MARKDOWN_LIST_ELEMENT_REGEX = /[-+*]?(?: \d+\.)? \[(.)\]/g;
const MAID_TASK_CLOSE_METADATA = / \(Done at (\d\d\d\d-\d\d-\d\d)\)/g;

function assert(value: unknown, message?: string): asserts value {
  if (!value) throw new Error("assertion failed:" + message);
}

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
  wantedDate: Date,
) {
  const datePosition = {
    line: cursor.line,
    ch: wantedLine.length,
  };

  // putting the same position on both 'from' and 'to' parameters leads
  // to the replaceRange inserting text instead.
  editor.replaceRange(doneString(wantedDate), datePosition, datePosition);
}

function removeDateToEditor(
  editor: Editor,
  cursor: EditorPosition,
  dateMatch: any,
) {
  const datePositionStart = {
    line: cursor.line,
    ch: dateMatch.index,
  };
  const datePositionEnd = {
    line: cursor.line,
    ch: dateMatch.index + dateMatch[0].length,
  };

  editor.replaceRange("", datePositionStart, datePositionEnd);
}

interface PriorityMap {
  [key: number]: number;
}

class Task {
  position: number;
  rawText: string;
  state?: string;
  priority?: number;
  doneAt?: Date;
  parentTaskPosition?: number;
  children: Array<number>; //array of task positions

  constructor(
    position: number,
    rawText: string,
    state?: string,
    priority?: number,
    doneAt?: Date,
    parentTaskPosition?: number,
  ) {
    this.position = position;
    this.state = state;
    this.priority = priority;
    this.rawText = rawText;
    this.doneAt = doneAt;
    this.parentTaskPosition = parentTaskPosition;
    this.children = [];
  }
}

type RawTaskMap = Map<number, Task>;

class TaskMap {
  rawMap: RawTaskMap;
  settings: MaidPluginSettings;

  constructor(rawMap: RawTaskMap, settings: MaidPluginSettings) {
    this.rawMap = rawMap;
    this.settings = settings;
  }

  set(position: number, task: Task) {
    this.rawMap.set(position, task);
  }

  getOptional(position: number): Task | undefined {
    return this.rawMap.get(position);
  }

  get(position: number): Task {
    const task = this.getOptional(position);
    assert(task !== undefined);
    return task;
  }

  // calculate a task's priority using a defined algorithm
  // (that accounts for the user's settings)
  //
  // do NOT use task.rawPriority for ordering as rawPriority can be undefined.
  //
  // this function will always return a value!
  fetchPriority(position: number): number {
    const task = this.rawMap.get(position);
    if (task === undefined) return this.settings.defaultPriority;

    if (
      this.settings.priorityInheritance &&
      task.priority === undefined &&
      task.parentTaskPosition !== undefined
    ) {
      // child tasks inherit priority from their parent tasks
      return this.fetchPriority(task.parentTaskPosition);
    }

    if (task.priority === undefined) {
      return this.settings.defaultPriority;
    } else {
      return task.priority;
    }
  }
}

function getPriority(
  lineNumber: number,
  priorities: PriorityMap,
  listItems: ListItemCache[],
  settings: MaidPluginSettings,
  editor: Editor,
  view: MarkdownView,
): number {
  const fileData = view.data;
  // find ourselves from our line number
  const listData = listItems.find((x) => x.position.start.line === lineNumber);

  assert(listData !== undefined);

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
        view,
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

  reorderFeatureEnabled: boolean;
}

const DEFAULT_SETTINGS: MaidPluginSettings = {
  defaultPriority: 0,
  priorityInheritance: true,

  statusBarEnabled: true,
  statusBarActivity: true,
  statusBarDoneToday: true,
  statusBarRemaining: false,

  reorderFeatureEnabled: false,
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

    assert(this.plugin.settings !== undefined);

    new Setting(containerEl)
      .setName("Default task priority")
      .setDesc(
        "The default task priority to use when there isn't one set. Set to 0 to disable.",
      )
      .addText((text) => {
        assert(this.plugin.settings !== undefined);
        text
          .setValue(this.plugin.settings.defaultPriority.toString())
          .onChange(async (value) => {
            assert(this.plugin.settings !== undefined);
            const parsedValue = parseInt(value);
            this.plugin.settings.defaultPriority = isNaN(parsedValue)
              ? 0
              : parsedValue;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Task priority inheritance")
      .setDesc(
        "When a task has no priority, it'll inherit from its parent. When disabled, it'll instead use the default task priority.",
      )
      .addToggle((toggle) => {
        assert(this.plugin.settings !== undefined);

        toggle
          .setValue(this.plugin.settings.priorityInheritance)
          .onChange(async (value) => {
            assert(this.plugin.settings !== undefined);
            this.plugin.settings.priorityInheritance = value;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Status bar" });

    new Setting(containerEl)
      .setName("Enable status bar")
      .setDesc("Whether to show the status bar in the bottom right.")
      .addToggle((toggle) => {
        assert(this.plugin.settings !== undefined);
        toggle
          .setValue(this.plugin.settings.statusBarEnabled)
          .onChange(async (value) => {
            assert(this.plugin.settings !== undefined);
            this.plugin.settings.statusBarEnabled = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Recent task activity")
      .setDesc("ASCII character graph of recent task activity.")
      .addToggle((toggle) => {
        assert(this.plugin.settings !== undefined);
        toggle
          .setValue(this.plugin.settings.statusBarActivity)
          .onChange(async (value) => {
            assert(this.plugin.settings !== undefined);
            this.plugin.settings.statusBarActivity = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Tasks done today")
      .setDesc("Shows how many tasks you've completed today.")
      .addToggle((toggle) => {
        assert(this.plugin.settings !== undefined);
        toggle
          .setValue(this.plugin.settings.statusBarDoneToday)
          .onChange(async (value) => {
            assert(this.plugin.settings !== undefined);
            this.plugin.settings.statusBarDoneToday = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Tasks remaining")
      .setDesc("Shows how many tasks yet to be completed.")
      .addToggle((toggle) => {
        assert(this.plugin.settings !== undefined);
        toggle
          .setValue(this.plugin.settings.statusBarRemaining)
          .onChange(async (value) => {
            assert(this.plugin.settings !== undefined);
            this.plugin.settings.statusBarRemaining = value;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { text: "Feature toggles" });

    new Setting(containerEl)
      .setName("Enable task reorder")
      .setDesc(
        "THIS FEATURE CAN DESTROY PARTS OF YOUR TODO LIST. BEWARE OF ENABLING THIS FEATURE. READ THE CODE BEFORE ENABLING THIS FEATURE.",
      )
      .addToggle((toggle) => {
        assert(this.plugin.settings !== undefined);
        toggle
          .setValue(this.plugin.settings.reorderFeatureEnabled)
          .onChange(async (value) => {
            assert(this.plugin.settings !== undefined);
            this.plugin.settings.reorderFeatureEnabled = value;
            await this.plugin.saveSettings();
          });
      });
  }
}

class TestModal extends Modal {
  plugin: MaidPlugin;
  constructor(plugin: MaidPlugin) {
    super(plugin.app);
    this.plugin = plugin;
  }

  onOpen() {
    let { contentEl } = this;
    contentEl.setText("Woah!");
  }

  onClose() {
    let { contentEl } = this;
    contentEl.empty();
  }
}

export default class MaidPlugin extends Plugin {
  settings?: MaidPluginSettings;
  statusBarItemEl?: HTMLElement;
  lastRefreshedFile?: TFile | TAbstractFile;
  isFileSafe: boolean = false;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new MaidSettingTab(this.app, this));

    this.statusBarItemEl = this.addStatusBarItem();
    this.statusBarItemEl.addClass("maid-status-bar");
    // gets rid of the tiny whitespace it makes when first enabled
    this.statusBarItemEl.addClass("maid-status-bar-hidden");

    this.registerEvent(
      this.app.workspace.on("file-open", (file: TFile | null) => {
        if (file !== null) {
          console.log("file-open", file);
          this.isFileSafe = true;
          this.refreshStatusBar(file);
        }
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file: TAbstractFile) => {
        console.log("vault:modify", file);
        this.refreshStatusBar(file);
      }),
    );

    this.registerEvent(
      this.app.workspace.on(
        "editor-change",
        (editor: Editor, markdownView: MarkdownView) => {
          if (this.isFileSafe) {
            console.log("file is not safe, waiting for metadata");
            this.isFileSafe = false;
          }
        },
      ),
    );

    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        console.log("metadata:changed", file);
        if (!this.isFileSafe) {
          console.log("file is safe");
          this.isFileSafe = true;
        }
        if (this.lastRefreshedFile === file) {
          this.refreshStatusBar(file);
        }
      }),
    );

    this.addCommand({
      id: "reorder-task",
      name: "Organize task list by priority",
      hotkeys: [{ modifiers: ["Ctrl"], key: "t" }],
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.reorderTaskList(editor, view);
      },
    });

    this.addCommand({
      id: "roll-task",
      name: "Roll random task by priority",
      hotkeys: [{ modifiers: ["Ctrl"], key: "g" }],
      editorCallback: (editor: Editor, view: MarkdownView) => {
        // TODO refactor to use TaskMap
        const cachedMetadata = this.app.metadataCache.getFileCache(view.file);
        if (cachedMetadata === null) {
          console.log("no file in cache, ignoring task roll");
          return;
        }
        const listItems = cachedMetadata.listItems;
        assert(listItems !== undefined);

        const priorities: PriorityMap = {};
        for (const listData of listItems) {
          const pos = listData.position;
          const lineNumber = pos.start.line;

          assert(this.settings !== undefined);

          // this assumes that there's one task per line.
          // if someone manages to get more than one task on a line, this will break!
          priorities[lineNumber] = getPriority(
            lineNumber,
            priorities,
            listItems,
            this.settings,
            editor,
            view,
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
        let choice: number | null = null;

        for (const pair of prio_pairs) {
          let [line_index, priority] = pair as Array<number>;
          if (priority > index) {
            choice = line_index;
            break;
          }
          index -= priority;
        }

        if (choice !== null) {
          editor.setCursor(choice);
        }
      },
    });

    this.addCommand({
      id: "toggle-task-completeness",
      name: "Toggle completeness of a task",
      hotkeys: [{ modifiers: ["Ctrl"], key: "m" }],
      editorCallback: (editor: Editor, view: MarkdownView) => {
        // TODO refactor to use TaskMap
        const cursor = editor.getCursor();

        const wantedLine = editor.getLine(cursor.line);
        const firstMatch = wantedLine
          .matchAll(MARKDOWN_LIST_ELEMENT_REGEX)
          .next().value;
        if (!firstMatch) return;

        let replaceWith = firstMatch[1] === " " ? "x" : " ";
        const charPosition: EditorPosition = {
          line: cursor.line,
          ch: firstMatch.index + 3,
        };
        const charPositionEnd: EditorPosition = {
          line: cursor.line,
          ch: firstMatch.index + 4,
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
      },
    });
  }

  makeTaskMap(view: MarkdownView): TaskMap {
    if (!this.isFileSafe) {
      console.warn("file is unsafe, please wait");
      throw new Error("file is unsafe, please wait");
    }
    const cachedMetadata = this.app.metadataCache.getFileCache(view.file);
    assert(cachedMetadata !== null);
    const listItems = cachedMetadata.listItems;
    assert(listItems !== undefined);

    let rawMap = new Map<number, Task>();

    assert(this.settings !== undefined);
    let map = new TaskMap(rawMap, this.settings);

    for (const listItem of listItems) {
      const fileData = view.data;
      const rawText = fileData.substring(
        listItem.position.start.offset,
        listItem.position.end.offset,
      );

      const priorityMatch: Array<string> | undefined = rawText
        .matchAll(PRIO_REGEX)
        .next().value;
      let rawPriority: number | undefined = undefined;
      if (priorityMatch !== undefined) {
        rawPriority = parseInt(priorityMatch[1], 10);
      }

      const rawDoneAtValue: Array<string> | undefined = rawText
        .matchAll(MAID_TASK_CLOSE_METADATA)
        .next().value;
      let rawDoneAt: Date | undefined = undefined;
      if (rawDoneAtValue !== undefined) {
        rawDoneAt = new Date(rawDoneAtValue[1]);
      }

      const taskPosition = listItem.position.start.line;
      let parentTaskPosition = undefined;
      if (listItem.parent > 0) {
        parentTaskPosition = listItem.parent;
      }
      let task = new Task(
        taskPosition,
        rawText,
        listItem.task,
        rawPriority,
        rawDoneAt,
        parentTaskPosition,
      );
      if (parentTaskPosition !== undefined) {
        const parentTask = map.get(parentTaskPosition);
        parentTask.children.push(taskPosition);
      }
      console.log(listItem, task);
      map.set(taskPosition, task);
    }

    return map;
  }

  async reorderTaskList(editor: Editor, view: MarkdownView) {
    // NOTE: this code WILL NOT CARE about text outside of the markdown tree.
    // IT WILL DESTROY SUCH TEXT AFTER REORDERING.
    // DO NOT USE THIS FEATURE IF YOUR TODO LIST DOES NOT FOLLOW MY FORMAT.
    // THIS PLUGIN IS OPINIONATED. NAMELY, IT HAS MY OPINION.
    //
    // from an unorganized task list, e.g
    //
    // - [ ] task 1 %prio=0
    //    - [ ] subtask 1 %prio=4
    // - [ ] task 2 %prio=1
    // - [ ] task unknown
    //    - [ ] another unknown task
    // - [ ] task 3 %prio=3
    // - [x] done %prio=3
    //
    // we want to have 3 task buckets
    //
    // # unprioritized
    //
    // - [ ] task unknown
    //    - [ ] another unknown task
    //
    // # prioritized (by the root task's priority, not child tasks.)
    //
    // - [ ] task 3 %prio=3
    // - [ ] task 2 %prio=1
    // - [ ] task 1 %prio=0
    //    - [ ] subtask 1 %prio=4
    //
    // # done (ordered by doneAt)
    //
    // - [x] done %prio=3

    assert(this.settings !== undefined);
    if (!this.settings.reorderFeatureEnabled) {
      console.log("reorders are disabled, please go to settings");
      return;
    }

    // to do that, we need to parse the entire todo tree, find out the top
    // level tasks, and reorder them...

    // tasks has a list of top level tasks only
    // children tasks inside each task object
    const tasks = this.makeTaskMap(view);

    // we need to find out the line reorderings we'll have to do, but first
    // we also need to find out where each root task will go in the buckets.
    let unprioritizedTasks = [];
    let prioritizedUndoneTasks = [];
    let doneTasks = [];
    let weirdTasks = [];

    const taskIterator = tasks.rawMap[Symbol.iterator]();
    for (const [taskPosition, task] of taskIterator) {
      // only care about root tasks in the tree. (then add the
      // children tasks when we're generating output)
      if (task.parentTaskPosition !== undefined) continue;

      if (
        (task.state === " " || task.state === undefined) &&
        task.priority === undefined
      ) {
        unprioritizedTasks.push(taskPosition);
      } else if (task.state == " " && task.priority !== undefined) {
        prioritizedUndoneTasks.push(taskPosition);
      } else if (task.state !== undefined) {
        doneTasks.push(taskPosition);
      } else {
        // if all other checks fail, add to weirdTasks for proper triage
        weirdTasks.push(taskPosition);
      }
    }

    function priorityCompare(
      firstTaskPosition: number,
      secondTaskPosition: number,
    ): number | null {
      const firstTaskPriority = tasks.fetchPriority(firstTaskPosition);
      const secondTaskPriority = tasks.fetchPriority(secondTaskPosition);

      if (firstTaskPriority < secondTaskPriority) {
        return -1;
      }

      if (firstTaskPriority > secondTaskPriority) {
        return 1;
      }

      return null;
    }

    function positionCompare(
      firstTaskPosition: number,
      secondTaskPosition: number,
    ): number {
      if (firstTaskPosition < secondTaskPosition) {
        return -1;
      }

      if (firstTaskPosition > secondTaskPosition) {
        return 1;
      }

      // they are the same task (impossible)
      return 0;
    }

    // unprioritizedTasks: sort by position
    // prioritizedUndoneTasks: sort by priority, then by position
    // doneTasks: sort by doneAt, then by position

    unprioritizedTasks.sort((firstTaskPosition, secondTaskPosition) => {
      return positionCompare(firstTaskPosition, secondTaskPosition);
    });

    prioritizedUndoneTasks.sort((firstTaskPosition, secondTaskPosition) => {
      const priorityResult = priorityCompare(
        firstTaskPosition,
        secondTaskPosition,
      );
      if (priorityResult !== null) return priorityResult;
      // if same priority, use line position
      return positionCompare(firstTaskPosition, secondTaskPosition);
    });

    doneTasks.sort((firstTaskPosition, secondTaskPosition) => {
      const firstTask = tasks.get(firstTaskPosition);
      const secondTask = tasks.get(secondTaskPosition);

      // always prefer doneAt instead of line number
      //
      // if a task was done just now, sort it to the 1st element
      if (firstTask.doneAt !== undefined && secondTask.doneAt !== undefined) {
        // from mdn docs:
        //
        // compareFunction(a, b) return value sort order
        // > 0  sort b before a
        // < 0  sort a before b
        // === 0  keep original order of a and b
        //
        // now we want to order by DESC
        // that means if firstTask is less (older) than secondTsk, we MUST say secondTask comes first in the array
        if (firstTask.doneAt < secondTask.doneAt) {
          return 1;
        }
        if (firstTask.doneAt > secondTask.doneAt) {
          return -1;
        }
      }

      return positionCompare(firstTaskPosition, secondTaskPosition);
    });

    console.log("weirdTasks", weirdTasks);
    console.log("unprioritizedTasks", unprioritizedTasks);
    console.log("prioritizedUndoneTasks", prioritizedUndoneTasks);
    console.log("doneTasks", doneTasks);

    // while generating output, keep track of which tasks we have
    // added to such. assert we have all the tasks we parsed in the output
    let touchedTasks: Array<number> = [];

    function stringifyTaskPositions(
      list: Array<number>,
      ident: number,
    ): string {
      return list
        .map((position) => tasks.get(position))
        .filter((task) => task !== undefined)
        .map((task) => {
          touchedTasks.push(task.position);
          return (
            "\t".repeat(ident) +
            task.rawText +
            "\n" +
            stringifyTaskPositions(task.children, ident + 1)
          );
        })
        .join("");
    }

    let output = "";

    output += "# weird (bugs in task selection)\n";
    output += stringifyTaskPositions(weirdTasks, 0);
    output += "# unprioritized\n";
    output += stringifyTaskPositions(unprioritizedTasks, 0);
    output += "\n# prioritized\n";
    output += stringifyTaskPositions(prioritizedUndoneTasks, 0);
    output += "\n# done\n";
    output += stringifyTaskPositions(doneTasks, 0);

    const finalTaskIterator = tasks.rawMap[Symbol.iterator]();
    let reorderError = false;
    for (const [taskPosition, _] of finalTaskIterator) {
      if (!touchedTasks.contains(taskPosition)) {
        reorderError = true;
      }
    }
    console.log(output);
    console.log("were all previous tasks written to output?", !reorderError);
    assert(
      !reorderError,
      "an algorithmic error has occoured. most likely a bug",
    );

    const lastLine = editor.lastLine();
    const lastChar = editor.getLine(lastLine).length;

    editor.replaceRange(
      output,
      { line: 0, ch: 0 },
      { line: lastLine, ch: lastChar },
    );
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    assert(this.settings !== undefined);
    await this.saveData(this.settings);
  }

  tasksDoneInDay(fileContent: string, day: Date): number {
    const nowDoneString = doneString(day);
    const doneRegex = new RegExp(
      // need to replace as () by themselves would be considered a
      // regex capturing group, and we don't want that
      nowDoneString.replace("(", "\\(").replace(")", "\\)"),
      "g",
    );
    const doneCount = [...fileContent.matchAll(doneRegex)].length;
    return doneCount;
  }

  async drawActivity(file: TFile | TAbstractFile, statusBarItems: string[]) {
    const fileContent = await file.vault.cachedRead(file as TFile);
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
    assert(this.settings !== undefined);
    if (this.settings.statusBarActivity) {
      statusBarItems.push(`|${blockCharacters}|`);
    }
    if (this.settings.statusBarDoneToday) {
      const tasksDoneToday = taskDoneAmounts[taskDoneAmounts.length - 1];
      statusBarItems.push(`[${tasksDoneToday} today]`);
    }
  }

  async drawDoneLeft(file: TFile | TAbstractFile, statusBarItems: string[]) {
    assert(this.settings !== undefined);
    if (!this.settings.statusBarRemaining) return;
    const cachedMetadata = this.app.metadataCache.getFileCache(file as TFile);
    assert(cachedMetadata !== null);
    assert(cachedMetadata.listItems !== undefined);

    // this'll be off slightly since it's cached
    const itemsLeft = cachedMetadata.listItems.filter((x) => {
      return x?.task === " ";
    }).length;

    statusBarItems.push(`[${itemsLeft} left]`);
  }

  async refreshStatusBar(file: TFile | TAbstractFile) {
    this.lastRefreshedFile = file;
    assert(this.settings !== undefined);
    assert(this.statusBarItemEl !== undefined);
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

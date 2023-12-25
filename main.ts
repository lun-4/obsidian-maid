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
import {
  ViewUpdate,
  PluginValue,
  EditorView,
  ViewPlugin,
  WidgetType,
  MatchDecorator,
  Decoration,
} from "@codemirror/view";
import {colorize_text} from "color.ts";


const TAG_REGEX = /%[\w-]+/g;
const PRIO_REGEX = /%prio=(\d+)/g;
// %due=2020-12-12
// %due=2022-02-21T00:36:42
// %due=2022-02-21T00:36
const DUE_TAG_REGEX = /%due=(\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:(\d{2})?)?)/g;
const MARKDOWN_LIST_ELEMENT_REGEX = /[-+*]?(?: \d+\.)? \[(.)\]/g;
const MAID_TASK_CLOSE_METADATA = / \(Done at (\d\d\d\d-\d\d-\d\d)\)/g;
const MAID_TASK_LEFT_METADATA = / \(Left at (\d\d\d\d-\d\d-\d\d)\)/g;

function assert(value: unknown, message?: string): asserts value {
  if (!value) throw new Error("assertion failed:" + message);
}

export const dateSuffixer: (title: string) => (dateObj: Date) => string = (
  title,
) => {
  return (dateObj: Date) => {
    const dateString =
      dateObj.getFullYear() +
      "-" +
      ("0" + (dateObj.getMonth() + 1)).slice(-2) +
      "-" +
      ("0" + dateObj.getDate()).slice(-2);

    return ` (${title} at ${dateString})`;
  };
};

const doneDateSuffixer = dateSuffixer("Done");
const leftDateSuffixer = dateSuffixer("Left");

function addDateToEditor(
  editor: Editor,
  cursor: EditorPosition,
  wantedLine: string,
  wantedDate: Date,
  dateSuffixer: (dateObj: Date) => string,
) {
  const datePosition = {
    line: cursor.line,
    ch: wantedLine.length,
  };

  // putting the same position on both 'from' and 'to' parameters leads
  // to the replaceRange inserting text instead.
  editor.replaceRange(dateSuffixer(wantedDate), datePosition, datePosition);
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
  dueAt?: Date;
  parentTaskPosition?: number;
  children: Array<number>; //array of task positions

  constructor(
    position: number,
    rawText: string,
    state?: string,
    priority?: number,
    doneAt?: Date,
    dueAt?: Date,
    parentTaskPosition?: number,
  ) {
    this.position = position;
    this.state = state;
    this.priority = priority;
    this.rawText = rawText;
    this.doneAt = doneAt;
    this.dueAt = dueAt;
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


    new Setting(containerEl)
      .setName("Enable tag autocoloring")
      .setDesc("colors pretty. requires restart to apply")
      .addToggle((toggle) => {
        assert(this.plugin.settings !== undefined);
        toggle
          .setValue(this.plugin.settings.autocolorTags)
          .onChange(async (value) => {
            assert(this.plugin.settings !== undefined);
            this.plugin.settings.autocolorTags = value;
            await this.plugin.saveSettings();
          });
      });
    
  }
}

const coolDeco = new MatchDecorator({
  regexp: TAG_REGEX,
  decoration: match => {
    const tag = match[0];

    const color = colorize_text(tag);
    const color_hex = color.map(x => x.toString(16)).reduce((x, y) => x + y);
    

    return Decoration.mark({
      inclusive: true,
      attributes: {
        style: `background-color: #${color_hex}`,
      }
    });
  }
});

class AutocolorPlugin implements PluginValue {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = coolDeco.createDeco(view)
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = coolDeco.updateDeco(update, this.decorations)
    }
  }
}

const pluginSpec: PluginSpec<AutocolorPlugin> = {
  decorations: (value: AutocolorPlugin) => value.decorations,
};

export const autocolorPlugin = ViewPlugin.fromClass(AutocolorPlugin, pluginSpec);

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

            setTimeout(() => {
              if (!this.isFileSafe) {
                // if this happens, try editing a new whitespace, seeing
                // console logs to notice the 'metadata:changed' event, then
                // move back to your normal mode of operations
                console.warn("metadata cache timed out, danger!");
              }
            }, 3400);
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
      id: "insert-current-date",
      name: "Insert current date as an %at tag",
      hotkeys: [{ modifiers: ["Ctrl"], key: "j" }],
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.insertCurrentDate(editor, view);
      },
    });

    this.addCommand({
      id: "reorder-task",
      name: "Organize task list",
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
        this.rollTask(editor, view);
      },
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
          addDateToEditor(editor, cursor, wantedLine, now, doneDateSuffixer);
        } else if (replaceWith == " " && dateMatchIterValue.value) {
          removeDateToEditor(editor, cursor, dateMatch);
        }
      },
    });

    this.addCommand({
      id: "toggle-task-leftness",
      name: "Toggle leftness of a task (for when you've given up on it)",
      hotkeys: [{ modifiers: ["Ctrl", "Shift"], key: "m" }],
      editorCallback: (editor: Editor, view: MarkdownView) => {
        const cursor = editor.getCursor();

        const wantedLine = editor.getLine(cursor.line);
        const firstMatch = wantedLine
          .matchAll(MARKDOWN_LIST_ELEMENT_REGEX)
          .next().value;
        if (!firstMatch) return;

        let replaceWith = firstMatch[1] === " " ? "N" : " ";
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
          .matchAll(MAID_TASK_LEFT_METADATA)
          .next();
        const dateMatch = dateMatchIterValue.value;

        if (replaceWith == "N" && !dateMatch) {
          const now = new Date();
          addDateToEditor(editor, cursor, wantedLine, now, leftDateSuffixer);
        } else if (replaceWith == " " && dateMatchIterValue.value) {
          removeDateToEditor(editor, cursor, dateMatch);
        }
      },
    });

    if (this.settings.autocolorTags) {
      this.registerEditorExtension([autocolorPlugin]);
    }
  }

  async insertCurrentDate(editor: Editor, view: MarkdownView) {
    const cursor = editor.getCursor();

    const dateObj = new Date();
    const dateString = dateObj.toISOString();

    const datePosition = {
      line: cursor.line,
      ch: cursor.ch,
    };

    // putting the same position on both 'from' and 'to' parameters leads
    // to the replaceRange inserting text instead.
    editor.replaceRange("%at=" + dateString, datePosition, datePosition);
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

      const dueMatch: Array<string> | undefined = rawText
        .matchAll(DUE_TAG_REGEX)
        .next().value;
      let dueAt: Date | undefined = undefined;
      if (dueMatch !== undefined) {
        dueAt = new Date(dueMatch[1]);
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
        dueAt,
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

  async rollTask(editor: Editor, view: MarkdownView) {
    const tasks = this.makeTaskMap(view);

    let prio_pairs: Array<Array<number>> = [];
    tasks.rawMap.forEach((task, taskPosition, _tasks) => {
      const isFinished = task.state !== " ";
      if (isFinished) return false;

      const priority = tasks.fetchPriority(taskPosition);
      if (priority < 0) return false;
      prio_pairs.push([taskPosition, priority]);
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
        return 1;
      }

      if (firstTaskPriority > secondTaskPriority) {
        return -1;
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

    function median(values: Array<number>): number {
      if (values.length === 0) throw new Error("No inputs");

      values.sort((a, b) => a - b);

      var half = Math.floor(values.length / 2);
      if (values.length % 2) return values[half];
      return (values[half - 1] + values[half]) / 2.0;
    }

    // optimizing code by precomputing priorities
    const priorities = prioritizedUndoneTasks.map((position) => [
      position,
      tasks.fetchPriority(position),
    ]);

    const priorityMedian = median(
      priorities.map(([position, priority]) => priority),
    );
    const lowPriorityTasks = priorities.filter(
      ([position, priority]) => priority <= priorityMedian,
    );
    const highPriorityTasks = priorities.filter(
      ([position, priority]) => priority > priorityMedian,
    );

    function prioritizedTaskSort(
      [thisPosition, thisPriority]: number[],
      [otherPosition, otherPriority]: number[],
    ) {
      // sort by dueAt first
      //
      // also always provide a default dueAt so that if i'm comparing
      // a task that has dueAt, and a task that doesn't, the one that has it
      // always wins

      const thisTask = tasks.get(thisPosition);
      const otherTask = tasks.get(otherPosition);

      const isSamePriority = thisPriority == otherPriority;
      const isOnlyOneDueAt =
        (thisTask.dueAt === undefined && otherTask.dueAt !== undefined) ||
        (thisTask.dueAt !== undefined && otherTask.dueAt === undefined);

      // if tasks are same priority AND one of them has a valid dueAt,
      // use that one above the other, always.
      if (isSamePriority && isOnlyOneDueAt) {
        if (thisTask.dueAt !== undefined) {
          return -1;
        }
        if (otherTask.dueAt !== undefined) {
          return 1;
        }
      }

      // if tasks are same priority but both provide dueAt, use dueAt
      if (
        isSamePriority &&
        thisTask.dueAt !== undefined &&
        otherTask.dueAt !== undefined
      ) {
        if (thisTask.dueAt < otherTask.dueAt) {
          return -1;
        }
        if (thisTask.dueAt > otherTask.dueAt) {
          return 1;
        }
      }

      // if no dueAt on both AND different priority, use priority sort
      if (thisPriority < otherPriority) {
        return 1;
      }

      if (thisPriority > otherPriority) {
        return -1;
      }

      // if same priority, and cant compare by dueAt, use line position
      return positionCompare(thisPosition, otherPosition);
    }

    lowPriorityTasks.sort(prioritizedTaskSort);
    highPriorityTasks.sort(prioritizedTaskSort);
    const finalPrioritizedTasks = highPriorityTasks
      .concat(lowPriorityTasks)
      .map(([position, priority]) => position);

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
    console.log("finalPrioritizedTasks", finalPrioritizedTasks);
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

    if (weirdTasks.length > 0) {
      output += "# weird (bugs in task selection)\n";
      output += stringifyTaskPositions(weirdTasks, 0);
    }
    output += "# unprioritized\n";
    output += stringifyTaskPositions(unprioritizedTasks, 0);
    output += "\n# prioritized\n";
    output += stringifyTaskPositions(finalPrioritizedTasks, 0);
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
    const nowDoneString = doneDateSuffixer(day);
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
    if (cachedMetadata.listItems === undefined) return;

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

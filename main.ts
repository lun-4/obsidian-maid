import {
  App,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownSourceView,
  Editor,
  MarkdownView,
} from "obsidian";

export default class MyPlugin extends Plugin {
  async onload() {
    console.log("loading plugin");

    this.addCommand({
      id: "roll-task",
      name: "Roll random task by priority",
      hotkeys: [{ modifiers: ["Ctrl"], key: "g" }],
      editorCallback: (editor: Editor, view: MarkdownView) => {
        console.log("must roll task", editor, view);
        const fileData = view.data;
        let lineIndex = 0; // TODO change to editor.firstLine()
        const PRIO_REGEX = /%prio=(\d+)/g;

        let prio_pairs: Array<Array<number>> = [];
        let total_prio = 0;
        fileData.split("\n").forEach((line) => {
          const isCompletedTask = line.includes("- [x]");

          const matches = [...line.matchAll(PRIO_REGEX)];
          if (matches.length > 0) {
            const priority: number = parseInt(matches[0][1], 10);
            if (priority && !isCompletedTask) {
              console.log("task", lineIndex, priority);
              prio_pairs.push([priority, lineIndex]);
              total_prio += priority;
            }
          }
          lineIndex += 1;
        });

        if (total_prio == 0) return;

        let index = Math.floor(Math.random() * total_prio);
        let choice: number = null;

        for (const pair of prio_pairs) {
          let [priority, line_index] = pair as Array<number>;
          if (priority > index) {
            choice = line_index;
            break;
          }
          index -= priority;
        }

        if (choice !== null) {
          console.log("selected line", choice);
          editor.setCursor(choice);
        }
      },
    });

    this.addCommand({
      id: "toggle-task-completeness",
      name: "Toggle completeness of a task",
      hotkeys: [{ modifiers: ["Ctrl"], key: "m" }],
      editorCallback: (editor: Editor, view: MarkdownView) => {
        const fileData = view.data;
        const cursor = editor.getCursor();
        const MARKDOWN_LIST_ELEMENT_REGEX = /- \[([x ]?)\]/g;
        const MAID_TASK_CLOSE_METADATA = / \(Done at \d\d\d\d-\d\d-\d\d\)/g;

        const wantedLine = editor.getLine(cursor.line);
        const matches = [...wantedLine.matchAll(MARKDOWN_LIST_ELEMENT_REGEX)];
        if (matches) {
          const firstMatch = matches[0];
          console.log("match", firstMatch);
          let replaceWith = null;
          if (firstMatch[1] == " ") {
            replaceWith = "x";
          } else if (firstMatch[1] == "x") {
            replaceWith = " ";
          }
          console.log("replaceWith", replaceWith);
          if (!replaceWith) return;
          const charPosition = {
            line: cursor.line,
            ch: firstMatch.index + 3,
          };
          const charPositionEnd = {
            line: cursor.line,
            ch: firstMatch.index + 4,
          };
          editor.replaceRange(replaceWith, charPosition, charPositionEnd);
          const dateMatchIterValue = wantedLine
            .matchAll(MAID_TASK_CLOSE_METADATA)
            .next();
          const dateMatch = dateMatchIterValue.value;
          if (replaceWith == "x" && !dateMatch) {
            const datePosition = {
              line: cursor.line,
              ch: wantedLine.length,
            };
            const now = new Date();
            const nowAsString =
              now.getFullYear() +
              "-" +
              ("0" + (now.getMonth() + 1)).slice(-2) +
              "-" +
              ("0" + now.getDate()).slice(-2);
            editor.replaceRange(
              ` (Done at ${nowAsString})`,
              datePosition,
              datePosition
            );
          } else if (replaceWith == " " && dateMatchIterValue.value) {
            const dateMatch = dateMatchIterValue.value;
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
        }
      },
    });
  }
}

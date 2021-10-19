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
        let lineIndex = 0;
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
  }
}

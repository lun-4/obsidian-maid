# Obsidian Maid

[voidmap](https://github.com/void-rs/void) but on Obsidian instead.

![a screenshot of a test todo list](https://clong.biz/i/dxvu0lcv.png)

## How to setup

- Download `obsidian-maid.zip` from [the releases page](https://github.com/lun-4/obsidian-maid/releases).
- Create a folder named `path/to/your/vault/folder/.obsidian/plugins/obsidian-maid` and unzip it.
- Turn on the `Maid` plugin on your obsidian editor (restart might be required, haven't tested that).
- It's likely you will need to unbind Graph View in your settings, or bind
  the Maid actions to different keys than the defaults.

## Micro-tutorial

Consider maid as automation on top of markdown checklists. It does not attempt
to force a specific organization strategy on those lists, other than each
checklist item is a task.

Tasks can have priorities attached to them with the `%prio=N` syntax, where N
is a number.

Use CTRL+G to jump to a random task, weighted by priority. Higher priority means
it's more likely to be selected.

- If a task has no priority set, the default priority is 0.
  This is configurable.

Use CTRL+M to toggle the completeness of a task.

There is a widget in the lower right corner which shows overall task completion
progress

Here is an example of a TODO list

```markdown
- [ ] task 1 %prio=1
- [ ] task 2 %prio=30
- stuff
  - [ ] task 3
```

## How to develop in obsidian-maid's source code

```sh
cd VaultFolder/.obsidian/plugins
git clone https://github.com/lun-4/obsidian-maid
cd obsidian-maid
npm i
npm run build # or 'npm run dev' for development
```

## How to build a zip for releases

After getting a development environment, do:

```sh
make
```

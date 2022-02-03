.PHONY: clean dev
	
obsidian-maid.zip: main.js
	zip -r obsidian-maid.zip main.js styles.css versions.json manifest.json

main.js: main.ts
	npm run build

dev:
	npm run dev

clean:
	rm -f obsidian-maid.zip
	rm -f main.js

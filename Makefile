.PHONY: build clean publish

build:
	bun install --frozen-lockfile
	bun run build

clean:
	rm -rf dist node_modules

publish: build
	npm publish

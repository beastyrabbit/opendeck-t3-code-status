import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { DOCS_IMAGE_DIRECTORY, renderDocsImages } from "../scripts/docs-images.js";

test("the key pictures in the user docs match the renderer", async () => {
	for (const [name, expected] of Object.entries(renderDocsImages())) {
		const committed = await readFile(resolve(DOCS_IMAGE_DIRECTORY, name), "utf8").catch(() => "");
		assert.equal(committed, expected, `docs/user/images/${name} is out of date; run pnpm docs:images`);
	}
});

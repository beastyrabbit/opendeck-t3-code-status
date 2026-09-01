#!/usr/bin/env node

import { T3CodeController } from "./controller.js";
import { OpenDeckHost } from "./opendeck.js";
import { T3Client } from "./t3-client.js";

export async function main(argumentsList = process.argv.slice(2)): Promise<void> {
	const host = new OpenDeckHost(argumentsList);
	const controller = new T3CodeController(host, new T3Client());
	host.onEvent((event) => controller.handle(event));

	let stopping = false;
	const stop = (): void => {
		if (stopping) return;
		stopping = true;
		host.close();
		void controller.dispose();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	await host.connect();
}

void main().catch(() => {
	console.error("[T3 Code Status] The plugin could not start.");
	process.exitCode = 1;
});
